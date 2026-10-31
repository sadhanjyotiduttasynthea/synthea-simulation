"""Seed data for the demonstration project.

DATA INTEGRITY NOTICE
---------------------
Ingredient values below are *illustrative demonstration values* unless the
provenance says otherwise. Proximate compositions of the commercial
ingredients (faba bean protein isolate and concentrate, potato starch, xanthan gum) vary by supplier
and lot; they must be replaced by the supplier certificate of analysis or by
in-house measurements before decisions are made. Prices are illustrative
placeholders, not market quotations. Physical constants of pure water and
sodium chloride are standard reference values.
"""
from __future__ import annotations

from . import db

ILLUSTRATIVE = "illustrative"
LITERATURE = "literature"
MISSING = "missing"

PROJECT_ID = "demo-faba-sausage"
FBPI = "faba-protein-isolate"
FBPC = "faba-protein-concentrate"

# Faba-relevant fields (Vicia faba). Every value defaults to None = "missing" until measured or sourced.
EMPTY_FABA = {"legumin_vicilin_ratio": None, "denaturation_temperatures_c": None, "vicine_mg_per_g": None, "convicine_mg_per_g": None,
              "off_flavour_markers": None}
FABA_ALIASES = ["faba bean", "fava bean", "broad bean", "Vicia faba"]


def _ing(id, name, category, nutrition, physical, rheology, thermal, price, allergens, evidence, provenance, source, synonyms=None):
    provenance = {**provenance, "faba": provenance.get("faba", MISSING)}
    return {
        "id": id,
        "project_id": None,
        "name": name,
        "category": category,
        "supplier": "Generic (demonstration)",
        "source": source,
        "version": 1,
        "allergens": allergens,
        "available": True,
        "nutrition": nutrition,
        "physical": physical,
        "rheology": rheology,
        "thermal": thermal,
        "economics": {"price_per_kg": price, "currency": "EUR", "supplier": "Illustrative placeholder", "date": "2026-10-31", "provenance": ILLUSTRATIVE},
        "evidence": evidence,
        "provenance": provenance,
        "faba": dict(EMPTY_FABA),
        "synonyms": synonyms or [],
    }


EMPTY_RHEO = {
    "viscosity_pa_s": None, "yield_stress_pa": None, "consistency_index_pa_sn": None,
    "flow_behaviour_index": None, "temperature_c": None, "shear_rate_1_s": None,
    "concentration_pct": None, "ph": None,
}


