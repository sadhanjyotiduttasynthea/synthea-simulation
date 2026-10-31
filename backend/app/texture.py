"""Texture Class IDs TX-01 ... TX-05 from texture profile analysis (TPA).

The classes are a CONVENTION of this platform (see SCIENTIFIC_MODELS.md): contiguous hardness bands for a stated TPA
protocol, plus typical ranges of the secondary TPA parameters. The default ranges are ILLUSTRATIVE and must be
calibrated with reference products (e.g. measuring commercial meat and plant-based sausages with the same protocol);
they are stored in the settings and can be edited.

A class is assigned only from
  (a) measured TPA data of the same formulation (project experiments, data type "measured"),
  (b) approved library records of the product material linked to the formulation, or
  (c) the Gaussian-process surrogate trained on recorded experiments, with its 95 % band and LOO Q².
When the uncertainty band spans several classes the result is a range ("TX-03 to TX-04"); with no data it is
"unclassified — needs texture data". Ingredient-level texture data are never averaged into a product class.
"""
from __future__ import annotations

import math

import numpy as np

from . import db, knowledge

PROTOCOL = ("TPA double compression to 50 % strain, cylindrical sample Ø 20 mm × 20 mm cut from the cooked product, "
            "crosshead 1 mm/s, 5 s between cycles, 20 °C")
DEFAULT_CLASSES = [
    {"id": "TX-01", "name": "soft paste", "hardness_n": [0.0, 5.0], "typical": {"springiness": [0.0, 0.5], "cohesiveness": [0.0, 0.4]}},
    {"id": "TX-02", "name": "soft gel", "hardness_n": [5.0, 15.0], "typical": {"springiness": [0.4, 0.8], "cohesiveness": [0.3, 0.6]}},
    {"id": "TX-03", "name": "tender, sliceable", "hardness_n": [15.0, 30.0], "typical": {"springiness": [0.6, 0.9], "cohesiveness": [0.4, 0.7]}},
    {"id": "TX-04", "name": "firm, sausage-like", "hardness_n": [30.0, 50.0], "typical": {"springiness": [0.7, 0.95], "cohesiveness": [0.45, 0.8], "resilience": [0.2, 0.5]}},
    {"id": "TX-05", "name": "firm, fibrous, meat-like", "hardness_n": [50.0, None], "typical": {"springiness": [0.8, 1.0], "cohesiveness": [0.5, 0.85], "resilience": [0.25, 0.6]}},
]
TPA_KEYS = {"hardness_n": "hardness", "springiness": "springiness", "cohesiveness": "cohesiveness", "chewiness_n": "chewiness", "gumminess_n": "gumminess", "resilience": "resilience"}


def scheme() -> dict:
    s = db.get_doc("settings", "texture_classes")
    if s and s.get("classes"):
        return s
    return {"id": "texture_classes", "name": "texture_classes", "classes": DEFAULT_CLASSES, "protocol": PROTOCOL, "provenance": "illustrative",
            "note": "Platform convention v1 with ILLUSTRATIVE ranges; calibrate with reference products measured by the same protocol."}


def save_scheme(doc: dict) -> dict:
    cls = doc.get("classes") or []
    if len(cls) < 2:
        raise ValueError("At least two classes are required")
    for a, b in zip(cls, cls[1:]):
        if a["hardness_n"][1] is None or abs(a["hardness_n"][1] - b["hardness_n"][0]) > 1e-9:
            raise ValueError("Hardness bands must be contiguous and in increasing order")
    return db.put_doc("settings", {**scheme(), **doc, "id": "texture_classes", "name": "texture_classes"})


def classes_for_interval(lo: float, hi: float, classes: list[dict]) -> list[str]:
    out = []
    for c in classes:
        a, b = c["hardness_n"]
        b = math.inf if b is None else b
        if hi >= a and lo < b:
            out.append(c["id"])
    return out


def label_for(ids: list[str]) -> str:
    if not ids:
        return "outside the defined classes"
    return ids[0] if len(ids) == 1 else f"{ids[0]} to {ids[-1]}"


def _secondary(values: dict, cls_id: str | None, classes: list[dict]) -> list[dict]:
    if not cls_id:
        return []
    c = next(x for x in classes if x["id"] == cls_id)
    out = []
    for k, (lo, hi) in c.get("typical", {}).items():
        v = values.get(k)
        if v is None:
            out.append({"parameter": k, "value": None, "typical": [lo, hi], "status": "not measured"})
        else:
            out.append({"parameter": k, "value": v, "typical": [lo, hi], "status": "typical" if lo <= v <= hi else "atypical for this class"})
    return out


def _matches(exp_comp: dict, lines: dict, tol: float = 0.5) -> bool:
    keys = set(exp_comp) | set(lines)
    return all(abs(float(exp_comp.get(k, 0.0)) - float(lines.get(k, 0.0))) <= tol for k in keys)


