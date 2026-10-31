"""Toolpath generation and extrusion calculations for 3D food printing.

Supported geometries are prisms (constant cross-section extruded in Z), a
tapered pyramid, or an imported closed 2-D polygon. For every layer the
toolpath contains:
  * perimeter loop(s) inset by half a line width,
  * rectilinear infill (scan-line intersection, even-odd rule, +/-45 deg
    alternating by layer) at the requested infill density.
Bead geometry is approximated as a rectangle of width w (line width) and
height h (layer height): volumetric flow Q = w*h*v.
"""
from __future__ import annotations

import math

import numpy as np

from .science import rheology

SHAPES = {
    "cube": "Rectangular block",
    "cylinder": "Cylinder (disc)",
    "ring": "Hollow ring",
    "hexagon": "Hexagonal prism",
    "star": "Five-point star prism",
    "pyramid": "Stepped pyramid",
    "custom": "Imported polygon (extruded)",
    "geometry": "Geometry editor / imported STL (sliced)",
}


def _circle(r, cx=0.0, cy=0.0, seg=64):
    t = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    return np.stack([cx + r * np.cos(t), cy + r * np.sin(t)], 1)


def _regular(n, R, rot=0.0):
    t = rot + np.arange(n) * 2 * math.pi / n
    return np.stack([R * np.cos(t), R * np.sin(t)], 1)


def _rect(w, d):
    return np.array([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]])


def _star(R, r):
    pts = []
    for k in range(10):
        rad = R if k % 2 == 0 else r
        t = math.pi / 2 + k * math.pi / 5
        pts.append([rad * math.cos(t), rad * math.sin(t)])
    return np.array(pts)


def _area(poly):
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _offset_polygon(poly, d):
    """Inward offset of a simple polygon by distance d (miter join). Exact for convex
    polygons; for concave polygons valid while d is small relative to features."""
    if _area(poly) < 0:
        poly = poly[::-1]
    n = len(poly)
    out = []
    for i in range(n):
        p0, p1, p2 = poly[i - 1], poly[i], poly[(i + 1) % n]
        e1 = p1 - p0
        e2 = p2 - p1
        n1 = np.array([-e1[1], e1[0]]) / (np.linalg.norm(e1) or 1)
        n2 = np.array([-e2[1], e2[0]]) / (np.linalg.norm(e2) or 1)
        bis = n1 + n2
        nb = np.linalg.norm(bis)
        if nb < 1e-9:
            out.append(p1 + n1 * d)
            continue
        bis /= nb
        cos_half = float(np.dot(bis, n1))
        miter = d / max(cos_half, 0.2)
        out.append(p1 + bis * miter)
    res = np.array(out)
    if _area(res) <= 0:
        return None
    return res


def layer_regions(shape: str, p: dict, z: float, height: float):
    """Return list of (outer, holes) polygons for a layer at height z."""
    if shape == "cube":
        return [(_rect(p["width"], p["depth"]), [])]
    if shape == "cylinder":
        return [(_circle(p["diameter"] / 2), [])]
    if shape == "ring":
        return [(_circle(p["diameter"] / 2), [_circle(p["inner_diameter"] / 2)])]
    if shape == "hexagon":
        return [(_regular(6, p["diameter"] / 2), [])]
    if shape == "star":
        return [(_star(p["diameter"] / 2, p["diameter"] / 2 * 0.45), [])]
    if shape == "pyramid":
        f = 1 - 0.7 * (z / height)
        return [(_rect(p["width"] * f, p["depth"] * f), [])]
    if shape == "custom":
        pts = np.array(p["polygon"], dtype=float)
        if len(pts) < 3:
            raise ValueError("Imported polygon needs at least 3 points")
        pts = pts - pts.mean(axis=0)
        return [(pts, [])]
    raise ValueError(f"Unknown shape {shape}")


