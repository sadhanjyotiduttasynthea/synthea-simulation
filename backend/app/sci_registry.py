"""Scientific Model Registry: equations with parameters, units, validity ranges and approval status.

* Expressions are machine-readable strings for the restricted parser (no code execution).
* Dimensional consistency is checked by evaluating the expression with *pint* quantities.
* Evaluation enforces the model status (only approved/validated models are used for
  simulation) and validity ranges (out-of-range inputs are refused unless extrapolation is
  explicitly allowed, in which case results are flagged).
* ``resolve`` is the internal scientific-model API used by simulations: given a material,
  a quantity and conditions it returns compatible approved models and property records,
  ranked by condition similarity, with in-range information.
"""
from __future__ import annotations

import ast
import math
import uuid
from datetime import datetime, timezone

import numpy as np

from . import db
from .science import catalog, expression

STATUSES = ("extracted", "reviewed", "approved", "validated", "deprecated", "rejected")
USABLE = ("approved", "validated")
R_GAS = 8.314462618

TEMPLATES = {
    "herschel_bulkley": {
        "name": "Herschel–Bulkley model", "category": "rheology", "latex": r"\tau = \tau_0 + K\,\dot{\gamma}^{\,n}", "expression": "tau0 + K * gamma_dot ** n",
        "dependent": {"symbol": "tau", "name": "shear stress", "unit": "Pa"},
        "variables": [{"symbol": "gamma_dot", "latex": r"\dot\gamma", "name": "shear rate", "unit": "1/s"}],
        "parameters": [{"symbol": "tau0", "latex": r"\tau_0", "name": "yield stress", "unit": "Pa"}, {"symbol": "K", "latex": "K", "name": "consistency index", "unit": "Pa*s**n"},
                       {"symbol": "n", "latex": "n", "name": "flow behaviour index", "unit": ""}],
        "provides": ["shear_stress", "viscosity", "rheology_hb"],
    },
    "power_law": {
        "name": "Power-law model", "category": "rheology", "latex": r"\tau = K\,\dot{\gamma}^{\,n}", "expression": "K * gamma_dot ** n",
        "dependent": {"symbol": "tau", "name": "shear stress", "unit": "Pa"},
        "variables": [{"symbol": "gamma_dot", "latex": r"\dot\gamma", "name": "shear rate", "unit": "1/s"}],
        "parameters": [{"symbol": "K", "latex": "K", "name": "consistency index", "unit": "Pa*s**n"}, {"symbol": "n", "latex": "n", "name": "flow behaviour index", "unit": ""}],
        "provides": ["shear_stress", "viscosity", "rheology_hb"],
    },
    "newtonian": {
        "name": "Newtonian fluid", "category": "rheology", "latex": r"\tau = \mu\,\dot{\gamma}", "expression": "mu * gamma_dot",
        "dependent": {"symbol": "tau", "name": "shear stress", "unit": "Pa"},
        "variables": [{"symbol": "gamma_dot", "latex": r"\dot\gamma", "name": "shear rate", "unit": "1/s"}],
        "parameters": [{"symbol": "mu", "latex": r"\mu", "name": "dynamic viscosity", "unit": "Pa*s"}],
        "provides": ["shear_stress", "viscosity", "rheology_hb"],
    },
    "arrhenius_viscosity": {
        "name": "Arrhenius temperature dependence of viscosity", "category": "rheology", "latex": r"\eta = A\,\exp\!\left(\frac{E_a}{R\,T}\right)",
        "expression": "A * exp(Ea / (R * T))", "dependent": {"symbol": "eta", "name": "apparent viscosity", "unit": "Pa*s"},
        "variables": [{"symbol": "T", "latex": "T", "name": "absolute temperature", "unit": "K"}],
        "parameters": [{"symbol": "A", "latex": "A", "name": "pre-exponential factor", "unit": "Pa*s"}, {"symbol": "Ea", "latex": "E_a", "name": "flow activation energy", "unit": "J/mol"}],
        "constants": {"R": {"value": R_GAS, "unit": "J/(mol*K)"}}, "provides": ["viscosity_temperature"],
    },
    "first_order_arrhenius": {
        "name": "First-order kinetics, Arrhenius rate constant", "category": "kinetics",
        "latex": r"\frac{dX}{dt} = -k(T)\,X,\quad k(T) = k_{ref}\exp\!\left[-\frac{E_a}{R}\left(\frac{1}{T}-\frac{1}{T_{ref}}\right)\right]",
        "expression": "k_ref * exp(-(Ea / R) * (1 / T - 1 / T_ref))", "dependent": {"symbol": "k", "name": "rate constant", "unit": "1/s"},
        "variables": [{"symbol": "T", "latex": "T", "name": "absolute temperature", "unit": "K"}],
        "parameters": [{"symbol": "k_ref", "latex": "k_{ref}", "name": "rate constant at T_ref", "unit": "1/s"}, {"symbol": "Ea", "latex": "E_a", "name": "activation energy", "unit": "J/mol"},
                       {"symbol": "T_ref", "latex": "T_{ref}", "name": "reference temperature", "unit": "K"}],
        "constants": {"R": {"value": R_GAS, "unit": "J/(mol*K)"}}, "provides": ["rate_constant", "kinetics_first_order"],
    },
    "linear_temperature": {
        "name": "Linear temperature dependence", "category": "thermal", "latex": r"y = y_0 + a\,(T - T_0)", "expression": "y0 + a * (T - T0)",
        "dependent": {"symbol": "y", "name": "property", "unit": ""},
        "variables": [{"symbol": "T", "latex": "T", "name": "temperature", "unit": "degC"}],
        "parameters": [{"symbol": "y0", "latex": "y_0", "name": "value at T0", "unit": ""}, {"symbol": "a", "latex": "a", "name": "slope", "unit": ""}, {"symbol": "T0", "latex": "T_0", "name": "reference temperature", "unit": "degC"}],
        "provides": [],
    },
}


