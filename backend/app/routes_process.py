"""Synthea Process: texture classes, Digital Twin studies opened from heating units, saved runs and the optimized product."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Body, HTTPException

from . import db, process, sci_registry, texture
from .twin import service as twin_service

router = APIRouter(prefix="/api")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _lines(body: dict) -> list[dict]:
    if body.get("lines"):
        return body["lines"]
    f = db.get_doc("formulations", body.get("formulation_id") or "")
    if not f:
        raise HTTPException(400, "Provide lines or a formulation_id")
    return f["lines"]


# ------------------------------------------------------------------ texture classes
@router.get("/texture/classes")
def get_classes():
    return texture.scheme()


@router.put("/texture/classes")
def put_classes(body: dict = Body(...)):
    try:
        return texture.save_scheme(body)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/process/texture")
def classify(body: dict = Body(...)):
    f = db.get_doc("formulations", body.get("formulation_id") or "") or {}
    return texture.classify(body.get("project_id"), _lines(body), body.get("product_material_id") or f.get("product_material_id"))


# ------------------------------------------------------------------ digital twin from a heating unit
@router.post("/process/twin")
def twin_for_unit(body: dict = Body(...)):
    flow = db.get_doc("process_flows", body.get("flow_id") or "")
    if not flow:
        raise HTTPException(404, "Save the process flow first")
    node = next((n for n in flow.get("nodes", []) if n["id"] == body.get("node_id")), None)
    if not node:
        raise HTTPException(404, "unit not found in the flow")
    kind = node["data"]["kind"]
    if kind not in process.HEATING_KINDS:
        raise HTTPException(400, "Digital Twin studies can be opened from heating units (heater, cooker, extruders)")
    p = {**process.UNIT_LIBRARY[kind]["params"], **(node["data"].get("params") or {})}
    lines = _lines(body)
    f = db.get_doc("formulations", body.get("formulation_id") or "") or {}
    ings = {i["id"]: i for i in db.list_docs("ingredients")}
    proteins = sorted([l for l in lines if (ings.get(l["ingredient_id"]) or {}).get("category") == "Protein"], key=lambda l: -float(l["percent"]))
    mat = f"mat-{proteins[0]['ingredient_id']}" if proteins else None
    T_medium = float(p.get("product_temperature_c") or p.get("outlet_temperature_c") or p.get("barrel_temperature_c") or 75.0)
    T_target = float(p.get("core_target_c") or T_medium)  # core criterion (illustrative unless set from a specification)
    T_in = float(body.get("inlet_temperature_c") if body.get("inlet_temperature_c") is not None else 20.0)
    hold = float(p.get("hold_time_min") or 30.0) * 60
    has_kin = bool(mat) and any(m.get("material_id") == mat and "kinetics_first_order" in (m.get("provides") or []) and m.get("status") in sci_registry.USABLE
                                for m in db.list_docs("sci_models"))
    t = twin_service.new_twin(flow.get("project_id"), f"{node['data'].get('label', kind)} — product cross-section", ["heat"], mat)
    t["geometry"] = {"shape": "circle", "params": {"diameter": float(p.get("caliber_mm") or 24.0)}, "depth": 100.0}
    t["conditions"] = {"temperature_c": T_in}
    srcs = {q: {"mode": "formulation_choi_okos", "lines": lines, "formulation_name": f.get("name")} for q in ("thermal_conductivity", "density", "specific_heat")}
    t["material"]["sources"] = srcs
    h = t["physics"][0]
    h["settings"].update({"initial_c": T_in, "t_end_s": hold, "target_c": T_target, "kinetics": {"enabled": has_kin}})
    h["bcs"] = {"default": {"type": "convection", "h": float(body.get("h_w_m2k") or 300.0), "ambient": T_medium}}
    t["origin"] = {"flow_id": flow["id"], "node_id": node["id"], "formulation_id": f.get("id"),
                   "note": "Boundary heat-transfer coefficient is an ILLUSTRATIVE default (water bath); replace it with a measured or literature value."}
    t = twin_service.save(t)
    node["data"]["twin_id"] = t["id"]
    db.put_doc("process_flows", flow)
    return {"twin": t, "kinetics_enabled": has_kin}


# ------------------------------------------------------------------ runs and optimized product
@router.post("/process/runs")
def save_run(body: dict = Body(...)):
    if not body.get("project_id") or not body.get("summary"):
        raise HTTPException(400, "project_id and summary are required")
    keep = {k: body.get(k) for k in ("project_id", "flow_id", "flow_name", "formulation_id", "formulation_name", "summary", "texture", "twins", "name", "notes")}
    doc = {**keep, "id": f"run-{uuid.uuid4().hex[:10]}", "created": _now(), "name": body.get("name") or f"Run {datetime.now().strftime('%Y-%m-%d %H:%M')}"}
    return db.put_doc("process_runs", doc)


@router.get("/process/runs")
def list_runs(project_id: str):
    return sorted([r for r in db.list_docs("process_runs") if r.get("project_id") == project_id], key=lambda r: r["created"], reverse=True)


@router.delete("/process/runs/{rid}")
def delete_run(rid: str):
    if not db.delete_doc("process_runs", rid):
        raise HTTPException(404, "run not found")
    return {"deleted": rid}


@router.post("/process/runs/{rid}/optimized")
def mark_optimized(rid: str):
    r = db.get_doc("process_runs", rid)
    if not r:
        raise HTTPException(404, "run not found")
    p = db.get_doc("projects", r["project_id"])
    if not p:
        raise HTTPException(404, "project not found")
    p["optimized_product"] = {"run_id": r["id"], "run_name": r.get("name"), "formulation_id": r.get("formulation_id"), "formulation_name": r.get("formulation_name"),
                              "texture": r.get("texture"), "technical": (r.get("summary") or {}).get("technical"), "marked_at": _now()}
    db.put_doc("projects", p)
    return p["optimized_product"]