def _scanline_segments(polys, angle, spacing):
    """Even-odd scan-line fill of a set of polygons (outer + holes)."""
    c, s = math.cos(-angle), math.sin(-angle)
    R = np.array([[c, -s], [s, c]])
    rot = [pp @ R.T for pp in polys]
    ys = np.concatenate([r[:, 1] for r in rot])
    ymin, ymax = ys.min(), ys.max()
    segs = []
    k = 0
    y = ymin + spacing / 2
    Rinv = R.T
    while y < ymax:
        xs = []
        for r in rot:
            n = len(r)
            for i in range(n):
                a, b = r[i], r[(i + 1) % n]
                if (a[1] <= y < b[1]) or (b[1] <= y < a[1]):
                    t = (y - a[1]) / (b[1] - a[1])
                    xs.append(a[0] + t * (b[0] - a[0]))
        xs.sort()
        line = []
        for i in range(0, len(xs) - 1, 2):
            if xs[i + 1] - xs[i] > 1e-6:
                line.append((xs[i], xs[i + 1]))
        if k % 2 == 1:
            line = [(b, a) for a, b in reversed(line)]
        for a, b in line:
            p0 = np.array([a, y]) @ Rinv.T
            p1 = np.array([b, y]) @ Rinv.T
            segs.append((p0, p1))
        y += spacing
        k += 1
    return segs