def _now():
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------------ dimensional analysis
def _unit_for(unit: str | None, params: dict):
    """pint unit for a declared unit string; '**n' exponents are substituted by the value of parameter n."""
    u = (unit or "").strip()
    if not u:
        return catalog.ureg.dimensionless
    if "**n" in u:
        n = params.get("n")
        if n is None:
            raise ValueError("unit uses exponent n but parameter n has no value")
        u = u.replace("**n", f"**{n}")
    return catalog.parse_unit(u)


def _eval_q(node, env):
    """Evaluate an expression AST with pint quantities (whitelist identical to the numeric parser)."""
    import operator as op
    if isinstance(node, ast.Expression):
        return _eval_q(node.body, env)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        if node.id == "pi":
            return math.pi
        raise expression.ExpressionError(f"Unknown symbol '{node.id}'")
    if isinstance(node, ast.BinOp):
        a, b = _eval_q(node.left, env), _eval_q(node.right, env)
        ops = {ast.Add: op.add, ast.Sub: op.sub, ast.Mult: op.mul, ast.Div: op.truediv, ast.Pow: op.pow}
        if type(node.op) not in ops:
            raise expression.ExpressionError("unsupported operator")
        if isinstance(node.op, ast.Pow) and hasattr(b, "magnitude"):
            b = b.to("dimensionless").magnitude
        return ops[type(node.op)](a, b)
    if isinstance(node, ast.UnaryOp):
        v = _eval_q(node.operand, env)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        args = [_eval_q(a, env) for a in node.args]
        f = node.func.id
        if f in ("exp", "log", "log10", "sin", "cos", "tan", "tanh"):
            x = args[0]
            if hasattr(x, "to"):
                x = x.to("dimensionless").magnitude  # raises DimensionalityError if not dimensionless
            return getattr(np, f)(x) if f != "log" else np.log(x)
        if f == "sqrt":
            return args[0] ** 0.5
        if f == "abs":
            return abs(args[0])
        if f in ("min", "max"):
            return (min if f == "min" else max)(args)
        if f == "pow":
            return args[0] ** (args[1].magnitude if hasattr(args[1], "magnitude") else args[1])
    raise expression.ExpressionError(f"Unsupported element {type(node).__name__}")


