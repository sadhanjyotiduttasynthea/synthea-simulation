"""Synthea Simulation API (FastAPI)."""
from __future__ import annotations

import csv
import io
import os
import uuid

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import assistant, db, experiments, knowledge, optimize, printing, process, reports, routes_knowledge, routes_papers, routes_science, routes_workspace, seed
from .science import expression, nutrition, registry, thermal

app = FastAPI(title="Synthea Simulation API", version="2.0.0")
_TOKEN = os.environ.get("SYNTHEA_TOKEN")
# Browser dev server and the Tauri webview origins only.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(http://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost)$",
    allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def token_guard(request: Request, call_next):
    """In desktop mode the sidecar is started with SYNTHEA_TOKEN; every API call must present it."""
    if _TOKEN and request.url.path.startswith("/api") and request.method != "OPTIONS":
        supplied = request.headers.get("x-synthea-token") or request.query_params.get("token")
        if supplied != _TOKEN:
            return JSONResponse(status_code=401, content={"detail": "invalid or missing session token"})
    return await call_next(request)


app.include_router(routes_workspace.router)
app.include_router(routes_knowledge.router)
app.include_router(routes_papers.router)
app.include_router(routes_science.router)


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.on_event("startup")
def _startup():
    db.connect()
    seed.seed()
    knowledge.ensure_seeded()


def _ingredient_map() -> dict:
    return {i["id"]: i for i in db.list_docs("ingredients")}


def _require(collection, doc_id):
    d = db.get_doc(collection, doc_id)
    if d is None:
        raise HTTPException(404, f"{collection[:-1]} '{doc_id}' not found")
    return d


# ---------------------------------------------------------------- health
@app.get("/api/health")
def health():
    return {"status": "ok", "ingredients": db.count("ingredients"), "projects": db.count("projects")}


# ---------------------------------------------------------------- ingredients
@app.get("/api/ingredients")
def list_ingredients():
    return sorted(db.list_docs("ingredients"), key=lambda i: i["name"].lower())


@app.post("/api/ingredients")
def create_ingredient(doc: dict = Body(...)):
    if not doc.get("name"):
        raise ValueError("Ingredient name is required")
    doc.pop("updated_at", None)
    doc["id"] = doc.get("id") or (doc["name"].lower().replace(" ", "-")[:40] + "-" + uuid.uuid4().hex[:4])
    if db.get_doc("ingredients", doc["id"]):
        raise ValueError("Ingredient id already exists")
    doc.setdefault("version", 1)
    doc.setdefault("available", True)
    doc.setdefault("allergens", [])
    doc.setdefault("provenance", {})
    return db.put_doc("ingredients", doc)


@app.put("/api/ingredients/{iid}")
def update_ingredient(iid: str, doc: dict = Body(...)):
    old = _require("ingredients", iid)
    doc["id"] = iid
    doc["version"] = int(old.get("version", 1)) + 1
    return db.put_doc("ingredients", doc)


@app.delete("/api/ingredients/{iid}")
def delete_ingredient(iid: str):
    used = [f["name"] for f in db.list_docs("formulations") if any(l["ingredient_id"] == iid for l in f.get("lines", []))]
    if used:
        raise HTTPException(409, f"Ingredient is used in formulations: {', '.join(used[:5])}")
    if not db.delete_doc("ingredients", iid):
        raise HTTPException(404, "not found")
    return {"deleted": iid}


@app.post("/api/ingredients/import")
def import_ingredients(docs: list[dict] = Body(...)):
    out = []
    for d in docs:
        if not d.get("name"):
            raise ValueError("Every imported ingredient needs a name")
        d.pop("updated_at", None)
        d["id"] = d.get("id") or (d["name"].lower().replace(" ", "-")[:40] + "-" + uuid.uuid4().hex[:4])
        d.setdefault("allergens", [])
        d.setdefault("available", True)
        out.append(db.put_doc("ingredients", d))
    return {"imported": len(out)}


# ---------------------------------------------------------------- projects
@app.get("/api/projects")
def list_projects():
    return db.list_docs("projects")


@app.post("/api/projects")
def create_project(doc: dict = Body(...)):
    doc.pop("id", None)
    doc.setdefault("name", "Untitled project")
    doc.setdefault("settings", {"serving_size_g": 30.0, "currency": "EUR", "energy_price_eur_kwh": 0.20})
    doc.setdefault("optimizer", {"min_protein": None, "max_cost": None, "bounds": {}, "nutrient_limits": {}})
    return db.put_doc("projects", doc)


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _require("projects", pid)


