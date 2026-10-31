"""Global scientific knowledge base: libraries, materials and condition-aware property records.

* Libraries are global (shared across projects). A material record is stored once and can be
  placed in several libraries (``library_ids``) -- no duplication.
* A property record is one reported value (or range / text) for one material under explicit
  experimental conditions, linked to its source (paper + page + passage) and with evidence
  type, uncertainty, quality indicators and review status. Records for the same property
  coexist; disagreements are reported as conflicts, never averaged.
"""
from __future__ import annotations

import copy
import math
import uuid
from datetime import datetime, timezone

from . import db
from .science import catalog

EVIDENCE_WEIGHT = {"directly_reported": 30, "fitted_parameter": 26, "calculated_from_reported": 22, "author_prediction": 14,
                   "manual_entry": 12, "ai_inferred": 6, "illustrative": 0}
REVIEW_WEIGHT = {"approved": 25, "reviewed": 15, "extracted": 0, "rejected": -50, "deprecated": -20}
COND_TOL = {"temperature": ("abs", 5.0), "concentration": ("abs", 2.0), "water_content": ("abs", 3.0), "ph": ("abs", 0.5),
            "shear_rate": ("log", math.log(2.0)), "frequency": ("log", math.log(2.0)), "salt_concentration": ("abs", 0.5)}
CONFLICT_REL = 0.25


def _now():
    return datetime.now(timezone.utc).isoformat()


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


# ------------------------------------------------------------------ libraries
def list_libraries(include_archived=False):
    libs = db.list_docs("libraries")
    mats = db.list_docs("materials")
    out = []
    for l in libs:
        if l.get("archived") and not include_archived:
            continue
        l = dict(l)
        l["material_count"] = sum(1 for m in mats if l["id"] in m.get("library_ids", []) and not m.get("archived"))
        out.append(l)
    return sorted(out, key=lambda l: l["name"].lower())


def save_library(doc: dict) -> dict:
    if not (doc.get("name") or "").strip():
        raise ValueError("Library name is required")
    doc = dict(doc)
    doc.setdefault("id", _id("lib"))
    doc.setdefault("folders", [])
    doc.setdefault("tags", [])
    doc.setdefault("description", "")
    doc.setdefault("created", _now())
    doc["version"] = int(doc.get("version", 0)) + 1
    doc.pop("material_count", None)
    return db.put_doc("libraries", doc)


# ------------------------------------------------------------------ materials
def get_material(mid: str) -> dict:
    m = db.get_doc("materials", mid)
    if not m:
        raise KeyError(mid)
    return m


def save_material(doc: dict, note: str = "edited") -> dict:
    if not (doc.get("name") or "").strip():
        raise ValueError("Material name is required")
    doc = dict(doc)
    old = db.get_doc("materials", doc["id"]) if doc.get("id") else None
    doc.setdefault("id", _id("mat"))
    doc.setdefault("library_ids", [])
    doc.setdefault("folders", {})
    doc.setdefault("tags", [])
    doc.setdefault("synonyms", [])
    doc.setdefault("category", "Other")
    doc.setdefault("identity", {})
    doc.setdefault("created", _now())
    hist = list((old or {}).get("history", []))
    hist.append({"t": _now(), "note": note if old else "created"})
    doc["history"] = hist[-50:]
    return db.put_doc("materials", doc)


def search_materials(q: str = "", library_id: str | None = None, tag: str | None = None, category: str | None = None, include_archived=False):
    mats = db.list_docs("materials")
    libs = {l["id"]: l["name"] for l in db.list_docs("libraries")}
    props = db.list_docs("properties")
    by_mat: dict[str, list[dict]] = {}
    for p in props:
        by_mat.setdefault(p.get("material_id"), []).append(p)
    ql = (q or "").strip().lower()
    out = []
    for m in mats:
        if m.get("archived") and not include_archived:
            continue
        if library_id and library_id not in m.get("library_ids", []):
            continue
        if tag and tag not in m.get("tags", []):
            continue
        if category and m.get("category") != category:
            continue
        mp = by_mat.get(m["id"], [])
        if ql:
            hay = " ".join([m.get("name", ""), m.get("category", ""), " ".join(m.get("synonyms", [])), " ".join(m.get("tags", [])),
                            " ".join(libs.get(i, "") for i in m.get("library_ids", [])),
                            " ".join(catalog.property_meta(p["property"])["label"] for p in mp)]).lower()
            if ql not in hay:
                continue
        r = dict(m)
        r["library_names"] = [libs.get(i, i) for i in m.get("library_ids", [])]
        r["property_count"] = len(mp)
        r["approved_count"] = sum(1 for p in mp if p.get("review_status") == "approved")
        r["pending_count"] = sum(1 for p in mp if p.get("review_status") == "extracted")
        out.append(r)
    return sorted(out, key=lambda m: m["name"].lower())


