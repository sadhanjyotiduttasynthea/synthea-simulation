"""Extraction review and scientific-model registry endpoints."""
from __future__ import annotations

import uuid

import numpy as np

from fastapi import APIRouter, Body, HTTPException

from . import db, extraction, knowledge, sci_registry
from .science import catalog, expression

router = APIRouter(prefix="/api")


def _ext(eid: str) -> dict:
    e = db.get_doc("extractions", eid)
    if not e:
        raise HTTPException(404, "extraction not found")
    return e


# ------------------------------------------------------------------ AI settings
@router.get("/settings/ai")
def get_ai():
    return extraction.ai_settings()


@router.put("/settings/ai")
def put_ai(body: dict = Body(...)):
    from datetime import datetime, timezone
    allow = bool(body.get("allow_external_ai"))
    if allow and not body.get("acknowledge_disclosure"):
        raise HTTPException(400, "The data-transfer disclosure must be acknowledged to enable external AI.")
    db.put_doc("settings", {"id": "ai_settings", "name": "ai_settings", "allow_external_ai": allow,
                            "acknowledged_at": datetime.now(timezone.utc).isoformat() if allow else None})
    return extraction.ai_settings()


# ------------------------------------------------------------------ extraction
@router.post("/extractions/run")
def run_extraction(body: dict = Body(...)):
    try:
        return extraction.run(body["paper_id"], body.get("method", "rule"))
    except KeyError:
        raise HTTPException(404, "paper not found")


@router.get("/papers/{pid}/extractions")
def list_extractions(pid: str):
    return db.list_children("extractions", pid)


@router.post("/extractions")
def manual_candidate(body: dict = Body(...)):
    """Manual extraction / data-entry fallback (e.g. scanned pages, complex notation)."""
    pid = body.get("paper_id")
    paper = db.get_doc("papers", pid)
    if not paper:
        raise HTTPException(404, "paper not found")
    c = {k: v for k, v in body.items() if k not in ("id", "status")}
    c.update({"id": f"ext-{uuid.uuid4().hex[:10]}", "parent_id": pid, "status": "pending", "extractor": "manual", "confidence": "manual"})
    c.setdefault("kind", "property")
    c["verification"] = extraction.verify(c, paper.get("pages", []))
    return db.put_doc("extractions", c)


@router.put("/extractions/{eid}")
def edit_extraction(eid: str, body: dict = Body(...)):
    e = _ext(eid)
    if e.get("status") == "approved":
        raise HTTPException(409, "Already approved; edit the library record or model instead.")
    paper = db.get_doc("papers", e["parent_id"]) or {}
    e.update({k: v for k, v in body.items() if k not in ("id", "parent_id", "status", "extractor")})
    e["edited"] = True
    e["verification"] = extraction.verify(e, paper.get("pages", []))
    if e.get("kind") == "property" and e.get("value") is not None:
        meta = catalog.property_meta(e["property"])
        e["label"] = meta["label"]
        e["normalized"] = catalog.normalize(float(e["value"]), e.get("unit"), meta["unit"]) if meta["unit"] else {"value": e["value"], "unit": "", "ok": True, "note": None}
    return db.put_doc("extractions", e)


def _material_for(body: dict, e: dict) -> str:
    if body.get("material_id"):
        knowledge.get_material(body["material_id"])
        return body["material_id"]
    nm = body.get("new_material")
    if nm and nm.get("name"):
        return knowledge.save_material({"name": nm["name"], "category": nm.get("category", "Other"), "library_ids": nm.get("library_ids", []),
                                        "synonyms": nm.get("synonyms", []), "tags": [], "version": 1}, note="created from paper review")["id"]
    if e.get("material_id"):
        return e["material_id"]
    raise ValueError("Select an existing material or create a new one before approving.")


def _source(e: dict, paper: dict, page=None, snippet=None, table_ref=None) -> dict:
    return {"paper_id": paper["id"], "page": page or e.get("page"), "snippet": snippet or e.get("snippet"), "table_ref": table_ref or e.get("table_ref"),
            "citation": (paper.get("metadata") or {}).get("citation"), "extraction_id": e["id"], "extractor": e.get("extractor")}


