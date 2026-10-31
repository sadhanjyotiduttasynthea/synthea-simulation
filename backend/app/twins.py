"""Digital twins: geometry + materials + physics + conditions + mesh + study + results + validation.

All material inputs are resolved from approved scientific-library records/models (or from the
Choi & Okos composition model for formulations) and recorded with provenance. Validity ranges are
enforced; extrapolation must be explicitly allowed per twin and is flagged in the results.
"""
from __future__ import annotations

import math
import time
import uuid
from datetime import datetime, timezone

import numpy as np

from . import db, knowledge, sci_registry, solvers
from .science import nutrition, thermal

R_GAS = 8.314462618


def _now():
    return datetime.now(timezone.utc).isoformat()


def default_twin(project_id: str, name: str = "Digital twin") -> dict:
    return {
        "name": name, "project_id": project_id, "geometry_object_id": None, "material": None,
        "physics": [{"kind": "heat", "enabled": True}],
        "conditions": {"initial_temperature": 20.0, "concentration": None},
        "boundaries": {"default": {"type": "convection", "h": 25.0, "T_inf": 90.0}},
        "flow": {"flow_rate_ml_min": 60.0, "temperature": 25.0},
        "diffusion": {"initial": 50.0, "D_source": "library", "D_manual": None, "surface_type": "temperature", "surface_value": 10.0, "k_m": None},
        "kinetics": {"material_id": None, "initial_native_fraction": 1.0},
        "property_overrides": {},
        "mesh": {"size_mm": None},
        "study": {"type": "time", "t_end": 1200.0, "dt": 10.0, "frames": 30, "sweep": {"parameter": "boundary_h", "values": [10, 25, 50, 100]}, "sensitivity": {"delta": 0.1}},
        "allow_extrapolation": False,
    }


# ------------------------------------------------------------------ material resolution
def _formulation_composition(fid: str) -> tuple[dict, str]:
    f = db.get_doc("formulations", fid)
    if not f:
        raise ValueError(f"Formulation {fid} not found")
    ings = {i["id"]: i for i in db.list_docs("ingredients")}
    lines = [nutrition.FormulationLine(ings[l["ingredient_id"]], float(l["percent"])) for l in f["lines"] if l["ingredient_id"] in ings]
    return nutrition.composition(lines).composition, f["name"]


def thermal_properties(twin: dict, warnings: list, provenance: list):
    """Return (k(T), rho_cp(T)) callables for the twin material plus a description."""
    mat = twin.get("material") or {}
    ov = twin.get("property_overrides") or {}
    if mat.get("type") == "formulation":
        comp, fname = _formulation_composition(mat["id"])

        # Choi–Okos is smooth in T: tabulate once on a 2.5 K grid and interpolate per cell
        grid = np.linspace(0, 150, 61)
        tab = [thermal.properties(comp, t) for t in grid]
        ks = np.array([p["conductivity_w_mk"] for p in tab])
        rcp = np.array([p["density_kg_m3"] * p["specific_heat_kj_kgk"] * 1000 for p in tab])

        def props(T):
            Tc = np.clip(T, 0.0, 150.0)
            return np.interp(Tc, grid, ks), np.interp(Tc, grid, rcp)
        provenance.append({"quantity": "k, ρ, cp", "source": f"Choi & Okos (1986) composition model for formulation '{fname}'", "type": "literature model (calculated)",
                           "validity": "0–150 °C, no porosity", "composition": {k: round(v, 3) for k, v in comp.items()}})
        cache = {}

        def k_of(u):
            key = id(u)
            if key not in cache:
                cache.clear()
                cache[key] = props(u)
            return cache[key][0] if "k" not in ov else np.full(u.size, float(ov["k"]))

        def c_of(u):
            key = id(u)
            if key not in cache:
                cache.clear()
                cache[key] = props(u)
            return cache[key][1] if "rho_cp" not in ov else np.full(u.size, float(ov["rho_cp"]))
        if ov:
            provenance.append({"quantity": ", ".join(ov.keys()), "source": "manual override in twin settings", "type": "user input (unvalidated)"})
            warnings.append("Manual property overrides are used; results inherit their (unvalidated) status.")
        return k_of, c_of, {"T_range": [0.0, 150.0]}
    if mat.get("type") == "material":
        m = knowledge.get_material(mat["id"])
        vals = {}
        for key, q in (("thermal_conductivity", "k"), ("specific_heat", "cp"), ("density", "rho")):
            if q in ov:
                vals[q] = float(ov[q])
                provenance.append({"quantity": q, "source": "manual override", "type": "user input (unvalidated)"})
                continue
            res = sci_registry.resolve(mat["id"], key, {"temperature": twin["conditions"].get("initial_temperature")})
            if not res["properties"]:
                raise ValueError(f"No approved '{key}' record for {m['name']}. Approve a library record (with conditions and source) or enter a manual override; "
                                 f"experimental characterisation is required for a validated simulation.")
            best = res["properties"][0]
            vals[q] = best["value"]
            provenance.append({"quantity": q, "value": best["value"], "unit": best["unit"], "record_id": best["id"], "conditions": best["conditions"],
                               "source": (best.get("source") or {}).get("citation"), "page": (best.get("source") or {}).get("page"), "type": "approved library record"})
            if best["conditions"] and best["conditions"].get("temperature") is not None:
                warnings.append(f"{key} measured at {best['conditions']['temperature']} °C is used as a constant over the simulated temperature range.")
        k_val, rcp = vals["k"], vals["rho"] * vals["cp"]
        return (lambda u: np.full(u.size, k_val)), (lambda u: np.full(u.size, rcp)), {"T_range": None}
    raise ValueError("Assign a material (library material or project formulation) to the twin.")


