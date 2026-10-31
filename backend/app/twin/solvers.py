"""2-D solvers for digital twins (NumPy / SciPy sparse).

All solvers work on a :class:`~app.twin.geometry.Grid` (uniform square cells of size h,
staircase boundary). Units are SI internally; temperatures in degC (heat equation is linear).

* :func:`solve_scalar` -- transient or steady diffusion equation
  ``C dT/dt = div(k grad T) + q``, cell-centred finite volumes, implicit Euler.
  Used for heat conduction (C = rho*cp, k) and mass diffusion (C = 1, k = D).
  Optional coupled first-order Arrhenius kinetics ``dX/dt = -k(T) X``.
* :func:`solve_duct_flow` -- fully developed laminar flow through a duct with the given
  cross-section: ``div(mu(gamma) grad w) = -G`` (G = -dp/dz), no slip on all walls,
  generalised-Newtonian viscosity (Newtonian, power law, Herschel-Bulkley with
  Papanastasiou regularisation), Picard iteration. Either G or the flow rate is prescribed.
* :func:`solve_elasticity` -- 2-D linear elasticity (plane stress or plane strain), bilinear
  quadrilateral (Q4) finite elements on the same cells, 2x2 Gauss integration.

These are 2-D continuum solvers, not 3-D CFD/FEA. Every solver reports the governing
equation, discretisation, assumptions and a conservation / equilibrium check.
"""
from __future__ import annotations

import math
from typing import Callable

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

from .geometry import Grid, poly_perimeter

R_GAS = 8.314462618
G_ACC = 9.80665

Progress = Callable[[float, str], None]


class Cancelled(Exception):
    pass


def _noop(_f, _m):
    return None


def _never():
    return False


def pack(a: np.ndarray, sig: int = 5) -> list:
    """Round to significant figures for compact JSON."""
    a = np.asarray(a, float)
    a = np.where(np.abs(a) < 1e-250, 0.0, a)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        mag = np.where(a == 0, 0, np.floor(np.log10(np.abs(np.where(a == 0, 1, a)))))
        f = 10.0 ** (sig - 1 - mag)
        out = np.round(a * f) / f
    out = np.where(np.isfinite(out), out, a)
    return [None if not math.isfinite(v) else float(v) for v in out]


def bc_for(bcs: dict, segment: str, fallback: dict) -> dict:
    """Boundary condition of a segment; segments not set explicitly use ``default``."""
    return bcs.get(segment) or bcs.get("default") or fallback


# ---------------------------------------------------------------- scalar diffusion (heat / mass)
def _laplacian(g: Grid, cond: float) -> sp.csr_matrix:
    a, b = g.pairs[:, 0], g.pairs[:, 1]
    G = np.full(len(a), cond)
    rows = np.r_[a, b, a, b]
    cols = np.r_[a, b, b, a]
    vals = np.r_[G, G, -G, -G]
    return sp.csr_matrix((vals, (rows, cols)), shape=(g.n, g.n))


