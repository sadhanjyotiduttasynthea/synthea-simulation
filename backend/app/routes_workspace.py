"""Workspace-level endpoints: model-builder tree index and global definitions."""
from __future__ import annotations

from fastapi import APIRouter, Body

from . import db
from .science import expression

router = APIRouter(prefix="/api")

# CODATA 2018 values (SI). Exact constants of the 2019 SI redefinition are marked exact.
CONSTANTS = [
    {"name": "R", "value": 8.314462618, "unit": "J/(mol·K)", "description": "Molar gas constant", "source": "CODATA 2018 (exact: N_A·k_B)"},
    {"name": "k_B", "value": 1.380649e-23, "unit": "J/K", "description": "Boltzmann constant", "source": "SI 2019, exact"},
    {"name": "N_A", "value": 6.02214076e23, "unit": "1/mol", "description": "Avogadro constant", "source": "SI 2019, exact"},
    {"name": "h", "value": 6.62607015e-34, "unit": "J·s", "description": "Planck constant", "source": "SI 2019, exact"},
    {"name": "g_n", "value": 9.80665, "unit": "m/s²", "description": "Standard acceleration of gravity", "source": "CGPM 1901, exact"},
    {"name": "sigma_SB", "value": 5.670374419e-8, "unit": "W/(m²·K⁴)", "description": "Stefan–Boltzmann constant", "source": "CODATA 2018"},
    {"name": "F", "value": 96485.33212, "unit": "C/mol", "description": "Faraday constant", "source": "CODATA 2018 (exact: N_A·e)"},
    {"name": "T_0", "value": 273.15, "unit": "K", "description": "0 °C in kelvin", "source": "definition"},
]


@router.get("/definitions/constants")
def constants():
    return CONSTANTS


@router.post("/definitions/evaluate")
def evaluate_definitions(body: dict = Body(...)):
    """Evaluate project parameters in order; each may reference constants and earlier parameters."""
    env = {c["name"]: c["value"] for c in CONSTANTS}
    out = []
    for p in body.get("parameters", []):
        name = (p.get("name") or "").strip()
        res = {"name": name, "value": None, "error": None}
        try:
            if not name.isidentifier():
                raise expression.ExpressionError("Name must be a valid identifier (letters, digits, underscore)")
            missing = [v for v in expression.variables_in(p.get("expression", "")) if v not in env]
            if missing:
                raise expression.ExpressionError("Undefined: " + ", ".join(missing))
            val = expression.evaluate(p.get("expression", ""), env)
            env[name] = val
            res["value"] = val
        except expression.ExpressionError as e:
            res["error"] = str(e)
        out.append(res)
    return out


@router.get("/workspace/tree")
def tree(project_id: str):
    libs = [d for d in db.list_docs("libraries") if not d.get("archived")]
    mats = db.list_docs("materials")
    papers = db.list_docs("papers")
    exts = db.list_docs("extractions")
    models = db.list_docs("sci_models")
    geos = [g for g in db.list_docs("geometries") if g.get("project_id") == project_id]
    twins = [t for t in db.list_docs("twins") if t.get("project_id") == project_id]
    geo_objs = []
    for g in geos:
        for o in g.get("objects", []):
            geo_objs.append({"id": o["id"], "name": o.get("name", o["id"]), "kind": o.get("kind", "")})
    return {
        "libraries": [{"id": l["id"], "name": l["name"], "materials": sum(1 for m in mats if l["id"] in m.get("library_ids", []))} for l in libs],
        "papers": [{"id": p["id"], "title": (p.get("metadata") or {}).get("title") or p.get("name") or p["id"],
                    "pending": sum(1 for e in exts if e.get("parent_id") == p["id"] and e.get("status") == "pending")} for p in papers],
        "models": {"approved": sum(1 for m in models if m.get("status") in ("approved", "validated")), "total": len(models)},
        "geometry": geo_objs,
        "twins": [{"id": t["id"], "name": t.get("name", t["id"]), "physics": [p.get("kind") for p in t.get("physics", [])]} for t in twins],
    }
