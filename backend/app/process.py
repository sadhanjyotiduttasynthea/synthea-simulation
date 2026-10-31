"""Steady-state process-line simulation (lumped unit operations).

Each unit is a 0-D steady-state model connected in a directed graph. The
stream carries mass flow (kg/h), temperature (degC) and proximate composition.
Thermophysical properties are computed with the Choi & Okos (1986) model.
This is a flowsheet mass and energy balance, NOT a CFD or multiphysics solver.
"""
from __future__ import annotations

import math
from collections import defaultdict, deque

from .science import rheology, thermal

LATENT_HEAT_WATER_KJ_KG = 2257.0  # at 100 degC, standard reference value

UNIT_LIBRARY = {
    "storage": {"label": "Ingredient storage", "params": {"mass_flow_kg_h": 120.0, "temperature_c": 20.0}},
    "mixer": {"label": "Mixer", "params": {"volume_l": 60.0, "fill_fraction": 0.6, "power_kw": 3.0}},
    "heater": {"label": "Heater", "params": {"outlet_temperature_c": 60.0, "efficiency": 0.85}},
    "cooler": {"label": "Cooler", "params": {"outlet_temperature_c": 25.0, "cop": 3.0}},
    "pump": {"label": "Pump", "params": {"pressure_rise_bar": 6.0, "efficiency": 0.55}},
    "pipe": {"label": "Pipe", "params": {"length_m": 5.0, "diameter_mm": 32.0}},
    "extruder": {"label": "Extruder", "params": {"barrel_temperature_c": 120.0, "sme_kwh_t": 120.0, "free_volume_l": 1.5, "moisture_loss_pct": 8.0, "die_diameter_mm": 4.0, "die_length_mm": 20.0, "die_count": 4}},
    "conveyor": {"label": "Conveyor", "params": {"length_m": 6.0, "speed_m_min": 4.0, "power_kw": 0.75}},
    "packaging": {"label": "Packaging", "params": {"pack_size_g": 30.0, "power_kw": 1.5}},
    # plant-based sausage line (defaults are illustrative design inputs)
    "hydration": {"label": "Hydration tank", "params": {"volume_l": 200.0, "fill_fraction": 0.7, "power_kw": 0.3}},
    "chopper": {"label": "Emulsifier / bowl chopper", "params": {"volume_l": 60.0, "fill_fraction": 0.5, "power_kw": 1.2}},
    "hme": {"label": "High-moisture extruder (cooling die)", "params": {"barrel_temperature_c": 140.0, "sme_kwh_t": 60.0, "free_volume_l": 1.5, "moisture_loss_pct": 0.0, "cooling_die_outlet_c": 60.0}},
    "stuffer": {"label": "Stuffer / casing", "params": {"pressure_rise_bar": 15.0, "efficiency": 0.5, "portion_g": 50.0, "power_kw": 2.0, "caliber_mm": 24.0}},
    "cooker": {"label": "Cooking (water bath / steam)", "params": {"product_temperature_c": 75.0, "core_target_c": 72.0, "hold_time_min": 30.0, "efficiency": 0.8, "caliber_mm": 24.0}},
    "chiller": {"label": "Chiller", "params": {"outlet_temperature_c": 4.0, "cop": 2.5}},
}
HEATING_KINDS = ("heater", "cooker", "hme", "extruder")
# unit parameters that are product properties (measured / literature / illustrative), not design settings
PRODUCT_PROPERTY_PARAMS = {"cooking_loss_pct": "Cooking loss"}


def _props(comp, T):
    return thermal.properties(comp, max(0.0, min(T, 150.0)))


def _p(params, key, kind):
    v = params.get(key)
    if v is None:
        v = UNIT_LIBRARY[kind]["params"].get(key)
    return float(v)


