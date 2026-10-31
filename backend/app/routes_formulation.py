"""Virtual formulation insights: sensory & technical profile and ingredient interaction panel."""
from __future__ import annotations

from fastapi import APIRouter, Body

from . import db, formulation_insights as fi

router = APIRouter(prefix="/api")


def _context(body: dict):
    lines = body.get("lines") or []
    formulation = db.get_doc("formulations", body["formulation_id"]) if body.get("formulation_id") else None
    if formulation and not lines:
        lines = formulation.get("lines", [])
    T = body.get("process_temperature_c")
    T_src = {"value": T, "unit": "°C", "source": "entered by the user", "provenance": "illustrative"} if T is not None else fi.process_temperature(body.get("project_id"))
    return lines, formulation, T_src


@router.post("/formulations/profile")
def profile(body: dict = Body(...)):
    lines, formulation, T_src = _context(body)
    out = fi.profile(lines, formulation, T_src["value"] if T_src else None)
    out["process_temperature"] = T_src
    return out


@router.post("/formulations/interactions")
def interactions(body: dict = Body(...)):
    lines, _f, T_src = _context(body)
    ph = body.get("ph")
    out = fi.interactions(lines, float(ph) if ph is not None else None, T_src["value"] if T_src else None)
    out["process_temperature"] = T_src
    return out