def new_version(mid: str) -> dict:
    """Create a new version of a material (copy of record and its property records, sources preserved)."""
    m = get_material(mid)
    nm = copy.deepcopy(m)
    nm["id"] = _id("mat")
    nm["version"] = int(m.get("version", 1)) + 1
    nm["previous_version_id"] = m["id"]
    nm["history"] = [{"t": _now(), "note": f"new version of {m['id']} (v{m.get('version', 1)})"}]
    nm["name"] = m["name"]
    saved = db.put_doc("materials", nm)
    for p in properties_of(mid):
        np_ = copy.deepcopy(p)
        np_["id"] = _id("prop")
        np_["material_id"] = np_["parent_id"] = saved["id"]
        np_["copied_from"] = p["id"]
        db.put_doc("properties", np_)
    return saved


# ------------------------------------------------------------------ properties
def properties_of(mid: str) -> list[dict]:
    return db.list_children("properties", mid)


def _num(x):
    try:
        return None if x is None or x == "" else float(x)
    except (TypeError, ValueError):
        return None


def quality(p: dict) -> dict:
    flags = []
    score = EVIDENCE_WEIGHT.get(p.get("evidence_type"), 0) + REVIEW_WEIGHT.get(p.get("review_status"), 0)
    src = p.get("source") or {}
    if src.get("paper_id") or src.get("citation"):
        score += 15
    else:
        flags.append("no source")
    if src.get("page"):
        score += 5
    if src.get("snippet") or src.get("table_ref"):
        score += 5
    else:
        flags.append("no supporting passage")
    if p.get("uncertainty") and (p["uncertainty"].get("value") is not None or p["uncertainty"].get("text")):
        score += 10
    else:
        flags.append("no uncertainty")
    if p.get("conditions"):
        score += 10
    else:
        flags.append("conditions not stated")
    if p.get("method"):
        score += 5
    else:
        flags.append("method not stated")
    if p.get("evidence_type") == "ai_inferred":
        flags.append("AI-inferred")
    if p.get("evidence_type") == "illustrative":
        flags.append("illustrative placeholder")
    if p.get("normalized") and p["normalized"].get("ok") is False:
        flags.append("unit not convertible")
    return {"score": max(0, min(100, score)), "flags": flags}


def save_property(doc: dict, note: str = "edited") -> dict:
    doc = dict(doc)
    if not doc.get("material_id"):
        raise ValueError("material_id required")
    get_material(doc["material_id"])
    if not doc.get("property"):
        raise ValueError("property key required")
    if doc.get("review_status", "extracted") not in catalog.REVIEW_STATUSES:
        raise ValueError("invalid review status")
    old = db.get_doc("properties", doc["id"]) if doc.get("id") else None
    meta = catalog.property_meta(doc["property"])
    doc.setdefault("id", _id("prop"))
    doc["parent_id"] = doc["material_id"]
    doc["label"] = doc.get("label") or meta["label"]
    doc["category"] = doc.get("category") or meta["category"]
    doc.setdefault("conditions", {})
    doc.setdefault("source", {})
    doc.setdefault("evidence_type", "manual_entry")
    doc.setdefault("review_status", "extracted")
    doc["value"] = _num(doc.get("value"))
    doc["value_max"] = _num(doc.get("value_max"))
    doc["normalized"] = catalog.normalize(doc["value"], doc.get("unit"), meta["unit"]) if doc["value"] is not None else None
    if doc["normalized"] and meta["unit"] is None:
        doc["normalized"] = {"value": doc["value"], "unit": doc.get("unit") or "", "ok": True, "note": None}
    doc["quality"] = quality(doc)
    hist = list((old or {}).get("history", []))
    if old:
        changed = [k for k in ("value", "value_max", "unit", "conditions", "review_status", "evidence_type", "uncertainty", "source") if old.get(k) != doc.get(k)]
        hist.append({"t": _now(), "note": note, "changed": changed, "previous": {k: old.get(k) for k in changed}})
    else:
        hist.append({"t": _now(), "note": "created"})
    doc["history"] = hist[-50:]
    doc["version"] = len(doc["history"])
    return db.put_doc("properties", doc)


def _cond_compatible(a: dict, b: dict) -> tuple[bool, list[str]]:
    """Conditions comparable if every condition present in both is within tolerance."""
    diffs = []
    for k, (mode, tol) in COND_TOL.items():
        va, vb = _num((a or {}).get(k)), _num((b or {}).get(k))
        if va is None or vb is None:
            continue
        d = abs(math.log(max(va, 1e-12)) - math.log(max(vb, 1e-12))) if mode == "log" else abs(va - vb)
        if d > tol:
            diffs.append(k)
    return (not diffs), diffs