def dimension_check(m: dict) -> dict:
    Q = catalog.Q_
    try:
        pvals = {p["symbol"]: p.get("value") for p in m.get("parameters", [])}
        env = {}
        for p in m.get("parameters", []):
            if p.get("value") is None:
                return {"ok": None, "message": f"parameter {p['symbol']} has no value"}
            env[p["symbol"]] = Q(float(p["value"]), _unit_for(p.get("unit"), pvals))
        for v in m.get("variables", []):
            rng = (m.get("validity") or {}).get(v["symbol"]) or v.get("range")
            x = (rng[0] + rng[1]) / 2 if rng else 1.0
            if (v.get("unit") or "").strip() in ("degC",):
                env[v["symbol"]] = Q(x, "delta_degC")
            else:
                env[v["symbol"]] = Q(x, _unit_for(v.get("unit"), pvals))
        for k, c in (m.get("constants") or {}).items():
            env[k] = Q(c["value"], _unit_for(c.get("unit"), pvals))
        res = _eval_q(expression.parse(m["expression"]), env)
        target = _unit_for(m.get("dependent", {}).get("unit"), pvals)
        res_q = res if hasattr(res, "to") else Q(res, "dimensionless")
        if (m.get("dependent", {}).get("unit") or "") in ("degC",):
            target = catalog.ureg.delta_degC
        res_q.to(target)
        return {"ok": True, "message": f"result dimension {res_q.dimensionality} matches {m['dependent'].get('unit') or 'dimensionless'}"}
    except expression.ExpressionError as e:
        return {"ok": False, "message": f"expression error: {e}"}
    except Exception as e:  # pint dimensionality / undefined units
        return {"ok": False, "message": f"{type(e).__name__}: {e}"}


# ------------------------------------------------------------------ CRUD and workflow
def save(doc: dict, note: str = "edited") -> dict:
    doc = dict(doc)
    if not doc.get("expression"):
        raise ValueError("A machine-readable expression is required")
    expression.parse(doc["expression"])
    declared = {p["symbol"] for p in doc.get("parameters", [])} | {v["symbol"] for v in doc.get("variables", [])} | set((doc.get("constants") or {}).keys())
    missing = [s for s in expression.variables_in(doc["expression"]) if s not in declared]
    if missing:
        raise ValueError("Undeclared symbols in expression: " + ", ".join(missing))
    if doc.get("status", "extracted") not in STATUSES:
        raise ValueError("invalid status")
    old = db.get_doc("sci_models", doc["id"]) if doc.get("id") else None
    doc.setdefault("id", f"model-{uuid.uuid4().hex[:10]}")
    doc.setdefault("status", "extracted")
    doc.setdefault("validity", {})
    doc.setdefault("validation", [])
    doc.setdefault("limitations", [])
    doc["parent_id"] = doc.get("material_id")
    if old and old.get("status") in USABLE and doc["status"] in USABLE:
        changed = [k for k in ("expression", "parameters", "validity") if old.get(k) != doc.get(k)]
        if changed:  # editing an approved model demotes it to reviewed
            doc["status"] = "reviewed"
            note = f"{note}; changed {', '.join(changed)} → status reset to reviewed"
    if doc["status"] == "validated" and not doc.get("validation"):
        raise ValueError("A model can only be marked validated after a validation result is attached")
    doc["dimension_check"] = dimension_check(doc)
    if doc["status"] in USABLE and doc["dimension_check"]["ok"] is False:
        raise ValueError("Cannot approve a model that fails the dimensional check: " + doc["dimension_check"]["message"])
    hist = list((old or {}).get("history", []))
    hist.append({"t": _now(), "note": note if old else "created", "status": doc["status"]})
    doc["history"] = hist[-50:]
    doc["version"] = len(hist)
    return db.put_doc("sci_models", doc)


