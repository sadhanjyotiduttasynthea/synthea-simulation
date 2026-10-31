"""Scientific property catalogue and unit handling.

The catalogue defines known property kinds (key, label, category, canonical unit,
extraction aliases). It is data-driven: new categories/properties are added by
extending PROPERTIES (or at runtime via user-defined keys), without code changes
elsewhere. Units are parsed and converted with *pint*; dimensional mismatches are
reported instead of silently converted.
"""
from __future__ import annotations

import re
from functools import lru_cache

import pint

ureg = pint.UnitRegistry(autoconvert_offset_to_baseunit=True)
ureg.define("percent_w = 0.01 = %w/w = pct_w")
ureg.define("ppm_w = 1e-6")
Q_ = ureg.Quantity

CATEGORIES = {
    "composition": "Composition & nutrition",
    "thermal": "Thermal properties",
    "rheology": "Flow & rheology",
    "functional": "Binding & functional properties",
    "mechanical": "Processing & mechanical properties",
    "chemical": "Chemical & biochemical properties",
    "model": "Experimental & predictive models",
}

# key: (label, category, canonical unit or None (dimensionless/free), aliases)
PROPERTIES: dict[str, tuple[str, str, str | None, list[str]]] = {
    # composition
    "protein": ("Protein content", "composition", "percent", ["protein content", "crude protein", "protein"]),
    "fat": ("Fat content", "composition", "percent", ["fat content", "lipid content", "crude fat", "fat"]),
    "carbohydrate": ("Carbohydrate content", "composition", "percent", ["carbohydrate", "carbohydrates"]),
    "moisture": ("Moisture content", "composition", "percent", ["moisture content", "water content", "moisture"]),
    "fibre": ("Dietary fibre", "composition", "percent", ["dietary fibre", "dietary fiber", "fibre", "fiber"]),
    "ash": ("Ash content", "composition", "percent", ["ash content", "ash"]),
    "sodium": ("Sodium", "composition", "percent", ["sodium"]),
    "amino_acid_profile": ("Amino acid profile", "composition", None, ["amino acid profile", "amino acid composition"]),
    # thermal
    "thermal_conductivity": ("Thermal conductivity", "thermal", "W/(m*K)", ["thermal conductivity"]),
    "specific_heat": ("Specific heat capacity", "thermal", "J/(kg*K)", ["specific heat capacity", "specific heat", "heat capacity"]),
    "thermal_diffusivity": ("Thermal diffusivity", "thermal", "m**2/s", ["thermal diffusivity"]),
    "glass_transition_temperature": ("Glass transition temperature", "thermal", "degC", ["glass transition temperature", "glass transition", "tg"]),
    "gelatinization_temperature": ("Gelatinization temperature", "thermal", "degC", ["gelatinization temperature", "gelatinisation temperature", "gelatinization peak temperature"]),
    "denaturation_temperature": ("Protein denaturation temperature", "thermal", "degC", ["denaturation temperature", "denaturation peak temperature", "td"]),
    "melting_temperature": ("Melting temperature", "thermal", "degC", ["melting temperature", "melting point"]),
    "denaturation_enthalpy": ("Denaturation enthalpy", "thermal", "J/g", ["denaturation enthalpy", "enthalpy of denaturation"]),
    "heat_transfer_coefficient": ("Heat-transfer coefficient", "thermal", "W/(m**2*K)", ["heat transfer coefficient", "heat-transfer coefficient"]),
    # rheology
    "viscosity": ("Apparent viscosity", "rheology", "Pa*s", ["apparent viscosity", "viscosity"]),
    "yield_stress": ("Yield stress", "rheology", "Pa", ["yield stress"]),
    "consistency_index": ("Consistency index K", "rheology", "Pa*s**n", ["consistency index", "consistency coefficient"]),
    "flow_behaviour_index": ("Flow behaviour index n", "rheology", None, ["flow behaviour index", "flow behavior index"]),
    "storage_modulus": ("Storage modulus G'", "rheology", "Pa", ["storage modulus", "g'"]),
    "loss_modulus": ("Loss modulus G''", "rheology", "Pa", ["loss modulus", "g''"]),
    "loss_tangent": ("Loss tangent tan δ", "rheology", None, ["loss tangent", "tan delta", "tan δ"]),
    "activation_energy_flow": ("Flow activation energy", "rheology", "J/mol", ["flow activation energy", "activation energy of flow"]),
    # functional
    "water_holding_capacity": ("Water-holding capacity", "functional", "g/g", ["water holding capacity", "water-holding capacity", "water absorption capacity", "whc"]),
    "oil_holding_capacity": ("Oil-holding capacity", "functional", "g/g", ["oil holding capacity", "oil-holding capacity", "oil absorption capacity", "ohc"]),
    "gel_strength": ("Gel strength", "functional", "N", ["gel strength"]),
    "solubility": ("Solubility", "functional", "percent", ["protein solubility", "solubility"]),
    "emulsifying_activity": ("Emulsifying activity index", "functional", "m**2/g", ["emulsifying activity index", "emulsifying activity", "eai"]),
    "emulsion_stability": ("Emulsion stability", "functional", None, ["emulsion stability index", "emulsion stability", "esi"]),
    "foaming_capacity": ("Foaming capacity", "functional", "percent", ["foaming capacity", "foam capacity"]),
    "swelling_power": ("Swelling power", "functional", "g/g", ["swelling power"]),
    "least_gelation_concentration": ("Least gelation concentration", "functional", "percent", ["least gelation concentration", "lgc"]),
    # mechanical / processing
    "density": ("Density", "mechanical", "kg/m**3", ["bulk density", "true density", "density"]),
    "porosity": ("Porosity", "mechanical", None, ["porosity"]),
    "particle_size": ("Particle size", "mechanical", "micrometer", ["particle size", "mean particle diameter", "d50", "d[4,3]"]),
    "diffusion_coefficient": ("Diffusion coefficient", "mechanical", "m**2/s", ["moisture diffusivity", "effective diffusivity", "diffusion coefficient"]),
    "elastic_modulus": ("Elastic (Young's) modulus", "mechanical", "Pa", ["young's modulus", "elastic modulus"]),
    "hardness": ("Hardness", "mechanical", "N", ["hardness"]),
    "fracture_stress": ("Fracture stress", "mechanical", "Pa", ["fracture stress", "breaking stress"]),
    "shape_retention": ("Shape retention", "mechanical", "percent", ["shape retention", "shape fidelity"]),
    "expansion_ratio": ("Expansion ratio", "mechanical", None, ["expansion ratio", "sectional expansion index"]),
    # chemical
    "ph": ("pH", "chemical", None, ["ph"]),
    "isoelectric_point": ("Isoelectric point", "chemical", None, ["isoelectric point", "pi"]),
    "rate_constant": ("Reaction rate constant", "chemical", "1/s", ["rate constant"]),
    "activation_energy": ("Activation energy", "chemical", "J/mol", ["activation energy"]),
    "degree_of_hydrolysis": ("Degree of hydrolysis", "chemical", "percent", ["degree of hydrolysis"]),
    "zeta_potential": ("Zeta potential", "chemical", "mV", ["zeta potential", "ζ-potential"]),
    "surface_hydrophobicity": ("Surface hydrophobicity", "chemical", None, ["surface hydrophobicity"]),
}