def _rheology_model(twin: dict, warnings: list, provenance: list) -> dict:
    mat = twin.get("material") or {}
    mid = mat.get("id") if mat.get("type") == "material" else (twin.get("flow") or {}).get("material_id")
    if not mid:
        raise ValueError("Flow physics needs a library material with an approved rheological model (select it under Physics → Laminar flow).")
    conds = {"temperature": (twin.get("flow") or {}).get("temperature")}
    if twin["conditions"].get("concentration") is not None:
        conds["concentration"] = twin["conditions"]["concentration"]
    res = sci_registry.resolve(mid, "rheology_hb", {k: v for k, v in conds.items() if v is not None})
    if not res["models"]:
        raise ValueError(res["message"] or "No approved rheological model.")
    best = res["models"][0]
    model = db.get_doc("sci_models", best["id"])
    if not best["exact_conditions"]:
        msg = f"Nearest approved rheological model '{model['name']}' was fitted at {model.get('conditions')}, requested {conds}."
        if not twin.get("allow_extrapolation"):
            raise ValueError(msg + " No model exists for the requested conditions; characterise the material experimentally or explicitly allow extrapolation.")
        warnings.append("EXTRAPOLATION (conditions): " + msg)
    provenance.append({"quantity": "Herschel–Bulkley parameters", "model_id": model["id"], "model": model["name"], "status": model["status"],
                       "conditions": model.get("conditions"), "source": (model.get("source") or {}).get("citation"), "page": (model.get("source") or {}).get("page"),
                       "type": "approved registry model"})
    return model


def _kinetics_model(twin: dict, provenance: list) -> dict | None:
    mid = (twin.get("kinetics") or {}).get("material_id")
    if not mid:
        return None
    for m in db.list_docs("sci_models"):
        if m.get("material_id") == mid and m.get("template") == "first_order_arrhenius" and m.get("status") in sci_registry.USABLE:
            provenance.append({"quantity": "first-order rate constant k(T)", "model_id": m["id"], "model": m["name"], "status": m["status"],
                               "source": (m.get("source") or {}).get("citation"), "page": (m.get("source") or {}).get("page"), "type": "approved registry model"})
            return m
    return None


# ------------------------------------------------------------------ geometry → mesh
def _geometry_object(twin: dict) -> dict:
    g = db.get_doc("geometries", f"geo-{twin['project_id']}")
    obj = next((o for o in (g or {}).get("objects", []) if o["id"] == twin.get("geometry_object_id")), None)
    if not obj:
        raise ValueError("Select a geometry object for the twin (Geometry → create a cuboid, cylinder or sphere).")
    return obj


