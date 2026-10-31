"""Constrained formulation optimisation.

* Linear problems (cost, nutrient and composition constraints are linear in the
  mass fractions) are solved exactly with linear programming (HiGHS via
  ``scipy.optimize.linprog``).
* Pareto front (protein vs cost) is computed with the epsilon-constraint method.
* Infeasible problems are diagnosed with an elastic LP that finds the minimum
  weighted relaxation of the constraints.
* Processing-compatibility optimisation uses a Gaussian-process surrogate
  trained on recorded experiments as a nonlinear constraint (SLSQP, multi-start).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linprog, minimize

from .science import nutrition
from .surrogate import RESPONSES, Surrogate

NUTRIENTS = ("protein", "fat", "carbohydrate", "moisture", "fibre", "sodium")
NUTRIENT_UNITS = {"sodium": "g/100 g"}


@dataclass
class Row:
    name: str
    a: np.ndarray
    b: float
    kind: str  # bound_upper, bound_lower, nutrient_min, nutrient_max, cost_max
    key: str
    limit: float
    scale: float = 1.0


@dataclass
class Problem:
    ingredients: list[dict]
    ids: list[str]
    price: np.ndarray
    comp: dict
    rows: list[Row] = field(default_factory=list)
    excluded: list[dict] = field(default_factory=list)

    @property
    def A(self):
        return np.array([r.a for r in self.rows]) if self.rows else np.zeros((0, len(self.ids)))

    @property
    def b(self):
        return np.array([r.b for r in self.rows])


def build_problem(ingredients: list[dict], req: dict) -> Problem:
    excluded_allergens = {a.strip().lower() for a in req.get("excluded_allergens", []) if a.strip()}
    include = req.get("ingredient_ids")
    bounds = req.get("bounds") or {}
    chosen, excluded = [], []
    for ing in ingredients:
        reason = None
        if include is not None and ing["id"] not in include:
            reason = "not selected"
        elif not ing.get("available", True):
            reason = "marked unavailable"
        else:
            hit = [a for a in ing.get("allergens", []) if any(x in a.lower() for x in excluded_allergens)]
            if hit:
                reason = f"allergen restriction ({', '.join(hit)})"
        if reason:
            excluded.append({"id": ing["id"], "name": ing["name"], "reason": reason})
        else:
            chosen.append(ing)
    if not chosen:
        raise ValueError("No ingredients remain after availability and allergen filters.")
    ids = [i["id"] for i in chosen]
    price = []
    for i in chosen:
        p = (i.get("economics") or {}).get("price_per_kg")
        if p is None:
            raise ValueError(f"Ingredient '{i['name']}' has no price; cost optimisation impossible.")
        price.append(float(p))
    price = np.array(price)
    comp = {k: np.array([float((i.get("nutrition") or {}).get(k) or 0.0) for i in chosen]) for k in NUTRIENTS}
    prob = Problem(chosen, ids, price, comp, excluded=excluded)
    n = len(ids)
    for j, i in enumerate(chosen):
        lo, hi = bounds.get(i["id"], [0.0, 100.0])
        lo = 0.0 if lo is None else float(lo)
        hi = 100.0 if hi is None else float(hi)
        e = np.zeros(n)
        e[j] = 1.0
        if hi < 100.0:
            prob.rows.append(Row(f"{i['name']} <= {hi:g} %", e, hi, "bound_upper", i["id"], hi))
        if lo > 0.0:
            prob.rows.append(Row(f"{i['name']} >= {lo:g} %", -e, -lo, "bound_lower", i["id"], lo))
    limits = dict(req.get("nutrient_limits") or {})
    if req.get("min_protein") is not None:
        lo_hi = list(limits.get("protein", [None, None]))
        lo_hi[0] = float(req["min_protein"])
        limits["protein"] = lo_hi
    for k, (lo, hi) in limits.items():
        if k not in comp:
            continue
        unit = NUTRIENT_UNITS.get(k, "%")
        if lo is not None:
            prob.rows.append(Row(f"{k} >= {lo:g} {unit}", -comp[k] / 100.0, -float(lo), "nutrient_min", k, float(lo)))
        if hi is not None:
            prob.rows.append(Row(f"{k} <= {hi:g} {unit}", comp[k] / 100.0, float(hi), "nutrient_max", k, float(hi)))
    if req.get("max_cost") is not None:
        prob.rows.append(Row(f"cost <= {float(req['max_cost']):.2f} EUR/kg", price / 100.0, float(req["max_cost"]), "cost_max", "cost", float(req["max_cost"]), scale=0.1))
    return prob


def _solve(prob: Problem, c: np.ndarray, extra_rows: list[Row] | None = None, skip: set[str] | None = None):
    rows = [r for r in prob.rows if not (skip and r.kind in skip)] + (extra_rows or [])
    n = len(prob.ids)
    A = np.array([r.a for r in rows]) if rows else None
    b = np.array([r.b for r in rows]) if rows else None
    res = linprog(c, A_ub=A, b_ub=b, A_eq=np.ones((1, n)), b_eq=[100.0], bounds=[(0, None)] * n, method="highs")
    return res, rows


def evaluate(prob: Problem, x: np.ndarray, serving_size_g: float, rows: list[Row] | None = None) -> dict:
    lines = [nutrition.FormulationLine(ing, float(v)) for ing, v in zip(prob.ingredients, x)]
    res = nutrition.composition(lines, serving_size_g).to_dict()
    checks = []
    for r in rows if rows is not None else prob.rows:
        lhs = float(r.a @ x)
        slack = r.b - lhs
        if r.kind in ("bound_lower", "nutrient_min"):
            value = -lhs
        else:
            value = lhs
        checks.append({
            "constraint": r.name, "kind": r.kind, "value": value, "limit": r.limit,
            "satisfied": slack >= -1e-6, "binding": abs(slack) < 1e-6 * max(1.0, abs(r.b)),
        })
    res["constraints"] = checks
    res["all_satisfied"] = all(c["satisfied"] for c in checks)
    res["formulation"] = [{"ingredient_id": i, "name": ing["name"], "percent": float(v)} for i, ing, v in zip(prob.ids, prob.ingredients, x)]
    return res


def diagnose_infeasibility(prob: Problem) -> dict:
    """Elastic LP: minimise weighted constraint violations needed for feasibility."""
    n = len(prob.ids)
    m = len(prob.rows)
    reasons = []
    lo_sum = sum(r.limit for r in prob.rows if r.kind == "bound_lower")
    if lo_sum > 100 + 1e-9:
        reasons.append(f"Sum of ingredient minimum concentrations is {lo_sum:.2f} % (> 100 %).")
    # max of upper bounds incl. unbounded
    ub = {i: 100.0 for i in prob.ids}
    for r in prob.rows:
        if r.kind == "bound_upper":
            ub[r.key] = r.limit
    if sum(ub.values()) < 100 - 1e-9:
        reasons.append(f"Sum of ingredient maximum concentrations is {sum(ub.values()):.2f} % (< 100 %).")
    if m == 0:
        return {"reasons": reasons or ["Unknown"], "relaxations": [], "suggestions": []}
    A = prob.A
    w = np.array([1.0 / r.scale for r in prob.rows])
    c = np.concatenate([np.zeros(n), w])
    A_ub = np.hstack([A, -np.eye(m)])
    A_eq = np.concatenate([np.ones(n), np.zeros(m)])[None, :]
    res = linprog(c, A_ub=A_ub, b_ub=prob.b, A_eq=A_eq, b_eq=[100.0], bounds=[(0, None)] * (n + m), method="highs")
    relaxations = []
    if res.status == 0:
        s = res.x[n:]
        for r, sj in zip(prob.rows, s):
            if sj > 1e-7:
                if r.kind in ("bound_lower", "nutrient_min"):
                    new = r.limit - sj
                    txt = f"Lower '{r.name}' to {new:.3g}"
                else:
                    new = r.limit + sj
                    txt = f"Raise '{r.name}' to {new:.3g}"
                relaxations.append({"constraint": r.name, "kind": r.kind, "current": r.limit, "required": new, "change": sj, "text": txt})
    # single-constraint alternatives for headline constraints
    suggestions = []
    for kind, label in (("cost_max", "budget"), ("nutrient_min", "minimum nutrient")):
        rows = [r for r in prob.rows if r.kind == kind]
        for r in rows:
            others = [o for o in prob.rows if o is not r]
            Aa = np.array([o.a for o in others]) if others else None
            bb = np.array([o.b for o in others]) if others else None
            obj = r.a if kind == "cost_max" else r.a  # minimise lhs of this row
            rr = linprog(obj, A_ub=Aa, b_ub=bb, A_eq=np.ones((1, n)), b_eq=[100.0], bounds=[(0, None)] * n, method="highs")
            if rr.status == 0:
                best = float(rr.fun)
                if kind == "cost_max":
                    suggestions.append(f"Keeping all other constraints, the lowest achievable cost is {best:.3f} EUR/kg; set the budget to at least this value.")
                else:
                    suggestions.append(f"Keeping all other constraints, the highest achievable {r.key} is {-best:.3g}; lower the minimum ({r.limit:g}) accordingly.")
            else:
                suggestions.append(f"Relaxing only the {label} constraint '{r.name}' is not sufficient; other constraints also conflict.")
    if prob.excluded:
        suggestions.append("Excluded ingredients: " + ", ".join(f"{e['name']} ({e['reason']})" for e in prob.excluded) + ". Re-enabling them may restore feasibility.")
    if not reasons:
        reasons.append("The combination of composition bounds, nutrient limits and budget has no common solution.")
    return {"reasons": reasons, "relaxations": relaxations, "suggestions": suggestions}


def _marginals(res, rows: list[Row], objective: str) -> list[dict]:
    out = []
    try:
        marg = res.ineqlin.marginals
    except AttributeError:  # pragma: no cover
        return out
    for r, mu in zip(rows, marg):
        if abs(mu) < 1e-9:
            continue
        # d(obj)/d(b); convert to d(obj)/d(limit)
        d = -mu if r.kind in ("bound_lower", "nutrient_min") else mu
        if objective == "protein":
            d = -d  # objective was -protein
        if r.kind in ("nutrient_min", "nutrient_max"):
            unit_in = NUTRIENT_UNITS.get(r.key, "percentage point")
        elif r.kind == "cost_max":
            unit_in = "EUR/kg"
        else:
            unit_in = "percentage point"
        unit_out = "EUR/kg" if objective == "cost" else "% protein"
        out.append({"constraint": r.name, "sensitivity": float(d), "text": f"Raising the limit of '{r.name}' by 1 {unit_in} changes the optimum by {d:+.4f} {unit_out} (LP dual value, valid locally)."})
    out.sort(key=lambda s: -abs(s["sensitivity"]))
    return out


def monte_carlo(prob: Problem, x: np.ndarray, req: dict, n: int = 2000, seed: int = 0) -> dict:
    """Propagate ASSUMED relative uncertainty of ingredient protein content and prices."""
    rng = np.random.default_rng(seed)
    rel_c = float(req.get("composition_uncertainty_rel", 0.05))
    rel_p = float(req.get("price_uncertainty_rel", 0.10))
    w = x / 100.0
    prot = prob.comp["protein"]
    P = np.clip(prot[None, :] * (1 + rel_c * rng.standard_normal((n, len(w)))), 0, 100)
    C = np.clip(prob.price[None, :] * (1 + rel_p * rng.standard_normal((n, len(w)))), 0, None)
    protein = P @ w
    cost = C @ w
    out = {
        "assumptions": f"Illustrative assumption: independent normal relative uncertainty of {rel_c*100:.0f} % on ingredient protein contents and {rel_p*100:.0f} % on prices (n = {n}).",
        "protein_p05": float(np.percentile(protein, 5)), "protein_p95": float(np.percentile(protein, 95)),
        "cost_p05": float(np.percentile(cost, 5)), "cost_p95": float(np.percentile(cost, 95)),
    }
    if req.get("min_protein") is not None:
        out["p_protein_ok"] = float(np.mean(protein >= float(req["min_protein"])))
    if req.get("max_cost") is not None:
        out["p_cost_ok"] = float(np.mean(cost <= float(req["max_cost"])))
    return out


def _candidate(prob, x, req, label, mode, rationale, rows=None, extra=None):
    cand = evaluate(prob, x, float(req.get("serving_size_g", 30.0)), rows)
    cand.update({"label": label, "mode": mode, "rationale": rationale, "uncertainty": monte_carlo(prob, x, req), "x": [float(v) for v in x]})
    if extra:
        cand.update(extra)
    return cand


def pareto_front(prob: Problem, req: dict, points: int = 15) -> list[dict]:
    # range of protein within all constraints except cost cap
    base = [r for r in prob.rows if r.kind != "cost_max"]
    prot = prob.comp["protein"] / 100.0
    lo_res, _ = _solve(prob, prot, skip={"cost_max"})
    hi_res, _ = _solve(prob, -prot, skip={"cost_max"})
    if lo_res.status != 0 or hi_res.status != 0:
        return []
    pmin, pmax = float(lo_res.fun), float(-hi_res.fun)
    front = []
    for lvl in np.linspace(pmin, pmax, points):
        row = Row("protein level", -prot, -lvl, "nutrient_min", "protein", lvl)
        res, _ = _solve(prob, prob.price / 100.0, extra_rows=[row], skip={"cost_max"})
        if res.status == 0:
            front.append({"protein": float(prot @ res.x), "cost": float(res.fun), "x": [float(v) for v in res.x],
                          "within_budget": req.get("max_cost") is None or res.fun <= float(req["max_cost"]) + 1e-9})
    del base
    return front


def _knee(front: list[dict], lo_p: float, hi_p: float):
    pts = [f for f in front if lo_p - 1e-9 <= f["protein"] <= hi_p + 1e-9]
    if len(pts) < 3:
        return None
    p = np.array([f["protein"] for f in pts])
    c = np.array([f["cost"] for f in pts])
    pn = (p - p.min()) / max(np.ptp(p), 1e-12)
    cn = (c - c.min()) / max(np.ptp(c), 1e-12)
    # distance below the chord joining the extremes (convex front: cost rises with protein)
    a = np.array([pn[0], cn[0]])
    bvec = np.array([pn[-1], cn[-1]])
    d = bvec - a
    dist = np.abs(d[0] * (cn - a[1]) - d[1] * (pn - a[0])) / max(np.linalg.norm(d), 1e-12)
    k = int(np.argmax(dist))
    if k in (0, len(pts) - 1) or dist[k] < 1e-3:
        return None
    return pts[k]


def optimise(ingredients: list[dict], req: dict, experiments: list[dict] | None = None) -> dict:
    prob = build_problem(ingredients, req)
    mode = req.get("mode", "all")
    ss = float(req.get("serving_size_g", 30.0))
    out = {"ingredients": [{"id": i["id"], "name": i["name"]} for i in prob.ingredients], "excluded": prob.excluded,
           "method": "Linear programming (HiGHS dual simplex / IPM via SciPy linprog); epsilon-constraint Pareto front.",
           "limitations": [
               "Optimises raw-material cost and composition only; texture, taste, stability and processability are not predicted by the linear model.",
               "Ingredient compositions and prices are only as reliable as the library entries (many are illustrative).",
               "Composition is computed before processing; moisture loss and reactions during cooking are not included.",
           ]}
    baseline = req.get("baseline")
    if baseline:
        xb = np.array([float(baseline.get(i, 0.0)) for i in prob.ids])
        out["baseline"] = evaluate(prob, xb, ss)
        missing = [k for k in baseline if k not in prob.ids and baseline[k] > 0]
        if missing:
            out["baseline"]["warnings"].append("Baseline contains ingredients excluded from optimisation: " + ", ".join(missing))

    cost_res, cost_rows = _solve(prob, prob.price / 100.0)
    if cost_res.status == 2:
        out["status"] = "infeasible"
        out["infeasibility"] = diagnose_infeasibility(prob)
        out["candidates"] = []
        out["pareto"] = pareto_front(prob, req)
        return out
    if cost_res.status != 0:
        out["status"] = "error"
        out["message"] = cost_res.message
        out["candidates"] = []
        return out

    out["status"] = "optimal"
    cands = []
    cheapest = cost_res.x
    if mode in ("all", "lowest_cost"):
        cands.append(_candidate(prob, cheapest, req, "Lowest cost", "lowest_cost",
                                "Minimises raw-material cost subject to all constraints (exact LP optimum).",
                                cost_rows, {"sensitivities": _marginals(cost_res, cost_rows, "cost")}))
    prot_vec = prob.comp["protein"] / 100.0
    prot_res, prot_rows = _solve(prob, -prot_vec)
    # second stage: among max-protein solutions choose the cheapest (lexicographic)
    if prot_res.status == 0:
        pmax = -prot_res.fun
        lex_row = Row("protein at maximum", -prot_vec, -(pmax - 1e-7), "nutrient_min", "protein", pmax)
        lex, _ = _solve(prob, prob.price / 100.0, extra_rows=[lex_row])
        xp = lex.x if lex.status == 0 else prot_res.x
        if mode in ("all", "highest_protein"):
            cands.append(_candidate(prob, xp, req, "Highest protein", "highest_protein",
                                    "Maximises protein within budget and composition limits; ties broken by lowest cost.",
                                    prot_rows, {"sensitivities": _marginals(prot_res, prot_rows, "protein")}))
    front = pareto_front(prob, req)
    out["pareto"] = front
    if mode == "all" and prot_res.status == 0:
        p_lo = float(prot_vec @ cheapest)
        p_hi = float(-prot_res.fun)
        k = _knee(front, p_lo, p_hi)
        if k is not None:
            xk = np.array(k["x"])
            why = "Knee of the protein-cost Pareto front: largest protein gain per unit of extra cost before returns diminish."
        else:
            mid = (p_lo + p_hi) / 2.0
            row = Row("protein midpoint", -prot_vec, -mid, "nutrient_min", "protein", mid)
            mres, _ = _solve(prob, prob.price / 100.0, extra_rows=[row])
            xk = mres.x if mres.status == 0 else cheapest
            why = "Cheapest formulation at the protein midpoint between the lowest-cost and highest-protein optima (front is linear, no distinct knee)."
        cands.insert(1, _candidate(prob, xk, req, "Balanced (Pareto)", "balanced", why))

    if mode in ("all", "processing") and req.get("processing"):
        cands.append(processing_candidate(prob, req, experiments or []))
    out["candidates"] = cands
    # surrogate predictions for LP candidates if a model is available
    return out


def _feasible_starts(prob: Problem, k: int = 16, seed: int = 1) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    starts = []
    for _ in range(k):
        c = rng.standard_normal(len(prob.ids))
        res, _ = _solve(prob, c)
        if res.status == 0:
            starts.append(res.x)
    if len(starts) >= 2:
        mixes = []
        for _ in range(k):
            w = rng.dirichlet(np.ones(len(starts)))
            mixes.append(np.sum([wi * s for wi, s in zip(w, starts)], axis=0))
        starts.extend(mixes)
    return starts


def processing_candidate(prob: Problem, req: dict, experiments: list[dict]) -> dict:
    spec = req["processing"]
    response = spec.get("response", "viscosity_pa_s")
    lo, hi = spec.get("lower"), spec.get("upper")
    meta = RESPONSES.get(response, {"label": response, "unit": ""})
    base = {"label": "Best processing compatibility", "mode": "processing", "response": response,
            "response_label": meta["label"], "unit": meta.get("unit", "")}
    try:
        sur = Surrogate(prob.ids, response).fit(experiments)
    except ValueError as e:
        return {**base, "status": "insufficient_data", "message": str(e),
                "rationale": "Processing compatibility cannot be optimised without measured response data. Use the Experiments module to plan and record a space-filling set of experiments."}
    tl = math.log(lo) if (sur.log and lo) else lo
    th = math.log(hi) if (sur.log and hi) else hi
    A, b = prob.A, prob.b
    cons = [{"type": "eq", "fun": lambda x: np.sum(x) - 100.0, "jac": lambda x: np.ones_like(x)}]
    if len(b):
        cons.append({"type": "ineq", "fun": lambda x: b - A @ x, "jac": lambda x: -A})

    def mu(x):
        return float(sur.predict_transformed(x)[0][0])

    if tl is not None:
        cons.append({"type": "ineq", "fun": lambda x: mu(x) - tl})
    if th is not None:
        cons.append({"type": "ineq", "fun": lambda x: th - mu(x)})
    target = None
    if tl is not None and th is not None:
        target = (tl + th) / 2
    elif tl is not None:
        target = tl
    elif th is not None:
        target = th
    cost_vec = prob.price / 100.0
    best, best_val, closest, closest_gap = None, math.inf, None, math.inf
    for x0 in _feasible_starts(prob):
        r = minimize(lambda x: float(cost_vec @ x), x0, jac=lambda x: cost_vec, method="SLSQP", bounds=[(0, 100)] * len(x0), constraints=cons, options={"maxiter": 200, "ftol": 1e-9})
        x = np.clip(r.x, 0, 100)
        lin_ok = abs(x.sum() - 100) < 1e-4 and (len(b) == 0 or np.all(A @ x <= b + 1e-5))
        m = mu(x)
        win_ok = (tl is None or m >= tl - 1e-6) and (th is None or m <= th + 1e-6)
        if lin_ok and win_ok and cost_vec @ x < best_val:
            best, best_val = x, float(cost_vec @ x)
        if lin_ok and target is not None:
            gap = abs(m - target)
            if gap < closest_gap:
                closest, closest_gap = x, gap
    info = sur.info()
    cv = sur.loo_cv()
    warnings = []
    if "synthetic_demo" in info["data_types"]:
        warnings.append("Surrogate trained on SYNTHETIC demonstration data - predictions illustrate the workflow only and carry no physical meaning.")
    if cv["q2"] < 0.5:
        warnings.append(f"Leave-one-out Q2 = {cv['q2']:.2f} (< 0.5): surrogate predictive quality is poor; treat as exploratory.")
    x = best if best is not None else closest
    if x is None:
        return {**base, "status": "no_solution", "message": "Optimiser found no linearly feasible point.", "model": info, "cv": cv}
    pm, ps, plo, phi = sur.predict(x)
    nov = float(sur.novelty(x)[0])
    if nov > 1.5:
        warnings.append(f"Candidate is {nov:.2f} standardised units from the nearest experiment: extrapolation - validate experimentally.")
    status = "optimal" if best is not None else "window_not_reached"
    cand = _candidate(prob, x, req, base["label"], "processing",
                      "Minimises cost subject to all composition constraints and the GP-predicted response lying in the target window." if best is not None
                      else "No formulation was predicted to meet the target window; showing the feasible formulation whose prediction is closest to the target.")
    cand.update(base)
    cand.update({"status": status, "prediction": {"value": float(pm[0]), "std_transformed": float(ps[0]), "band_low": float(plo[0]), "band_high": float(phi[0]), "target_low": lo, "target_high": hi, "novelty": nov},
                 "model": info, "cv": {k: v for k, v in cv.items() if k not in ("predictions", "observed")}, "model_warnings": warnings})
    return cand