def generate(params: dict) -> dict:
    shape = params.get("shape", "cube")
    g = params.get("geometry", {})
    mesh = None
    if shape == "geometry":
        from . import geometry3d
        V, F = geometry3d.geometry_mesh(g.get("objects") or [])
        if V[:, 2].min() < -1e-6:
            raise ValueError("Geometry extends below the print bed (z < 0)")
        mesh = (V, F)
        g = {**g, "height": float(V[:, 2].max())}
    nozzle = float(params.get("nozzle_diameter_mm", 1.2))
    lw = float(params.get("line_width_mm") or nozzle * 1.1)
    lh = float(params.get("layer_height_mm", 1.0))
    height = float(g.get("height", 15.0))
    speed = float(params.get("print_speed_mm_s", 20.0))
    travel_speed = float(params.get("travel_speed_mm_s", 60.0))
    infill = float(params.get("infill_pct", 40.0)) / 100.0
    perims = int(params.get("perimeters", 1))
    vol = params.get("build_volume_mm", [200, 200, 100])
    warnings, unsupported = [], []
    if lh > nozzle:
        warnings.append("Layer height exceeds nozzle diameter: poor layer bonding expected (common rule: h <= 0.8 d).")
    if height > vol[2]:
        raise ValueError("Object height exceeds build volume.")
    n_layers = max(1, int(math.ceil(height / lh - 1e-9)))
    path = []  # list of [x, y, z, extrude(0/1)]
    extrude_len = 0.0
    travel_len = 0.0
    last = None
    layers_info = []
    layer_regions_all = []
    max_xy = 0.0

    def move(pt, z, ext):
        nonlocal last, extrude_len, travel_len
        q = (float(pt[0]), float(pt[1]), float(z))
        if last is not None:
            d = math.dist(last, q)
            if ext:
                extrude_len += d
            else:
                travel_len += d
        path.append([round(q[0], 3), round(q[1], 3), round(q[2], 3), 1 if ext else 0])
        last = q

    for L in range(n_layers):
        z = min((L + 1) * lh, height)
        layer_ext0 = extrude_len
        if mesh is not None:
            from . import geometry3d
            regs = geometry3d.slice_mesh(mesh[0], mesh[1], z - lh / 2)
        else:
            regs = layer_regions(shape, g, z - lh / 2, height)
        layer_regions_all.append(regs)
        for outer, holes in regs:
            max_xy = max(max_xy, float(np.abs(outer).max()))
            inner_outer = outer
            inner_holes = list(holes)
            for k in range(perims):
                d = lw * (k + 0.5)
                po = _offset_polygon(outer, d)
                if po is None:
                    break
                loop = list(po) + [po[0]]
                move(loop[0], z, False)
                for pnt in loop[1:]:
                    move(pnt, z, True)
                inner_outer = _offset_polygon(outer, lw * (k + 1))
                for hi, h in enumerate(holes):
                    hc = h if _area(h) > 0 else h[::-1]  # counter-clockwise copy; a negative inset grows the hole outward
                    ph = _offset_polygon(hc, -d)
                    if ph is None:
                        continue
                    loop = list(ph) + [ph[0]]
                    move(loop[0], z, False)
                    for pnt in loop[1:]:
                        move(pnt, z, True)
                    grown = _offset_polygon(hc, -lw * (k + 1))
                    if grown is not None:
                        inner_holes[hi] = grown
            if infill > 0 and inner_outer is not None:
                spacing = lw / infill
                angle = math.pi / 4 if L % 2 == 0 else -math.pi / 4
                for p0, p1 in _scanline_segments([inner_outer] + inner_holes, angle, spacing):
                    if last is None or math.dist(last[:2], p0) > 1e-9:
                        move(p0, z, False)
                    move(p1, z, True)
        layers_info.append({"layer": L + 1, "z": z, "extrusion_mm": extrude_len - layer_ext0})
    if 2 * max_xy > min(vol[0], vol[1]):
        warnings.append("Object footprint exceeds build plate.")

    bead_area = lw * lh  # mm^2
    volume_mm3 = extrude_len * bead_area
    q_req = bead_area * speed  # mm^3/s
    t_print = extrude_len / speed + travel_len / travel_speed
    out = {
        "shape": shape, "layer_count": n_layers, "toolpath_points": len(path),
        "extrusion_length_mm": extrude_len, "travel_length_mm": travel_len,
        "toolpath_length_mm": extrude_len + travel_len,
        "print_time_s": t_print, "line_width_mm": lw,
        "deposited_volume_cm3": volume_mm3 / 1000.0,
        "required_volumetric_flow_mm3_s": q_req,
        "path": path, "layers": layers_info,
        "assumptions": [
            "Rectangular bead cross-section (width x layer height); no die swell, sagging or spreading.",
            "Constant print speed; acceleration, retraction and dwell times ignored.",
            "Material mass uses composition-based density (Choi & Okos) with no air inclusion.",
        ],
        "warnings": warnings, "unsupported": unsupported,
    }
    density = params.get("density_kg_m3")
    if density:
        out["material_mass_g"] = volume_mm3 * 1e-9 * float(density) * 1000
    flow_set = params.get("flow_rate_mm3_s")
    if flow_set:
        ratio = float(flow_set) / q_req if q_req > 0 else None
        out["flow_ratio"] = ratio
        if ratio and abs(ratio - 1) > 0.1:
            out["warnings"].append(f"Set flow rate is {ratio*100:.0f} % of the flow required for the bead geometry (Q = w*h*v = {q_req:.1f} mm3/s): {'over' if ratio > 1 else 'under'}-extrusion expected.")
    rheo = params.get("rheology")
    if rheo and all(rheo.get(k) is not None for k in ("yield_stress_pa", "consistency_index_pa_sn", "flow_behaviour_index")):
        L = float(params.get("nozzle_length_mm", 10.0)) / 1000
        D = nozzle / 1000
        pf = rheology.pipe_flow(q_req * 1e-9, D, L, rheo["yield_stress_pa"], rheo["consistency_index_pa_sn"], rheo["flow_behaviour_index"], density)
        out["nozzle"] = {
            "pressure_drop_kpa": pf["pressure_drop_pa"] / 1000, "wall_shear_rate_1_s": pf["wall_shear_rate_1_s"],
            "wall_shear_stress_pa": pf["wall_shear_stress_pa"], "apparent_viscosity_pa_s": pf["apparent_viscosity_wall_pa_s"],
            "plug_fraction": pf["plug_radius_m"] / (D / 2), "model": pf["model"], "source": rheo.get("source", "user input"),
            "note": "Capillary pressure drop only; syringe/barrel, contraction and entrance losses not included.",
        }
        rng = rheo.get("shear_rate_range")
        if rng and not (rng[0] <= pf["wall_shear_rate_1_s"] <= rng[1]):
            out["warnings"].append(f"EXTRAPOLATION: nozzle wall shear rate {pf['wall_shear_rate_1_s']:.3g} 1/s is outside the validated range {rng} of the rheological model; nozzle results are not validated.")
            out["nozzle"]["extrapolated"] = True
        bead_weight_stress = (density or 1100) * 9.81 * height / 1000
        out["nozzle"]["self_weight_stress_base_pa"] = bead_weight_stress
        out["nozzle"]["yield_vs_self_weight"] = rheo["yield_stress_pa"] / bead_weight_stress if bead_weight_stress > 0 else None
        out["nozzle"]["note_shape"] = "Ratio of yield stress to hydrostatic stress at the base of the object (>1 suggests the material can resist gravity-driven flow when at rest; a screening indicator, not a printing success prediction)."
    else:
        unsupported.append("Nozzle pressure and shape-fidelity indicators require Herschel-Bulkley parameters (yield stress, K, n) for this formulation at the extrusion temperature.")
    unsupported.append("Printing success probability is not predicted (no validated model).")
    out["layer_analysis"] = analyse_layers(layer_regions_all, lh, nozzle)
    ext = extrusion(params, q_req, volume_mm3, out.get("nozzle"))
    out["extrusion"] = ext
    out["manufacturability"] = manufacturability(out, params, height, density, rheo)
    return out


