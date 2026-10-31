"""2-D cross-section geometry for digital twins and its structured finite-volume mesh.

A geometry is a parametric shape (dimensions in mm) or a user polygon, extruded by a depth
(mm) for 3-D display, plane-stress thickness and duct length. Every shape is converted to an
outer polygon plus optional hole polygons.

The mesh is a uniform Cartesian grid of square cells of size h; a cell belongs to the domain if
its centre lies inside the shape. Curved boundaries are therefore represented by a staircase.
The area error of this approximation is reported as a mesh-quality indicator and decreases
with refinement.

Boundary *segments* are the edges of the shape: ``bottom/right/top/left`` for a rectangle,
named edges for the L-shape, ``side n`` / ``edge n`` for polygons and stars, ``outer`` /
``inner`` for curved outlines and holes. Every boundary face of the staircase mesh is
assigned to the nearest segment. Boundary conditions are set per segment, with a
``default`` for all segments that are not set explicitly.
"""
from __future__ import annotations

import math

import numpy as np

SHAPES = {
    "rectangle": {"label": "Rectangle", "params": {"width": 40.0, "height": 20.0}},
    "circle": {"label": "Circle", "params": {"diameter": 30.0}},
    "ellipse": {"label": "Ellipse", "params": {"width": 40.0, "height": 24.0}},
    "annulus": {"label": "Ring (annulus)", "params": {"outer_diameter": 40.0, "inner_diameter": 16.0}},
    "l_shape": {"label": "L-shape", "params": {"width": 40.0, "height": 40.0, "cut_width": 20.0, "cut_height": 20.0}},
    "hexagon": {"label": "Hexagon", "params": {"diameter": 36.0}},
    "star": {"label": "Star", "params": {"outer_diameter": 40.0, "inner_diameter": 20.0, "points": 5}},
    "polygon": {"label": "Custom polygon", "params": {"points": [[0, 0], [40, 0], [40, 10], [20, 25], [0, 10]]}},
}
MESH_LEVELS = {"extra_coarse": 24, "coarse": 40, "normal": 70, "fine": 110, "extra_fine": 160}
MAX_CELLS_ACROSS = 220


def _circle(d, seg=160):
    r = d / 2
    t = np.linspace(0, 2 * math.pi, seg, endpoint=False)
    return np.c_[r * np.cos(t), r * np.sin(t)]


def polygons(geom: dict) -> tuple[np.ndarray, list[np.ndarray]]:
    """Return (outer polygon [mm], holes [mm]) for a geometry definition."""
    s = geom.get("shape", "rectangle")
    p = {**SHAPES.get(s, {"params": {}})["params"], **(geom.get("params") or {})}

    def pos(k):
        v = float(p[k])
        if not v > 0:
            raise ValueError(f"Geometry parameter '{k}' must be positive")
        return v

    if s == "rectangle":
        w, h = pos("width"), pos("height")
        return np.array([[0, 0], [w, 0], [w, h], [0, h]], float), []
    if s == "circle":
        return _circle(pos("diameter")), []
    if s == "ellipse":
        t = np.linspace(0, 2 * math.pi, 160, endpoint=False)
        return np.c_[pos("width") / 2 * np.cos(t), pos("height") / 2 * np.sin(t)], []
    if s == "annulus":
        do, di = pos("outer_diameter"), pos("inner_diameter")
        if di >= do:
            raise ValueError("Inner diameter must be smaller than the outer diameter")
        return _circle(do), [_circle(di)]
    if s == "l_shape":
        w, h, cw, ch = pos("width"), pos("height"), pos("cut_width"), pos("cut_height")
        if cw >= w or ch >= h:
            raise ValueError("The cut-out must be smaller than the overall L-shape")
        return np.array([[0, 0], [w, 0], [w, h - ch], [w - cw, h - ch], [w - cw, h], [0, h]], float), []
    if s == "hexagon":
        r = pos("diameter") / 2
        t = np.arange(6) * math.pi / 3
        return np.c_[r * np.cos(t), r * np.sin(t)], []
    if s == "star":
        R, r, n = pos("outer_diameter") / 2, pos("inner_diameter") / 2, int(p.get("points", 5))
        if r >= R or n < 3:
            raise ValueError("Star needs inner < outer diameter and at least 3 points")
        t = np.arange(2 * n) * math.pi / n + math.pi / 2
        rad = np.where(np.arange(2 * n) % 2 == 0, R, r)
        return np.c_[rad * np.cos(t), rad * np.sin(t)], []
    if s == "polygon":
        pts = np.array(p.get("points") or [], float)
        if pts.ndim != 2 or len(pts) < 3:
            raise ValueError("A custom polygon needs at least three points [x, y] in mm")
        holes = [np.array(hh, float) for hh in (p.get("holes") or []) if len(hh) >= 3]
        if abs(poly_area(pts)) < 1e-9:
            raise ValueError("Custom polygon has zero area")
        return pts, holes
    raise ValueError(f"Unknown shape '{s}'")