def compare(material_id: str, prop: str, include_unreviewed: bool = True) -> dict:
    recs = [p for p in properties_of(material_id) if p["property"] == prop and p.get("review_status") not in ("rejected", "deprecated")]
    if not include_unreviewed:
        recs = [p for p in recs if p.get("review_status") in ("reviewed", "approved")]
    meta = catalog.property_meta(prop)
    papers = {p["id"]: p for p in db.list_docs("papers")}
    rows = []
    for r in recs:
        src = r.get("source") or {}
        paper = papers.get(src.get("paper_id") or "")
        rows.append({**r, "citation": src.get("citation") or ((paper or {}).get("metadata") or {}).get("citation") or ((paper or {}).get("metadata") or {}).get("title")})
    conflicts = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            a, b = rows[i], rows[j]
            na, nb = (a.get("normalized") or {}).get("value"), (b.get("normalized") or {}).get("value")
            if na is None or nb is None:
                continue
            same_src = (a.get("source") or {}).get("paper_id") and (a.get("source") or {}).get("paper_id") == (b.get("source") or {}).get("paper_id")
            ok, diffs = _cond_compatible(a.get("conditions"), b.get("conditions"))
            rel = abs(na - nb) / max(abs(na), abs(nb), 1e-12)
            if ok and rel > CONFLICT_REL and not same_src:
                conflicts.append({"a": a["id"], "b": b["id"], "relative_difference": rel,
                                  "message": f"{meta['label']}: {na:.4g} vs {nb:.4g} {meta['unit'] or ''} under comparable reported conditions ({rel*100:.0f} % difference)."})
    cond_keys = sorted({k for r in rows for k in (r.get("conditions") or {}) if _num(r["conditions"].get(k)) is not None})
    return {"property": meta, "records": rows, "conflicts": conflicts, "condition_keys": cond_keys,
            "policy": "Records are shown side by side with their conditions; values are never averaged automatically."}


# ------------------------------------------------------------------ export / import
def export_library(lib_id: str) -> dict:
    lib = db.get_doc("libraries", lib_id)
    if not lib:
        raise KeyError(lib_id)
    mats = [m for m in db.list_docs("materials") if lib_id in m.get("library_ids", [])]
    mids = {m["id"] for m in mats}
    props = [p for p in db.list_docs("properties") if p.get("material_id") in mids]
    models = [m for m in db.list_docs("sci_models") if m.get("material_id") in mids or lib_id in m.get("library_ids", [])]
    pids = {(p.get("source") or {}).get("paper_id") for p in props} | {(m.get("source") or {}).get("paper_id") for m in models}
    papers = [{k: v for k, v in p.items() if k not in ("pages", "file_path")} for p in db.list_docs("papers") if p["id"] in pids]
    return {"format": "synthea-library/1", "exported": _now(), "library": lib, "materials": mats, "properties": props, "models": models, "papers": papers,
            "note": "Original PDF files are not embedded; paper metadata and source passages are included for traceability."}


def import_library(bundle: dict) -> dict:
    if bundle.get("format") != "synthea-library/1":
        raise ValueError("Not a Synthea library file")
    lib = dict(bundle["library"])
    existing = db.get_doc("libraries", lib["id"])
    if existing and existing.get("name") != lib.get("name"):
        lib["id"] = _id("lib")
    lib.pop("updated_at", None)
    db.put_doc("libraries", lib)
    added = {"materials": 0, "properties": 0, "models": 0, "papers": 0, "merged_materials": 0}
    for p in bundle.get("papers", []):
        if not db.get_doc("papers", p["id"]):
            db.put_doc("papers", {**p, "pdf_available": False})
            added["papers"] += 1
    for m in bundle.get("materials", []):
        cur = db.get_doc("materials", m["id"])
        if cur:  # global record already present: just place it in the library (no duplicate)
            if lib["id"] not in cur.get("library_ids", []):
                cur["library_ids"] = cur.get("library_ids", []) + [lib["id"]]
                db.put_doc("materials", cur)
            added["merged_materials"] += 1
        else:
            m = dict(m)
            m["library_ids"] = list({*m.get("library_ids", []), lib["id"]} - {bundle["library"]["id"]} | {lib["id"]})
            db.put_doc("materials", m)
            added["materials"] += 1
    for p in bundle.get("properties", []):
        if not db.get_doc("properties", p["id"]):
            db.put_doc("properties", p)
            added["properties"] += 1
    for m in bundle.get("models", []):
        if not db.get_doc("sci_models", m["id"]):
            db.put_doc("sci_models", m)
            added["models"] += 1
    return {"library_id": lib["id"], **added}