# experimental condition keys (canonical unit)
CONDITIONS: dict[str, tuple[str, str | None]] = {
    "temperature": ("Temperature", "degC"),
    "concentration": ("Concentration", "percent"),
    "water_content": ("Water content", "percent"),
    "ph": ("pH", None),
    "shear_rate": ("Shear rate", "1/s"),
    "frequency": ("Frequency", "Hz"),
    "strain": ("Strain", "percent"),
    "ionic_strength": ("Ionic strength", "mol/L"),
    "salt_concentration": ("Salt concentration", "percent"),
    "pressure": ("Pressure", "Pa"),
    "heating_rate": ("Heating rate", "K/min"),
    "time": ("Time", "s"),
}

EVIDENCE_TYPES = {
    "directly_reported": "Directly reported value",
    "calculated_from_reported": "Calculated from reported data",
    "fitted_parameter": "Fitted model parameter",
    "author_prediction": "Prediction reported by the authors",
    "ai_inferred": "AI-inferred interpretation",
    "manual_entry": "Manually entered",
    "illustrative": "Illustrative placeholder",
}
REVIEW_STATUSES = ("extracted", "reviewed", "approved", "rejected", "deprecated")

_UNIT_FIXES = [
    (r"g\s*/\s*\(?\s*100\s*g\s*\)?", "percent"), (r"g\s*/\s*hg", "percent"),
    (r"°\s*C", "degC"), (r"º\s*C", "degC"), (r"(?<![a-zA-Z])℃", "degC"), (r"°\s*F", "degF"),
    (r"(?<![a-zA-Z])K(?![a-zA-Z])", "K"),
    (r"Pa\s*[·.\s]\s*s\s*\^?\s*n", "Pa*s**n"), (r"Pa\s*[·.\s]\s*s(?![a-z])", "Pa*s"), (r"mPa\s*[·.\s]\s*s", "mPa*s"),
    (r"cP\b", "centipoise"), (r"s\s*[-−–]\s*1", "1/s"), (r"s\^?\s*-1", "1/s"), (r"s⁻¹", "1/s"),
    (r"W\s*/?\s*\(?\s*m\s*[·.]?\s*K\s*\)?", "W/(m*K)"), (r"W\s*m\s*[-−]\s*1\s*K\s*[-−]\s*1", "W/(m*K)"),
    (r"J\s*/?\s*\(?\s*kg\s*[·.]?\s*K\s*\)?", "J/(kg*K)"), (r"kJ\s*/?\s*\(?\s*kg\s*[·.]?\s*K\s*\)?", "kJ/(kg*K)"),
    (r"m\s*²\s*/\s*s", "m**2/s"), (r"m2\s*/\s*s", "m**2/s"), (r"m\s*\^?\s*2\s*s\s*[-−]\s*1", "m**2/s"),
    (r"kg\s*/\s*m\s*³", "kg/m**3"), (r"kg\s*/\s*m3", "kg/m**3"), (r"kg\s*m\s*[-−]\s*3", "kg/m**3"),
    (r"g\s*/\s*cm\s*³", "g/cm**3"), (r"g\s*/\s*cm3", "g/cm**3"),
    (r"%\s*\(?w/w\)?", "percent"), (r"%\s*w/v", "percent"), (r"(?<![a-zA-Z])%", "percent"), (r"wt\s*%", "percent"),
    (r"µm|μm", "micrometer"), (r"kJ\s*/\s*mol", "kJ/mol"), (r"J\s*/\s*mol", "J/mol"), (r"kJ\s*mol\s*[-−]\s*1", "kJ/mol"),
    (r"g\s*/\s*g", "g/g"), (r"mL\s*/\s*g", "mL/g"), (r"m²\s*/\s*g", "m**2/g"),
]


