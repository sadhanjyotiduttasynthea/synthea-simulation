"""Scientific information extraction from research papers.

Pipeline: PDF text/tables (papers.py) -> extractor -> structured *candidates* -> source
verification -> human review -> approved library records / registry models.

Extractors
----------
* ``rule``  : local, deterministic (always available). Finds property values with units and
              uncertainties near catalogue aliases, per-value experimental conditions, fitted
              parameters in tables (header symbols/units) and known equation forms.
* ``ai``    : optional Claude extraction (only with an API key AND explicit user opt-in to send
              document text to the external service). Output is verified exactly like rule output.

Every candidate keeps page number + verbatim supporting passage (or table cell reference) and a
verification block: the passage must occur on the stated page and the value must occur in the
passage. Candidates failing verification are flagged and never auto-approved. Nothing is
written to a library until a human approves it.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone

from . import db
from .science import catalog

NUM = r"(\d+(?:[.,]\d+)?(?:\s*[x×]\s*10\s*[-−–]?\s*\d+|\s*[eE][-+]?\d+)?)"
PM = r"(?:\s*(?:±|\+/-|\+-|&plusmn;)\s*(\d+(?:\.\d+)?))?"

UNIT_PATTERNS = {
    "Pa*s": r"(mPa\s*[·.⋅]?\s*s|Pa\s*[·.⋅]?\s*s|cP|mPa s|Pa s)(?!\s*\^?\s*n)",
    "degC": r"(°\s*C|ºC|℃|K\b)",
    "W/(m*K)": r"(W\s*/\s*\(?\s*m\s*[·.⋅]?\s*K\s*\)?|W\s*m\s*[-−]1\s*K\s*[-−]1)",
    "J/(kg*K)": r"(kJ\s*/\s*\(?\s*kg\s*[·.⋅]?\s*K\s*\)?|J\s*/\s*\(?\s*kg\s*[·.⋅]?\s*K\s*\)?|J\s*/\s*\(?\s*g\s*[·.⋅]?\s*K\s*\)?)",
    "m**2/s": r"(m\s*²\s*/\s*s|m2\s*/\s*s|m\s*2\s*s\s*[-−]1)",
    "kg/m**3": r"(kg\s*/\s*m\s*³|kg\s*/\s*m3|g\s*/\s*cm\s*³|g\s*/\s*cm3|g\s*/\s*mL)",
    "g/g": r"(g\s*/\s*g|mL\s*/\s*g)",
    "percent": r"(%)",
    "Pa": r"(kPa|MPa|Pa)(?!\s*[·.⋅]?\s*s)",
    "N": r"(N\b|mN\b)",
    "J/mol": r"(kJ\s*/\s*mol|J\s*/\s*mol|kJ\s*mol\s*[-−]1)",
    "J/g": r"(J\s*/\s*g)",
    "1/s": r"(s\s*[-−–]\s*1|s\^-1|s⁻¹|min\s*[-−]1|h\s*[-−]1)",
    "m**2/g": r"(m\s*²\s*/\s*g|m2\s*/\s*g)",
    "micrometer": r"(µm|μm|nm|mm)",
    "mV": r"(mV)",
    "W/(m**2*K)": r"(W\s*/\s*\(?\s*m\s*²\s*[·.⋅]?\s*K\s*\)?|W\s*m\s*[-−]2\s*K\s*[-−]1)",
}
COND_PATTERNS = [
    ("temperature", r"(?<![\d.])(-?\d+(?:\.\d+)?)\s*(?:°\s*C|ºC|℃)", 1.0),
    ("shear_rate", r"(\d+(?:\.\d+)?)\s*s\s*[-−–]\s*1", 1.0),
    ("concentration", r"(\d+(?:\.\d+)?)\s*%\s*\(?\s*w\s*/\s*[wv]\s*\)?", 1.0),
    ("ph", r"\bpH\s*(?:of\s*)?(\d+(?:\.\d+)?)", 1.0),
    ("heating_rate", r"(\d+(?:\.\d+)?)\s*(?:K|°C)\s*/\s*min", 1.0),
    ("frequency", r"(\d+(?:\.\d+)?)\s*Hz", 1.0),
]
N_REPL = re.compile(r"\(\s*n\s*=\s*(\d+)\s*\)")
TABLE_SYMBOLS = {
    "τ0": "yield_stress", "τ_0": "yield_stress", "τy": "yield_stress", "tau0": "yield_stress", "σ0": "yield_stress", "yield stress": "yield_stress",
    "k": "consistency_index", "consistency": "consistency_index",
    "n": "flow_behaviour_index", "flow behaviour index": "flow_behaviour_index", "flow behavior index": "flow_behaviour_index",
    "η": "viscosity", "viscosity": "viscosity", "ηapp": "viscosity",
    "g'": "storage_modulus", "g′": "storage_modulus", "g''": "loss_modulus", "g″": "loss_modulus",
    "td": "denaturation_temperature", "tg": "glass_transition_temperature", "whc": "water_holding_capacity", "ea": "activation_energy",
}
TABLE_CONDITIONS = {"concentration": "concentration", "conc": "concentration", "temperature": "temperature", "t (°c)": "temperature",
                    "ph": "ph", "shear rate": "shear_rate", "frequency": "frequency"}
CAPTION_FIT = re.compile(r"\b(fit|fitted|model|parameters)\b", re.I)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _norm_ws(s: str) -> str:
    return " ".join((s or "").replace("­", "").split())


def _num(s: str) -> float | None:
    s = s.replace(",", ".").replace("−", "-").replace("–", "-")
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*[x×]\s*10\s*(-?\s*\d+)\s*$", s)
    if m:
        return float(m.group(1)) * 10 ** int(m.group(2).replace(" ", ""))
    try:
        return float(s)
    except ValueError:
        return None


HEADING = re.compile(r"^\s*(\d+(\.\d+)*\.?\s+)?[A-Z][A-Za-z ,&-]{2,45}$")


def sentences(text: str) -> list[str]:
    # section headings ("3. Results") become sentence boundaries instead of merging into the next sentence
    lines = [(l.strip() + ".") if HEADING.match(l) and not l.strip().endswith((".", ":")) else l for l in (text or "").splitlines()]
    t = _norm_ws("\n".join(lines))
    parts = re.split(r"(?<=[\w\)\]%°])\.\s+(?=[A-Z(])", t)
    return [p.strip() for p in parts if len(p.strip()) > 15]


# ----------------------------------------------------------------- materials
def material_candidates(full_text: str) -> list[dict]:
    """Known materials mentioned in the paper (by name/synonym) and defined abbreviations."""
    low = full_text.lower()
    out = []
    for m in db.list_docs("materials"):
        names = [m["name"]] + m.get("synonyms", [])
        hits = sum(low.count(n.lower()) for n in names if len(n) > 3)
        if hits:
            out.append({"material_id": m["id"], "name": m["name"], "mentions": hits})
    abbr = {}
    for mm in re.finditer(r"([A-Za-z][A-Za-z \-]{4,60}?)\s*\(([A-Z]{2,6})\)", full_text):
        words = mm.group(1).strip().split()
        abbr[mm.group(2)] = " ".join(words[-4:])
    return sorted(out, key=lambda x: -x["mentions"]), abbr


# ----------------------------------------------------------------- rule-based extraction
SAFE_SINGLE_WORD = {"moisture", "viscosity", "hardness", "porosity", "solubility", "density"}
ALL_ALIASES = sorted({a for v in catalog.PROPERTIES.values() for a in v[3] if " " in a or a in SAFE_SINGLE_WORD}, key=len, reverse=True)


def _extraction_aliases(aliases: list[str]) -> list[str]:
    """Multi-word aliases (or a short allow-list of unambiguous single words) to avoid false positives
    such as 'protein' in 'pea protein isolate'."""
    return [a for a in aliases if " " in a or a in SAFE_SINGLE_WORD]


def _strip_uncertainty(text: str) -> str:
    return re.sub(r"(?:±|\+/-|\+-)\s*\d+(?:\.\d+)?\s*(?:°\s*C|ºC|℃|%|K)?", " ", text)


def _conditions_in(text: str, exclude_span: tuple[int, int] | None = None) -> dict:
    text = _strip_uncertainty(text)
    conds = {}
    for key, pat, _ in COND_PATTERNS:
        for m in re.finditer(pat, text):
            if exclude_span and exclude_span[0] <= m.start() < exclude_span[1]:
                continue
            v = _num(m.group(1))
            if v is not None and key not in conds:
                conds[key] = v
    return conds


def _value_regex(unit_key: str) -> re.Pattern:
    return re.compile(NUM + PM + r"\s*" + UNIT_PATTERNS[unit_key])


def extract_sentences(pages: list[dict], primary_material: dict | None) -> list[dict]:
    cands = []
    for pg in pages:
        for sent in sentences(pg["text"]):
            low = sent.lower()
            claimed: dict[tuple[int, int], int] = {}  # value span -> alias length (longest alias wins)
            found = []
            for key, (label, cat, unit, aliases) in catalog.PROPERTIES.items():
                if unit is None or unit not in UNIT_PATTERNS:
                    continue
                for alias in sorted(_extraction_aliases(aliases), key=len, reverse=True):
                    m_alias = re.search(r"(?<![a-z])" + re.escape(alias) + r"(?![a-z])", low)
                    if m_alias:
                        break
                else:
                    continue
                a_pos, a_end = m_alias.start(), m_alias.end()
                # the value must follow the alias before any other property alias appears
                stop = len(sent)
                for other in ALL_ALIASES:
                    if other in alias or alias in other:
                        continue
                    mo = re.search(r"(?<![a-z])" + re.escape(other) + r"(?![a-z])", low[a_end:])
                    if mo:
                        stop = min(stop, a_end + mo.start())
                rx = _value_regex(unit)
                matches = [m for m in rx.finditer(sent) if a_end <= m.start() < stop]
                for i, m in enumerate(matches[:4]):
                    before = sent[max(0, m.start() - 12): m.start()]
                    if re.search(r"\b[A-Za-z]{1,2}\s*=\s*$", before) and not re.search(r"\b(k|K|η|n)\s*=\s*$", before) and m.start() - a_end > 30:
                        continue  # value assigned to a different symbol far from the alias (e.g. 'A = ...')
                    if re.match(r"\s*\(?\s*w\s*/\s*[wv]", sent[m.end(): m.end() + 8]):
                        continue  # a concentration, not a content value
                    end = min(matches[i + 1].start() if i + 1 < len(matches) else stop, m.end() + 90)
                    shared = _conditions_in(sent[a_end: matches[0].start()]) if i == 0 else _conditions_in(sent[a_end: matches[0].start()])
                    local = _conditions_in(sent[m.end(): end])
                    conds = {**shared, **local}
                    if key.endswith("temperature"):
                        conds.pop("temperature", None)
                    val = _num(m.group(1))
                    if val is None:
                        continue
                    span = (m.start(), m.end())
                    if claimed.get(span, -1) >= len(alias):
                        continue
                    claimed[span] = len(alias)
                    unc = _num(m.group(2)) if m.group(2) else None
                    nrep = N_REPL.search(sent[m.end(): end])
                    found.append((span, len(alias), {
                        "kind": "property", "property": key, "label": label, "value": float(f"{val:.12g}"), "unit": m.group(3).strip(),
                        "uncertainty": {"type": "sd", "value": unc} if unc is not None else {},
                        "n": int(nrep.group(1)) if nrep else None, "conditions": conds,
                        "page": pg["n"], "snippet": sent, "value_text_in_source": m.group(0).strip(),
                        "evidence_type": "directly_reported", "confidence": "medium" if conds else "low",
                        "material_name": (primary_material or {}).get("name"), "material_id": (primary_material or {}).get("material_id"),
                        "notes": "Conditions taken from the same sentence; check the methods section for unstated conditions (e.g. pH, shear rate).",
                    }))
            for span, alen, c in found:
                if claimed.get(span) == alen:
                    cands.append(c)
    return cands


def _header_key(h: str) -> tuple[str | None, str | None, str | None]:
    """Map a table header like 'τ0 (Pa)' to (kind, key, unit)."""
    hs = _norm_ws(h)
    unit = None
    m = re.search(r"\(([^()]*)\)\s*$", hs)
    if m:
        unit = m.group(1).strip()
        hs = hs[: m.start()].strip()
    low = hs.lower().replace(" ", "") if len(hs) <= 4 else hs.lower()
    for k, v in TABLE_CONDITIONS.items():
        if low.startswith(k):
            return "condition", v, unit
    if low in ("r²", "r2", "r^2", "adj.r²"):
        return "fit", "r2", None
    for k, v in TABLE_SYMBOLS.items():
        if low == k.replace(" ", "") or low == k:
            return "property", v, (unit if unit not in ("-", "–") else "")
    for key, (label, cat, u, aliases) in catalog.PROPERTIES.items():
        if any(a == hs.lower() for a in aliases):
            return "property", key, unit
    return None, None, unit


def extract_tables(pages: list[dict], primary_material: dict | None) -> tuple[list[dict], list[dict]]:
    cands, param_sets = [], []
    for pg in pages:
        text = _norm_ws(pg["text"])
        for t in pg.get("tables", []):
            rows = t["rows"]
            if len(rows) < 2:
                continue
            heads = [_header_key(h) for h in rows[0]]
            if not any(h[0] == "property" for h in heads):
                continue
            cap = re.search(r"(Table\s+\d+\.?[^.]*\.)", text)
            caption = cap.group(1) if cap else f"Table {t['id']}"
            fitted = bool(CAPTION_FIT.search(caption))
            for ri, row in enumerate(rows[1:], start=1):
                conds, props, r2 = {}, {}, None
                for (kind, key, unit), cell in zip(heads, row):
                    v = _num(cell) if cell else None
                    if v is None:
                        continue
                    if kind == "condition":
                        conds[key] = v
                    elif kind == "fit":
                        r2 = v
                    elif kind == "property":
                        props[key] = (v, unit, cell)
                for key, (v, unit, cell) in props.items():
                    meta = catalog.property_meta(key)
                    cands.append({
                        "kind": "property", "property": key, "label": meta["label"], "value": v, "unit": unit if unit is not None else (meta["unit"] or ""),
                        "uncertainty": {}, "n": None, "conditions": dict(conds), "page": pg["n"],
                        "snippet": " | ".join(row), "table_ref": f"{caption} (row {ri})", "table_id": t["id"], "value_text_in_source": cell,
                        "evidence_type": "fitted_parameter" if fitted else "directly_reported", "confidence": "high" if conds else "medium",
                        "material_name": (primary_material or {}).get("name"), "material_id": (primary_material or {}).get("material_id"),
                        "fit_r2": r2, "notes": f"From {caption}",
                    })
                if props:
                    param_sets.append({"page": pg["n"], "table_ref": f"{caption} (row {ri})", "conditions": conds,
                                       "parameters": {k: {"value": v, "unit": u} for k, (v, u, _) in props.items()}, "r2": r2, "row": row})
    return cands, param_sets


EQUATION_TEMPLATES = [
    {
        "id": "herschel_bulkley", "name": "Herschel–Bulkley model",
        "detect": lambda ctx: ("herschel" in ctx.lower()) or (re.search(r"τ\s*=\s*τ\s*0?", ctx) and re.search(r"γ", ctx) and "K" in ctx),
        "latex": r"\tau = \tau_0 + K\,\dot{\gamma}^{\,n}", "expression": "tau0 + K * gamma_dot ** n", "dependent": {"symbol": "tau", "name": "shear stress", "unit": "Pa"},
        "variables": [{"symbol": "gamma_dot", "latex": r"\dot\gamma", "name": "shear rate", "unit": "1/s"}],
        "parameters": [{"symbol": "tau0", "latex": r"\tau_0", "name": "yield stress", "unit": "Pa", "property": "yield_stress"},
                       {"symbol": "K", "latex": "K", "name": "consistency index", "unit": "Pa*s**n", "property": "consistency_index"},
                       {"symbol": "n", "latex": "n", "name": "flow behaviour index", "unit": "", "property": "flow_behaviour_index"}],
        "category": "rheology",
    },
    {
        "id": "power_law", "name": "Power-law (Ostwald–de Waele) model",
        "detect": lambda ctx: "power law" in ctx.lower() or "ostwald" in ctx.lower(),
        "latex": r"\tau = K\,\dot{\gamma}^{\,n}", "expression": "K * gamma_dot ** n", "dependent": {"symbol": "tau", "name": "shear stress", "unit": "Pa"},
        "variables": [{"symbol": "gamma_dot", "latex": r"\dot\gamma", "name": "shear rate", "unit": "1/s"}],
        "parameters": [{"symbol": "K", "latex": "K", "name": "consistency index", "unit": "Pa*s**n", "property": "consistency_index"},
                       {"symbol": "n", "latex": "n", "name": "flow behaviour index", "unit": "", "property": "flow_behaviour_index"}],
        "category": "rheology",
    },
    {
        "id": "arrhenius_viscosity", "name": "Arrhenius temperature dependence of viscosity",
        "detect": lambda ctx: "arrhenius" in ctx.lower() and ("viscosity" in ctx.lower() or "η" in ctx),
        "latex": r"\eta = A\,\exp\!\left(\frac{E_a}{R\,T}\right)", "expression": "A * exp(Ea / (R * T))", "dependent": {"symbol": "eta", "name": "apparent viscosity", "unit": "Pa*s"},
        "variables": [{"symbol": "T", "latex": "T", "name": "absolute temperature", "unit": "K"}],
        "parameters": [{"symbol": "A", "latex": "A", "name": "pre-exponential factor", "unit": "Pa*s"},
                       {"symbol": "Ea", "latex": "E_a", "name": "flow activation energy", "unit": "J/mol", "property": "activation_energy_flow"}],
        "constants": {"R": 8.314462618}, "category": "rheology",
    },
    {
        "id": "first_order_arrhenius", "name": "First-order reaction kinetics with Arrhenius rate constant",
        "detect": lambda ctx: "first-order" in ctx.lower() and "rate constant" in ctx.lower(),
        "latex": r"\frac{dX}{dt} = -k(T)\,X,\quad k(T) = k_{ref}\exp\!\left[-\frac{E_a}{R}\left(\frac{1}{T}-\frac{1}{T_{ref}}\right)\right]",
        "expression": "k_ref * exp(-(Ea / R) * (1 / T - 1 / T_ref))", "dependent": {"symbol": "k", "name": "rate constant", "unit": "1/s"},
        "variables": [{"symbol": "T", "latex": "T", "name": "absolute temperature", "unit": "K"}],
        "parameters": [{"symbol": "k_ref", "latex": "k_{ref}", "name": "rate constant at T_ref", "unit": "1/s", "property": "rate_constant"},
                       {"symbol": "Ea", "latex": "E_a", "name": "activation energy", "unit": "J/mol", "property": "activation_energy"},
                       {"symbol": "T_ref", "latex": "T_{ref}", "name": "reference temperature", "unit": "K"}],
        "constants": {"R": 8.314462618}, "category": "kinetics",
    },
]


def _tpl(tid):
    return next(t for t in EQUATION_TEMPLATES if t["id"] == tid)


def _detect_template(line: str, ctx: str):
    """Classify an equation line by its own form first, then by nearby wording."""
    l, c = line, ctx.lower()
    if "exp" in l:
        if "η" in l or "eta" in l.lower() or ("viscosity" in c and "rate constant" not in c[:400]):
            return _tpl("arrhenius_viscosity")
        if "first-order" in c:
            return _tpl("first_order_arrhenius")
        return None
    if re.search(r"τ", l) and re.search(r"τ\s*_?\s*(0|y)|τ0", l):
        return _tpl("herschel_bulkley")
    if re.search(r"τ", l) and re.search(r"γ", l):
        return _tpl("power_law")
    return None


def _param_from_text(ctx: str, sym: str, unit_key: str | None) -> tuple[float | None, str | None, str | None]:
    pats = {
        "Ea": r"(?:E\s*a|activation energy)\s*(?:=|of)?\s*" + NUM + r"\s*(kJ\s*/\s*mol|J\s*/\s*mol)",
        "A": r"\bA\s*=\s*" + NUM + r"\s*(Pa\s*[·.⋅]?\s*s|mPa\s*[·.⋅]?\s*s)",
        "k_ref": r"rate constant\s*k?\s*=?\s*" + NUM + r"\s*(s\s*[-−–]\s*1|min\s*[-−]\s*1)",
    }
    p = pats.get(sym)
    if not p:
        return None, None, None
    m = re.search(p, ctx, re.I)
    if not m:
        return None, None, None
    v = _num(m.group(1))
    return (float(f"{v:.12g}") if v is not None else None), m.group(2), m.group(0)


def extract_equations(pages: list[dict], param_sets: list[dict], primary_material: dict | None) -> list[dict]:
    cands = []
    all_text = " ".join(_norm_ws(p["text"]) for p in pages)
    for pg in pages:
        text = _norm_ws(pg["text"])
        for line in pg["text"].splitlines():
            l = _norm_ws(line)
            if "=" not in l or len(l) > 140:
                continue
            if not re.search(r"\(\s*\d+\s*\)\s*$", l) and not re.search(r"[τγηκλμσ]", l):
                continue
            ctx_i = text.find(l[:25])
            ctx = text[max(0, ctx_i - 400): ctx_i + 700] if ctx_i >= 0 else text
            tpl = _detect_template(l, ctx)
            base = {"kind": "equation", "page": pg["n"], "snippet": l, "context": ctx[:900], "evidence_type": "directly_reported",
                    "material_name": (primary_material or {}).get("name"), "material_id": (primary_material or {}).get("material_id")}
            if not tpl:
                cands.append({**base, "equation": {"name": "Unrecognised equation", "latex": "", "expression": "", "raw": l, "template": None},
                              "confidence": "low", "notes": "Equation form not recognised automatically. Enter LaTeX and a machine-readable expression manually."})
                continue
            eq = {k: v for k, v in tpl.items() if k != "detect"}
            eq["template"] = tpl["id"]
            eq["raw"] = l
            params = []
            for prm in tpl["parameters"]:
                v, u, src = _param_from_text(ctx + " " + all_text if prm["symbol"] in ("Ea", "A", "k_ref") else ctx, prm["symbol"], prm.get("unit"))
                params.append({**prm, "value": v, "value_unit": u, "source_text": src})
            if tpl["id"] == "first_order_arrhenius":
                m = re.search(r"rate constant[^.]{0,80}?at\s*(\d+(?:\.\d+)?)\s*°\s*C", all_text)
                for p_ in params:
                    if p_["symbol"] == "T_ref" and m:
                        p_["value"], p_["value_unit"], p_["source_text"] = float(m.group(1)) + 273.15, "K", m.group(0)
            eq["parameters"] = params
            # fitted parameter sets from tables apply to constitutive models whose parameters they contain
            sets = [s for s in param_sets if all(p["property"] in s["parameters"] for p in tpl["parameters"] if p.get("property"))] if tpl["category"] == "rheology" else []
            eq["parameter_sets"] = sets
            rng = {}
            m = re.search(r"shear rates?\s*(?:between|from)\s*(\d+(?:\.\d+)?)\s*(?:and|to|-)\s*(\d+(?:\.\d+)?)\s*s\s*[-−–]\s*1", all_text, re.I)
            if m and any(v["symbol"] == "gamma_dot" for v in tpl["variables"]):
                rng["gamma_dot"] = [float(m.group(1)), float(m.group(2))]
            m = re.search(r"between\s*(\d+(?:\.\d+)?)\s*and\s*(\d+(?:\.\d+)?)\s*°\s*C", all_text)
            if m and tpl["id"] in ("arrhenius_viscosity",):
                rng["T"] = [float(m.group(1)) + 273.15, float(m.group(2)) + 273.15]
            eq["validity"] = rng
            cands.append({**base, "equation": eq, "confidence": "medium" if (sets or any(p["value"] is not None for p in params)) else "low",
                          "notes": "Equation form recognised from template; verify symbols, parameters and units against the source."})
    for pg in pages:
        for sent in sentences(pg["text"]):
            if re.search(r"first[- ]order", sent, re.I) and re.search(r"rate constant", sent, re.I):
                tpl = _tpl("first_order_arrhenius")
                eq = {k: v for k, v in tpl.items() if k != "detect"}
                eq["template"], eq["raw"] = tpl["id"], sent
                params = []
                for prm in tpl["parameters"]:
                    v, u, src = _param_from_text(sent, prm["symbol"], prm.get("unit"))
                    params.append({**prm, "value": v, "value_unit": u, "source_text": src})
                m = re.search(r"at\s*(\d+(?:\.\d+)?)\s*°\s*C", sent)
                for p_ in params:
                    if p_["symbol"] == "T_ref" and m:
                        p_["value"], p_["value_unit"], p_["source_text"] = float(m.group(1)) + 273.15, "K", m.group(0)
                eq.update({"parameters": params, "parameter_sets": [], "validity": {}})
                cands.append({"kind": "equation", "page": pg["n"], "snippet": sent, "context": sent, "evidence_type": "directly_reported",
                              "material_name": (primary_material or {}).get("name"), "material_id": (primary_material or {}).get("material_id"),
                              "equation": eq, "confidence": "medium" if all(p["value"] is not None for p in params) else "low",
                              "notes": "Kinetic model stated in text (no displayed equation); the mathematical form is the standard first-order/Arrhenius form — verify."})
    # de-duplicate by template
    seen, out = set(), []
    for c in cands:
        key = (c["equation"].get("template") or c["snippet"], c["page"])
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


# ----------------------------------------------------------------- verification
def verify(cand: dict, pages: list[dict]) -> dict:
    page = next((p for p in pages if p["n"] == cand.get("page")), None)
    v = {"snippet_on_page": False, "value_in_snippet": None, "notes": []}
    if not page:
        v["notes"].append("stated page does not exist")
        return v
    ptxt = _norm_ws(page["text"]).lower()
    snip = _norm_ws(cand.get("snippet", "")).lower()
    if cand.get("table_id"):
        cells = [c for t in page.get("tables", []) if t["id"] == cand["table_id"] for r in t["rows"] for c in r]
        v["snippet_on_page"] = bool(cells)
        v["value_in_snippet"] = str(cand.get("value_text_in_source", "")).strip() in cells
    else:
        v["snippet_on_page"] = bool(snip) and (snip in ptxt or snip[:80] in ptxt)
        if cand.get("kind") == "property":
            vt = str(cand.get("value_text_in_source") or "")
            num = cand.get("value")
            v["value_in_snippet"] = bool(vt and _norm_ws(vt).lower() in snip) or (num is not None and (f"{num:g}" in snip or str(num) in snip))
    if not v["snippet_on_page"]:
        v["notes"].append("supporting passage not found verbatim on the stated page")
    if v["value_in_snippet"] is False:
        v["notes"].append("value not found in the supporting passage")
    return v


# ----------------------------------------------------------------- AI extraction (optional)
AI_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["candidates"],
    "properties": {"candidates": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["kind", "material_name", "property", "value", "unit", "page", "snippet", "evidence_type", "conditions", "uncertainty", "latex", "notes"],
        "properties": {
            "kind": {"type": "string", "enum": ["property", "equation"]},
            "material_name": {"type": "string"}, "property": {"type": "string"},
            "value": {"type": ["number", "null"]}, "unit": {"type": "string"}, "page": {"type": "integer"},
            "snippet": {"type": "string"}, "latex": {"type": "string"}, "notes": {"type": "string"},
            "evidence_type": {"type": "string", "enum": ["directly_reported", "calculated_from_reported", "fitted_parameter", "author_prediction", "ai_inferred"]},
            "conditions": {"type": "object", "additionalProperties": {"type": ["number", "null"]}},
            "uncertainty": {"type": ["number", "null"]},
        }}}},
}

AI_SYSTEM = (
    "You extract food-science measurements and equations from research-paper text for a scientific database. "
    "Only report information explicitly present in the text. Never estimate or invent values. For every item give the page number and a "
    "VERBATIM supporting passage copied exactly from that page. Use property keys from the provided catalogue when possible. Put experimental "
    "conditions (temperature in degC, concentration in % w/w, pH, shear_rate in 1/s, heating_rate) in `conditions` only when stated. "
    "Classify evidence_type as directly_reported, calculated_from_reported, fitted_parameter, author_prediction or ai_inferred. "
    "For equations, set kind='equation', give LaTeX in `latex` and leave value null."
)


def ai_settings() -> dict:
    s = db.get_doc("settings", "ai_settings") or {}
    return {"allow_external_ai": bool(s.get("allow_external_ai")), "acknowledged_at": s.get("acknowledged_at"),
            "api_key_configured": bool(os.environ.get("ANTHROPIC_API_KEY")), "model": os.environ.get("SYNTHEA_AI_MODEL", "claude-opus-5-5")}


def extract_ai(paper: dict) -> list[dict]:
    st = ai_settings()
    if not st["api_key_configured"]:
        raise ValueError("No ANTHROPIC_API_KEY configured on this machine; use the local rule-based extractor or manual entry.")
    if not st["allow_external_ai"]:
        raise ValueError("External AI is disabled. Enable it in Settings → AI assistant after reading the data-transfer disclosure.")
    import anthropic

    keys = ", ".join(catalog.PROPERTIES.keys())
    doc_text = "\n\n".join(f"=== PAGE {p['n']} ===\n{p['text']}" for p in paper["pages"])[:400_000]
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=st["model"], max_tokens=16000, system=AI_SYSTEM,
        output_config={"format": {"type": "json_schema", "schema": AI_SCHEMA}},
        messages=[{"role": "user", "content": f"Property catalogue keys: {keys}\n\nDocument:\n{doc_text}"}],
    )
    if resp.stop_reason == "refusal":
        raise ValueError("The external model declined this request.")
    text = "".join(b.text for b in resp.content if b.type == "text")
    data = json.loads(text)
    out = []
    for c in data.get("candidates", []):
        base = {"page": c["page"], "snippet": c["snippet"], "evidence_type": c["evidence_type"], "material_name": c["material_name"],
                "notes": c.get("notes", ""), "confidence": "medium"}
        if c["kind"] == "equation":
            out.append({**base, "kind": "equation", "equation": {"name": c.get("property") or "Equation", "latex": c.get("latex", ""), "expression": "",
                                                                  "raw": c["snippet"], "template": None, "parameters": [], "parameter_sets": [], "validity": {}}})
        else:
            meta = catalog.property_meta(c["property"])
            out.append({**base, "kind": "property", "property": c["property"], "label": meta["label"], "value": c["value"], "unit": c["unit"],
                        "uncertainty": {"type": "sd", "value": c["uncertainty"]} if c.get("uncertainty") is not None else {},
                        "conditions": {k: v for k, v in (c.get("conditions") or {}).items() if v is not None},
                        "value_text_in_source": f"{c['value']:g}" if c.get("value") is not None else ""})
    return out


# ----------------------------------------------------------------- orchestration
def run(paper_id: str, method: str = "rule") -> dict:
    paper = db.get_doc("papers", paper_id)
    if not paper:
        raise KeyError(paper_id)
    pages = paper.get("pages", [])
    full = " ".join(p["text"] for p in pages)
    mats, abbr = material_candidates(full)
    primary = mats[0] if mats else None
    if method == "ai":
        cands = extract_ai(paper)
        extractor = f"claude:{ai_settings()['model']}"
    else:
        tab_cands, param_sets = extract_tables(pages, primary)
        cands = extract_sentences(pages, primary) + tab_cands + extract_equations(pages, param_sets, primary)
        extractor = "rule-based v1"
    # keep reviewed decisions; replace previous pending candidates
    for e in db.list_children("extractions", paper_id):
        if e.get("status") == "pending":
            db.delete_doc("extractions", e["id"])
    kept = {(e.get("kind"), e.get("property"), e.get("page"), str(e.get("value")), _norm_ws(e.get("snippet", ""))[:60]) for e in db.list_children("extractions", paper_id)}
    created = []
    for c in cands:
        key = (c.get("kind"), c.get("property"), c.get("page"), str(c.get("value")), _norm_ws(c.get("snippet", ""))[:60])
        if key in kept:
            continue
        kept.add(key)
        c["verification"] = verify(c, pages)
        if c["verification"]["notes"]:
            c["confidence"] = "low"
        if c.get("kind") == "property" and c.get("unit") is not None:
            meta = catalog.property_meta(c["property"])
            if c.get("value") is None:
                c["normalized"] = None
            elif meta["unit"]:
                c["normalized"] = catalog.normalize(c["value"], c["unit"], meta["unit"])
            else:
                c["normalized"] = {"value": c["value"], "unit": "", "ok": True, "note": None}
        doc = {"id": f"ext-{uuid.uuid4().hex[:10]}", "parent_id": paper_id, "paper_id": paper_id, "status": "pending", "extractor": extractor,
               "created": _now(), "name": c.get("label") or (c.get("equation") or {}).get("name"), **c}
        created.append(db.put_doc("extractions", doc))
    paper["status"] = "extracted"
    paper["material_candidates"] = mats
    paper["abbreviations"] = abbr
    db.put_doc("papers", paper)
    return {"extractor": extractor, "created": len(created), "materials": mats, "abbreviations": abbr,
            "summary": {"properties": sum(1 for c in created if c["kind"] == "property"), "equations": sum(1 for c in created if c["kind"] == "equation"),
                        "flagged": sum(1 for c in created if c["verification"]["notes"])}}