# ------------------------------------------------------------------ layer analysis (raster)
def analyse_layers(regions_by_layer: list, lh: float, nozzle: float, max_layers: int = 60) -> dict:
    """Overhang angle between consecutive layers and the share of each layer narrower than the nozzle.

    Layers are rasterised on a common grid (cell = min(nozzle/4, extent/250)).
    * overhang: for each layer, the largest distance of its material from the material of the layer below
      (Euclidean distance transform); angle = atan(distance / layer height), 0° = vertical wall.
    * thin features: morphological opening with a disc of the nozzle diameter; the share of the layer area that
      disappears is narrower than the nozzle.
    """
    from scipy import ndimage

    from .twin.geometry import inside
    allp = [o for regs in regions_by_layer for o, _h in regs]
    if not allp:
        return {"overhang_max_deg": None, "thin_fraction_max": None}
    pts = np.vstack(allp)
    lo, hi = pts.min(0) - nozzle, pts.max(0) + nozzle
    ext = float(max(hi - lo))
    cell = min(nozzle / 4, ext / 250)
    nx, ny = int(math.ceil((hi[0] - lo[0]) / cell)), int(math.ceil((hi[1] - lo[1]) / cell))
    xs = lo[0] + (np.arange(nx) + 0.5) * cell
    ys = lo[1] + (np.arange(ny) + 0.5) * cell
    X, Y = np.meshgrid(xs, ys)

    def raster(regs):
        m = np.zeros(X.shape, bool)
        for outer, holes in regs:
            r = inside(outer, X, Y)
            for h in holes:
                r &= ~inside(h, X, Y)
            m |= r
        return m

    idx = list(range(len(regions_by_layer)))
    if len(idx) > max_layers:  # sample layers evenly (always keep consecutive pairs for the overhang)
        step = len(idx) / max_layers
        idx = sorted({min(len(idx) - 1, int(k * step)) for k in range(max_layers)})
    r_open = max(1, int(round(nozzle / 2 / cell)))
    yy, xx = np.mgrid[-r_open:r_open + 1, -r_open:r_open + 1]
    disc = xx ** 2 + yy ** 2 <= r_open ** 2
    worst_over, worst_over_layer, worst_thin, worst_thin_layer = 0.0, None, 0.0, None
    for L in idx:
        m = raster(regions_by_layer[L])
        area = m.sum()
        if not area:
            continue
        opened = ndimage.binary_opening(m, structure=disc)
        thin = (m & ~opened).sum() / area
        if thin > worst_thin:
            worst_thin, worst_thin_layer = float(thin), L + 1
        if L > 0:
            below = raster(regions_by_layer[L - 1])
            if below.any():
                dist = ndimage.distance_transform_edt(~below) * cell
                over = float(dist[m].max()) if m.any() else 0.0
                ang = math.degrees(math.atan2(max(over - cell, 0.0), lh))
                if ang > worst_over:
                    worst_over, worst_over_layer = ang, L + 1
            else:
                worst_over, worst_over_layer = 90.0, L + 1  # floating layer
    return {"overhang_max_deg": worst_over, "overhang_layer": worst_over_layer, "thin_fraction_max": worst_thin, "thin_layer": worst_thin_layer,
            "raster_cell_mm": cell, "layers_analysed": len(idx)}


