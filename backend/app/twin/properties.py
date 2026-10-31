"""Material-property resolution for digital twins.

Every number a twin uses comes from the global scientific library, i.e. from records extracted
from the user's research papers (or computed from molecular structure) and reviewed by a person:

* ``auto``   -- best record *approved for calculation*, ranked by closeness of its experimental
  conditions (temperature, ...) to the twin's operating conditions; for rheology and kinetics
  an approved registry model is preferred.
* ``record`` -- a specific record chosen by the user (reviewed records are allowed but flagged).
* ``model``  -- a specific approved registry model, evaluated at the operating temperature.
* ``choi_okos`` -- thermal properties calculated from approved/reviewed proximate-composition
  records with the Choi & Okos (1986) correlations (labelled *calculated*).
* ``manual`` -- a user-typed value, flagged as not traceable to a paper.

Missing quantities are reported, never invented.
"""
from __future__ import annotations

from .. import db, knowledge, sci_registry
from ..science import catalog, thermal

USABLE_RECORDS = ("approved",)
SELECTABLE_RECORDS = ("approved", "reviewed")

# physics kind -> list of (quantity key, required?)
REQUIREMENTS = {
    "heat": [("thermal_conductivity", True), ("density", True), ("specific_heat", True)],
    "kinetics": [("kinetics", True)],
    "flow": [("rheology", True), ("density", False)],
    "structural": [("elastic_modulus", True), ("poissons_ratio", True), ("density", False), ("fracture_stress", False)],
    "diffusion": [("diffusion_coefficient", True)],
}
LABELS = {"rheology": "Flow law (τ₀, K, n)", "kinetics": "First-order kinetics (k_ref, Eₐ, T_ref)"}
THERMAL_CO = {"thermal_conductivity": "conductivity_w_mk", "density": "density_kg_m3", "specific_heat": "specific_heat_kj_kgk"}


def _label(q):
    return LABELS.get(q) or catalog.property_meta(q)["label"]


def _paper_ref(src: dict | None) -> dict | None:
    if not src:
        return None
    ref = {k: src.get(k) for k in ("paper_id", "page", "passage", "table_id", "citation") if src.get(k) is not None}
    if src.get("paper_id"):
        p = db.get_doc("papers", src["paper_id"])
        if p:
            ref["title"] = (p.get("metadata") or {}).get("title")
            ref["synthetic"] = bool(p.get("synthetic_test_document"))
    return ref or None


def _cond_dist(rec_cond: dict, cond: dict) -> float:
    return sci_registry._cond_distance(rec_cond or {}, cond)[0]


def candidates(material_id: str, prop: str, cond: dict) -> list[dict]:
    out = []
    for p in knowledge.properties_of(material_id):
        if p["property"] != prop or p.get("review_status") not in SELECTABLE_RECORDS:
            continue
        nv = p.get("normalized") or {}
        if not nv.get("ok") or nv.get("value") is None:
            continue
        out.append({"kind": "record", "id": p["id"], "value": nv["value"], "unit": nv.get("unit"), "status": p.get("review_status"),
                    "evidence_type": p.get("evidence_type"), "conditions": p.get("conditions") or {}, "condition_distance": _cond_dist(p.get("conditions"), cond),
                    "source": _paper_ref(p.get("source")), "uncertainty": p.get("uncertainty")})
    out.sort(key=lambda r: (r["status"] != "approved", r["condition_distance"]))
    return out


def _models(material_id: str, provides: str, cond: dict) -> list[dict]:
    out = []
    for m in db.list_docs("sci_models"):
        if m.get("material_id") != material_id or provides not in (m.get("provides") or []) or m.get("status") not in sci_registry.USABLE:
            continue
        out.append({"kind": "model", "id": m["id"], "name": m["name"], "template": m.get("template"), "status": m["status"], "conditions": m.get("conditions") or {},
                    "condition_distance": _cond_dist(m.get("conditions"), cond), "validity": m.get("validity"), "source": _paper_ref(m.get("source"))})
    out.sort(key=lambda r: r["condition_distance"])
    return out


def _from_record(rec: dict, q: str) -> dict:
    flags = [] if rec["status"] == "approved" else ["record is reviewed but not approved for calculation"]
    if rec.get("source") and rec["source"].get("synthetic"):
        flags.append("source is the SYNTHETIC test document")
    if rec.get("evidence_type") == "illustrative":
        flags.append("illustrative placeholder value")
    return {"quantity": q, "label": _label(q), "value": rec["value"], "unit": rec["unit"], "origin": "record", "record_id": rec["id"], "status": rec["status"],
            "evidence_type": rec.get("evidence_type"), "conditions": rec.get("conditions"), "source": rec.get("source"), "flags": flags}


