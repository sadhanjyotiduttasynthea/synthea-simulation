"""Scientific model registry.

Each entry documents the equation, parameters (with units), assumptions,
applicability and validation status, and optionally provides a ``compute``
function that evaluates the model from a parameter dict.
"""
from __future__ import annotations

import math

from . import rheology, thermal

VALIDATION_LEVELS = {
    "exact": "Exact conservation law (valid when assumptions hold).",
    "literature": "Published empirical/theoretical model; not validated in this platform for the specific formulations.",
    "simplified": "Simplified engineering estimate; order-of-magnitude use only.",
    "user": "User-defined equation; unvalidated.",
}


def _heat_balance(p):
    m = p["mass_flow_kg_h"] / 3600.0
    q = m * p["cp_kj_kgk"] * (p["t_out_c"] - p["t_in_c"])
    return {"heat_duty_kw": q, "heat_input_kw": q / p.get("efficiency", 1.0)}


def _lmtd(p):
    dt1 = p["t_hot_in_c"] - p["t_cold_out_c"]
    dt2 = p["t_hot_out_c"] - p["t_cold_in_c"]
    if dt1 <= 0 or dt2 <= 0:
        raise ValueError("Temperature cross: invalid counter-current configuration")
    lm = dt1 if abs(dt1 - dt2) < 1e-9 else (dt1 - dt2) / math.log(dt1 / dt2)
    q = p["u_w_m2k"] * p["area_m2"] * lm / 1000.0
    return {"lmtd_k": lm, "heat_duty_kw": q}


def _residence(p):
    v = p["volume_l"] / 1000.0 * p.get("fill_fraction", 1.0)
    qv = p["mass_flow_kg_h"] / 3600.0 / p["density_kg_m3"]
    return {"mean_residence_time_s": v / qv}


def _pump(p):
    qv = p["mass_flow_kg_h"] / 3600.0 / p["density_kg_m3"]
    w = p["pressure_rise_pa"] * qv / p.get("efficiency", 0.6)
    return {"shaft_power_kw": w / 1000.0}


def _hb_pipe(p):
    qv = p["mass_flow_kg_h"] / 3600.0 / p["density_kg_m3"]
    return rheology.pipe_flow(qv, p["diameter_m"], p["length_m"], p["yield_stress_pa"], p["k_pa_sn"], p["n"], p["density_kg_m3"])


def _choi(p):
    comp = {k: p.get(k, 0.0) for k in ("protein", "fat", "carbohydrate", "fibre", "ash", "moisture")}
    return thermal.properties(comp, p["temperature_c"])


def _energy(p):
    return {"energy_kcal_100g": 4 * p["protein"] + 4 * p["carbohydrate"] + 9 * p["fat"] + 2 * p.get("fibre", 0.0)}