# ------------------------------------------------------------------ extrusion methods
EXTRUSION_DEFAULTS = {
    "piston": {"barrel_diameter_mm": 22.0, "barrel_length_mm": 100.0},
    "screw": {"screw_diameter_mm": 10.0, "channel_depth_mm": 2.0, "pitch_mm": 8.0, "fill_fraction": 0.8, "max_speed_rpm": 120.0},
}


def extrusion(params: dict, q_req: float, volume_mm3: float, nozzle: dict | None) -> dict:
    ex = params.get("extrusion") or {"method": "piston"}
    method = ex.get("method", "piston")
    p = {**EXTRUSION_DEFAULTS.get(method, {}), **{k: v for k, v in ex.items() if v is not None}}
    dp_pa = nozzle["pressure_drop_kpa"] * 1000 if nozzle else None
    out = {"method": method, "params": p, "required_flow_mm3_s": q_req, "warnings": [],
           "pressure": {"value_kpa": dp_pa / 1000 if dp_pa is not None else None, "status": "computed" if dp_pa is not None else "not computed",
                        "basis": "Herschel–Bulkley capillary flow in the nozzle" if dp_pa is not None else "needs Herschel–Bulkley parameters of the formulation at the extrusion temperature"}}
    if method == "piston":
        A = math.pi * float(p["barrel_diameter_mm"]) ** 2 / 4
        out["ram_speed_mm_s"] = q_req / A
        out["ram_displacement_mm"] = volume_mm3 / A
        out["barrel_capacity_mm3"] = A * float(p["barrel_length_mm"])
        out["refills"] = max(0, math.ceil(volume_mm3 / out["barrel_capacity_mm3"]) - 1)
        out["e_per_mm3"] = 1.0 / A  # G-code E = plunger travel in mm
        out["e_axis"] = "plunger travel [mm]"
        if out["refills"]:
            out["warnings"].append(f"The object needs {out['refills']} barrel refill(s).")
        out["ram_force_n"] = dp_pa * A * 1e-6 if dp_pa is not None else None
        out["model"] = "Q = A·v_ram (incompressible paste); force = Δp_nozzle·A (barrel friction and contraction losses not included)"
    elif method == "screw":
        D, h, s, fill = float(p["screw_diameter_mm"]), float(p["channel_depth_mm"]), float(p["pitch_mm"]), float(p["fill_fraction"])
        if not (0 < h < D / 2):
            raise ValueError("Channel depth must be between 0 and half the screw diameter")
        q_rev = fill * math.pi / 4 * (D ** 2 - (D - 2 * h) ** 2) * s
        out["displacement_per_rev_mm3"] = q_rev
        out["screw_speed_rpm"] = q_req / q_rev * 60
        out["revolutions_total"] = volume_mm3 / q_rev
        out["e_per_mm3"] = 1.0 / q_rev  # G-code E = auger revolutions
        out["e_axis"] = "auger revolutions (set firmware steps/rev accordingly)"
        if out["screw_speed_rpm"] > float(p["max_speed_rpm"]):
            out["warnings"].append(f"Required screw speed {out['screw_speed_rpm']:.0f} rpm exceeds the maximum {float(p['max_speed_rpm']):g} rpm: reduce print speed or layer height.")
        out["model"] = "Positive-displacement conveying Q = f·(π/4)(D² − (D − 2h)²)·pitch·N (leakage and pressure back-flow not modelled)"
    else:
        raise ValueError("extrusion method must be 'piston' or 'screw'")
    return out


# ------------------------------------------------------------------ manufacturability (compatibility index)
CHECK_WEIGHTS = {"pressure": 25, "shape_retention": 25, "overhang": 20, "feature_size": 15, "time_layers": 15}
DEFAULT_LIMITS = {"max_pressure_kpa": 600.0, "overhang_limit_deg": 45.0, "thin_fraction_max": 0.05, "max_print_time_min": 60.0, "max_layers": 200,
                  "shape_retention_safety": 1.0}