@app.put("/api/projects/{pid}")
def update_project(pid: str, doc: dict = Body(...)):
    _require("projects", pid)
    doc["id"] = pid
    return db.put_doc("projects", doc)


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    _require("projects", pid)
    for c in ("formulations", "experiments", "process_flows", "geometries", "twins", "studies"):
        db.delete_where_project(c, pid)
    db.delete_doc("projects", pid)
    return {"deleted": pid}


@app.get("/api/projects/{pid}/export")
def export_project(pid: str):
    p = _require("projects", pid)
    bundle = {"format": "synthea-project/1", "project": p}
    for c in ("formulations", "experiments", "process_flows", "geometries", "twins", "studies"):
        bundle[c] = [d for d in db.list_docs(c) if d.get("project_id") == pid]
    used = {l["ingredient_id"] for f in bundle["formulations"] for l in f.get("lines", [])}
    bundle["ingredients"] = [i for i in db.list_docs("ingredients") if i["id"] in used]
    return bundle


@app.post("/api/projects/import")
def import_project(bundle: dict = Body(...)):
    if bundle.get("format") != "synthea-project/1":
        raise ValueError("Unsupported project file format")
    new_id = uuid.uuid4().hex[:12]
    proj = dict(bundle["project"])
    idmap = {}
    for ing in bundle.get("ingredients", []):
        if not db.get_doc("ingredients", ing["id"]):
            db.put_doc("ingredients", ing)
    proj["id"] = new_id
    proj["name"] = proj.get("name", "Imported") + " (imported)"
    for c in ("formulations", "experiments", "process_flows", "geometries", "twins", "studies"):
        for d in bundle.get(c, []):
            nd = dict(d)
            old = nd.get("id")
            nd["id"] = f"geo-{new_id}" if c == "geometries" else uuid.uuid4().hex[:12]
            idmap[old] = nd["id"]
            nd["project_id"] = new_id
            db.put_doc(c, nd)
    if proj.get("active_formulation_id") in idmap:
        proj["active_formulation_id"] = idmap[proj["active_formulation_id"]]
    # re-link references inside twins/studies/geometry to the new ids
    for c in ("twins", "studies", "geometries"):
        for d in db.list_docs(c):
            if d.get("project_id") != new_id:
                continue
            txt = __import__("json").dumps(d)
            for o, n in idmap.items():
                if o:
                    txt = txt.replace(f'"{o}"', f'"{n}"')
            db.put_doc(c, __import__("json").loads(txt))
    bundle_libs = {"library_refs": sorted({m for d in bundle.get("twins", []) for m in [x.get("material_id") for x in d.get("materials", [])] if m})}
    proj["imported_library_refs"] = bundle_libs["library_refs"]
    return db.put_doc("projects", proj)


@app.post("/api/projects/{pid}/duplicate")
def duplicate_project(pid: str):
    b = export_project(pid)
    p = import_project(b)
    p["name"] = b["project"]["name"] + " (copy)"
    return db.put_doc("projects", p)


@app.post("/api/admin/reset-demo")
def reset_demo():
    for c in ("formulations", "experiments", "process_flows"):
        db.delete_where_project(c, seed.PROJECT_ID)
    seed.seed(force=True)
    return {"reset": True}


# ---------------------------------------------------------------- formulations
@app.get("/api/formulations")
def list_formulations(project_id: str | None = None):
    docs = db.list_docs("formulations")
    return [d for d in docs if project_id is None or d.get("project_id") == project_id]


@app.post("/api/formulations")
def create_formulation(doc: dict = Body(...)):
    doc.pop("id", None)
    doc.pop("updated_at", None)
    if not doc.get("project_id"):
        raise ValueError("project_id required")
    doc.setdefault("name", "New formulation")
    doc.setdefault("lines", [])
    return db.put_doc("formulations", doc)


@app.put("/api/formulations/{fid}")
def update_formulation(fid: str, doc: dict = Body(...)):
    _require("formulations", fid)
    doc["id"] = fid
    return db.put_doc("formulations", doc)


@app.delete("/api/formulations/{fid}")
def delete_formulation(fid: str):
    if not db.delete_doc("formulations", fid):
        raise HTTPException(404, "not found")
    return {"deleted": fid}