def _to_unit(value, unit, target):
    if value is None or not target or target == "Pa*s**n":
        return value
    r = catalog.normalize(float(value), unit, target)
    return r["value"] if r["ok"] else value


@router.post("/extractions/{eid}/approve")
def approve(eid: str, body: dict = Body(default={})):
    e = _ext(eid)
    if e.get("status") == "approved":
        raise HTTPException(409, "already approved")
    paper = db.get_doc("papers", e["parent_id"]) or {"id": e["parent_id"], "metadata": {}}
    status = body.get("review_status", "reviewed")
    if status not in ("reviewed", "approved"):
        raise HTTPException(400, "review_status must be reviewed or approved")
    try:
        mid = _material_for(body, e)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    created = []
    if e["kind"] == "property":
        rec = knowledge.save_property({
            "material_id": mid, "property": e["property"], "value": e.get("value"), "value_max": e.get("value_max"), "value_text": e.get("value_text"),
            "unit": e.get("unit"), "uncertainty": e.get("uncertainty") or {}, "n": e.get("n"), "conditions": e.get("conditions") or {},
            "composition": e.get("composition"), "method": e.get("method"), "evidence_type": e.get("evidence_type", "directly_reported"),
            "review_status": status, "source": _source(e, paper), "notes": (e.get("notes") or "") + (" | AI-extracted" if str(e.get("extractor", "")).startswith("claude") else ""),
        }, note=f"approved from paper review ({e.get('extractor')})")
        created.append({"type": "property", "id": rec["id"]})
    else:
        eq = e.get("equation") or {}
        tid = eq.get("template")
        sets = eq.get("parameter_sets") or []
        chosen = body.get("parameter_sets")
        if chosen is not None:
            sets = [sets[i] for i in chosen if 0 <= i < len(sets)]
        mat = knowledge.get_material(mid)
        base_kw = {"material_id": mid, "library_ids": mat.get("library_ids", []), "status": status if status != "approved" else "approved",
                   "limitations": eq.get("limitations") or [f"Validated only within the reported conditions of {(paper.get('metadata') or {}).get('citation', 'the source')}."]}
        if tid and tid in sci_registry.TEMPLATES and sets:
            for s in sets:
                m = sci_registry.from_template(tid, **base_kw)
                for p in m["parameters"]:
                    prop = next((q.get("property") for q in eq.get("parameters", []) if q["symbol"] == p["symbol"]), None)
                    if prop and prop in s["parameters"]:
                        v = s["parameters"][prop]
                        p["value"] = _to_unit(v["value"], v.get("unit"), p["unit"])
                cond_txt = ", ".join(f"{k} {v:g}" for k, v in s["conditions"].items())
                m["name"] = f"{m['name']} — {mat['name']} ({cond_txt})"
                m["conditions"] = s["conditions"]
                m["validity"] = {**(eq.get("validity") or {})}
                m["fit_quality"] = {"r2": s.get("r2")}
                m["source"] = _source(e, paper, page=s["page"], snippet=" | ".join(s.get("row", [])), table_ref=s["table_ref"])
                m["evidence_type"] = "fitted_parameter"
                created.append({"type": "model", "id": sci_registry.save(m, note="created from paper review")["id"]})
        else:
            if tid and tid in sci_registry.TEMPLATES:
                m = sci_registry.from_template(tid, **base_kw)
                for p in m["parameters"]:
                    src = next((q for q in eq.get("parameters", []) if q["symbol"] == p["symbol"]), None)
                    if src and src.get("value") is not None:
                        p["value"] = _to_unit(src["value"], src.get("value_unit"), p["unit"])
            else:
                if not body.get("expression") and not eq.get("expression"):
                    raise HTTPException(400, "Unrecognised equation: provide a machine-readable expression, variables and parameters before approval.")
                m = {"name": eq.get("name") or "Equation", "category": body.get("category", "other"), **base_kw}
            for k in ("name", "latex", "expression", "dependent", "variables", "parameters", "constants", "validity", "conditions", "provides"):
                if body.get(k) is not None:
                    m[k] = body[k]
                elif k in eq and eq[k] not in (None, "", [], {}) and k in ("latex", "validity"):
                    m[k] = eq[k] if k != "latex" or not m.get("latex") else m["latex"]
            m["conditions"] = m.get("conditions") or {}
            m["source"] = _source(e, paper)
            try:
                created.append({"type": "model", "id": sci_registry.save(m, note="created from paper review")["id"]})
            except ValueError as ex:
                raise HTTPException(400, str(ex))
    e["status"] = "approved"
    e["approved_as"] = created
    e["material_id"] = mid
    db.put_doc("extractions", e)
    return {"extraction": e, "created": created}