def simulate(flow: dict, composition: dict, formulation_cost_per_kg: float | None, energy_price: float = 0.20, rheo: dict | None = None) -> dict:
    nodes = {n["id"]: n for n in flow.get("nodes", [])}
    if not nodes:
        raise ValueError("Process flow is empty.")
    succ, indeg = defaultdict(list), {nid: 0 for nid in nodes}
    for e in flow.get("edges", []):
        if e["source"] in nodes and e["target"] in nodes:
            succ[e["source"]].append(e["target"])
            indeg[e["target"]] += 1
    order, q = [], deque([n for n, d in indeg.items() if d == 0])
    indeg2 = dict(indeg)
    while q:
        n = q.popleft()
        order.append(n)
        for m in succ[n]:
            indeg2[m] -= 1
            if indeg2[m] == 0:
                q.append(m)
    if len(order) != len(nodes):
        raise ValueError("Process flow contains a cycle; recycle streams are not supported.")

    inlets: dict[str, list[dict]] = defaultdict(list)
    results, warnings_global = [], []
    total_elec_kw, total_heat_kw, evaporated, losses = 0.0, 0.0, 0.0, 0.0
    product_streams: list[tuple[float, dict]] = []
    technical_extra: list[dict] = []
    twins: list[dict] = []
    feed = 0.0
    product = 0.0
    hb_ok = rheo is not None and all(rheo.get(k) is not None for k in ("yield_stress_pa", "consistency_index_pa_sn", "flow_behaviour_index"))

    for nid in order:
        node = nodes[nid]
        kind = node["data"]["kind"]
        params = node["data"].get("params", {})
        label = node["data"].get("label", kind)
        res = {"id": nid, "kind": kind, "label": label, "outputs": {}, "warnings": [], "unsupported": []}
        ins = inlets.get(nid, [])
        if kind == "storage":
            m = _p(params, "mass_flow_kg_h", kind)
            T = _p(params, "temperature_c", kind)
            comp = dict(composition)
            feed += m
            if ins:
                res["warnings"].append("Storage unit has inlets; they are added to its feed.")
        else:
            if not ins:
                res["warnings"].append("Unit has no inlet stream; skipped.")
                results.append(res)
                continue
            comp = ins[0]["comp"]
            m = 0.0
            hsum = 0.0
            for s in ins:
                cp_s = _props(s["comp"], s["T"])["specific_heat_kj_kgk"]
                m += s["m"]
                hsum += s["m"] * cp_s * s["T"]
            cp_mix = _props(comp, 25.0)["specific_heat_kj_kgk"]
            T = hsum / (m * cp_mix) if m > 0 else 20.0
            if len(ins) > 1:
                res["warnings"].append("Multiple inlets mixed adiabatically (compositions assumed identical).")
        if kind == "storage" and ins:
            for s in ins:
                m += s["m"]
        T_in, m_in = T, m
        pr = _props(comp, T)
        rho, cp = pr["density_kg_m3"], pr["specific_heat_kj_kgk"]
        md = m / 3600.0
        qv = md / rho if rho > 0 else 0.0
        elec = 0.0
        o = res["outputs"]
        o["inlet_mass_flow_kg_h"] = m
        o["inlet_temperature_c"] = T
        o["density_kg_m3"] = rho
        o["specific_heat_kj_kgk"] = cp
        o["volumetric_flow_l_h"] = qv * 3600 * 1000

        if kind in ("mixer", "hydration", "chopper"):
            V = _p(params, "volume_l", kind) / 1000 * _p(params, "fill_fraction", kind)
            P = _p(params, "power_kw", kind)
            o["mean_residence_time_s"] = V / qv if qv > 0 else None
            dT = P / (md * cp) if md > 0 else 0.0
            o["adiabatic_temperature_rise_k"] = dT
            T = T + dT
            elec = P
            res["warnings"].append("Shaft power assumed fully dissipated as heat (adiabatic upper bound). Mixing quality is not predicted.")
            if kind == "chopper":
                res["unsupported"].append("Emulsion droplet size and fat/water binding: not predicted — needs particle-size / emulsion-stability measurements of the batter.")
            if kind == "hydration":
                res["unsupported"].append("Degree of protein hydration: not predicted — needs water-holding-capacity data at the hydration time and temperature.")
        elif kind == "heater":
            Tout = _p(params, "outlet_temperature_c", kind)
            eff = _p(params, "efficiency", kind)
            cpm = _props(comp, (T + Tout) / 2)["specific_heat_kj_kgk"]
            Q = md * cpm * (Tout - T)
            if Q < 0:
                res["warnings"].append("Outlet temperature below inlet: heater acts as cooler (duty negative).")
            o["heat_duty_kw"] = Q
            o["energy_input_kw"] = max(Q, 0) / eff
            elec = max(Q, 0) / eff
            total_heat_kw += max(Q, 0)
            T = Tout
            if Tout > 100:
                res["warnings"].append("Outlet above 100 degC: vapour formation not modelled unless pressurised.")
        elif kind == "cooker":
            Tp = _p(params, "product_temperature_c", kind)
            eff = _p(params, "efficiency", kind)
            cpm = _props(comp, (T + Tp) / 2)["specific_heat_kj_kgk"]
            Q = md * cpm * (Tp - T)
            o["heat_duty_kw"] = Q
            o["energy_input_kw"] = max(Q, 0) / eff
            o["hold_time_min"] = _p(params, "hold_time_min", kind)
            elec = max(Q, 0) / eff
            total_heat_kw += max(Q, 0)
            T = Tp
            res["warnings"].append("Duty is the sensible heat to bring the product to the set product temperature (lumped); heat-up time and core temperature need a Digital Twin study.")
            loss = params.get("cooking_loss_pct")
            prov = params.get("cooking_loss_provenance") or ("illustrative" if loss is not None else "missing")
            if loss is not None:
                lw = min(float(loss) / 100 * m, comp.get("moisture", 0.0) / 100 * m)
                water = comp.get("moisture", 0.0) / 100 * m
                o["cooking_loss_kg_h"] = lw
                losses += lw
                m_out = m - lw
                comp = {k: (((water - lw) / m_out * 100) if k == "moisture" else v * m / m_out) for k, v in comp.items()} if m_out > 0 else comp
                m = m_out
                res["warnings"].append("Cooking loss treated as water released (purge / evaporation); fat exudation is not separated.")
            else:
                res["unsupported"].append("Cooking loss: not computed — needs a measured cooking loss (or literature value) for this formulation.")
            technical_extra.append({"key": "cooking_loss_pct", "label": f"Cooking loss ({label})", "value": float(loss) if loss is not None else None, "unit": "%", "provenance": prov,
                                    "basis": "unit input" if loss is not None else None, "needs": None if loss is not None else "measured cooking loss of the formulation"})
        elif kind == "stuffer":
            dp = _p(params, "pressure_rise_bar", kind) * 1e5
            eff = _p(params, "efficiency", kind)
            P = dp * qv / eff / 1000 + _p(params, "power_kw", kind)
            portion = _p(params, "portion_g", kind)
            o["shaft_power_kw"] = dp * qv / eff / 1000
            o["units_per_hour"] = m * 1000 / portion if portion > 0 else None
            elec = P
            res["warnings"].append("Stuffing pressure is a user input; casing mass is not included in the mass balance.")
        elif kind in ("cooler", "chiller"):
            Tout = _p(params, "outlet_temperature_c", kind)
            cop = _p(params, "cop", kind)
            cpm = _props(comp, (T + Tout) / 2)["specific_heat_kj_kgk"]
            Q = md * cpm * (T - Tout)
            o["heat_removed_kw"] = Q
            o["electrical_power_kw"] = max(Q, 0) / cop
            elec = max(Q, 0) / cop
            T = Tout
        elif kind == "pump":
            dp = _p(params, "pressure_rise_bar", kind) * 1e5
            eff = _p(params, "efficiency", kind)
            P = dp * qv / eff / 1000
            o["shaft_power_kw"] = P
            o["hydraulic_power_kw"] = dp * qv / 1000
            elec = P
        elif kind == "pipe":
            L = _p(params, "length_m", kind)
            D = _p(params, "diameter_mm", kind) / 1000
            vol = math.pi * D * D / 4 * L
            o["mean_residence_time_s"] = vol / qv if qv > 0 else None
            o["mean_velocity_m_s"] = qv / (math.pi * D * D / 4)
            if hb_ok and qv > 0:
                pf = rheology.pipe_flow(qv, D, L, rheo["yield_stress_pa"], rheo["consistency_index_pa_sn"], rheo["flow_behaviour_index"], rho)
                o["pressure_drop_bar"] = pf["pressure_drop_pa"] / 1e5
                o["wall_shear_rate_1_s"] = pf["wall_shear_rate_1_s"]
                o["plug_radius_mm"] = pf["plug_radius_m"] * 1000
                res["warnings"] += pf["warnings"]
                res["warnings"].append(f"Pressure drop uses Herschel-Bulkley parameters from: {rheo.get('source', 'user input')}.")
            else:
                res["unsupported"].append("Pressure drop: no Herschel-Bulkley parameters for this formulation. Measure flow curve (tau_y, K, n) at process temperature.")
        elif kind in ("extruder", "hme"):
            Tb = _p(params, "barrel_temperature_c", kind)
            sme = _p(params, "sme_kwh_t", kind)
            Vf = _p(params, "free_volume_l", kind) / 1000
            loss = _p(params, "moisture_loss_pct", kind) / 100
            P_mech = sme * m / 1000.0  # kWh/t * t/h = kW
            cpm = _props(comp, (T + Tb) / 2)["specific_heat_kj_kgk"]
            Q_heat = md * cpm * (Tb - T)
            o["mechanical_power_kw"] = P_mech
            o["sensible_heat_to_barrel_temp_kw"] = Q_heat
            o["barrel_heating_needed_kw"] = max(Q_heat - P_mech, 0.0)
            o["mean_residence_time_s"] = Vf / qv if qv > 0 else None
            water = comp.get("moisture", 0.0) / 100 * m
            evap = min(loss * m, water)
            if loss * m > water:
                res["warnings"].append("Specified moisture loss exceeds available water; capped.")
            o["moisture_flash_off_kg_h"] = evap
            o["latent_heat_flash_kw"] = evap / 3600 * LATENT_HEAT_WATER_KJ_KG
            evaporated += evap
            m_out = m - evap
            if m_out > 0:
                newc = {}
                for k, v in comp.items():
                    if k == "sodium":
                        newc[k] = v * m / m_out
                    elif k == "moisture":
                        newc[k] = (water - evap) / m_out * 100
                    else:
                        newc[k] = v * m / m_out
                comp = newc
            m = m_out
            elec = P_mech + o["barrel_heating_needed_kw"]
            T = Tb
            res["warnings"].append("SME and moisture loss are user inputs (not predicted). Product expansion, texture and melt rheology are not modelled.")
            res["warnings"].append("Outlet temperature taken as barrel temperature; flash cooling at die not modelled.")
            dd = params.get("die_diameter_mm")
            if hb_ok and dd and qv > 0:
                n_d = max(int(params.get("die_count") or 1), 1)
                pf = rheology.pipe_flow(qv / n_d, float(dd) / 1000, float(params.get("die_length_mm") or 20) / 1000, rheo["yield_stress_pa"], rheo["consistency_index_pa_sn"], rheo["flow_behaviour_index"], rho)
                o["die_pressure_drop_bar"] = pf["pressure_drop_pa"] / 1e5
                o["die_wall_shear_rate_1_s"] = pf["wall_shear_rate_1_s"]
                res["warnings"].append("Die pressure uses room-condition HB parameters; melt rheology at barrel temperature differs - indicative only.")
            elif kind == "extruder":
                res["unsupported"].append("Die pressure: requires Herschel-Bulkley parameters of the melt at barrel temperature.")
            if kind == "hme":
                Tdie = _p(params, "cooling_die_outlet_c", kind)
                cpm2 = _props(comp, (T + Tdie) / 2)["specific_heat_kj_kgk"]
                o["cooling_die_heat_removed_kw"] = (m / 3600.0) * cpm2 * (T - Tdie)
                T = Tdie
                res["warnings"] = [w for w in res["warnings"] if "flash cooling" not in w]
                res["unsupported"].append("Fibre formation / anisotropy in the cooling die: not predicted — needs texture (cutting strength in two directions) of extrudates.")
        elif kind == "conveyor":
            L = _p(params, "length_m", kind)
            v = _p(params, "speed_m_min", kind)
            o["residence_time_s"] = L / v * 60 if v > 0 else None
            elec = _p(params, "power_kw", kind)
        elif kind == "packaging":
            ps = _p(params, "pack_size_g", kind)
            o["packs_per_hour"] = m * 1000 / ps if ps > 0 else None
            elec = _p(params, "power_kw", kind)
        # results of a Digital Twin study opened from this unit flow back into it
        tw = node["data"].get("twin_id")
        if tw and kind in HEATING_KINDS:
            tr = twin_results(tw, params)
            if tr:
                res["twin"] = tr
                twins.append({"unit": label, **tr})
                if tr.get("warning"):
                    res["warnings"].append(tr["warning"])
        res["outputs"]["outlet_mass_flow_kg_h"] = m
        res["outputs"]["outlet_temperature_c"] = T
        res["outputs"]["electrical_power_kw"] = elec
        res["outputs"]["temperature_change_k"] = T - T_in
        res["outputs"]["mass_change_kg_h"] = m - m_in
        total_elec_kw += elec
        res["warnings"] += pr["warnings"]
        results.append(res)
        outs = succ[nid]
        if outs:
            share = m / len(outs)
            if len(outs) > 1:
                res["warnings"].append(f"Outlet split equally between {len(outs)} downstream units.")
            for t in outs:
                inlets[t].append({"m": share, "T": T, "comp": comp})
        else:
            product += m
            product_streams.append((m, comp))

    balance_error = feed - product - evaporated - losses
    mat_cost_h = feed * formulation_cost_per_kg if formulation_cost_per_kg is not None else None
    energy_cost_h = total_elec_kw * energy_price
    summary = {
        "feed_kg_h": feed, "product_kg_h": product, "evaporated_kg_h": evaporated, "cooking_loss_kg_h": losses,
        "mass_balance_error_kg_h": balance_error,
        "total_power_kw": total_elec_kw, "total_heating_duty_kw": total_heat_kw,
        "specific_energy_kwh_per_kg_product": total_elec_kw / product if product > 0 else None,
        "energy_cost_eur_h": energy_cost_h,
        "material_cost_eur_h": mat_cost_h,
        "operating_cost_eur_per_kg_product": ((mat_cost_h or 0) + energy_cost_h) / product if product > 0 else None,
        "energy_price_eur_kwh": energy_price,
        "excludes": "Labour, maintenance, depreciation, water, cleaning, packaging materials and losses other than modelled moisture loss.",
    }
    if abs(balance_error) > 1e-6 * max(feed, 1):
        warnings_global.append("Mass balance does not close; check for units without outlets or inlets.")
    summary["technical"] = technical_outputs(feed, product, evaporated, losses, product_streams, summary, results, technical_extra, twins)
    return {"order": order, "units": results, "summary": summary, "warnings": warnings_global, "twins": twins,
            "rheology_available": hb_ok,
            "disclaimer": "Lumped steady-state mass and energy balances with literature property models. Not a CFD/multiphysics simulation."}


