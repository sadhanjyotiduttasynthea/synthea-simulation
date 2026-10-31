"""AI assistant.

Two back-ends:
* ``local`` (always available): deterministic, rule-based explanations built
  only from values computed by the engine. No external service.
* ``claude`` (optional): used when ANTHROPIC_API_KEY is set on the server. The
  model receives the engine's computed context as JSON and is instructed never
  to produce numbers that are not present in that context.
"""
from __future__ import annotations

import json
import os

MODEL = os.environ.get("SYNTHEA_AI_MODEL", "claude-opus-5-5")

SYSTEM_PROMPT = """You are the scientific assistant inside Synthea Simulation, a virtual food-formulation platform.
You explain ingredient properties, formulation results, optimisation trade-offs, missing data, experimental plans and process/printing simulations.

Rules:
- Every number you state must appear in the CONTEXT JSON supplied by the computation engine. Never estimate, invent or round-trip new numerical results; if a number is not in the context, say it is not available and name the measurement or calculation that would provide it.
- Clearly distinguish measured data, literature data, calculated results, model predictions, illustrative assumptions and missing information, using the provenance labels in the context.
- Do not claim that simulation replaces physical validation. Recommend experiments when predictions are uncertain or data are illustrative/synthetic.
- Be concise and technical (food science / process engineering audience). Use short paragraphs or bullet lists."""


def status() -> dict:
    key = bool(os.environ.get("ANTHROPIC_API_KEY"))
    return {"llm_available": key, "model": MODEL if key else None,
            "mode": "claude" if key else "local",
            "note": "External AI is optional. Without an API key the built-in deterministic explainer is used."}


def _fmt(v, nd=2):
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def local_answer(question: str, page: str, context: dict) -> str:
    q = (question or "").lower()
    lines: list[str] = []
    ctx = context or {}

    res = ctx.get("result") or ctx.get("composition_result")
    if res and isinstance(res, dict) and res.get("composition"):
        c = res["composition"]
        lines.append(f"Calculated composition (mass balance): protein {_fmt(c.get('protein'))} %, fat {_fmt(c.get('fat'))} %, carbohydrate {_fmt(c.get('carbohydrate'))} %, moisture {_fmt(c.get('moisture'))} %.")
        if res.get("cost_per_kg") is not None:
            lines.append(f"Raw-material cost {_fmt(res['cost_per_kg'], 3)} EUR/kg; {_fmt(res.get('cost_per_g_protein'), 4)} EUR per g protein. Prices in the library are illustrative unless replaced by real quotations.")
        if res.get("missing_data"):
            lines.append("Missing data: " + "; ".join(res["missing_data"][:6]) + ".")

    opt = ctx.get("optimisation")
    if opt:
        if opt.get("status") == "infeasible":
            inf = opt.get("infeasibility", {})
            lines.append("The optimisation problem is infeasible. " + " ".join(inf.get("reasons", [])))
            for r in inf.get("relaxations", [])[:5]:
                lines.append(f"- Minimum relaxation found by elastic LP: {r['text']}.")
            for s in inf.get("suggestions", [])[:4]:
                lines.append(f"- {s}")
        else:
            for cand in opt.get("candidates", []):
                if cand.get("status") == "insufficient_data":
                    lines.append(f"{cand['label']}: {cand.get('message')}")
                    continue
                comp = cand.get("composition", {})
                lines.append(f"{cand['label']}: protein {_fmt(comp.get('protein'))} %, cost {_fmt(cand.get('cost_per_kg'), 3)} EUR/kg. {cand.get('rationale', '')}")
                binding = [k['constraint'] for k in cand.get('constraints', []) if k.get('binding')]
                if binding:
                    lines.append(f"  Binding (active) constraints: {', '.join(binding)}.")
                for s in (cand.get("sensitivities") or [])[:3]:
                    lines.append(f"  {s['text']}")
            if "trade" in q or not q:
                lines.append("Trade-off: along the Pareto front each extra percentage point of protein is bought with more protein isolate, the most expensive protein carrier; the knee point marks where cost begins to rise faster per unit protein.")
        lines.append("Limitations: the linear model optimises composition and cost only; texture, flavour and processability must be verified experimentally.")

    exp = ctx.get("recommendation")
    if exp:
        lines.append(f"Experimental plan phase: {exp.get('phase')}. Method: {exp.get('method')} Reason: {exp.get('reason')}")
        for w in exp.get("warnings", []):
            lines.append(f"Warning: {w}")

    proc = ctx.get("process")
    if proc:
        s = proc.get("summary", {})
        lines.append(f"Process simulation (lumped steady-state balances): feed {_fmt(s.get('feed_kg_h'))} kg/h, product {_fmt(s.get('product_kg_h'))} kg/h, total electrical power {_fmt(s.get('total_power_kw'))} kW, specific energy {_fmt(s.get('specific_energy_kwh_per_kg_product'), 3)} kWh/kg.")
        uns = [u for unit in proc.get("units", []) for u in unit.get("unsupported", [])]
        if uns:
            lines.append("Unsupported predictions (missing data): " + "; ".join(sorted(set(uns))))

    pr = ctx.get("print")
    if pr:
        lines.append(f"Print job: {pr.get('layer_count')} layers, extrusion path {_fmt(pr.get('extrusion_length_mm'), 0)} mm, estimated time {_fmt((pr.get('print_time_s') or 0) / 60, 1)} min, deposited volume {_fmt(pr.get('deposited_volume_cm3'))} cm3.")
        for u in pr.get("unsupported", []):
            lines.append(f"Not predicted: {u}")

    ing = ctx.get("ingredient")
    if ing:
        prov = ing.get("provenance", {})
        lines.append(f"{ing.get('name')}: data provenance - " + ", ".join(f"{k}: {v}" for k, v in prov.items()) + ".")
        ev = ing.get("evidence", {})
        if ev.get("validation_status"):
            lines.append(f"Validation status: {ev['validation_status']}")
        missing = [k for k, v in (ing.get("rheology") or {}).items() if v is None]
        if missing:
            lines.append("Rheology fields missing: " + ", ".join(missing) + ". Measure flow curves (e.g. rotational rheometer, controlled shear rate sweep) at the relevant concentration and temperature.")

    if "missing" in q and not any("issing" in l for l in lines):
        lines.append("No missing-data flags in the current context.")
    if not lines:
        lines.append(f"I can explain results on the '{page}' page once a calculation has been run. Ask about composition, cost, optimisation trade-offs, missing data, experimental planning, process or printing results.")
    lines.append("(Built-in deterministic explainer: all numbers above come directly from the computation engine.)")
    return "\n".join(lines)


def ask(question: str, page: str, context: dict) -> dict:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"mode": "local", "answer": local_answer(question, page, context)}
    try:
        import anthropic

        client = anthropic.Anthropic()
        ctx_json = json.dumps(context, default=str)[:150_000]
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM_PROMPT,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": f"PAGE: {page}\nCONTEXT (computed by the engine):\n{ctx_json}\n\nQUESTION: {question}"}],
        )
        if resp.stop_reason == "refusal":
            return {"mode": "local", "answer": local_answer(question, page, context), "note": "External model declined; showing built-in explanation."}
        text = "".join(b.text for b in resp.content if b.type == "text")
        return {"mode": "claude", "model": resp.model, "answer": text}
    except Exception as e:  # network/auth errors must not break the app
        return {"mode": "local", "answer": local_answer(question, page, context), "note": f"External AI unavailable ({type(e).__name__}); showing built-in explanation."}
