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
        for outer, holes in layer_regions(shape, g, z - lh / 2, height):
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
                    ph = _offset_polygon(h, -d) if _area(h) > 0 else None
                    if ph is None:
                        ph = h * (1 + d / max(np.abs(h).max(), 1e-9))
                    loop = list(ph) + [ph[0]]
                    move(loop[0], z, False)
                    for pnt in loop[1:]:
                        move(pnt, z, True)
                    inner_holes[hi] = h * (1 + (lw * (k + 1)) / max(np.abs(h).max(), 1e-9))
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
        bead_weight_stress = (density or 1100) * 9.81 * height / 1000
        out["nozzle"]["self_weight_stress_base_pa"] = bead_weight_stress
        out["nozzle"]["yield_vs_self_weight"] = rheo["yield_stress_pa"] / bead_weight_stress if bead_weight_stress > 0 else None
        out["nozzle"]["note_shape"] = "Ratio of yield stress to hydrostatic stress at the base of the object (>1 suggests the material can resist gravity-driven flow when at rest; a screening indicator, not a printing success prediction)."
    else:
        unsupported.append("Nozzle pressure and shape-fidelity indicators require Herschel-Bulkley parameters (yield stress, K, n) for this formulation at the extrusion temperature.")
    unsupported.append("Printing success probability is not predicted (no validated model).")
    return out
