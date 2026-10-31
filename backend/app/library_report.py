""""Summarize all PDFs": one combined report per library.

Contents (all numbers come from extracted records -- library property records, extraction
candidates awaiting review, or registry models -- never from a language model):

* papers in the library with their verbatim key statements (page-linked),
* a consolidated property table (value, unit, uncertainty, conditions, material, paper, page, status),
* all equations and numerical models with parameters, validity ranges and sources,
* key numbers: the range of reported values per property (min-max, number of values and papers; no averaging),
* disagreements: values of the same property for the same material under comparable conditions that differ by
  more than 25 %, listed side by side (never averaged).

Optional narrative: with an API key and the external-AI opt-in, Claude writes a short text summary from the
key statements. It is labelled as a summary, and any number in it that does not appear in the records is masked.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from . import db, extraction, knowledge, paper_summary
from .science import catalog

STATUS_RANK = {"approved": 0, "reviewed": 1, "pending": 2, "extracted": 2}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _fmt(v) -> str:
    if v is None:
        return "–"
    if isinstance(v, (int, float)):
        return f"{v:.4g}"
    return str(v)


def _papers(lib_id: str) -> list[dict]:
    return [p for p in db.list_docs("papers") if lib_id in (p.get("library_ids") or [])]


def _mat_names() -> dict:
    return {m["id"]: m["name"] for m in db.list_docs("materials")}


def property_rows(papers: list[dict]) -> list[dict]:
    pids = {p["id"]: p for p in papers}
    names = _mat_names()
    rows = []
    for r in db.list_docs("properties"):
        src = r.get("source") or {}
        if src.get("paper_id") not in pids or r.get("review_status") in ("rejected", "deprecated"):
            continue
        p = pids[src["paper_id"]]
        rows.append({"origin": "library record", "record_id": r["id"], "material_id": r.get("material_id"), "material": names.get(r.get("material_id"), r.get("material_id")),
                     "property": r["property"], "label": catalog.property_meta(r["property"])["label"], "value": r.get("value"), "value_max": r.get("value_max"),
                     "unit": r.get("unit"), "normalized": r.get("normalized"), "uncertainty": r.get("uncertainty") or {}, "conditions": r.get("conditions") or {},
                     "paper_id": p["id"], "paper": (p.get("metadata") or {}).get("title") or p.get("name"), "page": src.get("page"),
                     "passage": src.get("snippet") or src.get("passage"), "status": r.get("review_status"), "evidence_type": r.get("evidence_type"),
                     "synthetic": bool(p.get("synthetic_test_document"))})
    for p in papers:
        for e in db.list_children("extractions", p["id"]):
            if e.get("kind") != "property" or e.get("status") != "pending":
                continue  # approved candidates are represented by their library record
            meta = catalog.property_meta(e["property"])
            nv = catalog.normalize(e["value"], e.get("unit"), meta["unit"]) if e.get("value") is not None and meta["unit"] else {"value": e.get("value"), "unit": e.get("unit"), "ok": True}
            rows.append({"origin": "extraction (awaiting review)", "extraction_id": e["id"], "material_id": e.get("material_id"), "material": e.get("material_name") or "unassigned",
                         "property": e["property"], "label": meta["label"], "value": e.get("value"), "value_max": e.get("value_max"), "unit": e.get("unit"), "normalized": nv,
                         "uncertainty": e.get("uncertainty") or {}, "conditions": e.get("conditions") or {}, "paper_id": p["id"],
                         "paper": (p.get("metadata") or {}).get("title") or p.get("name"), "page": e.get("page"), "passage": e.get("snippet"), "status": "pending",
                         "evidence_type": e.get("evidence_type"), "synthetic": bool(p.get("synthetic_test_document"))})
    rows.sort(key=lambda r: (r["material"] or "", r["label"], STATUS_RANK.get(r["status"], 3)))
    return rows


def equation_rows(papers: list[dict]) -> list[dict]:
    pids = {p["id"]: p for p in papers}
    names = _mat_names()
    out = []
    for m in db.list_docs("sci_models"):
        src = m.get("source") or {}
        if src.get("paper_id") not in pids or m.get("status") in ("rejected", "deprecated"):
            continue
        p = pids[src["paper_id"]]
        out.append({"origin": "registry model", "model_id": m["id"], "name": m.get("name"), "template": m.get("template"), "latex": m.get("latex"), "expression": m.get("expression"),
                    "dependent": m.get("dependent"), "variables": m.get("variables") or [],
                    "parameters": [{"symbol": q["symbol"], "name": q.get("name"), "value": q.get("value"), "unit": q.get("unit")} for q in m.get("parameters") or []],
                    "validity": m.get("validity") or {}, "conditions": m.get("conditions") or {}, "material": names.get(m.get("material_id")), "status": m.get("status"),
                    "paper_id": p["id"], "paper": (p.get("metadata") or {}).get("title"), "page": src.get("page"), "synthetic": bool(p.get("synthetic_test_document"))})
    for p in papers:
        for e in db.list_children("extractions", p["id"]):
            if e.get("kind") != "equation" or e.get("status") != "pending":
                continue
            eq = e.get("equation") or {}
            out.append({"origin": "extraction (awaiting review)", "extraction_id": e["id"], "name": eq.get("name"), "template": eq.get("template"), "latex": eq.get("latex"),
                        "expression": eq.get("expression"), "dependent": eq.get("dependent"), "variables": eq.get("variables") or [],
                        "parameters": [{"symbol": q["symbol"], "name": q.get("name"), "value": q.get("value"), "unit": q.get("value_unit") or q.get("unit")} for q in eq.get("parameters") or []],
                        "parameter_sets": len(eq.get("parameter_sets") or []), "validity": eq.get("validity") or {}, "raw": eq.get("raw"),
                        "material": e.get("material_name"), "status": "pending" if eq.get("template") else "unrecognised (manual entry)",
                        "paper_id": p["id"], "paper": (p.get("metadata") or {}).get("title"), "page": e.get("page"), "synthetic": bool(p.get("synthetic_test_document"))})
    return out


def key_numbers(rows: list[dict]) -> list[dict]:
    """Range of reported values per (material, property) in canonical units -- no averaging."""
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        nv = r.get("normalized") or {}
        if nv.get("ok") and isinstance(nv.get("value"), (int, float)):
            groups.setdefault((r["material"], r["property"]), []).append(r)
    out = []
    for (mat, prop), rs in groups.items():
        vals = [x["normalized"]["value"] for x in rs]
        out.append({"material": mat, "property": prop, "label": rs[0]["label"], "unit": rs[0]["normalized"].get("unit"), "min": min(vals), "max": max(vals),
                    "n_values": len(vals), "n_papers": len({x["paper_id"] for x in rs}),
                    "sources": [{"paper": x["paper"], "page": x["page"], "value": x["normalized"]["value"], "status": x["status"]} for x in rs]})
    return sorted(out, key=lambda k: (k["material"] or "", k["label"]))


def disagreements(rows: list[dict]) -> list[dict]:
    out = []
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        nv = r.get("normalized") or {}
        if nv.get("ok") and isinstance(nv.get("value"), (int, float)):
            groups.setdefault((r["material"], r["property"]), []).append(r)
    for (mat, prop), rs in groups.items():
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                a, b = rs[i], rs[j]
                ok, notes = knowledge._cond_compatible(a["conditions"], b["conditions"])
                if not ok:
                    continue
                va, vb = a["normalized"]["value"], b["normalized"]["value"]
                rel = abs(va - vb) / max(abs(va), abs(vb), 1e-30)
                if rel > knowledge.CONFLICT_REL:
                    out.append({"material": mat, "property": prop, "label": a["label"], "unit": a["normalized"].get("unit"), "relative_difference": rel, "notes": notes,
                                "a": {k: a[k] for k in ("value", "unit", "conditions", "paper", "page", "status")} | {"canonical": va},
                                "b": {k: b[k] for k in ("value", "unit", "conditions", "paper", "page", "status")} | {"canonical": vb}})
    return out


def _numbers_in(rows, eqs, statements) -> set[str]:
    allowed: set[str] = set()

    def add(v):
        if isinstance(v, (int, float)):
            for f in (f"{v:g}", f"{v:.2g}", f"{v:.3g}", f"{v:.4g}", f"{v}"):
                allowed.add(f.lower())
    for r in rows:
        add(r.get("value"))
        add(r.get("value_max"))
        add((r.get("uncertainty") or {}).get("value"))
        for c in (r.get("conditions") or {}).values():
            add(c)
    for e in eqs:
        for q in e["parameters"]:
            add(q.get("value"))
        for rng in (e.get("validity") or {}).values():
            for v in rng:
                add(v)
    for s in statements:
        for m in re.finditer(r"\d+(?:\.\d+)?", s):
            allowed.add(m.group(0))
    return allowed


def mask_untraceable_numbers(text: str, allowed: set[str]) -> tuple[str, int]:
    n = 0

    def rep(m):
        nonlocal n
        tok = m.group(0)
        if tok in allowed or tok.lstrip("0") in allowed or re.fullmatch(r"\d", tok):  # single digits (counts, list numbering) pass
            return tok
        n += 1
        return "[number removed — not in the extracted records]"
    return re.sub(r"(?<![\w.])\d+(?:\.\d+)?(?![\w])", rep, text), n


def build(lib_id: str, method: str = "local") -> dict:
    lib = db.get_doc("libraries", lib_id)
    if not lib:
        raise KeyError(lib_id)
    papers = _papers(lib_id)
    paper_items = []
    statements = []
    for p in papers:
        d = paper_summary.local_summary(p, n_key=5)
        meta = p.get("metadata") or {}
        paper_items.append({"paper_id": p["id"], "title": meta.get("title") or p.get("name"), "citation": meta.get("citation"), "pages": p.get("page_count"),
                            "synthetic": bool(p.get("synthetic_test_document")), "species": d.get("species"),
                            "key_statements": [{"page": s["page"], "text": s["text"]} for s in d["key_sentences"]],
                            "topics": [t["label"] for t in d["topics"][:8]]})
        statements += [s["text"] for s in d["key_sentences"]]
    rows = property_rows(papers)
    eqs = equation_rows(papers)
    report = {
        "library": {"id": lib["id"], "name": lib["name"]}, "generated_at": _now(), "method": "local",
        "label": "Combined extractive report. Every number is copied from extracted records (library records, candidates awaiting review or registry models) with paper and page.",
        "papers": paper_items, "properties": rows, "equations": eqs, "key_numbers": key_numbers(rows), "disagreements": disagreements(rows),
        "counts": {"papers": len(papers), "property_values": len(rows), "approved": sum(r["status"] == "approved" for r in rows),
                   "awaiting_review": sum(r["status"] == "pending" for r in rows), "equations": len(eqs)},
        "warnings": (["Some papers are SYNTHETIC test documents: their values are invented."] if any(p["synthetic"] for p in paper_items) else [])
        + (["No papers in this library yet: import PDFs and file them in this library."] if not papers else []),
    }
    if method == "claude":
        report["narrative"] = _claude_narrative(report, statements)
        report["method"] = report["narrative"]["model"]
    return report


NARRATIVE_SYSTEM = ("You summarise a set of food-science papers about faba bean (Vicia faba) protein ingredients for researchers. "
                    "Use ONLY the supplied verbatim statements and table rows. Write at most 250 words: main themes, which properties and models are covered, "
                    "where sources disagree, and what data is missing. Do not state any number unless it appears verbatim in the input. Cite papers by title.")


def _claude_narrative(report: dict, statements: list[str]) -> dict:
    st = extraction.ai_settings()
    if not st["api_key_configured"]:
        raise ValueError("No ANTHROPIC_API_KEY configured on this machine; the local report is available.")
    if not st["allow_external_ai"]:
        raise ValueError("External AI is disabled. Enable it in Settings → AI assistant after reading the data-transfer disclosure.")
    import anthropic

    payload = {"papers": [{"title": p["title"], "key_statements": p["key_statements"]} for p in report["papers"]],
               "properties": [{k: r[k] for k in ("material", "label", "value", "unit", "conditions", "paper", "page", "status")} for r in report["properties"][:300]],
               "disagreements": report["disagreements"][:40]}
    resp = anthropic.Anthropic().messages.create(model=st["model"], max_tokens=2000, system=NARRATIVE_SYSTEM,
                                                 messages=[{"role": "user", "content": json.dumps(payload, default=str)[:300_000]}])
    if resp.stop_reason == "refusal":
        raise ValueError("The external model declined this request.")
    text = "".join(b.text for b in resp.content if b.type == "text")
    clean, removed = mask_untraceable_numbers(text, _numbers_in(report["properties"], report["equations"], statements))
    return {"model": f"claude:{st['model']}", "text": clean, "numbers_removed": removed,
            "label": "AI-written summary (explains and quotes only). Numbers not found in the extracted records were removed; use the tables for values."}


def pdf_payload(r: dict, project: str = "") -> dict:
    sections = [{"title": "About this report", "paragraphs": [r["label"]] + r["warnings"] + ([f"Narrative ({r['narrative']['model']}): {r['narrative']['label']}", r["narrative"]["text"]] if r.get("narrative") else [])}]
    for p in r["papers"]:
        sections.append({"title": f"Paper: {p['title']}" + (" [SYNTHETIC]" if p["synthetic"] else ""),
                         "paragraphs": [p.get("citation") or ""], "bullets": [f"p. {s['page']}: “{s['text']}”" for s in p["key_statements"]]})
    sections.append({"title": "Consolidated property table", "tables": [{"headers": ["Material", "Property", "Value", "Unit", "Conditions", "Paper, page", "Status"],
                     "rows": [[x["material"], x["label"], _fmt(x["value"]) + (f"–{_fmt(x['value_max'])}" if x.get("value_max") is not None else "") + (f" ± {_fmt(x['uncertainty'].get('value'))}" if x["uncertainty"].get("value") is not None else ""),
                               x.get("unit") or "", ", ".join(f"{k} {v}" for k, v in x["conditions"].items()), f"{x['paper']}, p. {x['page']}", x["status"]] for x in r["properties"]]}]})
    sections.append({"title": "Equations and numerical models", "tables": [{"headers": ["Model", "Expression", "Parameters", "Validity", "Paper, page", "Status"],
                     "rows": [[e.get("name") or "–", e.get("expression") or e.get("raw") or "–", "; ".join(f"{q['symbol']} = {_fmt(q['value'])} {q.get('unit') or ''}" for q in e["parameters"]) or "–",
                               "; ".join(f"{k}: {v[0]:g}–{v[1]:g}" for k, v in e["validity"].items()) or "not stated", f"{e['paper']}, p. {e['page']}", e["status"]] for e in r["equations"]]}]})
    sections.append({"title": "Key numbers (range of reported values, not averaged)", "tables": [{"headers": ["Material", "Property", "Range", "Unit", "Values / papers"],
                     "rows": [[k["material"], k["label"], f"{_fmt(k['min'])} – {_fmt(k['max'])}" if k["min"] != k["max"] else _fmt(k["min"]), k["unit"] or "", f"{k['n_values']} / {k['n_papers']}"] for k in r["key_numbers"]]}]})
    sections.append({"title": "Where sources disagree (comparable conditions, > 25 % difference)", "paragraphs": [] if r["disagreements"] else ["No disagreements found among comparable values."],
                     "tables": [{"headers": ["Material", "Property", "Source A", "Source B", "Difference"],
                                 "rows": [[d["material"], d["label"], f"{_fmt(d['a']['value'])} {d['a']['unit'] or ''} ({d['a']['paper']}, p. {d['a']['page']})",
                                           f"{_fmt(d['b']['value'])} {d['b']['unit'] or ''} ({d['b']['paper']}, p. {d['b']['page']})", f"{d['relative_difference'] * 100:.0f} %"] for d in r["disagreements"]]}] if r["disagreements"] else []})
    return {"title": f"Library report — {r['library']['name']}", "project": project, "sections": sections}