@router.post("/extractions/{eid}/reject")
def reject(eid: str, body: dict = Body(default={})):
    e = _ext(eid)
    e["status"] = "rejected"
    e["reject_reason"] = body.get("reason", "")
    return db.put_doc("extractions", e)


@router.post("/extractions/{eid}/reopen")
def reopen(eid: str):
    e = _ext(eid)
    if e.get("status") == "approved":
        raise HTTPException(409, "Approved candidates created library records; deprecate those records instead.")
    e["status"] = "pending"
    return db.put_doc("extractions", e)


# ------------------------------------------------------------------ model registry
@router.get("/sci-models/templates")
def templates():
    return sci_registry.TEMPLATES


@router.get("/sci-models")
def list_models(material_id: str | None = None, status: str | None = None):
    out = [m for m in db.list_docs("sci_models") if (not material_id or m.get("material_id") == material_id) and (not status or m.get("status") == status)]
    return sorted(out, key=lambda m: m.get("updated_at", ""), reverse=True)


@router.get("/sci-models/{mid}")
def get_model(mid: str):
    m = db.get_doc("sci_models", mid)
    if not m:
        raise HTTPException(404, "model not found")
    return m


@router.post("/sci-models")
def create_model(body: dict = Body(...)):
    body.pop("id", None)
    if body.get("template") and not body.get("expression"):
        body = sci_registry.from_template(body["template"], **{k: v for k, v in body.items() if k != "template"})
    return sci_registry.save(body, note="created manually")


@router.put("/sci-models/{mid}")
def update_model(mid: str, body: dict = Body(...)):
    if not db.get_doc("sci_models", mid):
        raise HTTPException(404, "model not found")
    body["id"] = mid
    return sci_registry.save(body, note=body.pop("_note", "edited"))


@router.post("/sci-models/{mid}/status")
def set_status(mid: str, body: dict = Body(...)):
    m = get_model(mid)
    m["status"] = body["status"]
    return sci_registry.save(m, note=f"status → {body['status']}" + (f": {body['comment']}" if body.get("comment") else ""))


@router.post("/sci-models/{mid}/evaluate")
def evaluate(mid: str, body: dict = Body(...)):
    m = get_model(mid)
    try:
        return sci_registry.evaluate(m, body.get("inputs", {}), bool(body.get("allow_extrapolation")), not body.get("preview", False))
    except (ValueError, expression.ExpressionError) as e:
        raise HTTPException(400, str(e))


@router.post("/sci-models/{mid}/curve")
def curve(mid: str, body: dict = Body(...)):
    m = get_model(mid)
    return {"points": sci_registry.evaluate_curve(m, body["variable"], float(body["lo"]), float(body["hi"]), int(body.get("n", 60)), body.get("fixed"), bool(body.get("log")))}


@router.post("/sci-models/{mid}/validate")
def validate(mid: str, body: dict = Body(...)):
    m = get_model(mid)
    res = sci_registry.validate(m, body["data"], body.get("label", "user dataset"))
    if body.get("attach", True):
        m["validation"] = (m.get("validation") or []) + [res]
        sci_registry.save(m, note=f"validation result attached ({res['dataset']}, RMSE {res['rmse']:.4g})")
    return res


@router.post("/sci-models/check")
def check(body: dict = Body(...)):
    return sci_registry.dimension_check(body)


@router.get("/science/resolve")
def resolve(material_id: str, quantity: str, temperature: float | None = None, concentration: float | None = None, include_unapproved: bool = False):
    conds = {k: v for k, v in (("temperature", temperature), ("concentration", concentration)) if v is not None}
    try:
        return sci_registry.resolve(material_id, quantity, conds, include_unapproved)
    except KeyError:
        raise HTTPException(404, "material not found")