def build_mesh(twin: dict) -> tuple[solvers.FVMesh, dict]:
    obj = _geometry_object(twin)
    d = obj["dims"]
    sc = obj.get("scale", [1, 1, 1])
    size = (twin.get("mesh") or {}).get("size_mm")
    if obj["kind"] == "cuboid":
        return solvers.mesh_cuboid(d["width"] * sc[0], d["depth"] * sc[1], d["height"] * sc[2], size), obj
    if obj["kind"] == "cylinder":
        r, h = d["radius"] * sc[0], d["height"] * sc[2]
        nr = None if not size else max(4, int(round(r / size)))
        nz = None if not size else max(4, int(round(h / size)))
        return solvers.mesh_cylinder(r, h, nr, nz), obj
    if obj["kind"] == "sphere":
        return solvers.mesh_sphere(d["radius"] * sc[0], nr=max(10, int(round(d["radius"] / size))) if size else 40), obj
    raise ValueError(f"Spatial solvers support cuboid, cylinder and sphere objects; '{obj['kind']}' is not supported (use the lumped process simulator).")


def _bcs(twin: dict, mesh: solvers.FVMesh) -> dict:
    b = twin.get("boundaries") or {}
    default = b.get("default", {"type": "insulated"})
    return {tag: dict(b.get(tag, default)) for tag in mesh.bnd_cell}


