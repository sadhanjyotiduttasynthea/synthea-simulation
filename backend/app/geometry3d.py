"""Prototype geometry for Synthea Print: primitives and STL meshes, STL I/O and planar slicing.

Coordinates are millimetres with z up (build direction); the print bed is z = 0.
A geometry document holds objects:
  * 2-D sketches extruded along z: ``rectangle`` (width, depth), ``circle`` (diameter), ``ring`` (diameter,
    inner_diameter), ``polygon`` (points [[x, y], ...]); each with ``height``;
  * 3-D primitives: ``box`` (width, depth, height), ``cylinder`` (diameter, height), ``cone`` (diameter, top_diameter,
    height), ``sphere`` (diameter);
  * ``mesh``: an imported STL (vertices, faces).
Every object has a position (x, y, z of its base centre) and is converted to a closed triangle mesh. Objects are sliced
together; they must not overlap (no boolean union is performed — overlapping volumes are reported).
"""
from __future__ import annotations

import io
import math
import struct
from collections import defaultdict

import numpy as np

KINDS = {
    "rectangle": {"label": "Rectangle (extruded)", "params": {"width": 30.0, "depth": 20.0, "height": 10.0}},
    "circle": {"label": "Circle (extruded)", "params": {"diameter": 25.0, "height": 10.0}},
    "ring": {"label": "Ring (extruded)", "params": {"diameter": 30.0, "inner_diameter": 15.0, "height": 10.0}},
    "polygon": {"label": "Polygon sketch (extruded)", "params": {"points": [[0, 0], [30, 0], [30, 10], [15, 20], [0, 10]], "height": 10.0}},
    "box": {"label": "Box", "params": {"width": 30.0, "depth": 20.0, "height": 15.0}},
    "cylinder": {"label": "Cylinder", "params": {"diameter": 25.0, "height": 15.0}},
    "cone": {"label": "Cone / frustum", "params": {"diameter": 30.0, "top_diameter": 10.0, "height": 20.0}},
    "sphere": {"label": "Sphere", "params": {"diameter": 25.0}},
}
SEG = 64
MAX_TRIANGLES = 400_000