def twin_results(twin_id: str, params: dict) -> dict | None:
    """Latest Digital Twin study of a unit: core temperature, time to target, remaining native protein."""
    from . import db
    studies = sorted(db.list_children("studies", twin_id), key=lambda s: s.get("created", ""), reverse=True)
    if not studies:
        return {"twin_id": twin_id, "study_id": None, "provenance": "missing", "note": "Twin created — compute its study (Digital Twin page) to bring results back here."}
    st = studies[0]
    heat = next((r for r in st["results"].values() if r.get("kind") == "heat"), None)
    if not heat:
        return {"twin_id": twin_id, "study_id": st["id"], "provenance": "missing", "note": "The twin study has no heat-transfer results."}
    h = heat["history"]
    out = {"twin_id": twin_id, "study_id": st["id"], "study_created": st.get("created"), "provenance": "calculated",
           "label": "Digital Twin study (2-D heat conduction with library inputs)", "end_time_s": h["t"][-1],
           "core_temperature_c": h["probe"][-1], "coldest_temperature_c": h["min"][-1], "mean_temperature_c": h["mean"][-1],
           "time_all_cells_reached_target_s": (heat.get("target") or {}).get("time_all_cells_reached_s"), "target_c": (heat.get("target") or {}).get("value"),
           "native_fraction_mean": h["x_mean"][-1] if h.get("x_mean") else None, "input_flags": st.get("warnings", [])[:6]}
    tgt = params.get("core_target_c", params.get("product_temperature_c"))
    if tgt is not None and out["coldest_temperature_c"] < float(tgt):
        out["warning"] = f"Digital twin: the slowest point reaches {out['coldest_temperature_c']:.1f} °C, below the core target {float(tgt):g} °C after {out['end_time_s']:.0f} s."
    return out