def from_template(tid: str, **kw) -> dict:
    t = TEMPLATES[tid]
    m = {"template": tid, "name": t["name"], "category": t["category"], "latex": t["latex"], "expression": t["expression"],
         "dependent": dict(t["dependent"]), "variables": [dict(v) for v in t["variables"]], "parameters": [{**p, "value": None} for p in t["parameters"]],
         "constants": dict(t.get("constants", {})), "provides": list(t.get("provides", []))}
    m.update(kw)
    return m


def evaluate(m: dict, inputs: dict, allow_extrapolation: bool = False, require_approved: bool = True) -> dict:
    warnings = []
    if require_approved and m.get("status") not in USABLE:
        raise ValueError(f"Model '{m.get('name')}' is {m.get('status')}; only approved or validated models can be used for calculation.")
    env = {p["symbol"]: float(p["value"]) for p in m.get("parameters", []) if p.get("value") is not None}
    missing = [p["symbol"] for p in m.get("parameters", []) if p.get("value") is None]
    if missing:
        raise ValueError("Parameters without values: " + ", ".join(missing))
    env.update({k: float(c["value"]) for k, c in (m.get("constants") or {}).items()})
    out_of_range = []
    for v in m.get("variables", []):
        if v["symbol"] not in inputs:
            raise ValueError(f"input {v['symbol']} ({v.get('name')}) required")
        x = float(inputs[v["symbol"]])
        env[v["symbol"]] = x
        rng = (m.get("validity") or {}).get(v["symbol"])
        if rng and not (rng[0] - 1e-12 <= x <= rng[1] + 1e-12):
            out_of_range.append(f"{v.get('name', v['symbol'])} = {x:g} {v.get('unit', '')} outside validated range [{rng[0]:g}, {rng[1]:g}]")
    if out_of_range and not allow_extrapolation:
        raise ValueError("Extrapolation refused: " + "; ".join(out_of_range))
    warnings += [f"EXTRAPOLATION: {w}" for w in out_of_range]
    val = expression.evaluate(m["expression"], env)
    return {"value": val, "unit": m["dependent"].get("unit", ""), "extrapolated": bool(out_of_range), "warnings": warnings, "model_id": m["id"], "status": m["status"]}


def evaluate_curve(m: dict, var: str, lo: float, hi: float, n: int = 60, fixed: dict | None = None, log: bool = False, require_approved=False) -> list[dict]:
    xs = np.logspace(math.log10(lo), math.log10(hi), n) if log and lo > 0 else np.linspace(lo, hi, n)
    out = []
    for x in xs:
        try:
            r = evaluate(m, {**(fixed or {}), var: float(x)}, allow_extrapolation=True, require_approved=require_approved)
            out.append({"x": float(x), "y": r["value"], "extrapolated": r["extrapolated"]})
        except (ValueError, expression.ExpressionError):
            out.append({"x": float(x), "y": None, "extrapolated": True})
    return out


def validate(m: dict, data: list[dict], label: str = "user dataset") -> dict:
    """Compare model predictions with observations [{inputs:{...}, observed: y}] (no fitting)."""
    obs, pred = [], []
    for d in data:
        r = evaluate(m, d["inputs"], allow_extrapolation=True, require_approved=False)
        obs.append(float(d["observed"]))
        pred.append(r["value"])
    o, p = np.array(obs), np.array(pred)
    resid = p - o
    ss_tot = float(np.sum((o - o.mean()) ** 2)) or 1e-12
    res = {"dataset": label, "n": len(o), "rmse": float(np.sqrt(np.mean(resid ** 2))), "mae": float(np.mean(np.abs(resid))),
           "r2": 1 - float(np.sum(resid ** 2)) / ss_tot, "mape_pct": float(np.mean(np.abs(resid) / np.maximum(np.abs(o), 1e-12)) * 100),
           "date": _now(), "points": [{"observed": a, "predicted": b} for a, b in zip(obs, pred)]}
    return res