def ingredients() -> list[dict]:
    return [
        _ing(
            FBPI, "Faba bean protein isolate", "Protein",
            {"protein": 86.0, "carbohydrate": 1.5, "fat": 2.5, "moisture": 6.0, "fibre": 0.5, "ash": 3.5, "sodium": 0.8},
            {"density_kg_m3": None, "solubility_pct": None, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": None, "conductivity_w_mk": None, "transition_temperatures": "Denaturation temperatures (legumin/vicilin) not provided - measure by DSC for the lot used."},
            6.20, ["legume (faba bean)"],
            {"references": [], "measurement_conditions": "Not measured.",
             "uncertainty": "Protein content of commercial isolates varies between suppliers and lots.",
             "validation_status": "Illustrative demonstration values - replace with supplier certificate of analysis."},
            {"nutrition": ILLUSTRATIVE, "physical": MISSING, "rheology": MISSING, "thermal": MISSING},
            "Faba bean (Vicia faba), isolate", ["FBPI"] + [f"{a} protein isolate" for a in FABA_ALIASES],
        ),
        _ing(
            FBPC, "Faba bean protein concentrate", "Protein",
            {"protein": 60.0, "carbohydrate": 18.0, "fat": 3.0, "moisture": 8.0, "fibre": 6.0, "ash": 5.0, "sodium": 0.1},
            {"density_kg_m3": None, "solubility_pct": None, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": None, "conductivity_w_mk": None, "transition_temperatures": "Not provided - measure by DSC (protein denaturation and starch gelatinisation overlap)."},
            2.90, ["legume (faba bean)"],
            {"references": [], "measurement_conditions": "Not measured.",
             "uncertainty": "Concentrates (e.g. air-classified) vary widely in protein, starch and fibre content.",
             "validation_status": "Illustrative demonstration values - replace with supplier certificate of analysis."},
            {"nutrition": ILLUSTRATIVE, "physical": MISSING, "rheology": MISSING, "thermal": MISSING},
            "Faba bean (Vicia faba), concentrate", ["FBPC"] + [f"{a} protein concentrate" for a in FABA_ALIASES],
        ),
        _ing(
            "water", "Water", "Solvent",
            {"protein": 0.0, "carbohydrate": 0.0, "fat": 0.0, "moisture": 100.0, "fibre": 0.0, "ash": 0.0, "sodium": 0.0},
            {"density_kg_m3": 997.0, "solubility_pct": None, "water_holding_capacity_g_g": None},
            {**EMPTY_RHEO, "viscosity_pa_s": 0.00089, "yield_stress_pa": 0.0, "consistency_index_pa_sn": 0.00089, "flow_behaviour_index": 1.0, "temperature_c": 25.0},
            {"specific_heat_kj_kgk": 4.18, "conductivity_w_mk": 0.607, "transition_temperatures": "Boiling point 100 degC at 101.325 kPa."},
            0.003, [],
            {"references": ["CRC Handbook of Chemistry and Physics (standard reference data for water at 25 degC)"],
             "measurement_conditions": "25 degC, 101.325 kPa", "uncertainty": "< 1 %",
             "validation_status": "Standard reference values. Price is an illustrative placeholder."},
            {"nutrition": LITERATURE, "physical": LITERATURE, "rheology": LITERATURE, "thermal": LITERATURE},
            "Potable water",
        ),
        _ing(
            "potato-starch", "Potato starch", "Starch",
            {"protein": 0.1, "carbohydrate": 82.4, "fat": 0.1, "moisture": 17.0, "fibre": 0.0, "ash": 0.4, "sodium": 0.0},
            {"density_kg_m3": None, "solubility_pct": None, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": None, "conductivity_w_mk": None, "transition_temperatures": "Gelatinisation range not provided - measure by DSC (depends on water content and botanical source)."},
            1.10, [],
            {"references": [], "measurement_conditions": "Not measured.",
             "uncertainty": "Moisture of native potato starch varies with storage humidity.",
             "validation_status": "Illustrative demonstration values - replace with supplier specification."},
            {"nutrition": ILLUSTRATIVE, "physical": MISSING, "rheology": MISSING, "thermal": MISSING},
            "Potato (Solanum tuberosum)",
        ),
        _ing(
            "sunflower-oil", "Sunflower oil", "Lipid",
            {"protein": 0.0, "carbohydrate": 0.0, "fat": 100.0, "moisture": 0.0, "fibre": 0.0, "ash": 0.0, "sodium": 0.0},
            {"density_kg_m3": None, "solubility_pct": None, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": None, "conductivity_w_mk": None, "transition_temperatures": "Not provided."},
            1.70, [],
            {"references": [], "measurement_conditions": "Not measured.",
             "uncertainty": "Refined oil is essentially pure fat; physical properties depend on fatty-acid profile.",
             "validation_status": "Composition is nominal (refined oil ~100 % fat). Price illustrative."},
            {"nutrition": ILLUSTRATIVE, "physical": MISSING, "rheology": MISSING, "thermal": MISSING},
            "Sunflower seed (Helianthus annuus)",
        ),
        _ing(
            "xanthan-gum", "Xanthan gum", "Hydrocolloid",
            {"protein": 1.0, "carbohydrate": 1.0, "fat": 0.0, "moisture": 11.0, "fibre": 80.0, "ash": 7.0, "sodium": 1.5},
            {"density_kg_m3": None, "solubility_pct": None, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": None, "conductivity_w_mk": None, "transition_temperatures": "Not provided."},
            14.00, [],
            {"references": [], "measurement_conditions": "Not measured.",
             "uncertainty": "Strongly concentration-, salt- and shear-dependent rheology; must be measured.",
             "validation_status": "Illustrative demonstration values - replace with supplier specification."},
            {"nutrition": ILLUSTRATIVE, "physical": MISSING, "rheology": MISSING, "thermal": MISSING},
            "Fermentation (Xanthomonas campestris)",
        ),
        _ing(
            "salt", "Salt (sodium chloride)", "Mineral",
            {"protein": 0.0, "carbohydrate": 0.0, "fat": 0.0, "moisture": 0.0, "fibre": 0.0, "ash": 100.0, "sodium": 39.3},
            {"density_kg_m3": 2165.0, "solubility_pct": 26.4, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": 0.85, "conductivity_w_mk": None, "transition_temperatures": "Melting point 801 degC."},
            0.35, [],
            {"references": ["CRC Handbook of Chemistry and Physics (NaCl: density, solubility ~36 g/100 g water at 25 degC, melting point)"],
             "measurement_conditions": "25 degC", "uncertainty": "Sodium fraction from stoichiometry (22.99/58.44).",
             "validation_status": "Composition by stoichiometry; physical constants standard reference. Price illustrative."},
            {"nutrition": LITERATURE, "physical": LITERATURE, "rheology": MISSING, "thermal": LITERATURE},
            "Mineral / sea salt",
        ),
    ]


BASELINE = {
    FBPI: 12.0,
    FBPC: 6.0,
    "water": 57.0,
    "potato-starch": 8.0,
    "sunflower-oil": 15.0,
    "xanthan-gum": 0.5,
    "salt": 1.5,
}


def demo_project() -> dict:
    return {
        "id": PROJECT_ID,
        "name": "Faba Bean Plant-Based Sausage",
        "description": "Develop a plant-based sausage from faba bean protein (isolate and concentrate) with a meat-like texture, suitable processing and printability.",
        "created": "2026-10-31",
        "active_formulation_id": "baseline-faba-sausage",
        "settings": {"serving_size_g": 50.0, "currency": "EUR", "energy_price_eur_kwh": 0.20},
        "optimizer": {
            "min_protein": 12.0, "max_cost": 1.60,
            "bounds": {
                FBPI: [0.0, 25.0], FBPC: [0.0, 20.0], "water": [40.0, 65.0], "potato-starch": [2.0, 15.0],
                "sunflower-oil": [5.0, 20.0], "xanthan-gum": [0.1, 1.0], "salt": [1.0, 2.0],
            },
            "nutrient_limits": {"fat": [None, 20.0], "moisture": [None, 65.0], "sodium": [None, 0.8]},
            "note": "Bounds and nutrient limits are demonstration assumptions for a faba bean sausage batter, not validated specifications.",
        },
        "print_settings": None,
    }


def demo_formulation() -> dict:
    return {
        "id": "baseline-faba-sausage",
        "project_id": PROJECT_ID,
        "name": "Baseline faba bean sausage batter",
        "origin": "manual",
        "lines": [{"ingredient_id": k, "percent": v, "locked": False} for k, v in BASELINE.items()],
        "notes": "Starting formulation for the hackathon demonstration (illustrative).",
    }


def demo_process_flow() -> dict:
    # plant-based sausage line; all unit settings are illustrative design inputs
    nodes = [
        ("n1", "storage", "Ingredient storage", 0, {"mass_flow_kg_h": 120.0, "temperature_c": 8.0}),
        ("n2", "hydration", "Protein hydration", 220, {"volume_l": 200.0, "fill_fraction": 0.7, "power_kw": 0.3}),
        ("n3", "chopper", "Emulsifier / bowl chopper", 440, {"volume_l": 60.0, "fill_fraction": 0.5, "power_kw": 1.2}),
        ("n4", "stuffer", "Stuffer / casing", 660, {"pressure_rise_bar": 15.0, "efficiency": 0.5, "portion_g": 50.0, "power_kw": 2.0, "caliber_mm": 24.0}),
        ("n5", "cooker", "Cooking (water bath)", 880, {"product_temperature_c": 75.0, "core_target_c": 72.0, "hold_time_min": 30.0, "efficiency": 0.8, "caliber_mm": 24.0}),
        ("n6", "chiller", "Chiller", 1100, {"outlet_temperature_c": 4.0, "cop": 2.5}),
        ("n7", "packaging", "Packaging", 1320, {"pack_size_g": 250.0, "power_kw": 1.5}),
    ]
    return {
        "id": "demo-process-flow",
        "project_id": PROJECT_ID,
        "name": "Faba sausage pilot line",
        "nodes": [{"id": i, "type": "unit", "position": {"x": x, "y": 120 + (60 if k % 2 else 0)}, "data": {"kind": kind, "label": label, "params": p}} for k, (i, kind, label, x, p) in enumerate(nodes)],
        "edges": [{"id": f"e{a}-{b}", "source": a, "target": b} for a, b in zip([n[0] for n in nodes[:-1]], [n[0] for n in nodes[1:]])],
    }


LEGACY_PROJECT = "demo-pea-snack"
LEGACY_INGREDIENT = "pea-protein-isolate"


def migrate_legacy() -> dict:
    """Upgrade databases created before the faba bean change (idempotent).

    * adds missing standard ingredients (FBPI, FBPC, ...) without touching edited existing ones;
    * removes the old demonstration project and its formulations, flows and experiments;
    * removes the old pea isolate ingredient (and its migrated library material) when no remaining
      formulation uses it; otherwise marks it unavailable so user formulations keep working.
    """
    out = {"added_ingredients": [], "removed_project": False, "legacy_ingredient": None}
    for ing in ingredients():
        if not db.get_doc("ingredients", ing["id"]):
            db.put_doc("ingredients", ing)
            out["added_ingredients"].append(ing["id"])
    if db.get_doc("projects", LEGACY_PROJECT):
        for c in ("formulations", "experiments", "process_flows", "twins", "process_runs"):
            db.delete_where_project(c, LEGACY_PROJECT)
        db.delete_doc("projects", LEGACY_PROJECT)
        out["removed_project"] = True
    old = db.get_doc("ingredients", LEGACY_INGREDIENT)
    if old:
        used = any(l.get("ingredient_id") == LEGACY_INGREDIENT for f in db.list_docs("formulations") for l in f.get("lines", []))
        if used:
            if old.get("available", True):
                old["available"] = False
                old["name"] = old["name"] + " (legacy — replace with a faba bean ingredient)"
                db.put_doc("ingredients", old)
            out["legacy_ingredient"] = "kept (used by a formulation), marked unavailable"
        else:
            db.delete_doc("ingredients", LEGACY_INGREDIENT)
            mid = f"mat-{LEGACY_INGREDIENT}"
            for p in db.list_children("properties", mid):
                db.delete_doc("properties", p["id"])
            db.delete_doc("materials", mid)
            out["legacy_ingredient"] = "removed"
    return out


def seed(force: bool = False):
    migrate_legacy()
    if db.count("ingredients") == 0 or force:
        for ing in ingredients():
            db.put_doc("ingredients", ing)
    if db.get_doc("projects", PROJECT_ID) is None or force:
        db.put_doc("projects", demo_project())
        db.put_doc("formulations", demo_formulation())
        db.put_doc("process_flows", demo_process_flow())