def boundary_terms(g: Grid, cond: float, bcs: dict, kind: str = "heat") -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Diagonal additions and right-hand side from boundary conditions (per unit depth)."""
    diag = np.zeros(g.n)
    rhs = np.zeros(g.n)
    notes = []
    fixed_name = "temperature" if kind == "heat" else "concentration"
    coef_name = "h" if kind == "heat" else "km"
    for grp in np.unique(g.b_group):
        bc = bc_for(bcs, grp, {"type": "insulated"})
        cells = g.b_cell[g.b_group == grp]
        t = bc.get("type", "insulated")
        if t == fixed_name or t == "fixed":
            Gb = 2 * cond
            np.add.at(diag, cells, Gb)
            np.add.at(rhs, cells, Gb * float(bc["value"]))
        elif t in ("convection", "mass_transfer"):
            hc = float(bc.get(coef_name, bc.get("h", bc.get("km", 0.0))))
            if hc <= 0:
                raise ValueError(f"Boundary '{grp}': transfer coefficient must be positive")
            Gb = 1.0 / (1.0 / (2 * cond) + 1.0 / (hc * g.h))
            np.add.at(diag, cells, Gb)
            np.add.at(rhs, cells, Gb * float(bc["ambient"]))
        elif t == "flux":
            np.add.at(rhs, cells, float(bc["flux"]) * g.h)
        elif t in ("insulated", "impermeable", "symmetry"):
            pass
        else:
            raise ValueError(f"Boundary '{grp}': unknown condition '{t}'")
        notes.append(f"{grp}: {t}")
    return diag, rhs, notes


def solve_scalar(g: Grid, *, cond: float, cap: float, bcs: dict, initial: float, t_end: float = 0.0, dt: float | None = None,
                 source: float = 0.0, steady: bool = False, kinetics: dict | None = None, target: float | None = None,
                 kind: str = "heat", frames: int = 16, progress: Progress = _noop, cancelled: Callable[[], bool] = _never) -> dict:
    if cond <= 0 or (not steady and cap <= 0):
        raise ValueError("Conductivity/diffusivity and capacity must be positive")
    K = _laplacian(g, cond)
    diag, rhs_b, notes = boundary_terms(g, cond, bcs, kind)
    K = (K + sp.diags(diag)).tocsc()
    b = rhs_b + source * g.h ** 2
    anchored = bool(np.any(diag > 0))
    probe = int(np.argmin((g.xc_mm - g.xc_mm.mean()) ** 2 + (g.yc_mm - g.yc_mm.mean()) ** 2))
    res = {"probe_cell": probe, "probe_xy_mm": [float(g.xc_mm[probe]), float(g.yc_mm[probe])], "bc_notes": notes}
    if steady:
        if not anchored:
            raise ValueError("A steady-state problem needs at least one fixed-value or transfer-coefficient boundary (otherwise the solution is not unique).")
        progress(0.3, "factorising steady-state system")
        T = spla.spsolve(K, b)
        res.update({"times": [0.0], "frames": [pack(T)], "history": {"t": [0.0], "min": [float(T.min())], "mean": [float(T.mean())], "max": [float(T.max())],
                                                                      "probe": [float(T[probe])]}})
        res["balance"] = _balance(g, cond, bcs, T, kind, source)
        return res
    if t_end <= 0:
        raise ValueError("End time must be positive for a transient study")
    nsteps = int(math.ceil(t_end / dt)) if dt else 400
    nsteps = max(10, min(nsteps, 20000))
    dt = t_end / nsteps
    C = cap * g.h ** 2
    A = (sp.identity(g.n, format="csc") * (C / dt) + K).tocsc()
    lu = spla.splu(A)
    T = np.full(g.n, float(initial))
    X = np.ones(g.n) if kinetics else None
    frame_steps = set(np.unique(np.linspace(0, nsteps, frames).round().astype(int)).tolist())
    times, fr, frx = [], [], []
    hist = {"t": [], "min": [], "mean": [], "max": [], "probe": []}
    if X is not None:
        hist.update({"x_mean": [], "x_min": []})
    reached = None
    every = max(1, nsteps // 300)

    def record(step):
        t = step * dt
        if step % every == 0 or step == nsteps:
            hist["t"].append(t)
            hist["min"].append(float(T.min()))
            hist["mean"].append(float(T.mean()))
            hist["max"].append(float(T.max()))
            hist["probe"].append(float(T[probe]))
            if X is not None:
                hist["x_mean"].append(float(X.mean()))
                hist["x_min"].append(float(X.min()))
        if step in frame_steps:
            times.append(t)
            fr.append(pack(T))
            if X is not None:
                frx.append(pack(X, 4))

    record(0)
    E0 = float(np.sum(C * T))
    for s in range(1, nsteps + 1):
        T = lu.solve(C / dt * T + b)
        if X is not None:
            k = kinetics["k_ref"] * np.exp(-(kinetics["Ea"] / R_GAS) * (1.0 / (T + 273.15) - 1.0 / (kinetics["T_ref_c"] + 273.15)))
            X = X * np.exp(-k * dt)
        if target is not None and reached is None and T.min() >= target:
            reached = s * dt
        record(s)
        if s % max(1, nsteps // 50) == 0:
            progress(s / nsteps, f"t = {s * dt:.4g} s / {t_end:.4g} s")
            if cancelled():
                raise Cancelled()
    res.update({"times": times, "frames": fr, "history": hist, "dt": dt, "steps": nsteps})
    if X is not None:
        res["kinetics_frames"] = frx
    if target is not None:
        res["target"] = {"value": target, "time_all_cells_reached_s": reached}
    stored = (float(np.sum(C * T)) - E0) * g.depth
    bal = _balance(g, cond, bcs, T, kind, source)
    res["balance"] = {**bal, "stored_change": stored, "note": "Stored change over the run (J for heat); boundary flow rate at the final time."}
    return res


def _balance(g, cond, bcs, T, kind, source):
    """Boundary flow (W, or mol/s per unit concentration scale) at the given field, by group."""
    out = {}
    for grp in np.unique(g.b_group):
        bc = bc_for(bcs, grp, {"type": "insulated"})
        cells = g.b_cell[g.b_group == grp]
        t = bc.get("type", "insulated")
        if t in ("temperature", "concentration", "fixed"):
            q = 2 * cond * (float(bc["value"]) - T[cells])
        elif t in ("convection", "mass_transfer"):
            hc = float(bc.get("h", bc.get("km", 0.0)))
            q = (float(bc["ambient"]) - T[cells]) / (1 / (2 * cond) + 1 / (hc * g.h))
        elif t == "flux":
            q = np.full(len(cells), float(bc["flux"]) * g.h)
        else:
            q = np.zeros(len(cells))
        out[grp] = float(q.sum() * g.depth)
    return {"boundary_inflow": out, "total_inflow": float(sum(out.values())), "source_total": float(source * g.n * g.h ** 2 * g.depth)}


# ---------------------------------------------------------------- duct flow
def _viscosity(gd: np.ndarray, law: dict) -> np.ndarray:
    tau0, K, n = law.get("tau0", 0.0), law["K"], law.get("n", 1.0)
    m = law.get("m_reg", 1000.0)
    gd = np.maximum(gd, 1e-5)
    mu = K * gd ** (n - 1.0)
    if tau0 > 0:
        mu = mu + tau0 * (1.0 - np.exp(-m * gd)) / gd
    return np.minimum(mu, law.get("mu_max", 1e7))


def _shear_rate(g: Grid, w: np.ndarray) -> np.ndarray:
    W = np.full((g.ny + 2, g.nx + 2), np.nan)
    W[1:-1, 1:-1][g.mask] = w

    def side(nb):
        ok = ~np.isnan(nb)
        return np.where(ok, nb, 0.0), np.where(ok, g.h, g.h / 2)

    e, de = side(W[1:-1, 2:])
    wv, dw = side(W[1:-1, :-2])
    nn, dn = side(W[2:, 1:-1])
    s, ds = side(W[:-2, 1:-1])
    gx = (e - wv) / (de + dw)
    gy = (nn - s) / (dn + ds)
    gm = np.sqrt(gx ** 2 + gy ** 2)
    return gm[g.mask]


def _flow_solve(g: Grid, G: float, law: dict, w0: np.ndarray | None, tol=1e-6, maxit=400) -> tuple[np.ndarray, np.ndarray, int]:
    a, b = g.pairs[:, 0], g.pairs[:, 1]
    newtonian = law.get("tau0", 0) == 0 and abs(law.get("n", 1) - 1) < 1e-12
    mu = np.full(g.n, law["K"]) if (w0 is None or newtonian) else _viscosity(_shear_rate(g, w0), law)
    w = w0
    it = 0
    for it in range(1, maxit + 1):
        mf = 2 * mu[a] * mu[b] / (mu[a] + mu[b])
        diag = np.zeros(g.n)
        np.add.at(diag, g.b_cell, 2 * mu[g.b_cell])
        A = sp.csr_matrix((np.r_[mf, mf, -mf, -mf], (np.r_[a, b, a, b], np.r_[a, b, b, a])), shape=(g.n, g.n)) + sp.diags(diag)
        w_new = spla.spsolve(A.tocsc(), np.full(g.n, G * g.h ** 2))
        if newtonian:
            return w_new, mu, 1
        if w is not None and np.max(np.abs(w_new - w)) <= tol * max(np.max(np.abs(w_new)), 1e-30):
            w = w_new
            break
        w = w_new
        mu_new = _viscosity(_shear_rate(g, w), law)
        mu = np.exp(0.5 * np.log(mu) + 0.5 * np.log(mu_new))
    return w, mu, it


def solve_duct_flow(g: Grid, *, law: dict, mode: str = "pressure_gradient", pressure_gradient: float | None = None, flow_rate_m3_s: float | None = None,
                    length: float | None = None, density: float | None = None, progress: Progress = _noop, cancelled: Callable[[], bool] = _never) -> dict:
    if law["K"] <= 0 or law.get("n", 1) <= 0 or law.get("tau0", 0) < 0:
        raise ValueError("Invalid rheological parameters (K > 0, n > 0, tau0 >= 0 required)")
    area = g.n * g.h ** 2
    iters = 0
    if mode == "pressure_gradient":
        G = float(pressure_gradient)
        if G <= 0:
            raise ValueError("Pressure gradient must be positive")
        progress(0.2, "Picard iteration on apparent viscosity")
        w, mu, iters = _flow_solve(g, G, law, None)
    elif mode == "flow_rate":
        Qt = float(flow_rate_m3_s)
        if Qt <= 0:
            raise ValueError("Flow rate must be positive")
        # Newtonian estimate with the viscosity at the nominal wall shear rate
        dh = 4 * area / (len(g.b_cell) * g.h)
        gd_nom = 8 * (Qt / area) / dh
        mu_nom = float(_viscosity(np.array([gd_nom]), law)[0])
        w1, _, _ = _flow_solve(g, 1.0, {"K": mu_nom, "n": 1.0}, None)
        G = Qt / (w1.sum() * g.h ** 2)
        w = None
        lg, lq = [], []
        for k in range(40):
            w, mu, it = _flow_solve(g, G, law, w)
            iters += it
            Q = w.sum() * g.h ** 2
            progress(min(0.9, 0.1 + k / 20), f"flow-rate iteration {k + 1}: Q = {Q:.4g} m3/s, G = {G:.4g} Pa/m")
            if cancelled():
                raise Cancelled()
            if abs(Q - Qt) <= 1e-5 * Qt:
                break
            lg.append(math.log(G))
            lq.append(math.log(Q))
            if len(lg) >= 2 and abs(lq[-1] - lq[-2]) > 1e-12:
                slope = (lg[-1] - lg[-2]) / (lq[-1] - lq[-2])
                slope = min(max(slope, 0.05), 20)
            else:
                slope = law.get("n", 1.0)
            G = math.exp(lg[-1] + slope * (math.log(Qt) - lq[-1]))
    else:
        raise ValueError("mode must be 'pressure_gradient' or 'flow_rate'")
    gd = _shear_rate(g, w)
    tau = mu * gd
    Q = float(w.sum() * g.h ** 2)
    P_exact = (poly_perimeter(g.outer_mm) + sum(poly_perimeter(h) for h in g.holes_mm)) / 1000.0
    tau_w_avg = G * area / P_exact  # global force balance
    wall_tau = 2 * mu[g.b_cell] * w[g.b_cell] / g.h
    dh = 4 * area / P_exact
    ubar = Q / area
    res = {"velocity": pack(w), "shear_rate": pack(gd), "viscosity": pack(mu), "shear_stress": pack(tau),
           "pressure_gradient_pa_m": G, "flow_rate_m3_s": Q, "mean_velocity_m_s": ubar, "max_velocity_m_s": float(w.max()),
           "wall_shear_stress_avg_pa": tau_w_avg, "wall_shear_stress_max_pa": float(wall_tau.max()), "hydraulic_diameter_m": dh,
           "max_shear_rate_s": float(gd.max()), "picard_iterations": iters, "flow_area_m2": area,
           "force_balance": {"pressure_force_n_per_m": G * area, "wall_force_n_per_m": float(wall_tau.sum() * g.h),
                             "relative_error": float(abs(wall_tau.sum() * g.h - G * area) / (G * area))}}
    if law.get("tau0", 0) > 0:
        unyielded = tau < law["tau0"]
        res["unyielded_fraction"] = float(unyielded.mean())
        res["unyielded"] = [int(v) for v in unyielded]
    if length:
        res["length_m"] = length
        res["pressure_drop_pa"] = G * length
        res["hydraulic_power_w"] = G * length * Q
    if density:
        res["mass_flow_kg_h"] = Q * density * 3600
        mu_eff = tau_w_avg / max(8 * ubar / dh, 1e-12)
        res["reynolds_generalised"] = density * ubar * dh / mu_eff
        res["reynolds_generalised"] = float(res["reynolds_generalised"])
        res["laminar"] = bool(res["reynolds_generalised"] < 2100)
    return res


# ---------------------------------------------------------------- linear elasticity (Q4)
_GP = np.array([-1, 1]) / math.sqrt(3)
_XI = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)


def _B(xi, eta, h):
    dN_dxi = 0.25 * np.array([_XI[:, 0] * (1 + eta * _XI[:, 1])])[0]
    dN_deta = 0.25 * np.array([_XI[:, 1] * (1 + xi * _XI[:, 0])])[0]
    dx, dy = dN_dxi * 2 / h, dN_deta * 2 / h
    B = np.zeros((3, 8))
    B[0, 0::2] = dx
    B[1, 1::2] = dy
    B[2, 0::2] = dy
    B[2, 1::2] = dx
    return B


def _D(E, nu, plane):
    if plane == "strain":
        c = E / ((1 + nu) * (1 - 2 * nu))
        return c * np.array([[1 - nu, nu, 0], [nu, 1 - nu, 0], [0, 0, (1 - 2 * nu) / 2]])
    c = E / (1 - nu ** 2)
    return c * np.array([[1, nu, 0], [nu, 1, 0], [0, 0, (1 - nu) / 2]])


def solve_elasticity(g: Grid, *, E: float, nu: float, density: float | None, bcs: dict, gravity: bool = True, plane: str = "stress",
                     fracture_stress: float | None = None, progress: Progress = _noop, cancelled: Callable[[], bool] = _never) -> dict:
    if E <= 0 or not (-1 < nu < 0.5):
        raise ValueError("Young's modulus must be positive and Poisson's ratio in (-1, 0.5)")
    h, t = g.h, g.depth
    D = _D(E, nu, plane)
    Ke = np.zeros((8, 8))
    for xi in _GP:
        for eta in _GP:
            B = _B(xi, eta, h)
            Ke += B.T @ D @ B * (h / 2) ** 2 * t
    nxn = g.nx + 1
    n0 = g.jc * nxn + g.ic
    enodes = np.c_[n0, n0 + 1, n0 + nxn + 1, n0 + nxn]  # counter-clockwise
    used = np.unique(enodes)
    remap = -np.ones((g.ny + 1) * nxn, int)
    remap[used] = np.arange(len(used))
    en = remap[enodes]
    nd = 2 * len(used)
    edofs = np.stack([2 * en, 2 * en + 1], axis=2).reshape(len(en), 8)
    rows = np.repeat(edofs, 8, axis=1).ravel()
    cols = np.tile(edofs, (1, 8)).ravel()
    vals = np.tile(Ke.ravel(), len(en))
    progress(0.2, f"assembling {len(en)} Q4 elements, {nd} degrees of freedom")
    Kg = sp.csr_matrix((vals, (rows, cols)), shape=(nd, nd))
    f = np.zeros(nd)
    applied = {"gravity_n": 0.0, "pressure_n": {}}
    if gravity:
        if not density:
            raise ValueError("Density is required for self-weight loading")
        fe = density * G_ACC * h * h * t / 4
        np.add.at(f, 2 * en.ravel() + 1, -fe)
        applied["gravity_n"] = -fe * 4 * len(en)
    fixed = np.zeros(nd, bool)
    normals = {"left": (-1, 0), "right": (1, 0), "bottom": (0, -1), "top": (0, 1)}
    face_nodes = {"left": ((0, 0), (1, 0)), "right": ((0, 1), (1, 1)), "bottom": ((0, 0), (0, 1)), "top": ((1, 0), (1, 1))}
    for grp in np.unique(g.b_group):
        bc = bc_for(bcs, grp, {"type": "free"})
        ty = bc.get("type", "free")
        sel = g.b_group == grp
        cells, dirs = g.b_cell[sel], g.b_dir[sel]
        total = 0.0
        for d, ((aj, ai), (bj, bi)) in face_nodes.items():
            s = dirs == d
            if not s.any():
                continue
            j, i = g.jc[cells[s]], g.ic[cells[s]]
            na = remap[(j + aj) * nxn + i + ai]
            nb = remap[(j + bj) * nxn + i + bi]
            nodes = np.r_[na, nb]
            if ty == "fixed":
                fixed[2 * nodes] = True
                fixed[2 * nodes + 1] = True
            elif ty == "roller":
                # normal displacement fixed; exact on axis-parallel edges, staircase-normal on inclined/curved ones
                comp = 0 if d in ("left", "right") else 1
                fixed[2 * nodes + comp] = True
            elif ty == "pressure":
                p = float(bc["pressure"])
                nx_, ny_ = normals[d]
                fn = p * h * t / 2
                np.add.at(f, 2 * nodes, -nx_ * fn)
                np.add.at(f, 2 * nodes + 1, -ny_ * fn)
                total += p * h * t * s.sum()
            elif ty != "free":
                raise ValueError(f"Boundary '{grp}': unknown condition '{ty}'")
        if ty == "pressure":
            applied["pressure_n"][grp] = total
    if fixed[0::2].sum() < 1 or fixed[1::2].sum() < 1 or fixed.sum() < 3:
        raise ValueError("The body is not sufficiently supported: fix at least one boundary (or rollers in both x and y) to prevent rigid-body motion.")
    free = ~fixed
    Kff = Kg[free][:, free].tocsc()
    progress(0.5, "solving K u = f")
    u = np.zeros(nd)
    try:
        u[free] = spla.splu(Kff).solve(f[free])
    except RuntimeError as e:
        raise ValueError("Stiffness matrix is singular: the supports allow a rigid-body motion (mechanism). Add supports.") from e
    size = max(g.nx, g.ny) * h
    if not np.all(np.isfinite(u)) or np.abs(u).max() > 1e3 * size:
        raise ValueError("Unbounded displacements: the supports allow a rigid-body motion (mechanism). Add supports.")
    if cancelled():
        raise Cancelled()
    ue = u[edofs]
    B0 = _B(0, 0, h)
    strain = ue @ B0.T
    stress = strain @ D.T
    sx, sy, txy = stress[:, 0], stress[:, 1], stress[:, 2]
    if plane == "strain":
        sz = nu * (sx + sy)
        vm = np.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * txy ** 2)
    else:
        vm = np.sqrt(sx ** 2 - sx * sy + sy ** 2 + 3 * txy ** 2)
    ux, uy = ue[:, 0::2].mean(1), ue[:, 1::2].mean(1)
    umag = np.hypot(ux, uy)
    reac = Kg @ u - f
    res = {"ux": pack(ux), "uy": pack(uy), "displacement": pack(umag), "von_mises": pack(vm), "sigma_xx": pack(sx), "sigma_yy": pack(sy), "tau_xy": pack(txy),
           "max_displacement_m": float(np.abs(np.hypot(u[0::2], u[1::2])).max()), "max_von_mises_pa": float(vm.max()),
           "min_sigma_yy_pa": float(sy.min()), "max_sigma_yy_pa": float(sy.max()),
           "strain_energy_j": float(0.5 * u @ f), "dofs": nd, "elements": len(en), "plane": plane, "applied_loads": applied,
           "equilibrium": {"reaction_fx_n": float(reac[0::2][fixed[0::2]].sum()), "reaction_fy_n": float(reac[1::2][fixed[1::2]].sum()),
                           "applied_fx_n": float(f[0::2].sum()), "applied_fy_n": float(f[1::2].sum())}}
    eq = res["equilibrium"]
    eq["residual_n"] = float(math.hypot(eq["reaction_fx_n"] + eq["applied_fx_n"], eq["reaction_fy_n"] + eq["applied_fy_n"]))
    if fracture_stress:
        res["fracture_stress_pa"] = fracture_stress
        res["safety_factor"] = fracture_stress / max(vm.max(), 1e-30)
        res["cells_above_fracture"] = int((vm > fracture_stress).sum())
    return res
