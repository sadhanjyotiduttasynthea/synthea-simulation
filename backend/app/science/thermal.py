"""Thermophysical properties of foods from proximate composition.

Choi, Y. & Okos, M.R. (1986). Effects of temperature and composition on the
thermal properties of foods. In: Food Engineering and Process Applications,
Vol. 1, Elsevier, pp. 93-101. Coefficients as commonly tabulated (e.g. ASHRAE
Handbook - Refrigeration, chapter "Thermal Properties of Foods").

Valid approximately -40 to 150 degC for unfrozen foods. Ice is not modelled
here (only temperatures >= 0 degC are supported).

Mixture rules:
  cp  = sum x_i cp_i                  (mass fractions)
  rho = 1 / sum (x_i / rho_i)         (assumes no porosity)
  k   = sum v_i k_i,  v_i = (x_i/rho_i) / sum(x_j/rho_j)   (parallel model)
"""
from __future__ import annotations

# coefficient tuples: (a0, a1, a2) -> a0 + a1*T + a2*T^2, T in degC
COEFFS = {
    "water": {
        "rho": (997.18, 3.1439e-3, -3.7574e-3),
        "cp": (4.1762, -9.0864e-5, 5.4731e-6),
        "k": (0.57109, 1.7625e-3, -6.7036e-6),
    },
    "protein": {
        "rho": (1329.9, -0.5184, 0.0),
        "cp": (2.0082, 1.2089e-3, -1.3129e-6),
        "k": (0.17881, 1.1958e-3, -2.7178e-6),
    },
    "fat": {
        "rho": (925.59, -0.41757, 0.0),
        "cp": (1.9842, 1.4733e-3, -4.8008e-6),
        "k": (0.18071, -2.7604e-4, -1.7749e-7),
    },
    "carbohydrate": {
        "rho": (1599.1, -0.31046, 0.0),
        "cp": (1.5488, 1.9625e-3, -5.9399e-6),
        "k": (0.20141, 1.3874e-3, -4.3312e-6),
    },
    "fibre": {
        "rho": (1311.5, -0.36589, 0.0),
        "cp": (1.8459, 1.8306e-3, -4.6509e-6),
        "k": (0.18331, 1.2497e-3, -3.1683e-6),
    },
    "ash": {
        "rho": (2423.8, -0.28063, 0.0),
        "cp": (1.0926, 1.8896e-3, -3.6817e-6),
        "k": (0.32962, 1.4011e-3, -2.9069e-6),
    },
}

COMPONENT_MAP = {
    "water": "moisture",
    "protein": "protein",
    "fat": "fat",
    "carbohydrate": "carbohydrate",
    "fibre": "fibre",
    "ash": "ash",
}

T_MIN, T_MAX = 0.0, 150.0


def _poly(c, T):
    return c[0] + c[1] * T + c[2] * T * T


def properties(composition: dict, T: float) -> dict:
    """Return density (kg/m3), cp (kJ/kg/K), k (W/m/K) for a composition in g/100 g."""
    warnings = []
    if T < T_MIN or T > T_MAX:
        warnings.append(f"T = {T:.1f} degC is outside the supported range {T_MIN}-{T_MAX} degC.")
    x = {}
    for comp, key in COMPONENT_MAP.items():
        x[comp] = max(float(composition.get(key) or 0.0), 0.0) / 100.0
    s = sum(x.values())
    if s <= 0:
        raise ValueError("Composition is empty")
    if abs(s - 1.0) > 0.02:
        warnings.append(
            f"Proximate components sum to {s*100:.1f} % (expected 100 %); fractions were normalised."
        )
    x = {k: v / s for k, v in x.items()}
    cp = sum(x[c] * _poly(COEFFS[c]["cp"], T) for c in x)
    inv_rho = sum(x[c] / _poly(COEFFS[c]["rho"], T) for c in x)
    rho = 1.0 / inv_rho
    v = {c: (x[c] / _poly(COEFFS[c]["rho"], T)) / inv_rho for c in x}
    k = sum(v[c] * _poly(COEFFS[c]["k"], T) for c in x)
    return {
        "temperature_c": T,
        "density_kg_m3": rho,
        "specific_heat_kj_kgk": cp,
        "conductivity_w_mk": k,
        "thermal_diffusivity_m2_s": k / (rho * cp * 1000.0),
        "model": "Choi & Okos (1986)",
        "warnings": warnings,
    }