# ------------------------------------------------------------------ molecules
from fastapi import File, UploadFile  # noqa: E402

from . import molecules  # noqa: E402


@router.get("/molecules")
def molecule_catalog():
    return molecules.catalog()


@router.get("/molecules/{key}")
def molecule(key: str):
    try:
        return molecules.builtin(key)
    except KeyError:
        raise HTTPException(404, "unknown molecule")


@router.post("/molecules/parse")
async def parse_molecule(file: UploadFile = File(...)):
    content = (await file.read()).decode("utf-8", errors="replace")
    return molecules.parse_file(content, file.filename or "structure.pdb")


@router.get("/molecular-scenes/{name}")
def scene(name: str, molecule: str = "glutamic_acid", temperature_c: float = 85.0, time_s: float = 300.0, material_id: str | None = None, order: float = 1.0):
    if name == "water":
        return molecules.scene_water()
    if name == "hydration":
        return molecules.scene_hydration(molecule)
    if name == "aggregation":
        return molecules.scene_aggregation(temperature_c, time_s, material_id)
    if name == "starch":
        return molecules.scene_starch(order)
    raise HTTPException(404, "unknown scene")


@router.post("/molecular-scenes/emulsion")
def emulsion(body: dict = Body(...)):
    return molecules.emulsion_physics(float(body["radius_um"]), float(body["gamma_mN_m"]), float(body["rho_d"]), float(body["rho_c"]), float(body["mu_c"]))


# ------------------------------------------------------------------ digital twins & studies
from . import twins as twin_svc  # noqa: E402


@router.get("/twins")
def list_twins(project_id: str):
    return [t for t in db.list_docs("twins") if t.get("project_id") == project_id]


@router.post("/twins")
def create_twin(body: dict = Body(...)):
    pid = body.get("project_id")
    if not pid:
        raise HTTPException(400, "project_id required")
    t = twin_svc.default_twin(pid, body.get("name") or "Digital twin")
    t.update({k: v for k, v in body.items() if k not in ("id",)})
    t["id"] = f"twin-{uuid.uuid4().hex[:8]}"
    return db.put_doc("twins", t)


@router.put("/twins/{tid}")
def update_twin(tid: str, body: dict = Body(...)):
    if not db.get_doc("twins", tid):
        raise HTTPException(404, "twin not found")
    body["id"] = tid
    return db.put_doc("twins", body)


@router.delete("/twins/{tid}")
def delete_twin(tid: str):
    for s in db.list_children("studies", tid):
        db.delete_doc("studies", s["id"])
    db.delete_doc("twins", tid)
    return {"deleted": tid}


@router.post("/twins/{tid}/mesh")
def twin_mesh(tid: str):
    t = db.get_doc("twins", tid)
    if not t:
        raise HTTPException(404, "twin not found")
    m, obj = twin_svc.build_mesh(t)
    q = m.quality()
    grid = {}
    if m.kind == "cartesian3d":
        grid = {"x_edges": (np.linspace(m.centers["x"][0] - (m.centers["x"][1] - m.centers["x"][0]) / 2, m.centers["x"][-1] + (m.centers["x"][1] - m.centers["x"][0]) / 2, m.shape[0] + 1)).tolist(),
                "z_edges": np.linspace(0, obj["dims"]["height"] * obj.get("scale", [1, 1, 1])[2], m.shape[2] + 1).tolist(),
                "y_edges": np.linspace(-obj["dims"]["depth"] / 2, obj["dims"]["depth"] / 2, m.shape[1] + 1).tolist()}
    elif m.kind == "axisym":
        grid = {"r_edges": np.linspace(0, obj["dims"]["radius"], m.shape[0] + 1).tolist(), "z_edges": np.linspace(0, obj["dims"]["height"], m.shape[1] + 1).tolist()}
    else:
        grid = {"r_edges": np.linspace(0, obj["dims"]["radius"], m.shape[0] + 1).tolist()}
    return {**q, "grid": grid, "object": {"id": obj["id"], "kind": obj["kind"], "name": obj["name"]}, "boundaries": list(m.bnd_cell.keys())}


