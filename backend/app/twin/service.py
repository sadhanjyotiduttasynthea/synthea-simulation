"""Digital-twin documents and study execution.

A twin = geometry (2-D cross-section + depth) + one domain material from the scientific library
+ physics interfaces with boundary conditions + mesh settings + operating conditions.
A study runs every enabled physics in a background job and is stored with a snapshot of the
twin, the mesh statistics, the exact inputs used (with their sources) and the results.
"""
from __future__ import annotations

import copy
import time
import uuid
from datetime import datetime, timezone

from .. import db, jobs
from . import properties as props
from . import solvers
from .geometry import MESH_LEVELS, SHAPES, Grid, segments
from .geometry import properties as geom_props

PHYSICS = {
    "heat": {"label": "Heat transfer in solids", "equation": r"\rho c_p \frac{\partial T}{\partial t} = \nabla\cdot(k\nabla T) + Q",
             "settings": {"steady": False, "initial_c": 20.0, "t_end_s": 600.0, "dt_s": None, "source_w_m3": 0.0, "target_c": None,
                          "kinetics": {"enabled": False}},
             "bcs": {"default": {"type": "convection", "h": 25.0, "ambient": 180.0}}},
    "flow": {"label": "Laminar flow (fully developed duct flow)", "equation": r"\nabla\cdot\left(\mu(\dot\gamma)\nabla w\right) = -G,\quad \mu = K\dot\gamma^{\,n-1} + \frac{\tau_0}{\dot\gamma}\left(1-e^{-m\dot\gamma}\right)",
             "settings": {"mode": "flow_rate", "flow_rate_l_h": 20.0, "pressure_gradient_pa_m": 1.0e5}, "bcs": {"default": {"type": "no_slip"}}},
    "structural": {"label": "Solid mechanics (linear elastic)", "equation": r"\nabla\cdot\boldsymbol\sigma + \rho\mathbf g = 0,\quad \boldsymbol\sigma = \mathbf D\,\boldsymbol\varepsilon(\mathbf u)",
                   "settings": {"plane": "stress", "gravity": True},
                   "bcs": {"default": {"type": "free"}, "bottom": {"type": "fixed"}}},
    "diffusion": {"label": "Transport of diluted species", "equation": r"\frac{\partial c}{\partial t} = \nabla\cdot(D\nabla c)",
                  "settings": {"steady": False, "initial": 0.0, "t_end_s": 3600.0, "dt_s": None, "unit": "mol/m³"},
                  "bcs": {"default": {"type": "concentration", "value": 1.0}}},
}
KINETICS_EQ = r"\frac{\partial X}{\partial t} = -k(T)X,\quad k(T) = k_{ref}\exp\left[-\frac{E_a}{R}\left(\frac{1}{T}-\frac{1}{T_{ref}}\right)\right]"


def _now():
    return datetime.now(timezone.utc).isoformat()


def catalogue() -> dict:
    return {"shapes": SHAPES, "mesh_levels": MESH_LEVELS, "physics": PHYSICS, "kinetics_equation": KINETICS_EQ,
            "requirements": props.REQUIREMENTS}


def new_physics(kind: str) -> dict:
    if kind not in PHYSICS:
        raise ValueError(f"unknown physics '{kind}'")
    d = PHYSICS[kind]
    return {"id": f"{kind}-{uuid.uuid4().hex[:6]}", "kind": kind, "label": d["label"], "enabled": True,
            "settings": copy.deepcopy(d["settings"]), "bcs": copy.deepcopy(d["bcs"])}


def new_twin(project_id: str | None, name: str = "Digital twin", physics: list[str] | None = None, material_id: str | None = None) -> dict:
    return {"id": f"twin-{uuid.uuid4().hex[:10]}", "project_id": project_id, "name": name, "created": _now(),
            "geometry": {"shape": "rectangle", "params": copy.deepcopy(SHAPES["rectangle"]["params"]), "depth": 60.0},
            "mesh": {"level": "normal"}, "material": {"material_id": material_id or "mat-pea-protein-isolate", "sources": {}},
            "conditions": {"temperature_c": 25.0}, "physics": [new_physics(k) for k in (physics or ["heat"])]}