def _composition(material_id: str) -> tuple[dict, list[dict]]:
    comp, used = {}, []
    for key in ("protein", "fat", "carbohydrate", "fibre", "ash", "moisture"):
        c = candidates(material_id, key, {})
        if c:
            comp[key] = c[0]["value"]
            used.append({"property": key, "record_id": c[0]["id"], "value": c[0]["value"], "status": c[0]["status"]})
    return comp, used


def resolve_quantity(material_id: str | None, q: str, cond: dict, choice: dict | None) -> dict:
    choice = choice or {"mode": "auto"}
    mode = choice.get("mode", "auto")
    T = float(cond.get("temperature", 25.0))
    base = {"quantity": q, "label": _label(q), "value": None, "origin": None, "flags": []}
    if mode == "manual":
        v = choice.get("value")
        if q == "rheology":
            return {**base, "origin": "manual", "value": {"tau0": float(choice.get("tau0", 0)), "K": float(choice["K"]), "n": float(choice.get("n", 1))},
                    "unit": "SI", "flags": ["manual entry — not traceable to a paper"]}
        if q == "kinetics":
            return {**base, "origin": "manual", "value": {"k_ref": float(choice["k_ref"]), "Ea": float(choice["Ea"]), "T_ref_c": float(choice["T_ref_c"])},
                    "unit": "SI", "flags": ["manual entry — not traceable to a paper"]}
        if v is None:
            return {**base, "message": "Manual value missing"}
        meta = catalog.property_meta(q)
        return {**base, "origin": "manual", "value": float(v), "unit": meta.get("unit"), "flags": ["manual entry — not traceable to a paper"]}
    if not material_id:
        return {**base, "message": "No material assigned to the domain"}

    if q == "rheology":
        models = _models(material_id, "rheology_hb", cond)
        if mode == "model" or (mode == "auto" and models):
            m = next((x for x in models if x["id"] == choice.get("model_id")), None) if mode == "model" else models[0]
            if m:
                law = sci_registry.hb_parameters(db.get_doc("sci_models", m["id"]))
                flags = []
                if m["condition_distance"] > 0.5:
                    flags.append(f"model conditions {m['conditions']} differ from operating temperature {T:g} °C")
                return {**base, "origin": "model", "model_id": m["id"], "name": m["name"], "status": m["status"], "source": m["source"], "conditions": m["conditions"],
                        "value": {"tau0": law["yield_stress_pa"], "K": law["consistency_index_pa_sn"], "n": law["flow_behaviour_index"]}, "unit": "SI", "flags": flags}
        # records: HB triple or Newtonian viscosity
        parts = {k: [c for c in candidates(material_id, k, cond) if c["status"] in USABLE_RECORDS] for k in ("yield_stress", "consistency_index", "flow_behaviour_index", "viscosity")}
        if parts["consistency_index"] and parts["flow_behaviour_index"]:
            K, n = parts["consistency_index"][0], parts["flow_behaviour_index"][0]
            t0 = parts["yield_stress"][0] if parts["yield_stress"] else None
            return {**base, "origin": "records", "value": {"tau0": t0["value"] if t0 else 0.0, "K": K["value"], "n": n["value"]}, "unit": "SI",
                    "record_ids": [r["id"] for r in (K, n, t0) if r], "source": K.get("source"), "conditions": K.get("conditions"),
                    "flags": [] if t0 else ["no approved yield-stress record: τ₀ = 0 (power law)"]}
        if parts["viscosity"]:
            v = parts["viscosity"][0]
            return {**base, "origin": "record", "record_id": v["id"], "value": {"tau0": 0.0, "K": v["value"], "n": 1.0}, "unit": "SI", "source": v.get("source"),
                    "conditions": v.get("conditions"), "flags": ["single apparent-viscosity record: treated as Newtonian at its measurement conditions"]}
        return {**base, "message": "No approved rheology model or records (τ₀, K, n or viscosity) for this material. Import a paper with flow-curve data, extract and approve it."}

    if q == "kinetics":
        models = _models(material_id, "kinetics_first_order", cond)
        if mode in ("model", "auto") and models:
            m = next((x for x in models if x["id"] == choice.get("model_id")), models[0])
            p = {x["symbol"]: x.get("value") for x in db.get_doc("sci_models", m["id"]).get("parameters", [])}
            return {**base, "origin": "model", "model_id": m["id"], "name": m["name"], "status": m["status"], "source": m["source"], "conditions": m["conditions"],
                    "value": {"k_ref": float(p["k_ref"]), "Ea": float(p["Ea"]), "T_ref_c": float(p["T_ref"]) - 273.15}, "unit": "SI", "flags": []}
        k = [c for c in candidates(material_id, "rate_constant", cond) if c["status"] in USABLE_RECORDS]
        ea = [c for c in candidates(material_id, "activation_energy", cond) if c["status"] in USABLE_RECORDS]
        if k and ea and (k[0]["conditions"] or {}).get("temperature") is not None:
            return {**base, "origin": "records", "value": {"k_ref": k[0]["value"], "Ea": ea[0]["value"], "T_ref_c": float(k[0]["conditions"]["temperature"])}, "unit": "SI",
                    "record_ids": [k[0]["id"], ea[0]["id"]], "source": k[0].get("source"), "flags": []}
        return {**base, "message": "No approved first-order kinetics model, or approved rate-constant (with temperature) and activation-energy records."}

    if mode == "formulation_choi_okos" and q in THERMAL_CO:
        from .. import db as _db
        from ..science import nutrition
        ings = {i["id"]: i for i in _db.list_docs("ingredients")}
        lines = [nutrition.FormulationLine(ings[l["ingredient_id"]], float(l["percent"])) for l in choice.get("lines") or [] if l["ingredient_id"] in ings and float(l["percent"]) > 0]
        if not lines:
            return {**base, "message": "No formulation lines for the Choi–Okos calculation"}
        comp = nutrition.composition(lines).composition
        r = thermal.properties(comp, T)
        v = r[THERMAL_CO[q]] * (1000.0 if q == "specific_heat" else 1.0)
        provs = sorted({(ings[l.ingredient["id"]].get("provenance") or {}).get("nutrition", "missing") for l in lines})
        return {**base, "origin": "calculated", "method": f"Choi & Okos (1986) at {T:.4g} °C from the formulation composition ({choice.get('formulation_name') or 'formulation'})",
                "value": v, "unit": catalog.property_meta(q).get("unit"), "inputs": {"composition": comp},
                "flags": [f"composition from ingredient-table values ({', '.join(provs)})"] + r.get("warnings", [])}
    if mode == "choi_okos" and q in THERMAL_CO:
        comp, used = _composition(material_id)
        if not comp:
            return {**base, "message": "No composition records for a Choi–Okos calculation"}
        r = thermal.properties(comp, T)
        v = r[THERMAL_CO[q]] * (1000.0 if q == "specific_heat" else 1.0)
        return {**base, "origin": "calculated", "method": "Choi & Okos (1986) at %.4g °C from composition records" % T, "value": v,
                "unit": catalog.property_meta(q).get("unit"), "inputs": used, "flags": ["calculated from composition (not measured)"] + r.get("warnings", [])}

    cands = candidates(material_id, q, cond)
    if mode == "record":
        rec = next((c for c in cands if c["id"] == choice.get("record_id")), None)
        if rec:
            return _from_record(rec, q)
        return {**base, "message": "Selected record is no longer available (rejected, deprecated or deleted)"}
    approved = [c for c in cands if c["status"] in USABLE_RECORDS]
    if approved:
        return _from_record(approved[0], q)
    msg = f"No record of '{_label(q)}' approved for calculation."
    if cands:
        msg += f" {len(cands)} reviewed record(s) exist — approve one or select it explicitly."
    elif q in THERMAL_CO:
        msg += " Choose 'Calculated (Choi–Okos)' to estimate it from composition records."
    return {**base, "message": msg}