# ------------------------------------------------------------------ seed / data migration
STARTER_LIBRARIES = [
    ("lib-plant-protein", "Plant Protein Library", "Plant proteins: isolates, concentrates and their functional/rheological behaviour."),
    ("lib-starch", "Starch Library", "Native and modified starches; gelatinisation and pasting behaviour."),
    ("lib-hydrocolloid", "Hydrocolloid Library", "Gums and hydrocolloids; rheology and water binding."),
    ("lib-lipid", "Lipid and Oil Library", "Oils and fats; composition and physical properties."),
    ("lib-thermal", "Thermal Properties Library", "Thermophysical properties and thermal transitions."),
    ("lib-rheology", "Rheological Models Library", "Constitutive and empirical flow models with fitted parameters."),
    ("lib-processing", "Food Processing Models Library", "Kinetic, transport and process models."),
    ("lib-custom", "Custom Research Library", "Basic food components and project-specific materials."),
]
ING_LIBS = {"pea-protein-isolate": ["lib-plant-protein"], "potato-starch": ["lib-starch"], "xanthan-gum": ["lib-hydrocolloid"],
            "sunflower-oil": ["lib-lipid"], "water": ["lib-custom", "lib-thermal"], "salt": ["lib-custom"]}


NORMALISATION_VERSION = 2


def renormalise_all():
    """Recompute unit normalisation/quality of stored records when the unit catalogue changes."""
    flag = db.get_doc("settings", "kb_norm")
    if flag and flag.get("version") == NORMALISATION_VERSION:
        return
    for p in db.list_docs("properties"):
        meta = catalog.property_meta(p["property"])
        if p.get("value") is not None:
            p["normalized"] = catalog.normalize(p["value"], p.get("unit"), meta["unit"])
            if meta["unit"] is None:
                p["normalized"] = {"value": p["value"], "unit": p.get("unit") or "", "ok": True, "note": None}
        p["quality"] = quality(p)
        db.put_doc("properties", p)
    db.put_doc("settings", {"id": "kb_norm", "name": "kb_norm", "version": NORMALISATION_VERSION})


def ensure_seeded():
    """Data migration: create starter libraries and materials from the existing ingredient table (once)."""
    flag = db.get_doc("settings", "kb_seeded")
    if flag:
        renormalise_all()
        return
    for lid, name, desc in STARTER_LIBRARIES:
        if not db.get_doc("libraries", lid):
            db.put_doc("libraries", {"id": lid, "name": name, "description": desc, "folders": [], "tags": [], "created": _now(), "version": 1})
    for ing in db.list_docs("ingredients"):
        mid = f"mat-{ing['id']}"
        if db.get_doc("materials", mid):
            continue
        save_material({"id": mid, "name": ing["name"], "category": ing.get("category", "Other"), "ingredient_id": ing["id"],
                       "library_ids": ING_LIBS.get(ing["id"], ["lib-custom"]), "tags": list(ing.get("allergens", [])) and ["allergen"],
                       "synonyms": [], "identity": {"source": ing.get("source"), "supplier": ing.get("supplier")}, "version": 1})
        prov = ing.get("provenance") or {}
        ev = ing.get("evidence") or {}
        refs = ev.get("references") or []
        for key, val in (ing.get("nutrition") or {}).items():
            if val is None or key not in catalog.PROPERTIES:
                continue
            p = prov.get("nutrition", "illustrative")
            save_property({"material_id": mid, "property": key, "value": val, "unit": "g/(100 g)" if key == "sodium" else "%",
                           "conditions": {}, "method": "", "evidence_type": "illustrative" if p == "illustrative" else "manual_entry",
                           "review_status": "reviewed" if p == "literature" else "extracted",
                           "source": {"citation": refs[0] if (refs and p == "literature") else "Migrated from ingredient table (demonstration values)"},
                           "notes": ev.get("validation_status", "")}, note="migrated")
        phys = ing.get("physical") or {}
        th = ing.get("thermal") or {}
        rh = ing.get("rheology") or {}
        extra = [("density", phys.get("density_kg_m3"), "kg/m**3", prov.get("physical")),
                 ("specific_heat", th.get("specific_heat_kj_kgk"), "kJ/(kg*K)", prov.get("thermal")),
                 ("thermal_conductivity", th.get("conductivity_w_mk"), "W/(m*K)", prov.get("thermal")),
                 ("viscosity", rh.get("viscosity_pa_s"), "Pa*s", prov.get("rheology"))]
        for key, val, unit, p in extra:
            if val is None:
                continue
            conds = {"temperature": 25.0} if key in ("density", "viscosity", "thermal_conductivity") else {}
            save_property({"material_id": mid, "property": key, "value": val, "unit": unit, "conditions": conds, "method": "reference data",
                           "evidence_type": "manual_entry", "review_status": "reviewed" if p == "literature" else "extracted",
                           "source": {"citation": refs[0] if refs else "Migrated from ingredient table"}}, note="migrated")
    db.put_doc("settings", {"id": "kb_seeded", "name": "kb_seeded", "at": _now()})
    renormalise_all()