def segments(geom: dict) -> list[dict]:
    """Named boundary segments: [{id, label, ring (0 = outer, k = hole k), edges: [edge indices]}]."""
    s = geom.get("shape", "rectangle")
    outer, holes = polygons(geom)
    n = len(outer)
    if s == "rectangle":
        segs = [("bottom", "Bottom", [0]), ("right", "Right", [1]), ("top", "Top", [2]), ("left", "Left", [3])]
    elif s == "l_shape":
        segs = [("bottom", "Bottom", [0]), ("right", "Right (short)", [1]), ("step", "Step (top of short leg)", [2]), ("inner", "Inner side", [3]),
                ("top", "Top", [4]), ("left", "Left", [5])]
    elif s in ("circle", "ellipse", "annulus"):
        segs = [("outer", "Outer surface", list(range(n)))]
    elif s == "hexagon":
        segs = [(f"side{k + 1}", f"Side {k + 1}", [k]) for k in range(n)]
    else:
        segs = [(f"edge{k + 1}", f"Edge {k + 1}: ({outer[k][0]:g}, {outer[k][1]:g}) → ({outer[(k + 1) % n][0]:g}, {outer[(k + 1) % n][1]:g})", [k]) for k in range(n)]
    out = [{"id": i, "label": l, "ring": 0, "edges": e} for i, l, e in segs]
    for k, _h in enumerate(holes):
        out.append({"id": "inner" if s == "annulus" else f"hole{k + 1}", "label": "Inner surface" if s == "annulus" else f"Hole {k + 1}", "ring": k + 1, "edges": None})
    return out


def _seg_dist(px, py, P):
    """Distance of points to every edge of polygon P -> array (points, edges)."""
    a = P
    b = np.roll(P, -1, 0)
    ab = b - a
    L2 = np.maximum((ab ** 2).sum(1), 1e-30)
    t = ((px[:, None] - a[None, :, 0]) * ab[None, :, 0] + (py[:, None] - a[None, :, 1]) * ab[None, :, 1]) / L2[None, :]
    t = np.clip(t, 0, 1)
    cx = a[None, :, 0] + t * ab[None, :, 0]
    cy = a[None, :, 1] + t * ab[None, :, 1]
    return np.hypot(px[:, None] - cx, py[:, None] - cy)