ADVICE = {
    "pressure": "Lower the pressure: larger nozzle, slower print speed, shorter nozzle, or a less viscous formulation (more water / less hydrocolloid).",
    "shape_retention": "Raise the yield stress (more protein / hydrocolloid, lower water) or reduce the object height; consider printing onto a support.",
    "overhang": "Reduce overhangs (chamfer/taper walls), reorient the part, or add supports.",
    "feature_size": "Thicken thin walls / small features to at least the nozzle diameter, or use a smaller nozzle.",
    "time_layers": "Increase layer height or print speed, reduce infill, or scale the part.",
}


def _status(margin: float) -> tuple[str, float]:
    if margin < 0:
        return "fail", 0.0
    if margin < 0.10:
        return "marginal", 0.5
    return "pass", 1.0


def manufacturability(out: dict, params: dict, height: float, density, rheo) -> dict:
    lim = {**DEFAULT_LIMITS, **(params.get("limits") or {})}
    lim_prov = (params.get("limits_provenance") or "illustrative")
    la = out.get("layer_analysis") or {}
    checks = []
    # 1 pressure vs printer limit
    noz = out.get("nozzle")
    if noz:
        p = noz["pressure_drop_kpa"]
        m = (lim["max_pressure_kpa"] - p) / lim["max_pressure_kpa"]
        st, s = _status(m)
        checks.append({"id": "pressure", "label": "Nozzle pressure vs printer limit", "value": p, "unit": "kPa", "threshold": f"≤ {lim['max_pressure_kpa']:g} kPa", "margin": m,
                       "status": st, "score": s, "inputs": {"rheology": noz.get("source"), "nozzle_diameter_mm": params.get("nozzle_diameter_mm"), "flow_mm3_s": out["required_volumetric_flow_mm3_s"]},
                       "provenance": f"calculated (rheology: {noz.get('source')}); limit: {lim_prov}"})
    else:
        checks.append({"id": "pressure", "label": "Nozzle pressure vs printer limit", "status": "not evaluated", "needs": "Herschel–Bulkley parameters (τ₀, K, n) of the formulation"})
    # 2 shape retention: yield stress vs hydrostatic load of the layers above
    if noz and noz.get("yield_vs_self_weight") is not None and density:
        r = noz["yield_vs_self_weight"]
        m = r / lim["shape_retention_safety"] - 1
        st, s = _status(m)
        checks.append({"id": "shape_retention", "label": "Yield stress vs hydrostatic load at the base", "value": r, "unit": "τ₀ / (ρ·g·H)", "threshold": f"≥ {lim['shape_retention_safety']:g}",
                       "margin": m, "status": st, "score": s, "inputs": {"yield_stress_pa": rheo["yield_stress_pa"], "density_kg_m3": density, "height_mm": height},
                       "provenance": f"calculated (yield stress: {noz.get('source')}; density: Choi–Okos)"})
    else:
        checks.append({"id": "shape_retention", "label": "Yield stress vs hydrostatic load at the base", "status": "not evaluated", "needs": "yield stress τ₀ of the formulation and its density"})
    # 3 overhang
    if la.get("overhang_max_deg") is not None:
        a = la["overhang_max_deg"]
        m = (lim["overhang_limit_deg"] - a) / lim["overhang_limit_deg"]
        st, s = _status(m)
        checks.append({"id": "overhang", "label": "Overhang angle vs limit", "value": a, "unit": "°", "threshold": f"≤ {lim['overhang_limit_deg']:g}° from vertical", "margin": m, "status": st, "score": s,
                       "inputs": {"worst_layer": la.get("overhang_layer"), "layer_height_mm": params.get("layer_height_mm")}, "provenance": f"calculated from the sliced geometry; limit: {lim_prov}"})
    # 4 feature size vs nozzle
    if la.get("thin_fraction_max") is not None:
        f = la["thin_fraction_max"]
        m = (lim["thin_fraction_max"] - f) / lim["thin_fraction_max"]
        st, s = _status(m)
        checks.append({"id": "feature_size", "label": "Minimum feature size vs nozzle diameter", "value": f * 100, "unit": "% of layer area narrower than the nozzle",
                       "threshold": f"≤ {lim['thin_fraction_max'] * 100:g} %", "margin": m, "status": st, "score": s,
                       "inputs": {"nozzle_diameter_mm": params.get("nozzle_diameter_mm"), "worst_layer": la.get("thin_layer")}, "provenance": f"calculated (morphological opening); limit: {lim_prov}"})
    # 5 print time / layers
    tmin = out["print_time_s"] / 60
    m = min((lim["max_print_time_min"] - tmin) / lim["max_print_time_min"], (lim["max_layers"] - out["layer_count"]) / lim["max_layers"])
    st, s = _status(m)
    checks.append({"id": "time_layers", "label": "Print time and layer count vs limits", "value": tmin, "unit": f"min ({out['layer_count']} layers)",
                   "threshold": f"≤ {lim['max_print_time_min']:g} min and ≤ {lim['max_layers']:g} layers", "margin": m, "status": st, "score": s,
                   "inputs": {"print_speed_mm_s": params.get("print_speed_mm_s"), "layer_height_mm": params.get("layer_height_mm")}, "provenance": f"calculated; limits: {lim_prov}"})
    for c in checks:
        c["weight"] = CHECK_WEIGHTS[c["id"]]
    ev = [c for c in checks if c["status"] != "not evaluated"]
    score = 100 * sum(c["weight"] * c["score"] for c in ev) / sum(c["weight"] for c in ev) if ev else None
    limiting = min(ev, key=lambda c: (c["score"], c.get("margin", 0), -c["weight"])) if ev else None
    return {"score_pct": score, "based_on": f"based on {len(ev)} of {len(checks)} checks", "n_evaluated": len(ev), "n_checks": len(checks),
            "label": "compatibility index — not a success probability", "weights": CHECK_WEIGHTS, "limits": lim, "limits_provenance": lim_prov, "checks": checks,
            "limiting": {"id": limiting["id"], "label": limiting["label"], "status": limiting["status"], "advice": ADVICE[limiting["id"]]} if limiting else None,
            "formula": "score = 100 · Σ wᵢ·sᵢ / Σ wᵢ over evaluated checks; sᵢ = 1 (pass, margin ≥ 10 %), 0.5 (marginal, 0–10 %), 0 (fail)"}