def classify(project_id: str | None, lines: list[dict], product_material_id: str | None = None) -> dict:
    sch = scheme()
    classes = sch["classes"]
    comp = {l["ingredient_id"]: float(l["percent"]) for l in lines if float(l.get("percent") or 0) > 0}
    base = {"scheme": {"protocol": sch.get("protocol", PROTOCOL), "provenance": sch.get("provenance", "illustrative"), "note": sch.get("note")}}
    exps = [e for e in db.list_docs("experiments", project_id) if (not project_id or e.get("project_id") == project_id)]

    # (a) measured TPA of the same formulation
    meas = [e for e in exps if e.get("data_type", "measured") == "measured" and (e.get("measurements") or {}).get("hardness_n") is not None and _matches(e.get("composition") or {}, comp)]
    if meas:
        h = np.array([float(e["measurements"]["hardness_n"]) for e in meas])
        mean = float(h.mean())
        sd = float(h.std(ddof=1)) if len(h) > 1 else None
        lo, hi = (mean - 2 * sd, mean + 2 * sd) if sd else (mean, mean)
        ids = classes_for_interval(lo, hi, classes)
        vals = {TPA_KEYS[k]: float(np.mean([e["measurements"][k] for e in meas if e["measurements"].get(k) is not None]))
                for k in TPA_KEYS if any(e["measurements"].get(k) is not None for e in meas)}
        return {**base, "class": ids[0] if len(ids) == 1 else None, "classes": ids, "label": label_for(ids), "source": "measured", "provenance": "measured",
                "hardness_n": mean, "hardness_sd_n": sd, "interval_n": [lo, hi], "n": len(meas), "basis": [{"kind": "experiment", "id": e["id"], "name": e.get("name")} for e in meas],
                "secondary": _secondary(vals, ids[0] if len(ids) == 1 else None, classes),
                "note": "Mean of replicate measurements of this formulation; band = mean ± 2 SD." if sd else "Single measurement (no replicate SD)."}

    # (b) approved library records of the product material
    if product_material_id:
        recs = {p["property"]: p for p in knowledge.properties_of(product_material_id) if p.get("review_status") == "approved" and p["property"] in TPA_KEYS.values()}
        if "hardness" in recs and (recs["hardness"].get("normalized") or {}).get("ok"):
            r = recs["hardness"]
            v = r["normalized"]["value"]
            u = (r.get("uncertainty") or {}).get("value")
            lo, hi = (v - 2 * u, v + 2 * u) if u else (v, v)
            ids = classes_for_interval(lo, hi, classes)
            vals = {k: (p.get("normalized") or {}).get("value") for k, p in recs.items()}
            src = r.get("source") or {}
            return {**base, "class": ids[0] if len(ids) == 1 else None, "classes": ids, "label": label_for(ids), "source": "library record", "provenance": "literature",
                    "hardness_n": v, "hardness_sd_n": u, "interval_n": [lo, hi],
                    "basis": [{"kind": "record", "record_id": p["id"], "property": k, "paper_id": (p.get("source") or {}).get("paper_id"), "page": (p.get("source") or {}).get("page")} for k, p in recs.items()],
                    "secondary": _secondary(vals, ids[0] if len(ids) == 1 else None, classes),
                    "note": f"Approved TPA records of the product material (source page {src.get('page')})." + ("" if u else " No uncertainty reported.")}

    # (c) GP surrogate trained on recorded experiments
    from .surrogate import Surrogate
    ids_ = sorted({k for e in exps for k in (e.get("composition") or {})} | set(comp))
    trainable = [e for e in exps if (e.get("measurements") or {}).get("hardness_n") is not None]
    if len(trainable) >= 6:
        try:
            s = Surrogate(ids_, "hardness_n").fit(trainable)
            x = [comp.get(i, 0.0) for i in ids_]
            m, sd = s.predict_transformed([x])
            m, sd = float(m[0]), float(sd[0])
            lo, hi = (math.exp(m - 1.96 * sd), math.exp(m + 1.96 * sd)) if s.log else (m - 1.96 * sd, m + 1.96 * sd)
            med = math.exp(m) if s.log else m
            loo = s.loo_cv()
            nov = float(s.novelty([x])[0])
            ids = classes_for_interval(lo, hi, classes)
            types = s.data_types
            warn = []
            if loo["q2"] < 0.5:
                warn.append(f"Low predictive ability (LOO Q² = {loo['q2']:.2f}).")
            if nov > 2.0:
                warn.append("The formulation lies outside the training data (extrapolation).")
            if any(t != "measured" for t in types):
                warn.append("Training data include " + ", ".join(t for t in types if t != "measured").upper() + " records — not physical measurements.")
            return {**base, "class": ids[0] if len(ids) == 1 else None, "classes": ids, "label": label_for(ids), "source": "GP surrogate", "provenance": "predicted",
                    "hardness_n": med, "interval_n": [lo, hi], "band": "95 %", "loo_q2": loo["q2"], "n_training": loo["n"], "novelty": nov, "training_data_types": types,
                    "basis": [{"kind": "surrogate", "response": "hardness_n", "n": loo["n"], "q2": loo["q2"]}], "warnings": warn, "secondary": [],
                    "note": "Gaussian-process prediction of TPA hardness with 95 % band; the class range covers every class the band touches."}
        except ValueError:
            pass
    return {**base, "class": None, "classes": [], "label": "unclassified — needs texture data", "source": None, "provenance": "missing", "basis": [],
            "needs": ["TPA of the cooked formulation (measured, " + PROTOCOL + ")", "or approved TPA records of the product material",
                      f"or ≥ 6 experiments with hardness to train the surrogate (have {len(trainable)})"]}