def _probes(mesh: solvers.FVMesh) -> dict:
    if mesh.kind == "cartesian3d":
        nx, ny, nz = mesh.shape
        idx = np.arange(mesh.n).reshape(nx, ny, nz)
        return {"centre": int(idx[nx // 2, ny // 2, nz // 2]), "top surface centre": int(idx[nx // 2, ny // 2, nz - 1]), "corner": int(idx[0, 0, nz - 1])}
    if mesh.kind == "axisym":
        nr, nz = mesh.shape
        idx = np.arange(mesh.n).reshape(nr, nz)
        return {"centre": int(idx[0, nz // 2]), "surface (mid-height)": int(idx[nr - 1, nz // 2]), "top centre": int(idx[0, nz - 1])}
    return {"centre": 0, "surface": mesh.n - 1}


def _field_views(mesh: solvers.FVMesh, frames: list[np.ndarray]) -> dict:
    """2-D views of the field for storage/plotting."""
    if mesh.kind == "cartesian3d":
        nx, ny, nz = mesh.shape
        xz = [f.reshape(nx, ny, nz)[:, ny // 2, :].T.round(4).tolist() for f in frames]   # rows z, cols x
        xy = [f.reshape(nx, ny, nz)[:, :, nz // 2].T.round(4).tolist() for f in frames]   # rows y, cols x
        return {"views": {"x–z mid-plane (y = 0)": {"x": mesh.centers["x"].tolist(), "y": mesh.centers["z"].tolist(), "xlabel": "x [mm]", "ylabel": "z [mm]", "frames": xz},
                          "x–y mid-plane (z = mid)": {"x": mesh.centers["x"].tolist(), "y": mesh.centers["y"].tolist(), "xlabel": "x [mm]", "ylabel": "y [mm]", "frames": xy}}}
    if mesh.kind == "axisym":
        nr, nz = mesh.shape
        rz = [f.reshape(nr, nz).T.round(4).tolist() for f in frames]
        r = mesh.centers["r"]
        full_r = np.concatenate([-r[::-1], r])
        mirrored = [np.hstack([np.array(x)[:, ::-1], np.array(x)]).round(4).tolist() for x in rz]
        return {"views": {"r–z section": {"x": full_r.tolist(), "y": mesh.centers["z"].tolist(), "xlabel": "r [mm] (axisymmetric, mirrored)", "ylabel": "z [mm]", "frames": mirrored}}}
    return {"profile": {"r": mesh.centers.get("r", mesh.centers.get("x")).tolist(), "frames": [f.round(4).tolist() for f in frames]}}


# ------------------------------------------------------------------ runners
def _run_heat(twin, mesh, log, warnings, provenance, overrides=None):
    t0 = time.time()
    ov = overrides or {}
    k_of, c_of, meta = thermal_properties(twin, warnings, provenance)
    if ov.get("k_factor"):
        k0 = k_of
        k_of = lambda u: k0(u) * ov["k_factor"]  # noqa: E731
    if ov.get("c_factor"):
        c0 = c_of
        c_of = lambda u: c0(u) * ov["c_factor"]  # noqa: E731
    bcs = _bcs(twin, mesh)
    if ov.get("h_factor"):
        for b in bcs.values():
            if b.get("type") == "convection":
                b["h"] = float(b["h"]) * ov["h_factor"]
    for tag, b in bcs.items():
        if b.get("type") == "convection" and float(b.get("h", 0)) <= 0:
            raise ValueError(f"Boundary {tag}: heat-transfer coefficient must be > 0")
    st = twin["study"]
    T0 = float(twin["conditions"].get("initial_temperature", 20.0))
    t_end = float(ov.get("t_end", st.get("t_end", 600)))
    dt = float(st.get("dt", 5))
    steady = st.get("type") == "stationary"
    Tmax_bc = max([T0] + [float(b.get("T_inf", b.get("value", T0))) for b in bcs.values() if b.get("type") != "insulated"])
    if meta.get("T_range") and not (meta["T_range"][0] <= min(T0, Tmax_bc) and Tmax_bc <= meta["T_range"][1]):
        msg = f"Boundary/initial temperatures reach {Tmax_bc:g} °C, outside the property model range {meta['T_range']} °C."
        if not twin.get("allow_extrapolation"):
            raise ValueError(msg)
        warnings.append("EXTRAPOLATION: " + msg)
    kin = _kinetics_model(twin, provenance) if any(p["kind"] == "kinetics" and p.get("enabled") for p in twin.get("physics", [])) else None
    X = np.full(mesh.n, float((twin.get("kinetics") or {}).get("initial_native_fraction", 1.0)))
    X_frames = []
    kin_note = None
    if any(p["kind"] == "kinetics" and p.get("enabled") for p in twin.get("physics", [])) and not kin:
        kin_note = "Kinetics enabled but no approved first-order model exists for the selected material; reaction progress not computed."
        warnings.append(kin_note)
    kin_viol = []

    def on_step(u_old, u_new, dt_eff):
        if kin is None:
            return
        Tm = 0.5 * (u_old + u_new) + 273.15
        p = {q["symbol"]: float(q["value"]) for q in kin["parameters"]}
        k = p["k_ref"] * np.exp(-(p["Ea"] / R_GAS) * (1 / Tm - 1 / p["T_ref"]))
        rng = (kin.get("validity") or {}).get("T")
        if rng and (Tm.min() < rng[0] or Tm.max() > rng[1]):
            kin_viol.append((float(Tm.min()), float(Tm.max())))
        X[:] = X * np.exp(-k * dt_eff)

    frames_n = int(st.get("frames", 30))
    res = solvers.solve_diffusion(mesh, k_of, c_of, bcs, T0, t_end, dt, frames_n, steady, on_step=on_step if kin else None)
    log.append(f"heat: {mesh.n} cells, {res['steps']} implicit steps (Δt = {res['dt']:.3g} s), solved in {time.time() - t0:.2f} s")
    if res["balance"]:
        log.append(f"heat: energy balance relative error {res['balance']['relative_error']:.2e}")
    out = {"field": "temperature", "unit": "°C", "times": res["times"], "frames": res["frames"], "balance": res["balance"], "boundary_flow_w": res["boundary_flow"]}
    if kin is not None:
        if kin_viol and not twin.get("allow_extrapolation"):
            warnings.append(f"Kinetics not reported: temperatures {min(v[0] for v in kin_viol) - 273.15:.1f}–{max(v[1] for v in kin_viol) - 273.15:.1f} °C exceed the validated range of the kinetic model.")
        else:
            if kin_viol:
                warnings.append("EXTRAPOLATION: kinetic model used outside its validated temperature range.")
            out["reaction"] = {"field": "native fraction (1 − X)", "unit": "–", "final": X.copy()}
            log.append(f"kinetics: model {kin['id']} integrated cell-wise (exact exponential per step)")
    return out


def _run_flow(twin, obj, log, warnings, provenance, overrides=None):
    if obj["kind"] != "cylinder":
        raise ValueError("Laminar channel flow requires a cylindrical channel geometry (e.g. an extrusion die).")
    model = _rheology_model(twin, warnings, provenance)
    hb = sci_registry.hb_parameters(model)
    ov = overrides or {}
    R = obj["dims"]["radius"] * 1e-3
    L = obj["dims"]["height"] * 1e-3
    Q = float(ov.get("flow_rate_ml_min", (twin.get("flow") or {}).get("flow_rate_ml_min", 60))) * 1e-6 / 60
    rho = 1100.0
    r = solvers.hb_channel(Q, None, R, L, hb["yield_stress_pa"], hb["consistency_index_pa_sn"], hb["flow_behaviour_index"], rho)
    rng = (model.get("validity") or {}).get("gamma_dot")
    if rng and not (rng[0] <= r["wall_shear_rate_1_s"] <= rng[1]):
        msg = f"Wall shear rate {r['wall_shear_rate_1_s']:.3g} 1/s is outside the validated shear-rate range {rng} of model '{model['name']}'."
        if not twin.get("allow_extrapolation"):
            raise ValueError(msg + " Reduce the flow rate or characterise the material at higher shear rates.")
        warnings.append("EXTRAPOLATION: " + msg)
    warnings += r.pop("warnings", [])
    log.append(f"flow: HB channel R = {R*1e3:g} mm, L = {L*1e3:g} mm, Q = {Q*6e7:.3g} mL/min, wall shear {r['wall_shear_rate_1_s']:.3g} 1/s, ΔP = {r['pressure_drop_pa']:.4g} Pa")
    # axisymmetric section fields (fully developed: uniform along z; pressure linear in z)
    nz = 30
    z = np.linspace(0, L * 1e3, nz)
    rr = np.array(r["r_mm"])
    full_r = np.concatenate([-rr[::-1], rr])
    vel = np.concatenate([np.array(r["velocity_m_s"])[::-1], r["velocity_m_s"]])
    visc = np.array([np.nan if v is None else v for v in r["apparent_viscosity_pa_s"]])
    visc = np.concatenate([visc[::-1], visc])
    gam = np.concatenate([np.array(r["shear_rate_1_s"])[::-1], r["shear_rate_1_s"]])
    P = (1 - z / (L * 1e3)) * r["pressure_drop_pa"]
    def tile(v):  # noqa: E301
        return [list(map(lambda x: None if not np.isfinite(x) else round(float(x), 6), v)) for _ in z]
    views = {"velocity [m/s]": tile(vel), "shear rate [1/s]": tile(gam), "apparent viscosity [Pa·s]": tile(visc),
             "pressure [Pa]": [[round(float(p), 3)] * len(full_r) for p in P]}
    return {**r, "section": {"x": full_r.tolist(), "y": z.tolist(), "xlabel": "r [mm] (axisymmetric, mirrored)", "ylabel": "z [mm]", "fields": views},
            "model_id": model["id"], "hb": hb}


def _run_diffusion(twin, mesh, log, warnings, provenance):
    cfg = twin.get("diffusion") or {}
    mat = twin.get("material") or {}
    if cfg.get("D_source") == "manual" or mat.get("type") != "material":
        if cfg.get("D_manual") is None:
            raise ValueError("Diffusion needs an approved diffusion-coefficient record for a library material, or a manual value (labelled unvalidated).")
        D = float(cfg["D_manual"])
        provenance.append({"quantity": "D", "value": D, "unit": "m^2/s", "source": "manual input", "type": "user input (unvalidated)"})
        warnings.append("Diffusion coefficient entered manually (unvalidated).")
    else:
        res = sci_registry.resolve(mat["id"], "diffusion_coefficient", {})
        if not res["properties"]:
            raise ValueError(res["message"] or "No approved diffusion coefficient.")
        D = res["properties"][0]["value"]
        provenance.append({"quantity": "D", "value": D, "unit": "m^2/s", "record_id": res["properties"][0]["id"], "type": "approved library record"})
    if cfg.get("surface_type") == "transfer" and cfg.get("k_m"):
        bc = {"type": "convection", "h": float(cfg["k_m"]) / D, "T_inf": float(cfg.get("surface_value", 0))}  # Robin: D ∂c/∂n = k_m (c∞ − c)
    else:
        bc = {"type": "temperature", "value": float(cfg.get("surface_value", 0))}
    bcs = {tag: bc for tag in mesh.bnd_cell}
    st = twin["study"]
    t0 = time.time()
    res = solvers.solve_diffusion(mesh, lambda u: np.full(mesh.n, D), lambda u: np.ones(mesh.n), bcs, float(cfg.get("initial", 50)), float(st.get("t_end", 600)), float(st.get("dt", 5)), int(st.get("frames", 30)))
    log.append(f"diffusion: D = {D:.3g} m²/s, {res['steps']} steps in {time.time() - t0:.2f} s")
    return {"field": "concentration", "unit": "% (moisture, w.b.)", "times": res["times"], "frames": res["frames"]}


def _metrics(heat: dict, mesh, probes: dict) -> dict:
    f = heat["frames"][-1]
    w = mesh.volume / mesh.volume.sum()
    return {"final_centre_C": float(f[probes["centre"]]), "final_mean_C": float(np.sum(f * w)), "final_min_C": float(f.min()), "final_max_C": float(f.max())}


def run_study(twin: dict) -> dict:
    log, warnings, provenance = [], [], []
    st = twin.get("study") or {}
    enabled = [p["kind"] for p in twin.get("physics", []) if p.get("enabled")]
    if not enabled:
        raise ValueError("Enable at least one physics interface.")
    out = {"id": f"study-{uuid.uuid4().hex[:10]}", "project_id": twin["project_id"], "twin_id": twin["id"], "parent_id": twin["id"],
           "name": f"{twin['name']} — {st.get('type', 'time')} study", "type": st.get("type", "time"), "created": _now(),
           "physics": enabled, "allow_extrapolation": bool(twin.get("allow_extrapolation"))}
    mesh = obj = None
    if any(k in enabled for k in ("heat", "diffusion", "kinetics")):
        mesh, obj = build_mesh(twin)
        out["mesh"] = mesh.quality()
        log.append(f"mesh: {out['mesh']['cells']} {out['mesh']['element']} ({'×'.join(map(str, mesh.shape))}), max aspect ratio {out['mesh']['max_aspect_ratio']:.2f}")
    else:
        obj = _geometry_object(twin)
    probes = _probes(mesh) if mesh else {}
    if "heat" in enabled or "kinetics" in enabled:
        if st.get("type") == "sweep":
            sw = st.get("sweep") or {}
            rows = []
            for v in sw.get("values", []):
                tw = _apply_param(twin, sw.get("parameter"), float(v))
                h = _run_heat(tw, mesh, log, warnings, [] if rows else provenance)
                rows.append({"value": float(v), **_metrics(h, mesh, probes)})
            out["sweep"] = {"parameter": sw.get("parameter"), "rows": rows}
        elif st.get("type") == "sensitivity":
            base_h = _run_heat(twin, mesh, log, warnings, provenance)
            base = _metrics(base_h, mesh, probes)
            dlt = float((st.get("sensitivity") or {}).get("delta", 0.1))
            rows = []
            for name, key in (("thermal conductivity k", "k_factor"), ("volumetric heat capacity ρcp", "c_factor"), ("heat-transfer coefficient h", "h_factor")):
                h = _run_heat(twin, mesh, log, [], [], {key: 1 + dlt})
                m = _metrics(h, mesh, probes)
                rise_b = base["final_centre_C"] - twin["conditions"].get("initial_temperature", 20)
                rise = m["final_centre_C"] - twin["conditions"].get("initial_temperature", 20)
                rows.append({"parameter": name, "perturbation": dlt, "final_centre_C": m["final_centre_C"],
                             "normalised_sensitivity": ((rise - rise_b) / rise_b) / dlt if abs(rise_b) > 1e-9 else None})
            out["sensitivity"] = {"base": base, "rows": rows, "metric": "temperature rise at the centre at t_end",
                                  "note": "One-at-a-time local sensitivity: S = (ΔY/Y)/(Δp/p) for a +{:.0%} perturbation.".format(dlt)}
            heat = base_h
            out.update(_pack_heat(heat, mesh, probes))
        else:
            heat = _run_heat(twin, mesh, log, warnings, provenance)
            out.update(_pack_heat(heat, mesh, probes))
    if "diffusion" in enabled:
        dif = _run_diffusion(twin, mesh, log, warnings, provenance)
        out["diffusion"] = {"unit": dif["unit"], "times": dif["times"], **_field_views(mesh, dif["frames"]),
                            "probes": {k: [float(f[i]) for f in dif["frames"]] for k, i in probes.items()},
                            "mean": [float(np.sum(f * mesh.volume) / mesh.volume.sum()) for f in dif["frames"]]}
    if "flow" in enabled:
        out["flow"] = _run_flow(twin, obj, log, warnings, provenance)
    out["log"] = log
    out["warnings"] = warnings
    out["provenance"] = provenance
    out["extrapolated"] = any(w.startswith("EXTRAPOLATION") for w in warnings)
    out["validation"] = {}
    return out


def _pack_heat(heat, mesh, probes):
    packed = {"heat": {"unit": "°C", "times": [t if math.isfinite(t) else None for t in heat["times"]], **_field_views(mesh, heat["frames"]),
                       "probes": {k: [float(f[i]) for f in heat["frames"]] for k, i in probes.items()},
                       "mean": [float(np.sum(f * mesh.volume) / mesh.volume.sum()) for f in heat["frames"]],
                       "balance": heat["balance"], "metrics": _metrics(heat, mesh, probes)}}
    if heat.get("reaction") is not None:
        fv = _field_views(mesh, [heat["reaction"]["final"]])
        packed["reaction"] = {"unit": "native fraction", **fv, "mean": float(np.sum(heat["reaction"]["final"] * mesh.volume) / mesh.volume.sum()),
                              "centre": float(heat["reaction"]["final"][probes["centre"]])}
    return packed


def _apply_param(twin: dict, param: str, v: float) -> dict:
    import copy
    tw = copy.deepcopy(twin)
    if param == "boundary_h":
        for b in tw["boundaries"].values():
            if b.get("type") == "convection":
                b["h"] = v
    elif param == "ambient_temperature":
        for b in tw["boundaries"].values():
            if b.get("type") == "convection":
                b["T_inf"] = v
            elif b.get("type") == "temperature":
                b["value"] = v
    elif param == "initial_temperature":
        tw["conditions"]["initial_temperature"] = v
    elif param == "t_end":
        tw["study"]["t_end"] = v
    else:
        raise ValueError(f"Unsupported sweep parameter '{param}'")
    return tw


def compare(study: dict, probe: str, data: list[list[float]], label: str, field: str = "heat") -> dict:
    res = study.get(field) or {}
    times = [t for t in res.get("times", []) if t is not None]
    series = res.get("probes", {}).get(probe) if probe != "mean" else res.get("mean")
    if not times or not series:
        raise ValueError("Study has no time series for this probe.")
    t_obs = np.array([d[0] for d in data], float)
    y_obs = np.array([d[1] for d in data], float)
    if t_obs.min() < times[0] - 1e-9 or t_obs.max() > times[-1] + 1e-9:
        raise ValueError(f"Observation times must lie within the simulated interval [{times[0]:g}, {times[-1]:g}] s.")
    y_pred = np.interp(t_obs, times, series[: len(times)])
    resid = y_pred - y_obs
    ss = float(np.sum((y_obs - y_obs.mean()) ** 2)) or 1e-12
    return {"label": label, "probe": probe, "field": field, "n": int(t_obs.size), "rmse": float(np.sqrt(np.mean(resid ** 2))), "bias": float(resid.mean()),
            "mae": float(np.abs(resid).mean()), "r2": 1 - float(np.sum(resid ** 2)) / ss, "max_abs_error": float(np.abs(resid).max()),
            "points": [{"t": float(a), "observed": float(b), "predicted": float(c)} for a, b, c in zip(t_obs, y_obs, y_pred)], "date": _now()}