def _evaluate_lines(lines: list[dict], serving: float, temperature: float = 25.0) -> dict:
    ing = _ingredient_map()
    fl = []
    unknown = []
    for l in lines:
        i = ing.get(l["ingredient_id"])
        if i is None:
            unknown.append(l["ingredient_id"])
            continue
        fl.append(nutrition.FormulationLine(i, float(l.get("percent") or 0.0)))
    res = nutrition.composition(fl, serving).to_dict()
    if unknown:
        res["warnings"].append("Unknown ingredients ignored: " + ", ".join(unknown))
    res["salt_equivalent_g_100g"] = nutrition.salt_equivalent(res["composition"]["sodium"])
    try:
        res["thermal"] = thermal.properties(res["composition"], temperature)
    except ValueError:
        res["thermal"] = None
    res["predictive_models"] = {
        "viscosity": "not available - mixture viscosity cannot be derived from ingredient data by weighted averaging; measure the flow curve or train a surrogate from experiments",
        "texture": "not available - requires experimental texture data",
    }
    res["provenance"] = sorted({v for l in fl for v in (l.ingredient.get("provenance") or {}).values()})
    return res


@app.post("/api/formulations/evaluate")
def evaluate_formulation(body: dict = Body(...)):
    return _evaluate_lines(body.get("lines", []), float(body.get("serving_size_g", 30.0)), float(body.get("temperature_c", 25.0)))


# ---------------------------------------------------------------- optimisation
@app.post("/api/optimize")
def run_optimize(req: dict = Body(...)):
    ings = list(_ingredient_map().values())
    if req.get("ingredient_ids"):
        order = {i: k for k, i in enumerate(req["ingredient_ids"])}
        ings.sort(key=lambda i: order.get(i["id"], 999))
    exps = [e for e in db.list_docs("experiments") if e.get("project_id") == req.get("project_id")] if req.get("project_id") else []
    return optimize.optimise(ings, req, exps)


# ---------------------------------------------------------------- experiments
@app.get("/api/experiments")
def list_experiments(project_id: str | None = None):
    return [d for d in db.list_docs("experiments") if project_id is None or d.get("project_id") == project_id]


@app.post("/api/experiments")
def create_experiment(doc: dict = Body(...)):
    doc.pop("id", None)
    doc.pop("updated_at", None)
    if not doc.get("project_id"):
        raise ValueError("project_id required")
    doc.setdefault("data_type", "measured")
    return db.put_doc("experiments", doc)


@app.put("/api/experiments/{eid}")
def update_experiment(eid: str, doc: dict = Body(...)):
    _require("experiments", eid)
    doc["id"] = eid
    return db.put_doc("experiments", doc)


@app.delete("/api/experiments/{eid}")
def delete_experiment(eid: str):
    if not db.delete_doc("experiments", eid):
        raise HTTPException(404, "not found")
    return {"deleted": eid}


PROC_COLS = ["temperature_c", "mixing_speed_rpm", "mixing_time_min"]
MEAS_COLS = ["viscosity_pa_s", "viscosity_shear_rate_1_s", "hardness_n", "extrusion_behaviour", "shape_retention_pct"]


@app.get("/api/experiments/export-csv")
def export_experiments_csv(project_id: str):
    exps = list_experiments(project_id)
    ing_ids = sorted({k for e in exps for k in (e.get("composition") or {})})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["name", "date", "data_type"] + [f"pct_{i}" for i in ing_ids] + PROC_COLS + MEAS_COLS + ["cost_eur", "notes"])
    for e in exps:
        c, p, m = e.get("composition") or {}, e.get("process") or {}, e.get("measurements") or {}
        w.writerow([e.get("name"), e.get("date"), e.get("data_type")] + [c.get(i, "") for i in ing_ids] + [p.get(k, "") for k in PROC_COLS] + [m.get(k, "") for k in MEAS_COLS] + [e.get("cost_eur", ""), e.get("notes", "")])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f"attachment; filename=experiments_{project_id}.csv"})


def _num(v):
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


@app.post("/api/experiments/import-csv")
def import_experiments_csv(body: dict = Body(...)):
    pid = body.get("project_id")
    if not pid:
        raise ValueError("project_id required")
    reader = csv.DictReader(io.StringIO(body.get("csv", "")))
    n = 0
    for row in reader:
        comp = {k[4:]: _num(v) for k, v in row.items() if k and k.startswith("pct_") and _num(v) is not None}
        doc = {
            "project_id": pid, "name": row.get("name") or f"Imported {n + 1}", "date": row.get("date") or None,
            "data_type": row.get("data_type") or "measured", "composition": comp,
            "process": {k: _num(row.get(k)) for k in PROC_COLS},
            "measurements": {k: (row.get(k) or None) if k == "extrusion_behaviour" else _num(row.get(k)) for k in MEAS_COLS},
            "cost_eur": _num(row.get("cost_eur")), "notes": row.get("notes") or "",
        }
        db.put_doc("experiments", doc)
        n += 1
    if n == 0:
        raise ValueError("No rows found in CSV")
    return {"imported": n}