# ------------------------------------------------------------------ G-code
def gcode(out: dict, params: dict, title: str = "Synthea print") -> str:
    ex = out.get("extrusion") or {}
    e_per_mm3 = ex.get("e_per_mm3")
    if not e_per_mm3:
        raise ValueError("Generate the toolpath with an extrusion method first")
    bead = out["line_width_mm"] * float(params.get("layer_height_mm", 1.0))
    f_print = float(params.get("print_speed_mm_s", 20.0)) * 60
    f_travel = float(params.get("travel_speed_mm_s", 60.0)) * 60
    man = out.get("manufacturability") or {}
    lines = [f"; {title}", "; Generated by Synthea Simulation (Synthea Print)", f"; Extrusion method: {ex.get('method')} — E axis = {ex.get('e_axis')}",
             f"; Layers: {out['layer_count']}, layer height {params.get('layer_height_mm')} mm, line width {out['line_width_mm']:.3f} mm, nozzle {params.get('nozzle_diameter_mm')} mm",
             f"; Estimated print time {out['print_time_s'] / 60:.1f} min, deposited volume {out['deposited_volume_cm3']:.2f} cm3",
             f"; Manufacturability: {('%.0f %%' % man['score_pct']) if man.get('score_pct') is not None else 'not evaluated'} ({man.get('based_on', '')}) — {man.get('label', '')}",
             "; Bead model: rectangular cross-section w x h; no die swell or sagging. Validate on the printer.",
             "G21 ; mm", "G90 ; absolute XYZ", "M83 ; relative extrusion", "G28 ; home", "G92 E0"]
    last = None
    for x, y, z, e in out["path"]:
        if last is None or not e:
            lines.append(f"G0 X{x:.3f} Y{y:.3f} Z{z:.3f} F{f_travel:.0f}")
        else:
            d = math.dist(last, (x, y, z))
            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{d * bead * e_per_mm3:.5f} F{f_print:.0f}")
        last = (x, y, z)
    lines += [f"G0 Z{out['layers'][-1]['z'] + 10:.3f} F{f_travel:.0f}", "M84 ; motors off", "; end"]
    return "\n".join(lines) + "\n"