def technical_outputs(feed, product, evaporated, losses, streams, summary, results, extra, twins) -> list[dict]:
    """Product-level technical outputs, each with its provenance and basis."""
    rows = []
    design = "calculated from design inputs (illustrative unless entered from plant data)"
    rows.append({"key": "throughput_kg_h", "label": "Throughput (product)", "value": product, "unit": "kg/h", "provenance": "calculated", "basis": design})
    units_h = [u["outputs"].get("units_per_hour") for u in results if u["kind"] == "stuffer" and u["outputs"].get("units_per_hour")]
    if units_h:
        rows.append({"key": "units_per_hour", "label": "Sausages per hour", "value": units_h[-1], "unit": "1/h", "provenance": "calculated", "basis": "throughput / portion size"})
    if product > 0 and streams:
        moist = sum(m * c.get("moisture", 0.0) for m, c in streams) / product
        rows.append({"key": "product_moisture_pct", "label": "Product moisture", "value": moist, "unit": "%", "provenance": "calculated",
                     "basis": "mass balance of ingredient moisture minus modelled losses (ingredient-table values; losses as entered)"})
    rows += extra
    lost_unknown = any(x["key"] == "cooking_loss_pct" and x["value"] is None for x in extra)
    rows.append({"key": "yield_pct", "label": "Yield (product / feed)", "value": None if lost_unknown else (product / feed * 100 if feed > 0 else None), "unit": "%",
                 "provenance": "missing" if lost_unknown else "calculated", "basis": None if lost_unknown else "mass balance including modelled moisture and cooking losses",
                 "needs": "measured cooking loss of the formulation" if lost_unknown else None})
    rows.append({"key": "specific_energy_kwh_kg", "label": "Specific energy", "value": summary.get("specific_energy_kwh_per_kg_product"), "unit": "kWh/kg", "provenance": "calculated",
                 "basis": "lumped steady-state energy balance (heating/cooling duties, shaft powers)"})
    for t in twins:
        if t.get("study_id"):
            rows.append({"key": "twin_core_temperature_c", "label": f"Core temperature after {t['end_time_s']:.0f} s ({t['unit']}, twin)", "value": t["core_temperature_c"], "unit": "°C",
                         "provenance": "calculated", "basis": f"Digital Twin study {t['study_id']}"})
            if t.get("native_fraction_mean") is not None:
                rows.append({"key": "twin_native_fraction", "label": f"Remaining native protein ({t['unit']}, twin)", "value": t["native_fraction_mean"], "unit": "–",
                             "provenance": "calculated", "basis": f"first-order kinetics from approved library model, study {t['study_id']}"})
    return rows
