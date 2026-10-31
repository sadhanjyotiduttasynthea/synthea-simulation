"""Experimental planning: design of experiments, active learning, cost scenarios.

Workflow (transparent, data-driven):
1. Few data (< MIN_POINTS with the chosen response): a space-filling design on
   the constrained mixture region. Candidate points are generated from a
   scrambled Sobol sequence mapped to the bounds of the non-filler ingredients
   (filler = largest-range ingredient takes the remainder); points that violate
   any bound are rejected. A greedy maximin selection picks the most spread out
   experiments, also maximising distance to experiments already performed.
2. Enough data: a Gaussian-process surrogate is fit and the next experiments are
   selected by an acquisition function (maximum predictive uncertainty, or
   expected improvement towards a target), with a "kriging believer" batch
   heuristic so that several experiments can be planned at once.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.stats import norm, qmc

from .surrogate import MIN_POINTS, RESPONSES, Surrogate


def _bounds(ids, bounds):
    lo = np.array([float((bounds.get(i) or [0, 100])[0] or 0) for i in ids])
    hi = np.array([float((bounds.get(i) or [0, 100])[1] if (bounds.get(i) or [0, 100])[1] is not None else 100) for i in ids])
    return lo, hi


def candidate_set(ids: list[str], bounds: dict, n: int = 2048, seed: int = 0) -> np.ndarray:
    lo, hi = _bounds(ids, bounds)
    if lo.sum() > 100 + 1e-9 or hi.sum() < 100 - 1e-9:
        raise ValueError("Bounds do not admit any mixture summing to 100 %.")
    filler = int(np.argmax(hi - lo))
    others = [j for j in range(len(ids)) if j != filler]
    sampler = qmc.Sobol(d=len(others), scramble=True, seed=seed)
    m = int(math.ceil(math.log2(max(n, 2))))
    u = sampler.random_base2(m)
    pts = []
    for row in u:
        x = np.zeros(len(ids))
        x[others] = lo[others] + row * (hi[others] - lo[others])
        x[filler] = 100.0 - x[others].sum()
        if lo[filler] - 1e-9 <= x[filler] <= hi[filler] + 1e-9:
            pts.append(x)
    if not pts:
        raise ValueError("No feasible candidate mixtures found within the bounds; widen the bounds.")
    return np.array(pts)


def maximin_select(cands: np.ndarray, k: int, existing: np.ndarray | None = None, scale: np.ndarray | None = None) -> list[int]:
    scale = scale if scale is not None else np.maximum(cands.std(axis=0), 1e-9)
    C = cands / scale
    chosen: list[int] = []
    if existing is not None and len(existing):
        dmin = np.sqrt((((C[:, None, :] - (existing / scale)[None, :, :]) ** 2).sum(-1))).min(axis=1)
    else:
        # start from the point closest to the centroid
        dmin = np.full(len(C), np.inf)
        first = int(np.argmin(((C - C.mean(axis=0)) ** 2).sum(1)))
        chosen.append(first)
        dmin = np.minimum(dmin, np.sqrt(((C - C[first]) ** 2).sum(1)))
    while len(chosen) < min(k, len(C)):
        j = int(np.argmax(dmin))
        chosen.append(j)
        dmin = np.minimum(dmin, np.sqrt(((C - C[j]) ** 2).sum(1)))
    return chosen


def recommend(ids: list[str], names: dict, bounds: dict, experiments: list[dict], response: str, k: int = 6,
              strategy: str = "uncertainty", target: float | None = None, maximise: bool = True) -> dict:
    cands = candidate_set(ids, bounds)
    meta = RESPONSES.get(response, {"label": response, "unit": ""})
    existing = []
    for e in experiments:
        comp = e.get("composition") or {}
        existing.append([float(comp.get(i, 0.0)) for i in ids])
    existing = np.array(existing) if existing else None
    n_resp = sum(1 for e in experiments if (e.get("measurements") or {}).get(response) is not None)

    def rows(idx, extra=None):
        out = []
        for r, j in enumerate(idx):
            item = {"rank": r + 1, "composition": {i: float(round(v, 3)) for i, v in zip(ids, cands[j])},
                    "names": {i: names.get(i, i) for i in ids}}
            if extra:
                item.update(extra[r])
            out.append(item)
        return out

    if n_resp < MIN_POINTS:
        idx = maximin_select(cands, k, existing)
        return {
            "phase": "design_of_experiments",
            "method": "Space-filling maximin design on the constrained mixture region (scrambled Sobol candidates, greedy maximin selection).",
            "reason": f"{n_resp} experiment(s) with '{meta['label']}' recorded; at least {MIN_POINTS} are needed before a surrogate model is trained.",
            "candidates_evaluated": int(len(cands)),
            "recommendations": rows(idx),
        }

    sur = Surrogate(ids, response).fit(experiments)
    cv = sur.loo_cv()
    selected: list[int] = []
    extra = []
    Xtrain_aug = sur.X.copy()
    ytrain_aug = sur._ty(sur.y).copy()
    from sklearn.gaussian_process import GaussianProcessRegressor
    gp = sur.gp
    Cs = (cands - sur.mu_x) / sur.sd_x
    tgt = None
    if target is not None:
        tgt = math.log(target) if sur.log else target
    for _ in range(min(k, len(cands))):
        m, s = gp.predict(Cs, return_std=True)
        s = np.maximum(s, 1e-12)
        if strategy == "expected_improvement":
            if tgt is not None:
                best = np.min(np.abs(ytrain_aug - tgt))
                # improvement in closeness to target: E[max(best - |Y - t|, 0)] approx via sampling-free bound
                z_hi = (tgt + best - m) / s
                z_lo = (tgt - best - m) / s
                acq = norm.cdf(z_hi) - norm.cdf(z_lo)  # probability of getting closer than current best
                acq_name = "Probability of improving closeness to target"
            else:
                best = ytrain_aug.max() if maximise else ytrain_aug.min()
                imp = (m - best) if maximise else (best - m)
                z = imp / s
                acq = imp * norm.cdf(z) + s * norm.pdf(z)
                acq_name = "Expected improvement"
        else:
            acq = s
            acq_name = "Predictive standard deviation (uncertainty sampling)"
        if selected:
            acq = acq.copy()
            acq[selected] = -np.inf
        j = int(np.argmax(acq))
        selected.append(j)
        pm, ps, plo, phi = sur.predict(cands[j:j + 1])
        extra.append({"predicted": float(pm[0]), "band_low": float(plo[0]), "band_high": float(phi[0]), "acquisition": float(acq[j])})
        # kriging believer: add predicted mean as pseudo-observation
        Xtrain_aug = np.vstack([Xtrain_aug, cands[j]])
        ytrain_aug = np.append(ytrain_aug, m[j])
        gp = GaussianProcessRegressor(kernel=sur.gp.kernel_, normalize_y=True, optimizer=None)
        gp.fit((Xtrain_aug - sur.mu_x) / sur.sd_x, ytrain_aug)
    warnings = []
    info = sur.info()
    if "synthetic_demo" in info["data_types"]:
        warnings.append("Model trained on SYNTHETIC demonstration data: recommendations illustrate the workflow only.")
    if cv["q2"] < 0.5:
        warnings.append(f"Leave-one-out Q2 = {cv['q2']:.2f}: model is not yet predictive; uncertainty-driven exploration is advisable.")
    return {
        "phase": "active_learning",
        "method": f"Gaussian-process surrogate (Matern 5/2, ARD) + {acq_name}; batch via kriging-believer heuristic.",
        "reason": f"{n_resp} experiments with '{meta['label']}' available; surrogate model trained.",
        "model": info, "cv": cv, "warnings": warnings,
        "candidates_evaluated": int(len(cands)),
        "recommendations": rows(selected, extra),
    }


def synthetic_dataset(ids: list[str], bounds: dict, n: int = 12, seed: int = 42) -> list[dict]:
    """Generate clearly-labelled SYNTHETIC records for demonstrating the workflow.

    The generating function is an arbitrary smooth function chosen only so the
    workflow can be exercised; it is NOT a physical model and the values are
    NOT measurements.
    """
    rng = np.random.default_rng(seed)
    cands = candidate_set(ids, bounds, n=512, seed=seed)
    idx = maximin_select(cands, n)
    out = []
    pos = {i: j for j, i in enumerate(ids)}

    def g(key, x):
        return x[pos[key]] if key in pos else 0.0

    for r, j in enumerate(idx):
        x = cands[j]
        solids = g("pea-protein-isolate", x) + g("potato-starch", x)
        logv = -1.0 + 0.09 * solids + 2.2 * g("xanthan-gum", x) - 0.02 * g("sunflower-oil", x) + 0.15 * rng.standard_normal()
        visc = float(math.exp(logv))
        retention = float(np.clip(35 + 18 * math.tanh((logv - 3.0) / 1.2) + 20 * g("xanthan-gum", x) + 4 * rng.standard_normal(), 0, 100))
        hardness = float(max(0.5, 2 + 0.25 * g("pea-protein-isolate", x) + 0.1 * g("potato-starch", x) + rng.standard_normal()))
        out.append({
            "name": f"SYN-{r + 1:02d}",
            "data_type": "synthetic_demo",
            "composition": {i: float(round(v, 3)) for i, v in zip(ids, x)},
            "process": {"temperature_c": 25.0, "mixing_speed_rpm": 300.0, "mixing_time_min": 5.0},
            "measurements": {"viscosity_pa_s": round(visc, 3), "viscosity_shear_rate_1_s": 10.0, "hardness_n": round(hardness, 2),
                             "shape_retention_pct": round(retention, 1), "extrusion_behaviour": "continuous" if 20 < visc < 400 else ("too fluid" if visc <= 20 else "blocked / intermittent")},
            "cost_eur": None,
            "date": None,
            "notes": "SYNTHETIC DEMO RECORD - generated by an arbitrary function, not measured.",
        })
    return out


def cost_scenario(p: dict) -> dict:
    n_conv = float(p.get("conventional_experiments", 200))
    n_plan = float(p.get("planned_experiments", 60))
    cpe = float(p.get("cost_per_experiment", 170))
    kg = float(p.get("material_per_experiment_kg", 2))
    mat_price = p.get("material_cost_per_kg")
    soft = float(p.get("software_modelling_cost", 0))
    days = p.get("days_per_experiment")
    conv_cost = n_conv * cpe
    plan_cost = n_plan * cpe
    avoided = conv_cost - plan_cost
    net = avoided - soft
    res = {
        "conventional_cost": conv_cost, "planned_cost": plan_cost, "gross_avoided": avoided,
        "software_modelling_cost": soft, "net_savings": net,
        "experiment_reduction_pct": (1 - n_plan / n_conv) * 100 if n_conv > 0 else None,
        "conventional_material_kg": n_conv * kg, "planned_material_kg": n_plan * kg,
        "material_saved_kg": (n_conv - n_plan) * kg,
        "net_saving_pct": net / conv_cost * 100 if conv_cost > 0 else None,
        "break_even_experiments_avoided": soft / cpe if cpe > 0 else None,
        "label": "Illustrative scenario: all inputs are user assumptions, not measured outcomes.",
    }
    if mat_price is not None:
        res["material_cost_note"] = "Cost per experiment is assumed to already include materials; material value shown separately for information."
        res["material_value_saved"] = (n_conv - n_plan) * kg * float(mat_price)
    if days is not None:
        res["conventional_days"] = n_conv * float(days)
        res["planned_days"] = n_plan * float(days)
    curve = []
    for n in np.linspace(0, n_conv, 21):
        curve.append({"planned_experiments": float(n), "net_savings": (n_conv - n) * cpe - soft})
    res["sensitivity"] = curve
    return res
