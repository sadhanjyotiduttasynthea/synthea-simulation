"""Paper summaries.

Two methods:

* ``local`` (always available, offline): an *extractive* summary. Sentences are copied verbatim
  from the paper (never rewritten), each with its page number, so every statement can be checked
  on the source page. Sentences are scored by section (abstract / conclusions weigh most), by
  catalogue property aliases, by reported numbers with units and by cue phrases.
* ``claude`` (optional): only with an API key AND the explicit external-AI opt-in in Settings.
  The model is instructed to cite pages; the result is labelled AI-generated.

The summary is stored on the paper document as ``digest``.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from . import db, extraction
from .science import catalog

SECTION_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(abstract|introduction|materials and methods|methods|methodology|experimental|results and discussion|results|discussion|conclusions?|summary|references|acknowledg(?:e)?ments?)\s*:?\s*$", re.I)
SECTION_WEIGHT = {"abstract": 3.0, "conclusion": 3.0, "conclusions": 3.0, "summary": 2.5, "results": 1.6, "results and discussion": 1.6,
                  "discussion": 1.3, "introduction": 0.6, "materials and methods": 0.8, "methods": 0.8, "methodology": 0.8, "experimental": 0.8}
CUES = ("we found", "results show", "results showed", "was found", "increased", "decreased", "significant", "in conclusion", "this study",
        "we show", "we report", "aim of", "objective", "suggest", "demonstrate", "compared with", "higher than", "lower than")
NUM_UNIT = re.compile(r"\d+(?:\.\d+)?\s*(?:%|°c|pa|mpa|kpa|w/|j/|kg|g/|mm|µm|s-1|s⁻¹|k\b)", re.I)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _aliases() -> list[tuple[str, str]]:
    out = []
    for key, (label, _cat, _u, aliases) in catalog.PROPERTIES.items():
        for a in aliases:
            if len(a) >= 4:
                out.append((a.lower(), key))
    return out


def _sentences_with_pages(pages: list[dict]) -> list[dict]:
    out, section = [], None
    for p in pages:
        buf = []
        for line in (p.get("text") or "").splitlines():
            m = SECTION_RE.match(line)
            if m:
                if buf:
                    out += [{"page": p["n"], "section": section, "text": s} for s in extraction.sentences(" ".join(buf))]
                    buf = []
                section = m.group(1).lower()
                continue
            buf.append(line.strip())
        if buf:
            out += [{"page": p["n"], "section": section, "text": s} for s in extraction.sentences(" ".join(buf))]
    return out


def local_summary(paper: dict, n_key: int = 8) -> dict:
    pages = paper.get("pages") or []
    sents = _sentences_with_pages(pages)
    aliases = _aliases()
    scored = []
    for i, s in enumerate(sents):
        t = s["text"].strip()
        tl = t.lower()
        if len(t) < 40 or len(t) > 420 or s["section"] in ("references", "acknowledgements", "acknowledgments", "acknowledgement"):
            continue
        props = sorted({k for a, k in aliases if re.search(r"(?<![a-z])" + re.escape(a) + r"(?![a-z])", tl)})
        score = SECTION_WEIGHT.get(s["section"] or "", 1.0) * (1.0 + 0.8 * len(props) + 0.7 * len(NUM_UNIT.findall(t)) + 0.6 * sum(c in tl for c in CUES))
        score *= 1.0 + 0.3 * (s["page"] == 1)
        scored.append({**s, "score": round(score, 3), "properties": props, "order": i})
    top = sorted(scored, key=lambda x: -x["score"])[:n_key]
    top.sort(key=lambda x: x["order"])
    # topics: property coverage across the whole document
    full = " ".join((p.get("text") or "") for p in pages).lower()
    topics = {}
    for a, k in aliases:
        c = len(re.findall(r"(?<![a-z])" + re.escape(a) + r"(?![a-z])", full))
        if c:
            topics[k] = topics.get(k, 0) + c
    known, abbr = extraction.material_candidates(" ".join(p.get("text") or "" for p in pages))
    mats = [{"material_id": m["material_id"], "name": m["name"], "mentions": m["mentions"]} for m in known[:10]]
    sections = sorted({s["section"] for s in sents if s["section"]})
    exts = db.list_children("extractions", paper["id"])
    meta = paper.get("metadata") or {}
    return {
        "method": "local", "generated_at": _now(),
        "label": "Extractive summary: sentences are quoted verbatim from the paper with their page numbers.",
        "title": meta.get("title"), "citation": meta.get("citation"),
        "key_sentences": [{"page": s["page"], "section": s["section"], "text": s["text"], "properties": s["properties"]} for s in top],
        "topics": [{"property": k, "label": catalog.property_meta(k)["label"], "mentions": c} for k, c in sorted(topics.items(), key=lambda kv: -kv[1])[:12]],
        "materials": mats, "abbreviations": abbr, "species": extraction.species_mentions(" ".join(p.get("text") or "" for p in pages)), "sections": sections, "page_count": len(pages),
        "tables": sum(len(p.get("tables") or []) for p in pages),
        "extractions": {k: sum(1 for e in exts if e.get("status") == k) for k in ("pending", "approved", "rejected")},
        "warnings": (paper.get("warnings") or []) + (["SYNTHETIC TEST DOCUMENT: values are invented."] if paper.get("synthetic_test_document") else []),
    }


AI_SYSTEM = ("You summarise scientific food-engineering papers for researchers. Use ONLY the supplied text. Every statement must cite "
             "its page as [p. N]. Do not add numbers that are not in the text. Structure: Aim, Materials & methods, Key quantitative "
             "findings (with units and conditions), Models/equations reported, Limitations. Keep it under 350 words.")


def claude_summary(paper: dict) -> dict:
    st = extraction.ai_settings()
    if not st["api_key_configured"]:
        raise ValueError("No ANTHROPIC_API_KEY configured on this machine; use the local summary.")
    if not st["allow_external_ai"]:
        raise ValueError("External AI is disabled. Enable it in Settings → AI assistant after reading the data-transfer disclosure.")
    import anthropic

    doc_text = "\n\n".join(f"=== PAGE {p['n']} ===\n{p['text']}" for p in paper.get("pages") or [])[:400_000]
    resp = anthropic.Anthropic().messages.create(model=st["model"], max_tokens=4000, system=AI_SYSTEM,
                                                 messages=[{"role": "user", "content": doc_text}])
    if resp.stop_reason == "refusal":
        raise ValueError("The external model declined this request.")
    base = local_summary(paper)
    base.update({"method": f"claude:{st['model']}", "label": "AI-generated summary (external model). Check every statement against the cited page.",
                 "text": "".join(b.text for b in resp.content if b.type == "text")})
    return base


def summarise(paper_id: str, method: str = "local") -> dict:
    p = db.get_doc("papers", paper_id)
    if not p:
        raise KeyError(paper_id)
    d = claude_summary(p) if method == "claude" else local_summary(p)
    p["digest"] = d
    db.put_doc("papers", p)
    return d