def requirements(twin: dict) -> list[tuple[str, bool]]:
    """Quantities needed by the enabled physics (quantity, required?) in first-use order."""
    req: dict[str, bool] = {}
    for ph in twin.get("physics", []):
        if not ph.get("enabled", True):
            continue
        st = ph.get("settings") or {}
        kinds = [ph["kind"]] + (["kinetics"] if ph["kind"] == "heat" and (st.get("kinetics") or {}).get("enabled") else [])
        for k in kinds:
            for q, required in REQUIREMENTS.get(k, []):
                if q == "density" and k == "structural":
                    required = bool(st.get("gravity", True))
                req[q] = req.get(q, False) or required
    return list(req.items())


def resolve_twin(twin: dict) -> dict:
    mat = twin.get("material") or {}
    mid = mat.get("material_id")
    cond = {"temperature": float((twin.get("conditions") or {}).get("temperature_c", 25.0))}
    out = {}
    for q, required in requirements(twin):
        r = resolve_quantity(mid, q, cond, (mat.get("sources") or {}).get(q))
        r["required"] = required
        if q not in ("rheology", "kinetics") and mid:
            r["candidates"] = candidates(mid, q, cond)
        if q in ("rheology", "kinetics") and mid:
            r["models"] = _models(mid, "rheology_hb" if q == "rheology" else "kinetics_first_order", cond)
        out[q] = r
    missing = [r["label"] for r in out.values() if r["required"] and r["value"] is None]
    return {"material_id": mid, "conditions": cond, "quantities": out, "missing": missing, "ready": not missing}