MODELS: list[dict] = [
    {
        "id": "nutrition_mass_balance",
        "name": "Nutritional mass balance",
        "equation": "c_mix = sum_i w_i * c_i",
        "parameters": [
            {"symbol": "w_i", "description": "mass fraction of ingredient i", "unit": "-"},
            {"symbol": "c_i", "description": "component content of ingredient i (protein, fat, ...)", "unit": "g/100 g"},
        ],
        "assumptions": ["No mass loss or reaction during mixing", "Ingredient composition values are representative of the lot used"],
        "applicability": "Any blend of ingredients prior to processing.",
        "validation": "exact",
    },
    {
        "id": "energy_atwater",
        "name": "Energy content (EU general factors)",
        "equation": "E = 4*P + 4*C + 9*F + 2*Fib  [kcal/100 g]",
        "parameters": [
            {"symbol": "protein", "description": "protein", "unit": "g/100 g"},
            {"symbol": "carbohydrate", "description": "available carbohydrate", "unit": "g/100 g"},
            {"symbol": "fat", "description": "fat", "unit": "g/100 g"},
            {"symbol": "fibre", "description": "dietary fibre", "unit": "g/100 g"},
        ],
        "assumptions": ["General conversion factors per Regulation (EU) No 1169/2011 Annex XIV"],
        "applicability": "Nutrition labelling estimates.",
        "validation": "literature",
        "compute": _energy,
        "defaults": {"protein": 16, "carbohydrate": 21, "fat": 9.5, "fibre": 0.6},
    },
    {
        "id": "ingredient_cost",
        "name": "Ingredient cost",
        "equation": "cost (EUR/kg) = sum_i w_i * price_i",
        "parameters": [
            {"symbol": "w_i", "description": "mass fraction", "unit": "-"},
            {"symbol": "price_i", "description": "ingredient price", "unit": "EUR/kg"},
        ],
        "assumptions": ["Raw-material cost only (no processing, packaging, labour, losses)", "Prices as entered (may be illustrative)"],
        "applicability": "Raw-material cost screening.",
        "validation": "exact",
    },
    {
        "id": "choi_okos",
        "name": "Thermophysical properties from composition",
        "equation": "cp = sum x_i cp_i(T); 1/rho = sum x_i/rho_i(T); k = sum v_i k_i(T)",
        "parameters": [
            {"symbol": "x_i", "description": "mass fraction of water, protein, fat, carbohydrate, fibre, ash", "unit": "-"},
            {"symbol": "T", "description": "temperature", "unit": "degC"},
        ],
        "assumptions": ["Unfrozen product", "No porosity / air inclusion", "Parallel model for conductivity"],
        "applicability": "0-150 degC, foods described by proximate composition.",
        "validation": "literature",
        "reference": "Choi, Y. & Okos, M.R. (1986), Food Engineering and Process Applications, Vol. 1, 93-101.",
        "compute": _choi,
        "defaults": {"protein": 16, "fat": 9.5, "carbohydrate": 21, "fibre": 0.6, "ash": 2.5, "moisture": 50, "temperature_c": 25},
    },
    {
        "id": "heat_balance",
        "name": "Sensible heat balance",
        "equation": "Q = m_dot * cp * (T_out - T_in);  Q_input = Q / eta",
        "parameters": [
            {"symbol": "mass_flow_kg_h", "description": "mass flow rate", "unit": "kg/h"},
            {"symbol": "cp_kj_kgk", "description": "specific heat", "unit": "kJ/(kg K)"},
            {"symbol": "t_in_c", "description": "inlet temperature", "unit": "degC"},
            {"symbol": "t_out_c", "description": "outlet temperature", "unit": "degC"},
            {"symbol": "efficiency", "description": "heating efficiency", "unit": "-"},
        ],
        "assumptions": ["Steady state", "Constant cp", "No phase change (no evaporation, gelatinisation/denaturation enthalpy neglected)"],
        "applicability": "Heating/cooling of liquid or paste streams below boiling.",
        "validation": "exact",
        "compute": _heat_balance,
        "defaults": {"mass_flow_kg_h": 100, "cp_kj_kgk": 3.2, "t_in_c": 20, "t_out_c": 80, "efficiency": 0.85},
    },
    {
        "id": "lmtd_heat_exchanger",
        "name": "Simplified heat transfer (counter-current LMTD)",
        "equation": "Q = U * A * dT_lm",
        "parameters": [
            {"symbol": "u_w_m2k", "description": "overall heat-transfer coefficient", "unit": "W/(m2 K)"},
            {"symbol": "area_m2", "description": "exchange area", "unit": "m2"},
            {"symbol": "t_hot_in_c / t_hot_out_c / t_cold_in_c / t_cold_out_c", "description": "terminal temperatures", "unit": "degC"},
        ],
        "assumptions": ["Steady state", "Constant U (user supplied, not predicted)", "Counter-current flow"],
        "applicability": "Sizing/checking heat exchangers with known U.",
        "validation": "simplified",
        "compute": _lmtd,
        "defaults": {"u_w_m2k": 500, "area_m2": 2, "t_hot_in_c": 120, "t_hot_out_c": 90, "t_cold_in_c": 20, "t_cold_out_c": 80},
    },
    {
        "id": "residence_time",
        "name": "Mean residence time",
        "equation": "tau = V_fill / Q_v",
        "parameters": [
            {"symbol": "volume_l", "description": "vessel volume", "unit": "L"},
            {"symbol": "fill_fraction", "description": "fill fraction", "unit": "-"},
            {"symbol": "mass_flow_kg_h", "description": "mass flow", "unit": "kg/h"},
            {"symbol": "density_kg_m3", "description": "density", "unit": "kg/m3"},
        ],
        "assumptions": ["Continuous operation", "Mean value only (residence-time distribution not modelled)"],
        "applicability": "Continuous mixers, holding tubes, extruder free volume.",
        "validation": "exact",
        "compute": _residence,
        "defaults": {"volume_l": 50, "fill_fraction": 0.7, "mass_flow_kg_h": 100, "density_kg_m3": 1150},
    },
    {
        "id": "pump_power",
        "name": "Pump shaft power",
        "equation": "P = dP * Q_v / eta",
        "parameters": [
            {"symbol": "pressure_rise_pa", "description": "pressure rise", "unit": "Pa"},
            {"symbol": "mass_flow_kg_h", "description": "mass flow", "unit": "kg/h"},
            {"symbol": "density_kg_m3", "description": "density", "unit": "kg/m3"},
            {"symbol": "efficiency", "description": "pump efficiency", "unit": "-"},
        ],
        "assumptions": ["Incompressible fluid"],
        "applicability": "Positive displacement or centrifugal pumps with known efficiency.",
        "validation": "exact",
        "compute": _pump,
        "defaults": {"pressure_rise_pa": 3e5, "mass_flow_kg_h": 100, "density_kg_m3": 1150, "efficiency": 0.6},
    },
    {
        "id": "herschel_bulkley_pipe",
        "name": "Herschel-Bulkley laminar pipe flow",
        "equation": "tau = tau_y + K*gamma^n;  Q = pi R^3/tau_w^3 * int tau^2 gamma(tau) dtau;  dP = 2 tau_w L / R",
        "parameters": [
            {"symbol": "yield_stress_pa", "description": "yield stress", "unit": "Pa"},
            {"symbol": "k_pa_sn", "description": "consistency index", "unit": "Pa s^n"},
            {"symbol": "n", "description": "flow behaviour index", "unit": "-"},
            {"symbol": "diameter_m / length_m", "description": "tube geometry", "unit": "m"},
        ],
        "assumptions": ["Laminar, isothermal, fully developed", "No wall slip", "Time-independent, inelastic"],
        "applicability": "Pastes and doughs with measured HB parameters at the process temperature.",
        "validation": "literature",
        "reference": "Herschel, W.H. & Bulkley, R. (1926) Kolloid-Zeitschrift 39, 291-300; Rabinowitsch-Mooney analysis (e.g. Steffe, Rheological Methods in Food Process Engineering, 1996).",
        "compute": _hb_pipe,
        "defaults": {"yield_stress_pa": 50, "k_pa_sn": 30, "n": 0.4, "diameter_m": 0.025, "length_m": 5, "mass_flow_kg_h": 100, "density_kg_m3": 1150},
    },
]


def list_models() -> list[dict]:
    out = []
    for m in MODELS:
        d = {k: v for k, v in m.items() if k != "compute"}
        d["computable"] = "compute" in m
        d["validation_description"] = VALIDATION_LEVELS[m["validation"]]
        out.append(d)
    return out


def compute(model_id: str, params: dict) -> dict:
    for m in MODELS:
        if m["id"] == model_id:
            if "compute" not in m:
                raise ValueError("Model is documentation-only; computed inside the formulation engine.")
            p = {**m.get("defaults", {}), **params}
            return m["compute"](p)
    raise KeyError(model_id)