def save(doc: dict) -> dict:
    if not (doc.get("name") or "").strip():
        raise ValueError("Twin name is required")
    geom_props(doc["geometry"])  # validates the geometry
    return db.put_doc("twins", doc)


def get(tid: str) -> dict:
    t = db.get_doc("twins", tid)
    if not t:
        raise KeyError(tid)
    return t


def mesh_preview(twin: dict) -> dict:
    g = Grid(twin["geometry"], twin.get("mesh"))
    return {"mesh": g.info(), "geometry": geom_props(twin["geometry"]) | {"segments": [{k: v for k, v in sg.items() if k != "edges"} for sg in segments(twin["geometry"])]}}


def _run(twin: dict, ctx: jobs.JobContext) -> dict:
    t0 = time.time()
    ctx.log(f"Study for twin '{twin['name']}'")
    res = props.resolve_twin(twin)
    if not res["ready"]:
        raise ValueError("Missing material data: " + "; ".join(res["missing"]) + ". Approve library records extracted from your papers, or choose another source.")
    q = {k: v["value"] for k, v in res["quantities"].items()}
    for k, v in res["quantities"].items():
        if v["value"] is not None:
            src = v.get("source") or {}
            where = f" — {src.get('title') or src.get('citation') or ''} p.{src.get('page')}" if src.get("page") else ""
            ctx.log(f"{v['label']}: {v['value']} {v.get('unit') or ''} [{v['origin']}{where}]" + (" ⚠ " + "; ".join(v["flags"]) if v.get("flags") else ""))
    g = Grid(twin["geometry"], twin.get("mesh"))
    info = g.info()
    ctx.log(f"Mesh: {g.nx}×{g.ny} grid, h = {g.h_mm:.4g} mm, {g.n} cells, staircase area error {info['area_error_pct']:+.2f} %")
    enabled = [p for p in twin.get("physics", []) if p.get("enabled", True)]
    if not enabled:
        raise ValueError("No physics interface is enabled")
    results, warnings = {}, []
    for k, ph in enumerate(enabled):
        st, bcs = ph.get("settings") or {}, ph.get("bcs") or {}
        lo, span = k / len(enabled), 1 / len(enabled)

        def prog(f, m, lo=lo, span=span, kind=ph["kind"]):
            ctx.progress(lo + span * f, f"[{kind}] {m}" if m else None)

        ctx.log(f"Solving {ph['label']} …")
        if ph["kind"] == "heat":
            kin = None
            if (st.get("kinetics") or {}).get("enabled"):
                kin = q["kinetics"]
            r = solvers.solve_scalar(g, cond=q["thermal_conductivity"], cap=q["density"] * q["specific_heat"], bcs=bcs, initial=float(st.get("initial_c", 20)),
                                     t_end=float(st.get("t_end_s") or 0), dt=st.get("dt_s"), source=float(st.get("source_w_m3") or 0), steady=bool(st.get("steady")),
                                     kinetics=kin, target=st.get("target_c"), kind="heat", progress=prog, cancelled=ctx.cancelled)
            a = q["thermal_conductivity"] / (q["density"] * q["specific_heat"])
            gp = geom_props(twin["geometry"])
            lc = gp["area_mm2"] / gp["perimeter_mm"] / 1000.0  # characteristic length A/P
            r["thermal_diffusivity_m2_s"] = a
            r["characteristic_length_m"] = lc
            if not st.get("steady"):
                r["fourier_number"] = a * float(st["t_end_s"]) / lc ** 2
            hs = [float(b.get("h", 0)) for b in bcs.values() if b.get("type") == "convection"]
            if hs:
                r["biot_number"] = max(hs) * lc / q["thermal_conductivity"]
            hist = r["history"]
            if max(hist["max"]) > 150 or min(hist["min"]) < -40:
                warnings.append("Temperatures outside -40…150 °C: property records were measured at other conditions; constant properties assumed.")
        elif ph["kind"] == "diffusion":
            r = solvers.solve_scalar(g, cond=q["diffusion_coefficient"], cap=1.0, bcs=bcs, initial=float(st.get("initial", 0)), t_end=float(st.get("t_end_s") or 0),
                                     dt=st.get("dt_s"), steady=bool(st.get("steady")), kind="diffusion", progress=prog, cancelled=ctx.cancelled)
        elif ph["kind"] == "flow":
            law = dict(q["rheology"])
            mode = st.get("mode", "flow_rate")
            r = solvers.solve_duct_flow(g, law=law, mode=mode, pressure_gradient=st.get("pressure_gradient_pa_m"),
                                        flow_rate_m3_s=(float(st.get("flow_rate_l_h") or 0) / 1000 / 3600) if mode == "flow_rate" else None,
                                        length=g.depth, density=q.get("density"), progress=prog, cancelled=ctx.cancelled)
            r["law"] = law
            if r.get("unyielded_fraction", 0) > 0.5:
                warnings.append(f"{r['unyielded_fraction'] * 100:.0f} % of the section is unyielded (plug); the thin sheared layer needs a finer mesh for accurate flow rates.")
            if r.get("laminar") is False:
                warnings.append("Generalised Reynolds number > 2100: the laminar-flow assumption is not valid.")
        elif ph["kind"] == "structural":
            r = solvers.solve_elasticity(g, E=q["elastic_modulus"], nu=q["poissons_ratio"], density=q.get("density"), bcs=bcs, gravity=bool(st.get("gravity", True)),
                                         plane=st.get("plane", "stress"), fracture_stress=q.get("fracture_stress"), progress=prog, cancelled=ctx.cancelled)
            if r["max_displacement_m"] > 0.05 * max(g.nx, g.ny) * g.h:
                warnings.append("Displacements exceed 5 % of the body size: small-strain linear elasticity is no longer accurate.")
            if r.get("cells_above_fracture"):
                warnings.append(f"{r['cells_above_fracture']} cells exceed the fracture stress: failure is expected (fracture itself is not simulated).")
        else:
            raise ValueError(f"unknown physics {ph['kind']}")
        r["equation"] = PHYSICS[ph["kind"]]["equation"]
        results[ph["id"]] = {"kind": ph["kind"], "label": ph["label"], **r}
        ctx.log(f"{ph['label']}: done")
    for v in res["quantities"].values():
        for f in v.get("flags", []):
            warnings.append(f"{v['label']}: {f}")
    study = {"id": f"study-{uuid.uuid4().hex[:10]}", "project_id": twin.get("project_id"), "parent_id": twin["id"], "twin_id": twin["id"],
             "name": f"{twin['name']} — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", "created": _now(), "elapsed_s": round(time.time() - t0, 3),
             "twin_snapshot": {k: twin.get(k) for k in ("name", "geometry", "mesh", "material", "conditions", "physics")},
             "mesh": info, "inputs": res, "results": results, "warnings": warnings, "validation": None,
             "label": "Computed by the Synthea 2-D solvers from library data (see inputs for sources)."}
    db.put_doc("studies", study)
    ctx.log(f"Study saved ({study['elapsed_s']} s)")
    return {"study_id": study["id"]}


def start_study(tid: str) -> dict:
    twin = get(tid)
    return jobs.submit("study", f"Study: {twin['name']}", lambda ctx: _run(twin, ctx), {"twin_id": tid})


def studies_of(tid: str) -> list[dict]:
    out = []
    for s in db.list_children("studies", tid):
        out.append({k: s.get(k) for k in ("id", "name", "created", "elapsed_s", "warnings")} | {"physics": [r["kind"] for r in s["results"].values()], "cells": s["mesh"]["cells"]})
    return sorted(out, key=lambda s: s["created"], reverse=True)
