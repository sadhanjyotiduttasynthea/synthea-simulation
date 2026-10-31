"""Synthea Print: geometry documents (sketches, primitives, STL), STL export and G-code export."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from . import db, geometry3d, printing

router = APIRouter(prefix="/api")
MAX_STL = 40 * 1024 * 1024


def _gid(project_id: str) -> str:
    return f"geo-{project_id}"


def _doc(project_id: str) -> dict:
    return db.get_doc("geometries", _gid(project_id)) or {"id": _gid(project_id), "project_id": project_id, "name": "Prototype geometry", "objects": []}


def _wrap(fn, *a):
    try:
        return fn(*a)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/geometry/kinds")
def kinds():
    return geometry3d.KINDS


@router.get("/geometry")
def get_geometry(project_id: str):
    return _doc(project_id)


@router.put("/geometry")
def put_geometry(body: dict = Body(...)):
    pid = body.get("project_id")
    if not pid:
        raise HTTPException(400, "project_id required")
    doc = {**_doc(pid), "objects": body.get("objects") or [], "name": body.get("name") or "Prototype geometry"}
    for o in doc["objects"]:
        o.setdefault("id", f"obj-{uuid.uuid4().hex[:8]}")
        o.setdefault("name", geometry3d.KINDS.get(o.get("kind"), {}).get("label", o.get("kind")))
    if doc["objects"]:
        _wrap(geometry3d.geometry_mesh, doc["objects"])  # validates every object
    return db.put_doc("geometries", doc)


@router.post("/geometry/info")
def geometry_info(body: dict = Body(...)):
    V, F = _wrap(geometry3d.geometry_mesh, body.get("objects") or [])
    return {**geometry3d.mesh_info(V, F), "overlap_warning": geometry3d.overlap_warning(body.get("objects") or [])}


@router.post("/geometry/import-stl")
async def import_stl(file: UploadFile = File(...), name: str = Form("")):
    data = await file.read()
    if len(data) > MAX_STL:
        raise HTTPException(413, "STL larger than 40 MB")
    V, F = _wrap(geometry3d.read_stl, data)
    return {"id": f"obj-{uuid.uuid4().hex[:8]}", "kind": "mesh", "name": name or (file.filename or "imported.stl"), "position": [0, 0, 0],
            "vertices": V.round(4).tolist(), "faces": F.tolist(), "source": {"type": "stl", "filename": file.filename}, "info": geometry3d.mesh_info(V, F)}


@router.post("/geometry/stl")
def export_stl(body: dict = Body(...)):
    V, F = _wrap(geometry3d.geometry_mesh, body.get("objects") or [])
    return Response(geometry3d.write_stl(V, F, body.get("name") or "synthea"), media_type="model/stl",
                    headers={"Content-Disposition": 'attachment; filename="synthea_geometry.stl"'})


@router.post("/print/gcode")
def export_gcode(body: dict = Body(...)):
    from .main import toolpath  # same density / rheology handling as the toolpath endpoint
    out = _wrap(toolpath, dict(body))
    text = _wrap(printing.gcode, out, body, body.get("title") or "Synthea print")
    return Response(text, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="synthea_print.gcode"'})


@router.post("/geometry/meshes")
def object_meshes(body: dict = Body(...)):
    """Triangle mesh of every object (what the slicer sees), for rendering."""
    out = []
    for o in body.get("objects") or []:
        V, F = _wrap(geometry3d.object_mesh, o)
        out.append({"id": o.get("id"), "vertices": V.round(4).tolist(), "faces": F.tolist()})
    return out
