"""Research-paper ingestion: local PDF storage, text/table extraction, metadata detection,
page rendering and passage search (PyMuPDF).

Original PDFs stay on the local machine (``<data_dir>/papers``). Nothing here sends
document content to external services.
"""
from __future__ import annotations

import hashlib
import os
import re
import uuid
from datetime import datetime, timezone

import pymupdf

from . import db

DOI_RE = re.compile(r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+[A-Za-z0-9])")
YEAR_RE = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")


def papers_dir() -> str:
    d = os.path.join(db.data_dir(), "papers")
    os.makedirs(d, exist_ok=True)
    return d


def _now():
    return datetime.now(timezone.utc).isoformat()


def _title_from_layout(doc: pymupdf.Document) -> str | None:
    """Largest-font text on page 1 (typical article title)."""
    if doc.page_count == 0:
        return None
    spans = []
    for b in doc[0].get_text("dict")["blocks"]:
        for line in b.get("lines", []):
            for s in line.get("spans", []):
                t = s["text"].strip()
                if len(t) > 3:
                    spans.append((round(s["size"], 1), s["bbox"][1], t))
    if not spans:
        return None
    top = max(s[0] for s in spans)
    parts = [t for size, _, t in sorted(spans, key=lambda s: s[1]) if size == top]
    title = " ".join(parts).strip()
    return title if 8 <= len(title) <= 400 else None


def _authors_guess(page1_text: str, title: str | None) -> list[str]:
    lines = [l.strip() for l in page1_text.splitlines() if l.strip()]
    if not title:
        return []
    # line(s) directly after the title that look like a list of names
    joined = " ".join(lines)
    idx = joined.find(title[:40])
    if idx < 0:
        return []
    after = joined[idx + len(title):].strip()
    cand = re.split(r"\b(Abstract|ABSTRACT|Keywords|Department|University|Institute|Received|a\s*Department)\b", after)[0]
    cand = cand[:300]
    names = [n.strip(" ,*;0123456789†‡") for n in re.split(r",|\band\b|;", cand)]
    names = [n for n in names if 3 <= len(n) <= 60 and re.match(r"^[A-Z][\w.\-' ]+$", n) and len(n.split()) <= 5]
    return names[:20]


def detect_metadata(doc: pymupdf.Document, pages_text: list[str], filename: str) -> dict:
    meta = doc.metadata or {}
    first = "\n".join(pages_text[:2])
    doi = None
    m = DOI_RE.search(first) or DOI_RE.search(" ".join(pages_text))
    if m:
        doi = m.group(1).rstrip(".")
    title = (meta.get("title") or "").strip() or _title_from_layout(doc) or os.path.splitext(filename)[0]
    authors = [a.strip() for a in re.split(r";|,| and ", meta.get("author") or "") if a.strip()] or _authors_guess(pages_text[0] if pages_text else "", title)
    year = None
    for pat in (r"(?:Received|Accepted|Published|Available online|©|Copyright)[^\n]{0,60}?\b(19[5-9]\d|20[0-4]\d)\b",):
        mm = re.search(pat, first)
        if mm:
            year = int(mm.group(1))
            break
    if year is None and (meta.get("creationDate") or "").startswith("D:"):
        try:
            year = int(meta["creationDate"][2:6])
        except ValueError:
            year = None
    journal = None
    head = [l.strip() for l in first.splitlines()[:40] if 5 < len(l.strip()) < 100]
    head = [l for l in head if l not in (title or "") and (title or "")[:30] not in l]
    for pat in (r"\b(Vol\.|Volume)\s*\d+|\(\d{4}\)\s*\d+", r"\bJournal of\b|\bJournal\b",
                r"\b(Food|Hydrocolloids|Rheology|Engineering|Chemistry|Science|Letters|Reviews)\b"):
        hit = next((l for l in head if re.search(pat, l)), None)
        if hit:
            journal = re.split(r",?\s*\b(?:Vol\.|Volume)|\s\(\d{4}\)", hit)[0].strip(" ,")
            break
    return {
        "title": title, "authors": authors, "journal": journal, "year": year, "doi": doi,
        "detection": {"title": "pdf metadata" if meta.get("title") else "largest font on page 1", "authors": "pdf metadata" if meta.get("author") else "heuristic",
                      "doi": "text pattern" if doi else None, "year": "text pattern" if year else None, "journal": "heuristic" if journal else None},
        "verified": False,
    }