# ------------------------------------------------------------------ resolver (internal scientific model API)
QUANTITY_PROPERTIES = {"viscosity": ["viscosity"], "rheology_hb": ["yield_stress", "consistency_index", "flow_behaviour_index"],
                       "thermal_conductivity": ["thermal_conductivity"], "specific_heat": ["specific_heat"], "density": ["density"],
                       "rate_constant": ["rate_constant"], "diffusion_coefficient": ["diffusion_coefficient"]}


def _cond_distance(a: dict, b: dict) -> tuple[float, list[str]]:
    scale = {"temperature": 10.0, "concentration": 5.0, "ph": 1.0, "shear_rate": 10.0, "water_content": 5.0}
    d, notes = 0.0, []
    for k, s in scale.items():
        if k in (b or {}) and b[k] is not None:
            if k in (a or {}) and a[k] is not None:
                d += ((float(a[k]) - float(b[k])) / s) ** 2
            else:
                notes.append(f"{k} not stated in source")
    return math.sqrt(d), notes


def resolve(material_id: str, quantity: str, conditions: dict | None = None, include_unapproved: bool = False) -> dict:
    conditions = conditions or {}
    mat = db.get_doc("materials", material_id)
    if not mat:
        raise KeyError(material_id)
    models = []
    for m in db.list_docs("sci_models"):
        if m.get("material_id") != material_id or quantity not in (m.get("provides") or []):
            continue
        if not include_unapproved and m.get("status") not in USABLE:
            continue
        dist, notes = _cond_distance(m.get("conditions") or {}, conditions)
        models.append({"id": m["id"], "name": m["name"], "status": m["status"], "conditions": m.get("conditions"), "validity": m.get("validity"),
                       "condition_distance": dist, "notes": notes, "source": m.get("source"), "template": m.get("template"),
                       "exact_conditions": dist < 1e-9 and not notes})
    models.sort(key=lambda x: (x["condition_distance"], x["status"] != "validated"))
    props = []
    for key in QUANTITY_PROPERTIES.get(quantity, [quantity]):
        for p in db.list_children("properties", material_id):
            if p["property"] != key or (not include_unapproved and p.get("review_status") != "approved"):
                continue
            dist, notes = _cond_distance(p.get("conditions") or {}, conditions)
            props.append({"id": p["id"], "property": key, "value": (p.get("normalized") or {}).get("value"), "unit": (p.get("normalized") or {}).get("unit"),
                          "conditions": p.get("conditions"), "condition_distance": dist, "notes": notes, "source": p.get("source"), "status": p.get("review_status")})
    props.sort(key=lambda x: x["condition_distance"])
    msg = None
    if not models and not props:
        msg = (f"No approved model or property record for '{quantity}' of {mat['name']}. Experimental characterisation (or review and approval of "
               f"extracted data) is required before this quantity can be simulated.")
    return {"material": {"id": mat["id"], "name": mat["name"]}, "quantity": quantity, "requested_conditions": conditions, "models": models, "properties": props, "message": msg}


def hb_parameters(model: dict) -> dict:
    """Return Herschel–Bulkley parameters (SI) from an HB / power-law / Newtonian model."""
    p = {x["symbol"]: x.get("value") for x in model.get("parameters", [])}
    t = model.get("template")
    if t == "herschel_bulkley":
        return {"yield_stress_pa": float(p["tau0"]), "consistency_index_pa_sn": float(p["K"]), "flow_behaviour_index": float(p["n"])}
    if t == "power_law":
        return {"yield_stress_pa": 0.0, "consistency_index_pa_sn": float(p["K"]), "flow_behaviour_index": float(p["n"])}
    if t == "newtonian":
        return {"yield_stress_pa": 0.0, "consistency_index_pa_sn": float(p["mu"]), "flow_behaviour_index": 1.0}
    raise ValueError("Model does not define a Herschel–Bulkley-type constitutive law")
