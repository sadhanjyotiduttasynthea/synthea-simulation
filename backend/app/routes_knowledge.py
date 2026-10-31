"""REST endpoints for the global scientific libraries."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from . import db, knowledge
from .science import catalog

router = APIRouter(prefix="/api")


def _404(e: KeyError):
    raise HTTPException(404, f"not found: {e}")


@router.get("/catalog")
def get_catalog():
    return catalog.catalog()


@router.post("/units/convert")
def convert(body: dict = Body(...)):
    return catalog.normalize(float(body["value"]), body.get("unit"), body.get("target"))


# libraries
@router.get("/libraries")
def libraries(include_archived: bool = False):
    return knowledge.list_libraries(include_archived)


@router.post("/libraries")
def create_library(doc: dict = Body(...)):
    doc.pop("id", None)
    return knowledge.save_library(doc)


@router.put("/libraries/{lid}")
def update_library(lid: str, doc: dict = Body(...)):
    if not db.get_doc("libraries", lid):
        raise HTTPException(404, "library not found")
    doc["id"] = lid
    return knowledge.save_library(doc)


@router.get("/libraries/{lid}/export")
def export_library(lid: str):
    try:
        return knowledge.export_library(lid)
    except KeyError as e:
        _404(e)


@router.post("/libraries/import")
def import_library(bundle: dict = Body(...)):
    return knowledge.import_library(bundle)


# materials
@router.get("/materials")
def materials(q: str = "", library_id: str | None = None, tag: str | None = None, category: str | None = None, include_archived: bool = False):
    return knowledge.search_materials(q, library_id, tag, category, include_archived)


@router.get("/materials/{mid}")
def material(mid: str):
    try:
        m = knowledge.get_material(mid)
    except KeyError as e:
        _404(e)
    return {**m, "properties": knowledge.properties_of(mid),
            "models": [x for x in db.list_docs("sci_models") if x.get("material_id") == mid]}


@router.post("/materials")
def create_material(doc: dict = Body(...)):
    doc.pop("id", None)
    doc.setdefault("version", 1)
    return knowledge.save_material(doc)


@router.put("/materials/{mid}")
def update_material(mid: str, doc: dict = Body(...)):
    try:
        knowledge.get_material(mid)
    except KeyError as e:
        _404(e)
    doc["id"] = mid
    for k in ("properties", "models", "library_names", "property_count", "approved_count", "pending_count"):
        doc.pop(k, None)
    return knowledge.save_material(doc)


@router.post("/materials/{mid}/version")
def version_material(mid: str):
    try:
        return knowledge.new_version(mid)
    except KeyError as e:
        _404(e)


# properties
@router.post("/properties")
def create_property(doc: dict = Body(...)):
    doc.pop("id", None)
    try:
        return knowledge.save_property(doc)
    except KeyError as e:
        _404(e)


@router.put("/properties/{pid}")
def update_property(pid: str, doc: dict = Body(...)):
    if not db.get_doc("properties", pid):
        raise HTTPException(404, "property not found")
    doc["id"] = pid
    note = doc.pop("_note", "edited")
    return knowledge.save_property(doc, note=note)


@router.delete("/properties/{pid}")
def delete_property(pid: str):
    p = db.get_doc("properties", pid)
    if not p:
        raise HTTPException(404, "property not found")
    if p.get("review_status") in ("approved",):
        # approved records are deprecated (kept for traceability), not deleted
        p["review_status"] = "deprecated"
        return knowledge.save_property(p, note="deprecated instead of deleted")
    db.delete_doc("properties", pid)
    return {"deleted": pid}


@router.get("/properties/compare")
def compare(material_id: str, property: str, include_unreviewed: bool = True):
    return knowledge.compare(material_id, property, include_unreviewed)


# ------------------------------------------------------------------ "Summarize all PDFs" (library report)
@router.post("/libraries/{lid}/report")
def library_report(lid: str, body: dict = Body(default={})):
    from . import library_report as lr
    try:
        return lr.build(lid, body.get("method", "local"))
    except KeyError as e:
        _404(e)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/libraries/{lid}/report.pdf")
def library_report_pdf(lid: str, body: dict = Body(default={})):
    from fastapi.responses import Response

    from . import library_report as lr
    from . import reports
    try:
        r = body.get("report") or lr.build(lid, body.get("method", "local"))
    except KeyError as e:
        _404(e)
    except ValueError as e:
        raise HTTPException(400, str(e))
    pdf = reports.build_pdf(lr.pdf_payload(r, body.get("project", "")))
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="library_report_{lid}.pdf"'})


@router.get("/equations")
def all_equations():
    """All extracted equations (awaiting review or unrecognised) and registry models, with sources."""
    from . import library_report as lr
    papers = db.list_docs("papers")
    rows = lr.equation_rows(papers)
    seen = {r.get("model_id") for r in rows}
    names = {m["id"]: m["name"] for m in db.list_docs("materials")}
    for m in db.list_docs("sci_models"):  # models without a paper source (manual entry)
        if m["id"] in seen or m.get("status") in ("rejected", "deprecated"):
            continue
        rows.append({"origin": "registry model", "model_id": m["id"], "name": m.get("name"), "template": m.get("template"), "latex": m.get("latex"), "expression": m.get("expression"),
                     "dependent": m.get("dependent"), "variables": m.get("variables") or [],
                     "parameters": [{"symbol": q["symbol"], "name": q.get("name"), "value": q.get("value"), "unit": q.get("unit")} for q in m.get("parameters") or []],
                     "validity": m.get("validity") or {}, "conditions": m.get("conditions") or {}, "material": names.get(m.get("material_id")), "status": m.get("status"),
                     "paper_id": None, "paper": (m.get("source") or {}).get("citation") or "manual entry", "page": None, "synthetic": False})
    return rows