def clean_unit(u: str | None) -> str | None:
    if u is None:
        return None
    s = u.strip()
    if not s or s in ("-", "–", "dimensionless", "none"):
        return ""
    for pat, rep in _UNIT_FIXES:
        s = re.sub(pat, rep, s)
    return s.replace("·", "*").replace("⋅", "*")


@lru_cache(maxsize=512)
def parse_unit(u: str | None):
    cu = clean_unit(u)
    if cu is None:
        return None
    if cu == "":
        return ureg.dimensionless
    return ureg.parse_units(cu) if not any(c.isdigit() for c in cu.replace("**", "")) else ureg.Quantity(1, cu).units


def normalize(value: float, unit: str | None, target: str | None) -> dict:
    """Convert value [unit] to target unit. Returns dict(value, unit, ok, note)."""
    if target is None:
        return {"value": value, "unit": unit or "", "ok": True, "note": None}
    if unit is None:
        return {"value": None, "unit": target, "ok": False, "note": "unit missing"}
    try:
        if target == "Pa*s**n":
            # power-law consistency index: only Pa*s^n <-> mPa*s^n scaling supported
            cu = clean_unit(unit) or ""
            factor = 1e-3 if cu.startswith("mPa") else 1.0
            return {"value": value * factor, "unit": target, "ok": True, "note": None if factor == 1 else "converted mPa·sⁿ → Pa·sⁿ"}
        q = Q_(value, parse_unit(unit))
        r = q.to(target)
        return {"value": float(r.magnitude), "unit": target, "ok": True, "note": None}
    except Exception as e:  # pint errors (undefined unit, dimensionality)
        return {"value": None, "unit": target, "ok": False, "note": f"cannot convert '{unit}' to '{target}': {type(e).__name__}"}


def dimension_of(unit: str | None) -> str:
    try:
        return str(parse_unit(unit).dimensionality) if unit else "dimensionless"
    except Exception:
        return "unknown"


def catalog() -> dict:
    return {
        "categories": CATEGORIES,
        "properties": [{"key": k, "label": v[0], "category": v[1], "unit": v[2], "aliases": v[3]} for k, v in PROPERTIES.items()],
        "conditions": [{"key": k, "label": v[0], "unit": v[1]} for k, v in CONDITIONS.items()],
        "evidence_types": EVIDENCE_TYPES,
        "review_statuses": REVIEW_STATUSES,
    }


def property_meta(key: str) -> dict:
    if key in PROPERTIES:
        v = PROPERTIES[key]
        return {"key": key, "label": v[0], "category": v[1], "unit": v[2]}
    return {"key": key, "label": key.replace("_", " "), "category": "model" if key.startswith("model") else "functional", "unit": None}
