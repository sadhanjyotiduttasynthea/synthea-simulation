"""Numerical solvers for digital twins (structured finite-volume method).

Meshes
------
* ``cartesian3d``  : cuboid, nx·ny·nz cells
* ``axisym``       : cylinder (r, z), nr·nz cells, symmetry on the axis
* ``spherical1d``  : sphere, nr radial shells
* ``slab1d``       : 1-D slab (used for verification)

Physics
-------
* Transient / steady heat conduction  ρ cp ∂T/∂t = ∇·(k ∇T)   (backward Euler, sparse direct solve)
  with temperature-dependent properties (Picard lagging, properties evaluated at the previous step).
* Mass diffusion  ∂c/∂t = ∇·(D ∇c)  — same discretisation.
* First-order kinetics on the temperature history: X_{n+1} = X_n · exp(−k(T) Δt) per cell (exact for piecewise-constant T).
* Fully-developed laminar Herschel–Bulkley flow in a circular channel: wall stress from the
  Rabinowitsch–Mooney relation; velocity u(r) = ∫_r^R γ̇(τ_w s/R) ds by numerical quadrature.

Boundary conditions per boundary: ``convection`` (h, T∞) with half-cell series resistance,
``temperature`` (Dirichlet) or ``insulated``.
These are genuine numerical solutions of the stated PDEs on the stated meshes; they are not
3-D finite-element / CFD solutions of arbitrary geometries.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import cg, splu

from .science import rheology


@dataclass
class FVMesh:
    kind: str
    shape: tuple
    centers: dict          # coordinate arrays per axis (mm) for plotting
    volume: np.ndarray     # m^3 per cell (flattened)
    conn_i: np.ndarray     # internal face: cell i
    conn_j: np.ndarray     # internal face: cell j
    conn_g: np.ndarray     # internal face geometric factor A/d [m]
    bnd_cell: dict = field(default_factory=dict)   # tag -> cell indices
    bnd_area: dict = field(default_factory=dict)   # tag -> face areas [m^2]
    bnd_dist: dict = field(default_factory=dict)   # tag -> centre-to-face distance [m]
    cell_sizes: dict = field(default_factory=dict)

    @property
    def n(self):
        return int(np.prod(self.shape))

    def quality(self) -> dict:
        sizes = [v for v in self.cell_sizes.values()]
        hmin, hmax = min(s.min() for s in sizes), max(s.max() for s in sizes)
        aspect = hmax / hmin if hmin > 0 else math.inf
        return {"cells": self.n, "shape": list(self.shape), "type": self.kind, "min_cell_mm": hmin * 1e3, "max_cell_mm": hmax * 1e3,
                "max_aspect_ratio": aspect, "quality": "good" if aspect < 5 else "acceptable" if aspect < 20 else "poor",
                "element": {"cartesian3d": "hexahedral finite volumes", "axisym": "axisymmetric annular finite volumes", "spherical1d": "spherical shells", "slab1d": "1-D finite volumes"}[self.kind]}


def _faces_1d(n, h):
    return np.full(n, h)


def mesh_cuboid(w_mm, d_mm, h_mm, target_mm=None, max_cells=40000) -> FVMesh:
    L = np.array([w_mm, d_mm, h_mm]) * 1e-3
    if target_mm is None:
        target_mm = max(L.min() * 1e3 / 8, (L.prod() * 1e9 / 6000) ** (1 / 3))
    ns = np.maximum(3, np.ceil(L * 1e3 / target_mm).astype(int))
    while ns.prod() > max_cells:
        ns = np.maximum(3, (ns * 0.85).astype(int))
    nx, ny, nz = map(int, ns)
    dx, dy, dz = L / ns
    idx = np.arange(nx * ny * nz).reshape(nx, ny, nz)
    ci, cj, cg = [], [], []
    for axis, (dd, area) in enumerate(((dx, dy * dz), (dy, dx * dz), (dz, dx * dy))):
        a = np.take(idx, range(0, ns[axis] - 1), axis=axis).ravel()
        b = np.take(idx, range(1, ns[axis]), axis=axis).ravel()
        ci.append(a); cj.append(b); cg.append(np.full(a.size, area / dd))
    m = FVMesh("cartesian3d", (nx, ny, nz),
               {"x": (np.arange(nx) + 0.5) * dx * 1e3 - w_mm / 2, "y": (np.arange(ny) + 0.5) * dy * 1e3 - d_mm / 2, "z": (np.arange(nz) + 0.5) * dz * 1e3},
               np.full(nx * ny * nz, dx * dy * dz), np.concatenate(ci), np.concatenate(cj), np.concatenate(cg),
               cell_sizes={"x": np.array([dx]), "y": np.array([dy]), "z": np.array([dz])})
    for tag, sl, area, dist in (("x-", idx[0, :, :], dy * dz, dx / 2), ("x+", idx[-1, :, :], dy * dz, dx / 2),
                                ("y-", idx[:, 0, :], dx * dz, dy / 2), ("y+", idx[:, -1, :], dx * dz, dy / 2),
                                ("z-", idx[:, :, 0], dx * dy, dz / 2), ("z+", idx[:, :, -1], dx * dy, dz / 2)):
        cells = sl.ravel()
        m.bnd_cell[tag], m.bnd_area[tag], m.bnd_dist[tag] = cells, np.full(cells.size, area), np.full(cells.size, dist)
    return m


def mesh_cylinder(r_mm, h_mm, nr=None, nz=None) -> FVMesh:
    R, H = r_mm * 1e-3, h_mm * 1e-3
    nr = nr or max(8, min(40, int(round(r_mm / max(r_mm / 20, 0.1)))))
    nz = nz or max(6, min(80, int(round(H / (R / nr)))))
    dr, dz = R / nr, H / nz
    re = np.linspace(0, R, nr + 1)
    rc = (re[:-1] + re[1:]) / 2
    idx = np.arange(nr * nz).reshape(nr, nz)
    vol = np.repeat(np.pi * (re[1:] ** 2 - re[:-1] ** 2) * dz, nz)
    ci, cj, cg = [], [], []
    a, b = idx[:-1, :].ravel(), idx[1:, :].ravel()
    ci.append(a); cj.append(b); cg.append(np.repeat(2 * np.pi * re[1:-1] * dz, nz) / dr)
    a, b = idx[:, :-1].ravel(), idx[:, 1:].ravel()
    ci.append(a); cj.append(b); cg.append(np.repeat(np.pi * (re[1:] ** 2 - re[:-1] ** 2), nz - 1) / dz)
    m = FVMesh("axisym", (nr, nz), {"r": rc * 1e3, "z": (np.arange(nz) + 0.5) * dz * 1e3}, vol,
               np.concatenate(ci), np.concatenate(cj), np.concatenate(cg), cell_sizes={"r": np.array([dr]), "z": np.array([dz])})
    side = idx[-1, :]
    m.bnd_cell["side"], m.bnd_area["side"], m.bnd_dist["side"] = side, np.full(nz, 2 * np.pi * R * dz), np.full(nz, dr / 2)
    for tag, cells in (("bottom", idx[:, 0]), ("top", idx[:, -1])):
        m.bnd_cell[tag], m.bnd_area[tag], m.bnd_dist[tag] = cells, np.pi * (re[1:] ** 2 - re[:-1] ** 2), np.full(nr, dz / 2)
    return m


def mesh_sphere(r_mm, nr=40) -> FVMesh:
    R = r_mm * 1e-3
    re = np.linspace(0, R, nr + 1)
    vol = 4 / 3 * np.pi * (re[1:] ** 3 - re[:-1] ** 3)
    dr = R / nr
    m = FVMesh("spherical1d", (nr,), {"r": (re[:-1] + re[1:]) / 2 * 1e3}, vol, np.arange(nr - 1), np.arange(1, nr), 4 * np.pi * re[1:-1] ** 2 / dr,
               cell_sizes={"r": np.array([dr])})
    m.bnd_cell["surface"], m.bnd_area["surface"], m.bnd_dist["surface"] = np.array([nr - 1]), np.array([4 * np.pi * R ** 2]), np.array([dr / 2])
    return m


def mesh_slab(thickness_mm, n=50) -> FVMesh:
    L = thickness_mm * 1e-3
    dx = L / n
    m = FVMesh("slab1d", (n,), {"x": (np.arange(n) + 0.5) * dx * 1e3}, np.full(n, dx), np.arange(n - 1), np.arange(1, n), np.full(n - 1, 1 / dx),
               cell_sizes={"x": np.array([dx])})
    for tag, c in (("x-", 0), ("x+", n - 1)):
        m.bnd_cell[tag], m.bnd_area[tag], m.bnd_dist[tag] = np.array([c]), np.array([1.0]), np.array([dx / 2])
    return m


# ------------------------------------------------------------------ diffusion-type PDE
def solve_diffusion(mesh: FVMesh, cond, cap, bcs: dict, u0: float, t_end: float, dt: float, n_frames: int = 30, steady: bool = False,
                    source=None, on_step=None) -> dict:
    """Solve cap(u)·∂u/∂t = ∇·(cond(u) ∇u).

    cond(u)/cap(u): callables returning per-cell conductivity [W/m/K or m^2/s] and capacity [J/m^3/K or 1].
    bcs: tag -> {"type": "convection"|"temperature"|"insulated", "h": .., "T_inf": .., "value": ..}
    Returns frames of the field, times, boundary heat-flow history and an energy-balance check.
    """
    n = mesh.n
    u = np.full(n, float(u0))
    times, frames, bflux_hist = [0.0], [u.copy()], []
    steps = 1 if steady else max(1, int(math.ceil(t_end / dt)))
    dt_eff = t_end / steps if not steady else 1.0
    frame_every = max(1, steps // max(1, n_frames - 1))
    energy_in = 0.0
    stored = 0.0
    for s in range(steps):
        k = cond(u)
        c = cap(u)
        kf = 2 * k[mesh.conn_i] * k[mesh.conn_j] / np.maximum(k[mesh.conn_i] + k[mesh.conn_j], 1e-30)  # harmonic mean
        g = kf * mesh.conn_g
        rows = np.concatenate([mesh.conn_i, mesh.conn_j, mesh.conn_i, mesh.conn_j])
        cols = np.concatenate([mesh.conn_i, mesh.conn_j, mesh.conn_j, mesh.conn_i])
        vals = np.concatenate([g, g, -g, -g])
        diag = np.zeros(n)
        rhs = np.zeros(n)
        bterm = []
        for tag, spec in bcs.items():
            if tag not in mesh.bnd_cell or spec.get("type", "insulated") == "insulated":
                continue
            cells, A, d = mesh.bnd_cell[tag], mesh.bnd_area[tag], mesh.bnd_dist[tag]
            if spec["type"] == "convection":
                Ub = A / (1.0 / float(spec["h"]) + d / k[cells])
                ub = float(spec["T_inf"])
            elif spec["type"] == "temperature":
                Ub = A * k[cells] / d
                ub = float(spec["value"])
            else:
                continue
            np.add.at(diag, cells, Ub)
            np.add.at(rhs, cells, Ub * ub)
            bterm.append((cells, Ub, ub))
        if source is not None:
            rhs += source(u) * mesh.volume
        if not steady:
            mcap = c * mesh.volume / dt_eff
            diag += mcap
            rhs += mcap * u
        A_ = sparse.coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr() + sparse.diags(diag, format="csr")
        if n <= 1500:
            u_new = splu(A_.tocsc()).solve(rhs)
        else:  # symmetric positive-definite: Jacobi-preconditioned conjugate gradients, warm-started
            M = sparse.diags(1.0 / A_.diagonal())
            u_new, info = cg(A_, rhs, x0=u, rtol=1e-10, atol=0.0, M=M, maxiter=5000)
            if info != 0:
                u_new = splu(A_.tocsc()).solve(rhs)
        q = sum(float(np.sum(Ub * (ub - u_new[cells]))) for cells, Ub, ub in bterm)  # W into the body
        bflux_hist.append(q)
        energy_in += q * dt_eff
        if not steady:
            stored += float(np.sum(c * mesh.volume * (u_new - u)))  # consistent with the discretisation (lagged capacity)
        if on_step:
            on_step(u, u_new, dt_eff)
        u = u_new
        if steady or (s + 1) % frame_every == 0 or s == steps - 1:
            times.append((s + 1) * dt_eff if not steady else math.inf)
            frames.append(u.copy())
    balance = None
    if not steady and abs(energy_in) > 1e-12:
        balance = {"boundary_input": energy_in, "stored": stored, "relative_error": abs(stored - energy_in) / max(abs(energy_in), 1e-12)}
    return {"times": times, "frames": frames, "boundary_flow": bflux_hist, "balance": balance, "steps": steps, "dt": dt_eff}


# ------------------------------------------------------------------ analytic verification (1-D slab, convective, Bi)
def slab_series(x_over_L: float, Fo: float, Bi: float, terms: int = 60) -> float:
    """Dimensionless temperature θ = (T−T∞)/(Ti−T∞) for a plane wall of half-thickness L (symmetric convection)."""
    from scipy.optimize import brentq
    th = 0.0
    for nn in range(terms):
        lo, hi = nn * math.pi + 1e-9, nn * math.pi + math.pi / 2 - 1e-9
        z = brentq(lambda z: z * math.tan(z) - Bi, lo, hi)
        Cn = 4 * math.sin(z) / (2 * z + math.sin(2 * z))
        th += Cn * math.exp(-z * z * Fo) * math.cos(z * x_over_L)
    return th


# ------------------------------------------------------------------ laminar HB channel flow
def hb_channel(Q_m3_s: float | None, dP_Pa: float | None, R_m: float, L_m: float, tau_y: float, K: float, nidx: float, rho: float, nr: int = 60) -> dict:
    if Q_m3_s is None and dP_Pa is None:
        raise ValueError("Specify a volumetric flow rate or a pressure drop")
    if Q_m3_s is not None:
        pf = rheology.pipe_flow(Q_m3_s, 2 * R_m, L_m, tau_y, K, nidx, rho)
        tau_w = pf["wall_shear_stress_pa"]
    else:
        tau_w = dP_Pa * R_m / (2 * L_m)
        if tau_w <= tau_y:
            raise ValueError(f"Wall shear stress {tau_w:.3g} Pa does not exceed the yield stress {tau_y:.3g} Pa: no flow.")
        pf = {"warnings": []}
    r = np.linspace(0, R_m, nr)
    gam = np.array([rheology.hb_shear_rate(tau_w * ri / R_m, tau_y, K, nidx) for ri in r])
    # u(r) = ∫_r^R γ̇ dr' (no slip at wall), trapezoidal from the wall inwards
    u = np.zeros(nr)
    for i in range(nr - 2, -1, -1):
        u[i] = u[i + 1] + 0.5 * (gam[i] + gam[i + 1]) * (r[i + 1] - r[i])
    Qn = float(np.trapezoid(2 * np.pi * r * u, r))
    tau = tau_w * r / R_m
    with np.errstate(divide="ignore", invalid="ignore"):
        eta = np.where(gam > 0, tau / gam, np.nan)
    dP = 2 * tau_w * L_m / R_m
    return {"r_mm": (r * 1e3).tolist(), "velocity_m_s": u.tolist(), "shear_rate_1_s": gam.tolist(), "shear_stress_pa": tau.tolist(),
            "apparent_viscosity_pa_s": [None if not np.isfinite(x) else float(x) for x in eta], "wall_shear_stress_pa": tau_w,
            "wall_shear_rate_1_s": float(gam[-1]), "pressure_drop_pa": dP, "flow_rate_m3_s": Qn, "mean_velocity_m_s": Qn / (np.pi * R_m ** 2),
            "max_velocity_m_s": float(u[0]), "plug_radius_mm": tau_y / tau_w * R_m * 1e3, "warnings": pf.get("warnings", [])}
