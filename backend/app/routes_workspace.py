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


@router.get("/workspace/summary")
def summary(project_id: str):
    props = db.list_docs("properties")
    models = db.list_docs("sci_models")
    exts = db.list_docs("extractions")
    twins = [t for t in db.list_docs("twins") if t.get("project_id") == project_id]
    studies = [s for s in db.list_docs("studies") if s.get("project_id") == project_id]
    geos = [g for g in db.list_docs("geometries") if g.get("project_id") == project_id]
    exps = [e for e in db.list_docs("experiments") if e.get("project_id") == project_id]
    count = lambda xs, key, val: sum(1 for x in xs if x.get(key) == val)  # noqa: E731
    recent = []
    for coll, label in (("papers", "paper"), ("sci_models", "model"), ("materials", "material"), ("twins", "digital twin"), ("studies", "study"), ("libraries", "library")):
        for d in db.list_docs(coll):
            if coll in ("twins", "studies") and d.get("project_id") != project_id:
                continue
            title = (d.get("metadata") or {}).get("title") or d.get("name") or d["id"]
            recent.append({"kind": label, "id": d["id"], "title": title, "updated_at": d.get("updated_at", "")})
    recent.sort(key=lambda r: r["updated_at"], reverse=True)
    return {
        "libraries": sum(1 for l in db.list_docs("libraries") if not l.get("archived")),
        "materials": db.count("materials"),
        "properties": {"total": len(props), "approved": count(props, "review_status", "approved"), "reviewed": count(props, "review_status", "reviewed"),
                       "extracted": count(props, "review_status", "extracted")},
        "papers": db.count("papers"),
        "extractions_pending": count(exts, "status", "pending"),
        "models": {"total": len(models), "approved": sum(1 for m in models if m.get("status") in ("approved", "validated")),
                   "validated": count(models, "status", "validated"), "extracted": count(models, "status", "extracted")},
        "geometry_objects": sum(len(g.get("objects", [])) for g in geos),
        "twins": len(twins),
        "studies": len(studies),
        "studies_with_validation": sum(1 for s in studies if (s.get("validation") or {}).get("metrics")),
        "experiments": len(exps),
        "recent": recent[:12],
    }


# ------------------------------------------------------------------ geometry (one geometry document per project)
DEMO_OBJECTS = [
    {"id": "obj-bar", "name": "Snack bar", "kind": "cuboid", "dims": {"width": 60.0, "depth": 20.0, "height": 12.0},
     "position": [0.0, 0.0, 6.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "visible": True,
     "material": {"type": "formulation", "id": "baseline-pea-snack"}, "color": "#c9a46c"},
    {"id": "obj-die", "name": "Extrusion die channel", "kind": "cylinder", "dims": {"radius": 2.0, "height": 20.0},
     "position": [60.0, 0.0, 10.0], "rotation": [0.0, 90.0, 0.0], "scale": [1.0, 1.0, 1.0], "visible": True,
     "material": {"type": "material", "id": "mat-pea-protein-isolate"}, "color": "#e11d48"},
]


def _geometry_for(project_id: str) -> dict:
    gid = f"geo-{project_id}"
    g = db.get_doc("geometries", gid)
    if not g:
        objs = DEMO_OBJECTS if project_id == "demo-pea-snack" else []
        g = db.put_doc("geometries", {"id": gid, "project_id": project_id, "name": "Geometry 1", "units": "mm", "objects": [dict(o) for o in objs]})
    return g


@router.get("/geometries")
def get_geometry(project_id: str):
    return _geometry_for(project_id)


@router.put("/geometries/{gid}")
def put_geometry(gid: str, body: dict = Body(...)):
    g = db.get_doc("geometries", gid)
    if not g:
        raise ValueError("geometry not found")
    objs = body.get("objects", [])
    size = sum(len(o.get("stl_base64") or "") for o in objs)
    if size > 30_000_000:
        raise ValueError("Imported meshes exceed 30 MB; simplify the STL before import.")
    ids = [o.get("id") for o in objs]
    if len(ids) != len(set(ids)) or any(not i for i in ids):
        raise ValueError("Every geometry object needs a unique id")
    g["objects"] = objs
    g["name"] = body.get("name", g.get("name"))
    return db.put_doc("geometries", g)