def poly_area(P: np.ndarray) -> float:
    x, y = P[:, 0], P[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def poly_perimeter(P: np.ndarray) -> float:
    return float(np.sum(np.hypot(*(np.roll(P, -1, 0) - P).T)))


def inside(P: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Even-odd point-in-polygon test, vectorised over points."""
    res = np.zeros(x.shape, bool)
    xj, yj = P[-1]
    for xi, yi in P:
        cond = (yi > y) != (yj > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
        res ^= cond & (x < xint)
        xj, yj = xi, yi
    return res


def properties(geom: dict) -> dict:
    outer, holes = polygons(geom)
    area = abs(poly_area(outer)) - sum(abs(poly_area(h)) for h in holes)
    per = poly_perimeter(outer) + sum(poly_perimeter(h) for h in holes)
    lo, hi = outer.min(0), outer.max(0)
    return {"area_mm2": area, "perimeter_mm": per, "hydraulic_diameter_mm": 4 * area / per, "bbox_mm": [lo.tolist(), hi.tolist()],
            "depth_mm": float(geom.get("depth", 50.0)), "outline": outer.tolist(), "holes": [h.tolist() for h in holes]}


class Grid:
    """Uniform cell-centred grid restricted to the shape (units: metres)."""

    def __init__(self, geom: dict, mesh: dict | None = None):
        mesh = mesh or {}
        outer, holes = polygons(geom)
        self.outer_mm, self.holes_mm = outer, holes
        lo, hi = outer.min(0), outer.max(0)
        W, H = hi - lo
        n = int(mesh.get("cells_across") or MESH_LEVELS.get(mesh.get("level", "normal"), 70))
        n = max(8, min(n, MAX_CELLS_ACROSS))
        h_mm = max(W, H) / n
        self.nx, self.ny = int(math.ceil(W / h_mm - 1e-9)), int(math.ceil(H / h_mm - 1e-9))
        # centre the grid on the bounding box
        self.x0 = lo[0] - (self.nx * h_mm - W) / 2
        self.y0 = lo[1] - (self.ny * h_mm - H) / 2
        self.h_mm = h_mm
        self.h = h_mm / 1000.0
        self.depth = float(geom.get("depth", 50.0)) / 1000.0
        ii, jj = np.meshgrid(np.arange(self.nx), np.arange(self.ny))
        xc = self.x0 + (ii + 0.5) * h_mm
        yc = self.y0 + (jj + 0.5) * h_mm
        m = inside(outer, xc, yc)
        for hole in holes:
            m &= ~inside(hole, xc, yc)
        if m.sum() < 4:
            raise ValueError("Mesh too coarse for this geometry; refine the mesh")
        self.mask = m
        self.idx = -np.ones(m.shape, int)
        self.idx[m] = np.arange(int(m.sum()))
        self.n = int(m.sum())
        self.jc, self.ic = np.nonzero(m)  # row (y), column (x) of each cell in index order
        self.xc_mm, self.yc_mm = xc[m], yc[m]
        self.segments = segments(geom)
        self._faces(holes)

    def _faces(self, holes):
        """Interior face pairs and boundary faces with their group."""
        pairs = []
        a = self.idx[:, :-1]
        b = self.idx[:, 1:]
        k = (a >= 0) & (b >= 0)
        pairs.append(np.c_[a[k], b[k]])
        a = self.idx[:-1, :]
        b = self.idx[1:, :]
        k = (a >= 0) & (b >= 0)
        pairs.append(np.c_[a[k], b[k]])
        self.pairs = np.vstack(pairs)
        bc_cell, bc_dir = [], []
        dirs = {"left": (0, -1), "right": (0, 1), "bottom": (-1, 0), "top": (1, 0)}
        padded = np.pad(self.idx, 1, constant_values=-1)
        for name, (dj, di) in dirs.items():
            nb = padded[1 + dj:1 + dj + self.ny, 1 + di:1 + di + self.nx]
            sel = (self.idx >= 0) & (nb < 0)
            cells = self.idx[sel]
            bc_cell.append(cells)
            bc_dir.append(np.full(len(cells), name, object))
        self.b_cell = np.concatenate(bc_cell)
        self.b_dir = np.concatenate(bc_dir)
        # assign every boundary face to the nearest segment (outer polygon edges or hole rings)
        off = {"left": (-0.5, 0), "right": (0.5, 0), "bottom": (0, -0.5), "top": (0, 0.5)}
        fx = self.xc_mm[self.b_cell] + np.array([off[d][0] for d in self.b_dir]) * self.h_mm
        fy = self.yc_mm[self.b_cell] + np.array([off[d][1] for d in self.b_dir]) * self.h_mm
        rings = [self.outer_mm] + list(holes)
        best_d = np.full(len(fx), np.inf)
        best_ring = np.zeros(len(fx), int)
        best_edge = np.zeros(len(fx), int)
        for r, P in enumerate(rings):
            d = _seg_dist(fx, fy, P)
            e = d.argmin(1)
            dm = d[np.arange(len(fx)), e]
            better = dm < best_d
            best_d[better], best_ring[better], best_edge[better] = dm[better], r, e[better]
        group = np.empty(len(fx), object)
        for seg in self.segments:
            if seg["ring"] == 0:
                sel = (best_ring == 0) & np.isin(best_edge, seg["edges"])
            else:
                sel = best_ring == seg["ring"]
            group[sel] = seg["id"]
        self.b_group = group

    def boundary_nodes(self, group: str) -> np.ndarray:
        """Grid-node indices (node grid (ny+1) x (nx+1), row-major) on faces of a boundary group."""
        sel = self.b_group == group
        c, d = self.b_cell[sel], self.b_dir[sel]
        j, i = self.jc[c], self.ic[c]
        nodes = []
        for dd, (a, b) in {"left": ((0, 0), (1, 0)), "right": ((0, 1), (1, 1)), "bottom": ((0, 0), (0, 1)), "top": ((1, 0), (1, 1))}.items():
            s = d == dd
            for dj, di in (a, b):
                nodes.append((j[s] + dj) * (self.nx + 1) + i[s] + di)
        return np.unique(np.concatenate(nodes)) if nodes else np.array([], int)

    def info(self) -> dict:
        exact = abs(poly_area(self.outer_mm)) - sum(abs(poly_area(h)) for h in self.holes_mm)
        meshed = self.n * self.h_mm ** 2
        groups = {sg["id"]: int((self.b_group == sg["id"]).sum()) for sg in self.segments}
        return {"nx": self.nx, "ny": self.ny, "h_mm": self.h_mm, "cells": self.n, "x0_mm": self.x0, "y0_mm": self.y0,
                "depth_mm": self.depth * 1000, "nodes": int(self._node_count()), "boundary_faces": groups,
                "segments": [{k: sg[k] for k in ("id", "label")} | {"faces": groups[sg["id"]]} for sg in self.segments],
                "boundary_cells": {sg["id"]: sorted({int(c) for c in self.b_cell[self.b_group == sg["id"]]}) for sg in self.segments},
                "exact_area_mm2": exact, "meshed_area_mm2": meshed, "area_error_pct": 100 * (meshed - exact) / exact,
                "mask": "".join("1" if v else "0" for v in self.mask.ravel())}

    def _node_count(self):
        nm = np.zeros((self.ny + 1, self.nx + 1), bool)
        for dj in (0, 1):
            for di in (0, 1):
                nm[self.jc + dj, self.ic + di] = True
        return nm.sum()
