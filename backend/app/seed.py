"""Seed data for the demonstration project.

DATA INTEGRITY NOTICE
---------------------
Ingredient values below are *illustrative demonstration values* unless the
provenance says otherwise. Proximate compositions of the commercial
ingredients (pea protein isolate, potato starch, xanthan gum) vary by supplier
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

PROJECT_ID = "demo-pea-snack"


def _ing(id, name, category, nutrition, physical, rheology, thermal, price, allergens, evidence, provenance, source):
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
    }


EMPTY_RHEO = {
    "viscosity_pa_s": None, "yield_stress_pa": None, "consistency_index_pa_sn": None,
    "flow_behaviour_index": None, "temperature_c": None, "shear_rate_1_s": None,
    "concentration_pct": None, "ph": None,
}


def ingredients() -> list[dict]:
    return [
        _ing(
            "pea-protein-isolate", "Pea protein isolate", "Protein",
            {"protein": 80.0, "carbohydrate": 3.0, "fat": 6.0, "moisture": 6.0, "fibre": 1.0, "ash": 4.0, "sodium": 1.0},
            {"density_kg_m3": None, "solubility_pct": None, "water_holding_capacity_g_g": None},
            dict(EMPTY_RHEO),
            {"specific_heat_kj_kgk": None, "conductivity_w_mk": None, "transition_temperatures": "Denaturation temperature not provided - measure by DSC for the lot used."},
            4.80, ["legume (pea)"],
            {"references": [], "measurement_conditions": "Not measured.",
             "uncertainty": "Commercial isolates commonly vary by several % protein between suppliers/lots.",
             "validation_status": "Illustrative demonstration values - replace with supplier certificate of analysis."},
            {"nutrition": ILLUSTRATIVE, "physical": MISSING, "rheology": MISSING, "thermal": MISSING},
            "Yellow pea (Pisum sativum)",
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
    "pea-protein-isolate": 20.0,
    "water": 45.0,
    "potato-starch": 25.0,
    "sunflower-oil": 8.0,
    "xanthan-gum": 0.5,
    "salt": 1.5,
}


def demo_project() -> dict:
    return {
        "id": PROJECT_ID,
        "name": "Affordable Pea Protein Snack",
        "description": "Develop an affordable, high-protein, pea-based snack dough with suitable processing and extrusion behaviour.",
        "created": "2026-10-31",
        "active_formulation_id": "baseline-pea-snack",
        "settings": {"serving_size_g": 30.0, "currency": "EUR", "energy_price_eur_kwh": 0.20},
        "optimizer": {
            "min_protein": 15.0, "max_cost": 2.20,
            "bounds": {
                "pea-protein-isolate": [5.0, 45.0], "water": [30.0, 65.0], "potato-starch": [5.0, 35.0],
                "sunflower-oil": [2.0, 12.0], "xanthan-gum": [0.1, 1.0], "salt": [0.5, 2.0],
            },
            "nutrient_limits": {"fat": [None, 15.0], "moisture": [None, 55.0], "sodium": [None, 0.8]},
            "note": "Bounds and nutrient limits are demonstration assumptions for a pea snack dough, not validated specifications.",
        },
        "print_settings": None,
    }


def demo_formulation() -> dict:
    return {
        "id": "baseline-pea-snack",
        "project_id": PROJECT_ID,
        "name": "Baseline pea snack dough",
        "origin": "manual",
        "lines": [{"ingredient_id": k, "percent": v, "locked": False} for k, v in BASELINE.items()],
        "notes": "Starting formulation for the hackathon demonstration (illustrative).",
    }


def demo_process_flow() -> dict:
    nodes = [
        ("n1", "storage", "Ingredient storage", 0, {"mass_flow_kg_h": 120.0, "temperature_c": 20.0}),
        ("n2", "mixer", "Batch/continuous mixer", 220, {"volume_l": 60.0, "fill_fraction": 0.6, "power_kw": 3.0}),
        ("n3", "pump", "Dough pump", 440, {"pressure_rise_bar": 6.0, "efficiency": 0.55}),
        ("n4", "heater", "Pre-heater", 660, {"outlet_temperature_c": 60.0, "efficiency": 0.85}),
        ("n5", "extruder", "Cooking extruder", 880, {"barrel_temperature_c": 120.0, "sme_kwh_t": 120.0, "free_volume_l": 1.5, "moisture_loss_pct": 8.0}),
        ("n6", "cooler", "Cooling tunnel", 1100, {"outlet_temperature_c": 25.0, "efficiency": 0.7}),
        ("n7", "conveyor", "Conveyor", 1320, {"length_m": 6.0, "speed_m_min": 4.0, "power_kw": 0.75}),
        ("n8", "packaging", "Packaging", 1540, {"pack_size_g": 30.0, "power_kw": 1.5}),
    ]
    return {
        "id": "demo-process-flow",
        "project_id": PROJECT_ID,
        "name": "Pea snack pilot line",
        "nodes": [{"id": i, "type": "unit", "position": {"x": x, "y": 120 + (60 if k % 2 else 0)}, "data": {"kind": kind, "label": label, "params": p}} for k, (i, kind, label, x, p) in enumerate(nodes)],
        "edges": [{"id": f"e{a}-{b}", "source": a, "target": b} for a, b in zip([n[0] for n in nodes[:-1]], [n[0] for n in nodes[1:]])],
    }


def seed(force: bool = False):
    if db.count("ingredients") == 0 or force:
        for ing in ingredients():
            db.put_doc("ingredients", ing)
    if db.get_doc("projects", PROJECT_ID) is None or force:
        db.put_doc("projects", demo_project())
        db.put_doc("formulations", demo_formulation())
        db.put_doc("process_flows", demo_process_flow())
