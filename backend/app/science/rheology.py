"""Herschel-Bulkley rheology and laminar pipe / capillary flow.

Constitutive model (Herschel & Bulkley, 1926):
    tau = tau_y + K * gamma_dot^n      for tau > tau_y
    gamma_dot = 0                      for tau <= tau_y
Newtonian (tau_y = 0, n = 1, K = mu) and power-law (tau_y = 0) are special cases.

Steady, isothermal, fully developed laminar flow in a circular tube of radius
R and length L (no wall slip). The volumetric flow rate for a given wall shear
stress tau_w follows from the Rabinowitsch-Mooney relation:

    Q = (pi R^3 / tau_w^3) * integral_{tau_y}^{tau_w} tau^2 * gamma_dot(tau) d tau
    Delta_P = 2 * tau_w * L / R

The relation is inverted numerically (Brent's method) to obtain tau_w for a
required Q. Entrance/exit losses, wall slip, compressibility, viscous heating,
time-dependent (thixotropic) and viscoelastic effects are NOT included.
"""
from __future__ import annotations

import math

from scipy import integrate, optimize


def hb_stress(gamma_dot: float, tau_y: float, K: float, n: float) -> float:
    if gamma_dot < 0:
        raise ValueError("shear rate must be >= 0")
    return tau_y + K * gamma_dot ** n


def hb_shear_rate(tau: float, tau_y: float, K: float, n: float) -> float:
    if tau <= tau_y:
        return 0.0
    return ((tau - tau_y) / K) ** (1.0 / n)


def apparent_viscosity(gamma_dot: float, tau_y: float, K: float, n: float) -> float:
    if gamma_dot <= 0:
        return math.inf if tau_y > 0 else (K if n == 1 else math.inf)
    return hb_stress(gamma_dot, tau_y, K, n) / gamma_dot


def _validate(tau_y, K, n):
    if K <= 0:
        raise ValueError("consistency index K must be > 0")
    if n <= 0:
        raise ValueError("flow behaviour index n must be > 0")
    if tau_y < 0:
        raise ValueError("yield stress must be >= 0")


def flow_rate_from_wall_stress(tau_w: float, R: float, tau_y: float, K: float, n: float) -> float:
    if tau_w <= tau_y:
        return 0.0
    val, _ = integrate.quad(lambda t: t * t * hb_shear_rate(t, tau_y, K, n), tau_y, tau_w, limit=200)
    return math.pi * R ** 3 / tau_w ** 3 * val


def pipe_flow(Q_m3_s: float, D_m: float, L_m: float, tau_y: float, K: float, n: float, rho: float | None = None) -> dict:
    """Pressure drop of a HB fluid in laminar tube flow for a required flow rate."""
    _validate(tau_y, K, n)
    if Q_m3_s <= 0 or D_m <= 0 or L_m <= 0:
        raise ValueError("Q, D and L must be > 0")
    R = D_m / 2.0
    warnings: list[str] = []

    # bracket: start above yield, expand until Q(tau) >= Q
    lo = tau_y + 1e-12
    hi = max(tau_y * 2.0, 1.0)
    for _ in range(200):
        if flow_rate_from_wall_stress(hi, R, tau_y, K, n) >= Q_m3_s:
            break
        hi *= 2.0
    else:  # pragma: no cover
        raise RuntimeError("could not bracket wall shear stress")
    tau_w = optimize.brentq(lambda t: flow_rate_from_wall_stress(t, R, tau_y, K, n) - Q_m3_s, lo, hi, xtol=1e-12, rtol=1e-10, maxiter=500)
    dP = 2.0 * tau_w * L_m / R
    V = Q_m3_s / (math.pi * R * R)
    gamma_w = hb_shear_rate(tau_w, tau_y, K, n)
    gamma_newt = 8.0 * V / D_m  # nominal (apparent) wall shear rate
    plug_radius = R * tau_y / tau_w
    mu_app_w = tau_w / gamma_w if gamma_w > 0 else math.inf

    re = None
    if rho is not None:
        # Metzner-Reed generalised Reynolds number (power-law part only)
        re = rho * V ** (2 - n) * D_m ** n / (K * 8 ** (n - 1) * ((3 * n + 1) / (4 * n)) ** n)
        if tau_y > 0:
            warnings.append("Reynolds number uses the Metzner-Reed power-law form and neglects yield stress (conservative indicator only).")
        if re > 2100:
            warnings.append(f"Generalised Re = {re:.0f} > 2100: laminar assumption may be invalid; result not reliable.")
    return {
        "model": "Herschel-Bulkley laminar tube flow (Rabinowitsch-Mooney)",
        "wall_shear_stress_pa": tau_w,
        "pressure_drop_pa": dP,
        "mean_velocity_m_s": V,
        "wall_shear_rate_1_s": gamma_w,
        "nominal_wall_shear_rate_1_s": gamma_newt,
        "apparent_viscosity_wall_pa_s": mu_app_w,
        "plug_radius_m": plug_radius,
        "reynolds_generalised": re,
        "warnings": warnings,
    }


def newtonian_pipe(Q_m3_s: float, D_m: float, L_m: float, mu: float, rho: float) -> dict:
    """Newtonian pipe flow: Hagen-Poiseuille (Re<2100) or Blasius (Re>4000)."""
    R = D_m / 2
    A = math.pi * R * R
    V = Q_m3_s / A
    Re = rho * V * D_m / mu
    warnings = []
    if Re < 2100:
        f = 64.0 / Re
        regime = "laminar (Hagen-Poiseuille)"
    else:
        f = 0.3164 * Re ** -0.25
        regime = "turbulent (Blasius, smooth pipe)"
        if Re < 4000:
            warnings.append("Transitional regime (2100 < Re < 4000): friction factor uncertain.")
        if Re > 1e5:
            warnings.append("Re > 1e5: Blasius correlation outside validated range.")
    dP = f * (L_m / D_m) * rho * V * V / 2.0
    return {"model": f"Newtonian pipe flow, {regime}", "pressure_drop_pa": dP, "reynolds": Re, "mean_velocity_m_s": V, "darcy_friction_factor": f, "warnings": warnings}


def flow_curve(tau_y: float, K: float, n: float, gmin: float = 0.1, gmax: float = 1000.0, points: int = 40) -> list[dict]:
    _validate(tau_y, K, n)
    out = []
    for i in range(points):
        g = gmin * (gmax / gmin) ** (i / (points - 1))
        s = hb_stress(g, tau_y, K, n)
        out.append({"shear_rate": g, "stress": s, "apparent_viscosity": s / g})
    return out
