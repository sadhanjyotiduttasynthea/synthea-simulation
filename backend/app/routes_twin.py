"""REST endpoints for digital twins, studies and background jobs."""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from . import db, jobs
from .twin import properties as tprops
from .twin import service

router = APIRouter(prefix="/api")


def _twin(tid: str) -> dict:
    try:
        return service.get(tid)
    except KeyError:
        raise HTTPException(404, "twin not found")


@router.get("/twins/catalogue")
def catalogue():
    return service.catalogue()


@router.get("/twins")
def list_twins(project_id: str | None = None):
    return [t for t in db.list_docs("twins") if not project_id or t.get("project_id") in (project_id, None)]


@router.post("/twins")
def create_twin(body: dict = Body(default={})):
    t = service.new_twin(body.get("project_id"), body.get("name") or "Digital twin", body.get("physics"), body.get("material_id"))
    if body.get("geometry"):
        t["geometry"] = body["geometry"]
    try:
        return service.save(t)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/twins/{tid}")
def get_twin(tid: str):
    return _twin(tid)


@router.put("/twins/{tid}")
def update_twin(tid: str, body: dict = Body(...)):
    t = _twin(tid)
    for k in ("name", "geometry", "mesh", "material", "conditions", "physics"):
        if k in body:
            t[k] = body[k]
    try:
        return service.save(t)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/twins/{tid}")
def delete_twin(tid: str):
    _twin(tid)
    for s in db.list_children("studies", tid):
        db.delete_doc("studies", s["id"])
    db.delete_doc("twins", tid)
    return {"deleted": tid}


@router.post("/twins/{tid}/physics")
def add_physics(tid: str, body: dict = Body(...)):
    t = _twin(tid)
    try:
        t["physics"].append(service.new_physics(body["kind"]))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return service.save(t)


@router.post("/twins/preview-mesh")
def preview_mesh(body: dict = Body(...)):
    try:
        return service.mesh_preview(body)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


@router.get("/twins/{tid}/mesh")
def twin_mesh(tid: str):
    try:
        return service.mesh_preview(_twin(tid))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/twins/{tid}/inputs")
def twin_inputs(tid: str):
    return tprops.resolve_twin(_twin(tid))


@router.post("/twins/{tid}/studies")
def run_study(tid: str):
    _twin(tid)
    return service.start_study(tid)


@router.get("/twins/{tid}/studies")
def list_studies(tid: str):
    return service.studies_of(tid)


@router.get("/studies/{sid}")
def get_study(sid: str):
    s = db.get_doc("studies", sid)
    if not s:
        raise HTTPException(404, "study not found")
    return s


@router.delete("/studies/{sid}")
def delete_study(sid: str):
    if not db.delete_doc("studies", sid):
        raise HTTPException(404, "study not found")
    return {"deleted": sid}


@router.get("/jobs/{jid}")
def get_job(jid: str):
    j = jobs.get(jid)
    if not j:
        raise HTTPException(404, "job not found (jobs are kept in memory until the engine restarts)")
    return j


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: str):
    j = jobs.cancel(jid)
    if not j:
        raise HTTPException(404, "job not found")
    return j