def citation(meta: dict) -> str:
    a = meta.get("authors") or []
    au = (a[0].split()[-1] + (" et al." if len(a) > 2 else (" & " + a[1].split()[-1] if len(a) == 2 else ""))) if a else "Unknown author"
    parts = [f"{au} ({meta.get('year') or 'n.d.'})", meta.get("title") or ""]
    if meta.get("journal"):
        parts.append(meta["journal"])
    if meta.get("doi"):
        parts.append(f"doi:{meta['doi']}")
    return ". ".join(p for p in parts if p)


def extract_document(path: str, filename: str) -> dict:
    doc = pymupdf.open(path)
    pages, warnings = [], []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        tables = []
        try:
            for k, t in enumerate(page.find_tables().tables):
                # cell text read from each cell rectangle (more robust than t.extract() for centred text)
                rows = [[" ".join(page.get_textbox(pymupdf.Rect(c)).split()) if c else "" for c in r.cells] for r in t.rows]
                if rows and sum(len("".join(r)) for r in rows) > 0:
                    tables.append({"id": f"p{i + 1}t{k + 1}", "bbox": list(t.bbox), "rows": rows})
        except Exception as e:  # table finder is best-effort
            warnings.append(f"page {i + 1}: table detection failed ({type(e).__name__})")
        has_images = bool(page.get_images())
        if len(text.strip()) < 30 and has_images:
            warnings.append(f"page {i + 1}: no text layer (scanned image). OCR / document vision is required; use manual entry.")
        pages.append({"n": i + 1, "text": text, "chars": len(text), "width": page.rect.width, "height": page.rect.height, "tables": tables, "has_images": has_images})
    meta = detect_metadata(doc, [p["text"] for p in pages], filename)
    meta["citation"] = citation(meta)
    doc.close()
    return {"pages": pages, "metadata": meta, "warnings": warnings}


def import_pdf(content: bytes, filename: str, library_ids: list[str] | None = None) -> dict:
    if not content.startswith(b"%PDF"):
        raise ValueError("File is not a PDF")
    sha = hashlib.sha256(content).hexdigest()
    for p in db.list_docs("papers"):
        if p.get("sha256") == sha:
            if library_ids:
                p["library_ids"] = sorted(set(p.get("library_ids", [])) | set(library_ids))
                db.put_doc("papers", p)
            return {**p, "duplicate": True}
    pid = f"paper-{uuid.uuid4().hex[:10]}"
    path = os.path.join(papers_dir(), f"{pid}.pdf")
    with open(path, "wb") as f:
        f.write(content)
    try:
        ex = extract_document(path, filename)
    except Exception as e:
        os.remove(path)
        raise ValueError(f"Could not read PDF: {e}") from e
    doc = {"id": pid, "name": filename, "file_name": f"{pid}.pdf", "sha256": sha, "size_bytes": len(content), "imported_at": _now(),
           "page_count": len(ex["pages"]), "pages": ex["pages"], "metadata": ex["metadata"], "warnings": ex["warnings"],
           "library_ids": library_ids or [], "status": "imported", "pdf_available": True}
    return db.put_doc("papers", doc)


def pdf_path(paper: dict) -> str | None:
    p = os.path.join(papers_dir(), paper.get("file_name") or f"{paper['id']}.pdf")
    return p if os.path.exists(p) else None


def render_page(paper: dict, n: int, zoom: float = 1.5) -> bytes:
    path = pdf_path(paper)
    if not path:
        raise FileNotFoundError("Original PDF is not available on this machine")
    with pymupdf.open(path) as doc:
        if not 1 <= n <= doc.page_count:
            raise ValueError("page out of range")
        pix = doc[n - 1].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")


def search(paper: dict, n: int, text: str) -> list[list[float]]:
    """Rectangles (PDF points) where ``text`` occurs on page n; falls back to the first 60 characters."""
    path = pdf_path(paper)
    if not path or not text.strip():
        return []
    with pymupdf.open(path) as doc:
        if not 1 <= n <= doc.page_count:
            return []
        page = doc[n - 1]
        q = " ".join(text.split())
        rects = page.search_for(q)
        if not rects and len(q) > 60:
            rects = page.search_for(q[:60])
        if not rects and len(q) > 25:
            rects = page.search_for(q[:25])
        return [[r.x0, r.y0, r.x1, r.y1] for r in rects]


def summary(p: dict) -> dict:
    return {k: v for k, v in p.items() if k != "pages"}