@router.post("/twins/{tid}/run")
def run_twin(tid: str):
    t = db.get_doc("twins", tid)
    if not t:
        raise HTTPException(404, "twin not found")
    try:
        s = twin_svc.run_study(t)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    return db.put_doc("studies", s)


@router.get("/studies")
def list_studies(twin_id: str):
    return [{k: v for k, v in s.items() if k not in ("heat", "flow", "diffusion", "reaction")} for s in db.list_children("studies", twin_id)]


@router.get("/studies/{sid}")
def get_study(sid: str):
    s = db.get_doc("studies", sid)
    if not s:
        raise HTTPException(404, "study not found")
    return s


@router.delete("/studies/{sid}")
def delete_study(sid: str):
    db.delete_doc("studies", sid)
    return {"deleted": sid}


@router.post("/studies/{sid}/compare")
def compare_study(sid: str, body: dict = Body(...)):
    s = get_study(sid)
    try:
        v = twin_svc.compare(s, body.get("probe", "centre"), body["data"], body.get("label", "experimental dataset"), body.get("field", "heat"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    s.setdefault("validation", {})
    s["validation"] = {"metrics": v}
    db.put_doc("studies", s)
    return v


@router.get("/twins/{tid}/dependencies")
def dependencies(tid: str):
    """Provenance graph: papers → records/models → material/formulation → twin → studies → validation."""
    t = db.get_doc("twins", tid)
    if not t:
        raise HTTPException(404, "twin not found")
    studies = db.list_children("studies", tid)
    latest = studies[-1] if studies else None
    nodes, edges = [], []

    def node(i, label, kind, sub=""):
        if not any(n["id"] == i for n in nodes):
            nodes.append({"id": i, "label": label, "kind": kind, "sub": sub})

    node("twin", t["name"], "twin", ", ".join(p["kind"] for p in t.get("physics", []) if p.get("enabled")))
    g = db.get_doc("geometries", f"geo-{t['project_id']}") or {}
    obj = next((o for o in g.get("objects", []) if o["id"] == t.get("geometry_object_id")), None)
    if obj:
        node("geo", obj["name"], "geometry", obj["kind"])
        edges.append(("geo", "twin"))
    mat = t.get("material") or {}
    if mat.get("type") == "formulation":
        f = db.get_doc("formulations", mat["id"]) or {}
        node("mat", f.get("name", mat["id"]), "formulation", "composition → Choi & Okos")
        edges.append(("mat", "twin"))
    elif mat.get("type") == "material":
        m = db.get_doc("materials", mat["id"]) or {}
        node("mat", m.get("name", mat["id"]), "material", "library material")
        edges.append(("mat", "twin"))
    for p in (latest or {}).get("provenance", []):
        key = p.get("model_id") or p.get("record_id")
        if not key:
            node(f"src-{p['quantity']}", p.get("source", "model"), "model", p.get("type", ""))
            edges.append((f"src-{p['quantity']}", "mat"))
            continue
        node(key, p.get("model") or f"{p['quantity']} record", "model" if p.get("model_id") else "record", p.get("status") or p.get("type", ""))
        edges.append((key, "mat" if mat else "twin"))
        doc = db.get_doc("sci_models", key) or db.get_doc("properties", key) or {}
        pid = (doc.get("source") or {}).get("paper_id")
        if pid:
            paper = db.get_doc("papers", pid) or {}
            node(pid, (paper.get("metadata") or {}).get("title", pid), "paper", f"p. {(doc.get('source') or {}).get('page', '?')}")
            edges.append((pid, key))
    if latest:
        node("study", latest["name"], "study", latest.get("created", "")[:16])
        edges.append(("twin", "study"))
        node("results", "Results", "results", f"{len(latest.get('warnings', []))} warnings")
        edges.append(("study", "results"))
        if (latest.get("validation") or {}).get("metrics"):
            v = latest["validation"]["metrics"]
            node("val", f"Validation: {v['label']}", "validation", f"RMSE {v['rmse']:.3g}")
            edges.append(("results", "val"))
    return {"nodes": nodes, "edges": [{"source": a, "target": b} for a, b in dict.fromkeys(edges)]}