# ------------------------------------------------------------------ 2-D helpers
def poly_area(P: np.ndarray) -> float:
    x, y = P[:, 0], P[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _circle(r, n=SEG):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return np.c_[r * np.cos(t), r * np.sin(t)]


def _inside(P, x, y) -> bool:
    res = False
    xj, yj = P[-1]
    for xi, yi in P:
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            res = not res
        xj, yj = xi, yi
    return res


def earclip(P: np.ndarray) -> list[tuple[int, int, int]]:
    """Ear-clipping triangulation of a simple polygon (counter-clockwise result indices)."""
    n = len(P)
    idx = list(range(n)) if poly_area(P) > 0 else list(range(n))[::-1]
    tris = []

    def cross(o, a, b):
        return (P[a][0] - P[o][0]) * (P[b][1] - P[o][1]) - (P[a][1] - P[o][1]) * (P[b][0] - P[o][0])

    guard = 0
    while len(idx) > 3 and guard < 10 * n * n:
        guard += 1
        m = len(idx)
        for k in range(m):
            a, b, c = idx[k - 1], idx[k], idx[(k + 1) % m]
            if cross(a, b, c) <= 1e-12:
                continue
            tri = np.array([P[a], P[b], P[c]])
            if any(_inside(tri, *P[j]) for j in idx if j not in (a, b, c)):
                continue
            tris.append((a, b, c))
            idx.pop(k)
            break
        else:
            raise ValueError("Polygon is self-intersecting or degenerate; cannot triangulate")
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


# ------------------------------------------------------------------ meshes
def _extrude(outer: np.ndarray, height: float, holes: list[np.ndarray] | None = None):
    """Closed prism mesh from a polygon (optionally one hole with the same vertex count as the outer loop)."""
    if poly_area(outer) < 0:
        outer = outer[::-1]
    n = len(outer)
    V, F = [], []
    if holes:
        h = holes[0]
        if poly_area(h) < 0:
            h = h[::-1]
        if len(h) != n:
            raise ValueError("Ring meshes need matching outer/inner vertex counts")
        for z in (0.0, height):
            V += [[x, y, z] for x, y in outer] + [[x, y, z] for x, y in h]
        ob, ib, ot, it = 0, n, 2 * n, 3 * n
        for i in range(n):
            j = (i + 1) % n
            F += [[ob + i, ib + j, ob + j], [ob + i, ib + i, ib + j]]          # bottom (down)
            F += [[ot + i, ot + j, it + j], [ot + i, it + j, it + i]]          # top (up)
            F += [[ob + i, ob + j, ot + j], [ob + i, ot + j, ot + i]]          # outer wall
            F += [[ib + i, it + j, ib + j], [ib + i, it + i, it + j]]          # inner wall (facing the hole)
        return np.array(V, float), np.array(F, int)
    tris = earclip(outer)
    V = [[x, y, 0.0] for x, y in outer] + [[x, y, height] for x, y in outer]
    F = [[a, c, b] for a, b, c in tris] + [[a + n, b + n, c + n] for a, b, c in tris]
    for i in range(n):
        j = (i + 1) % n
        F += [[i, j, j + n], [i, j + n, i + n]]
    return np.array(V, float), np.array(F, int)


def _frustum(r0, r1, height, n=SEG):
    b = _circle(r0, n)
    t = _circle(max(r1, 1e-6), n)
    V = [[x, y, 0.0] for x, y in b] + [[x, y, height] for x, y in t] + [[0, 0, 0], [0, 0, height]]
    F = []
    cb, ct = 2 * n, 2 * n + 1
    for i in range(n):
        j = (i + 1) % n
        F += [[i, j, j + n], [i, j + n, i + n], [cb, j, i], [ct, i + n, j + n]]
    return np.array(V, float), np.array(F, int)


def _sphere(r, n=32):
    V, F = [], []
    rings = n // 2
    for a in range(rings + 1):
        phi = math.pi * a / rings
        for b in range(n):
            th = 2 * math.pi * b / n
            V.append([r * math.sin(phi) * math.cos(th), r * math.sin(phi) * math.sin(th), r - r * math.cos(phi)])
    for a in range(rings):
        for b in range(n):
            p, q = a * n + b, a * n + (b + 1) % n
            pn, qn = p + n, q + n
            F += [[p, q, qn], [p, qn, pn]]
    V = np.array(V, float)
    return V, np.array(F, int)


def object_mesh(obj: dict) -> tuple[np.ndarray, np.ndarray]:
    k = obj.get("kind")
    p = {**KINDS.get(k, {"params": {}})["params"], **(obj.get("params") or {})}

    def pos(key):
        v = float(p[key])
        if not v > 0:
            raise ValueError(f"{obj.get('name', k)}: '{key}' must be positive")
        return v

    if k == "rectangle" or k == "box":
        w, d = pos("width"), pos("depth")
        V, F = _extrude(np.array([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]), pos("height"))
    elif k == "circle" or k == "cylinder":
        V, F = _extrude(_circle(pos("diameter") / 2), pos("height"))
    elif k == "ring":
        if pos("inner_diameter") >= pos("diameter"):
            raise ValueError("Ring: inner diameter must be smaller than the outer diameter")
        V, F = _extrude(_circle(pos("diameter") / 2), pos("height"), [_circle(pos("inner_diameter") / 2)])
    elif k == "polygon":
        pts = np.array(p.get("points") or [], float)
        if len(pts) < 3:
            raise ValueError("Polygon sketch needs at least three points")
        pts = pts - pts.mean(axis=0)
        V, F = _extrude(pts, pos("height"))
    elif k == "cone":
        V, F = _frustum(pos("diameter") / 2, float(p.get("top_diameter") or 0) / 2, pos("height"))
    elif k == "sphere":
        V, F = _sphere(pos("diameter") / 2)
    elif k == "mesh":
        V, F = np.array(obj["vertices"], float), np.array(obj["faces"], int)
    else:
        raise ValueError(f"Unknown geometry kind '{k}'")
    off = np.array(obj.get("position") or [0, 0, 0], float)
    return V + off, F


def geometry_mesh(objects: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    Vs, Fs, base = [], [], 0
    for o in objects:
        if o.get("hidden"):
            continue
        V, F = object_mesh(o)
        Vs.append(V)
        Fs.append(F + base)
        base += len(V)
    if not Vs:
        raise ValueError("The geometry has no visible objects")
    V, F = np.vstack(Vs), np.vstack(Fs)
    if len(F) > MAX_TRIANGLES:
        raise ValueError(f"Mesh has {len(F)} triangles; the limit is {MAX_TRIANGLES}")
    return V, F


def mesh_info(V, F) -> dict:
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    cr = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cr, axis=1)
    vol = float(np.sum(np.einsum("ij,ij->i", a, np.cross(b, c))) / 6.0)
    return {"triangles": int(len(F)), "vertices": int(len(V)), "bbox_mm": [V.min(0).round(3).tolist(), V.max(0).round(3).tolist()],
            "surface_mm2": float(area.sum()), "volume_mm3": abs(vol), "closed_orientation_ok": vol > 0}


# ------------------------------------------------------------------ STL
def read_stl(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    if data[:5].lower() == b"solid" and b"facet" in data[:400]:
        txt = data.decode("utf-8", "replace")
        pts = [list(map(float, l.split()[1:4])) for l in txt.splitlines() if l.strip().startswith("vertex")]
        tri = np.array(pts, float).reshape(-1, 3, 3)
    else:
        if len(data) < 84:
            raise ValueError("Not an STL file")
        n = struct.unpack("<I", data[80:84])[0]
        if len(data) < 84 + 50 * n:
            raise ValueError("Truncated binary STL")
        rec = np.frombuffer(data[84:84 + 50 * n], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
        tri = rec["v"].astype(float)
    if len(tri) == 0:
        raise ValueError("STL contains no triangles")
    if len(tri) > MAX_TRIANGLES:
        raise ValueError(f"STL has {len(tri)} triangles; the limit is {MAX_TRIANGLES}")
    flat = tri.reshape(-1, 3)
    key = np.round(flat, 5)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    F = inv.reshape(-1, 3)
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    V = uniq.astype(float)
    # place on the bed, centred in x/y
    V[:, :2] -= (V[:, :2].min(0) + V[:, :2].max(0)) / 2
    V[:, 2] -= V[:, 2].min()
    return V, F


def write_stl(V: np.ndarray, F: np.ndarray, name: str = "synthea") -> bytes:
    buf = io.BytesIO()
    buf.write(name.encode()[:80].ljust(80, b" "))
    buf.write(struct.pack("<I", len(F)))
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    nrm = np.cross(b - a, c - a)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-30)
    rec = np.zeros(len(F), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"] = nrm
    rec["v"] = np.stack([a, b, c], axis=1)
    buf.write(rec.tobytes())
    return buf.getvalue()


# ------------------------------------------------------------------ slicing
def slice_mesh(V: np.ndarray, F: np.ndarray, z: float) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    """Intersect the mesh with the plane z; return regions [(outer, [holes])] (even-odd nesting)."""
    z = float(z)
    tri = V[F]
    d = tri[:, :, 2] - z
    d = np.where(np.abs(d) < 1e-9, 1e-9, d)  # avoid vertices exactly on the plane
    sgn = d > 0
    cross = sgn.any(1) & (~sgn).any(1)
    segs = []
    for t, dd in zip(tri[cross], d[cross]):
        pts = []
        for i, j in ((0, 1), (1, 2), (2, 0)):
            if (dd[i] > 0) != (dd[j] > 0):
                s = dd[i] / (dd[i] - dd[j])
                pts.append(t[i, :2] + s * (t[j, :2] - t[i, :2]))
        if len(pts) == 2 and np.linalg.norm(pts[0] - pts[1]) > 1e-9:
            segs.append(pts)
    if not segs:
        return []
    # chain segments into closed loops
    def key(p):
        return (round(float(p[0]), 4), round(float(p[1]), 4))
    adj = defaultdict(list)
    for i, (a, b) in enumerate(segs):
        adj[key(a)].append((i, b))
        adj[key(b)].append((i, a))
    used = [False] * len(segs)
    loops = []
    for i, (a, b) in enumerate(segs):
        if used[i]:
            continue
        used[i] = True
        loop = [a, b]
        cur = key(b)
        start = key(a)
        while cur != start:
            nxt = next(((j, q) for j, q in adj[cur] if not used[j]), None)
            if nxt is None:
                break
            used[nxt[0]] = True
            loop.append(nxt[1])
            cur = key(nxt[1])
        if len(loop) >= 4 and key(loop[-1]) == start:
            P = np.array(loop[:-1])
            if abs(poly_area(P)) > 1e-6:
                loops.append(P)
    # nesting: depth = number of loops containing a point of this loop
    depth = []
    for i, L in enumerate(loops):
        p = L[0]
        depth.append(sum(1 for j, M in enumerate(loops) if j != i and _inside(M, p[0], p[1])))
    regions = []
    for i, L in enumerate(loops):
        if depth[i] % 2:
            continue
        holes = [M for j, M in enumerate(loops) if depth[j] == depth[i] + 1 and _inside(L, M[0][0], M[0][1])]
        outer = L if poly_area(L) > 0 else L[::-1]
        regions.append((outer, [h if poly_area(h) < 0 else h[::-1] for h in holes]))
    return regions


def overlap_warning(objects: list[dict]) -> str | None:
    boxes = []
    for o in objects:
        if o.get("hidden"):
            continue
        V, _ = object_mesh(o)
        boxes.append((V.min(0), V.max(0), o.get("name") or o.get("kind")))
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a0, a1, na = boxes[i]
            b0, b1, nb = boxes[j]
            if np.all(a0 < b1 - 1e-6) and np.all(b0 < a1 - 1e-6):
                return f"Objects '{na}' and '{nb}' overlap: volumes are not merged (no boolean union) — overlapping regions may print twice or as holes."
    return None