def _opt_space(project_id: str, body: dict):
    proj = _require("projects", project_id)
    bounds = body.get("bounds") or (proj.get("optimizer") or {}).get("bounds") or {}
    ids = body.get("ingredient_ids") or list(bounds.keys())
    if not ids:
        raise ValueError("Define ingredient bounds (AI Optimizer) to set the experimental region.")
    return ids, bounds


@app.post("/api/experiments/synthetic")
def add_synthetic(body: dict = Body(...)):
    pid = body["project_id"]
    ids, bounds = _opt_space(pid, body)
    recs = experiments.synthetic_dataset(ids, bounds, int(body.get("n", 12)), int(body.get("seed", 42)))
    for r in recs:
        r["project_id"] = pid
        db.put_doc("experiments", r)
    return {"added": len(recs)}


@app.post("/api/experiments/recommend")
def recommend(body: dict = Body(...)):
    pid = body["project_id"]
    ids, bounds = _opt_space(pid, body)
    names = {k: v["name"] for k, v in _ingredient_map().items()}
    exps = list_experiments(pid)
    return experiments.recommend(ids, names, bounds, exps, body.get("response", "viscosity_pa_s"), int(body.get("k", 6)),
                                 body.get("strategy", "uncertainty"), body.get("target"), bool(body.get("maximise", True)))


@app.post("/api/experiments/cost-scenario")
def cost_scenario(body: dict = Body(...)):
    return experiments.cost_scenario(body)


# ---------------------------------------------------------------- process
@app.get("/api/process/units")
def process_units():
    return process.UNIT_LIBRARY


@app.get("/api/process-flows")
def list_flows(project_id: str):
    return [d for d in db.list_docs("process_flows") if d.get("project_id") == project_id]


@app.post("/api/process-flows")
def save_flow(doc: dict = Body(...)):
    if not doc.get("project_id"):
        raise ValueError("project_id required")
    doc.pop("updated_at", None)
    return db.put_doc("process_flows", doc)


@app.delete("/api/process-flows/{fid}")
def delete_flow(fid: str):
    db.delete_doc("process_flows", fid)
    return {"deleted": fid}


@app.post("/api/process/simulate")
def simulate(body: dict = Body(...)):
    ev = _evaluate_lines(body.get("lines", []), 30.0)
    if not body.get("lines"):
        raise ValueError("Select a formulation for the process simulation.")
    res = process.simulate(body["flow"], ev["composition"], ev["cost_per_kg"], float(body.get("energy_price_eur_kwh", 0.20)), body.get("rheology"))
    res["formulation_cost_per_kg"] = ev["cost_per_kg"]
    return res


# ---------------------------------------------------------------- printing
@app.get("/api/print/shapes")
def print_shapes():
    return printing.SHAPES


@app.post("/api/print/toolpath")
def toolpath(body: dict = Body(...)):
    if body.get("lines"):
        ev = _evaluate_lines(body["lines"], 30.0, float(body.get("extrusion_temperature_c", 25.0)))
        if ev.get("thermal"):
            body["density_kg_m3"] = ev["thermal"]["density_kg_m3"]
    return printing.generate(body)


# ---------------------------------------------------------------- models
@app.get("/api/models")
def models():
    return registry.list_models()


@app.post("/api/models/{mid}/compute")
def compute_model(mid: str, params: dict = Body(...)):
    try:
        return registry.compute(mid, params)
    except KeyError:
        raise HTTPException(404, "model not found")


@app.post("/api/expressions/evaluate")
def eval_expression(body: dict = Body(...)):
    try:
        expr = body.get("expression", "")
        vars_ = {k: float(v) for k, v in (body.get("variables") or {}).items()}
        needed = expression.variables_in(expr)
        missing = [v for v in needed if v not in vars_]
        if missing:
            return {"ok": False, "error": "Missing variables: " + ", ".join(missing), "variables": needed}
        return {"ok": True, "value": expression.evaluate(expr, vars_), "variables": needed}
    except expression.ExpressionError as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------- assistant
@app.get("/api/assistant/status")
def assistant_status():
    return assistant.status()


@app.post("/api/assistant")
def ask(body: dict = Body(...)):
    return assistant.ask(body.get("question", ""), body.get("page", ""), body.get("context") or {})


# ---------------------------------------------------------------- reports
@app.post("/api/reports/pdf")
def report_pdf(body: dict = Body(...)):
    pdf = reports.build_pdf(body)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": "attachment; filename=synthea_report.pdf"})


# ---------------------------------------------------------------- static frontend (production build)
_dist = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
if os.path.isdir(_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(_dist, "assets")), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = os.path.join(_dist, path)
        if path and os.path.isfile(f):
            return FileResponse(f)
        return FileResponse(os.path.join(_dist, "index.html"))
