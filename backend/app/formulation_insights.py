"""Virtual formulation insights: sensory & technical profile and ingredient interactions.

Integrity rules (README / SCIENTIFIC_MODELS.md):
* Every statement is built from APPROVED library records (paper + page), measured formulation data,
  calculated mass balances, computed Molecules scenes or a documented qualitative rule (R1-R5 below).
* Statements carry a provenance label: literature (a record quoted directly), measured, calculated,
  predicted (derived by a stated rule or mass balance, with its assumptions) or not_predicted.
* Where no evidence exists the statement is "not predicted — needs <data>", naming the data that would
  unlock it. Nothing is filled with defaults or averages. Sensory scores, colour coordinates and texture are
  never averaged over ingredients (they are not additive).

Documented interaction rules (qualitative; no numbers are introduced by the rules themselves):
R1 protein–polysaccharide: electrostatic association needs opposite charges. An anionic polysaccharide and a
   protein below its isoelectric point (pH < pI, protein net positive) can form complexes / coacervates
   (caution); above the pI both are negatively charged and electrostatic complexation is not expected
   (compatible; segregative separation possible only at high concentrations). Neutral polysaccharides (starch)
   do not complex electrostatically (compatible) but compete for water during heating.
R2 protein heating: when the process temperature reaches the reported denaturation temperature, unfolding
   exposes thiol groups and enables disulfide cross-linking that contributes to heat-set gel networks
   (compatible / desired); below it, cross-linking is limited (caution).
R3 Maillard reaction: reducing sugars + amino groups + heating → browning and flavour compounds (caution).
R4 protein–lipid: a protein with reported emulsifying activity / emulsion stability can stabilise the oil
   phase (compatible); without such data the outcome is unknown.
R5 salt–protein: ionic strength changes protein solubility and gelation; rated only from reported solubility
   data at a stated salt concentration.
"""
from __future__ import annotations

from . import db, knowledge
from .science import catalog

APPROVED = ("approved",)

# R1: charge type of polysaccharides by name (standard chemistry, see SCIENTIFIC_MODELS.md)
POLYSACCHARIDE_CHARGE = {"xanthan": "anionic", "alginate": "anionic", "pectin": "anionic", "carrageenan": "anionic", "carboxymethyl": "anionic",
                         "gum arabic": "anionic", "starch": "neutral", "methylcellulose": "neutral", "guar": "neutral", "locust bean": "neutral", "chitosan": "cationic"}
ROLE = {"Protein": "protein", "Starch": "polysaccharide", "Hydrocolloid": "polysaccharide", "Fibre": "polysaccharide", "Lipid": "lipid", "Mineral": "salt",
        "Solvent": "water", "Sugar": "sugar"}


# ------------------------------------------------------------------ helpers
def _materials_for(ingredient_ids: list[str]) -> dict[str, dict]:
    by_ing = {}
    for m in db.list_docs("materials"):
        iid = m.get("ingredient_id")
        if iid in ingredient_ids and not m.get("archived"):
            by_ing.setdefault(iid, m)
    return by_ing


def _paper_title(pid):
    p = db.get_doc("papers", pid) if pid else None
    return ((p or {}).get("metadata") or {}).get("title"), bool((p or {}).get("synthetic_test_document"))


def _basis(rec: dict, material_name: str) -> dict:
    src = rec.get("source") or {}
    title, synthetic = _paper_title(src.get("paper_id"))
    nv = rec.get("normalized") or {}
    return {"kind": "record", "record_id": rec["id"], "material": material_name, "property": rec["property"], "label": catalog.property_meta(rec["property"])["label"],
            "value": rec.get("value"), "value_text": rec.get("value_text"), "unit": rec.get("unit"), "canonical": nv.get("value"), "canonical_unit": nv.get("unit"),
            "uncertainty": rec.get("uncertainty") or {}, "conditions": rec.get("conditions") or {}, "paper_id": src.get("paper_id"), "page": src.get("page"),
            "paper": title, "citation": src.get("citation"), "synthetic": synthetic, "status": rec.get("review_status"), "evidence_type": rec.get("evidence_type")}


def _approved(material: dict | None, keys: list[str]) -> list[dict]:
    if not material:
        return []
    return [p for p in knowledge.properties_of(material["id"]) if p["property"] in keys and p.get("review_status") in APPROVED]


def _fmt(v, unit=None):
    if v is None:
        return "—"
    s = f"{v:.4g}" if isinstance(v, (int, float)) else str(v)
    return f"{s} {unit}".strip() if unit else s


def _stmt(attribute, text, label, basis=None, needs=None, uncertainty=None, assumptions=None, value=None, unit=None):
    return {"attribute": attribute, "text": text, "label": label, "basis": basis or [], "needs": needs or [], "uncertainty": uncertainty,
            "assumptions": assumptions or [], "value": value, "unit": unit}


def _lines(lines: list[dict], ings: dict) -> list[dict]:
    out = []
    for l in lines:
        ing = ings.get(l["ingredient_id"])
        if ing and float(l.get("percent") or 0) > 0:
            out.append({"id": ing["id"], "name": ing["name"], "w": float(l["percent"]) / 100.0, "ing": ing})
    return out


# ------------------------------------------------------------------ sensory & technical profile
SENSORY = {
    "aroma": {"keys": ["hexanal_content", "aroma_descriptors"], "formulation_needs": "volatile analysis (e.g. GC-MS hexanal) or sensory panel aroma data on the formulation"},
    "flavour": {"keys": ["beany_flavour_intensity", "bitterness_intensity"], "formulation_needs": "sensory panel scores (beany, bitter) on the formulation or a validated sensory model"},
    "colour": {"keys": ["colour_l", "colour_a", "colour_b"], "formulation_needs": "instrumental colour (L*a*b*) of the formulation — colour is not additive by mass"},
    "mouthfeel": {"keys": ["water_holding_capacity", "oil_holding_capacity", "emulsifying_activity", "emulsion_stability", "particle_size", "viscosity"],
                  "formulation_needs": "flow curve of the formulation (Herschel–Bulkley τ₀, K, n) or a sensory mouthfeel panel"},
    "texture": {"keys": ["hardness", "gel_strength", "storage_modulus", "elastic_modulus", "fracture_stress", "least_gelation_concentration"],
                "formulation_needs": "texture profile analysis (TPA) of the cooked formulation, or a texture class from Synthea Process"},
}


def profile(lines: list[dict], formulation: dict | None = None, process_temperature_c: float | None = None) -> dict:
    ings = {i["id"]: i for i in db.list_docs("ingredients")}
    L = _lines(lines, ings)
    mats = _materials_for([x["id"] for x in L])
    out = {}
    for attr, spec in SENSORY.items():
        st = []
        # 1) ingredient-level evidence, quoted directly (literature)
        for x in L:
            m = mats.get(x["id"])
            for rec in _approved(m, spec["keys"]):
                b = _basis(rec, x["name"])
                val = rec.get("value_text") or _fmt(rec.get("value"), rec.get("unit"))
                cond = ", ".join(f"{k} {v}" for k, v in (rec.get("conditions") or {}).items())
                st.append(_stmt(attr, f"{x['name']} ({x['w'] * 100:.3g} % of the formulation): {b['label']} {val}{f' ({cond})' if cond else ''}.", "literature", [b]))
            # faba-specific ingredient fields (off-flavour markers) when they are sourced
            fab = x["ing"].get("faba") or {}
            prov = (x["ing"].get("provenance") or {}).get("faba", "missing")
            if attr == "aroma" and fab.get("off_flavour_markers") and prov != "missing":
                st.append(_stmt(attr, f"{x['name']}: off-flavour markers {fab['off_flavour_markers']} (ingredient table).", prov,
                                [{"kind": "ingredient", "ingredient_id": x["id"], "field": "faba.off_flavour_markers", "provenance": prov}]))
        # 2) formulation-level derivations
        if attr == "aroma":
            st += _hexanal_mass_balance(L, mats)
        if attr == "mouthfeel" and formulation and formulation.get("rheology"):
            r = formulation["rheology"]
            if r.get("yield_stress_pa") is not None and r.get("consistency_index_pa_sn") is not None:
                lab = r.get("data_type") or "measured"
                st.append(_stmt(attr, f"Formulation flow behaviour: τ₀ = {_fmt(r['yield_stress_pa'], 'Pa')}, K = {_fmt(r['consistency_index_pa_sn'], 'Pa·sⁿ')}, n = {_fmt(r.get('flow_behaviour_index'))}"
                                f"{' at ' + _fmt(r.get('temperature_c'), '°C') if r.get('temperature_c') is not None else ''} (formulation rheology record).", lab,
                                [{"kind": "formulation_rheology", "source": r.get("source"), "provenance": lab}]))
        if not any(s["label"] in ("measured", "predicted", "calculated") for s in st):
            st.append(_stmt(attr, f"Formulation {attr}: not predicted — needs {spec['formulation_needs']}.", "not_predicted", needs=[spec["formulation_needs"]]))
        out[attr] = st
    out["technical"] = _technical(L, mats, process_temperature_c)
    return {"attributes": out, "evidence_count": sum(len(s["basis"]) for v in out.values() for s in v),
            "note": "Statements quote approved library records or apply the documented rules; ingredient sensory scores, colour and texture are never averaged."}


def _hexanal_mass_balance(L, mats) -> list[dict]:
    """Concentration of a compound in the mix = sum(w_i c_i), assuming no formation or loss (labelled predicted)."""
    have, missing, basis = [], [], []
    for x in L:
        recs = [r for r in _approved(mats.get(x["id"]), ["hexanal_content"]) if (r.get("normalized") or {}).get("ok")]
        if recs:
            r = recs[0]
            have.append((x, r))
            basis.append(_basis(r, x["name"]))
        elif x["ing"].get("category") != "Solvent" and x["ing"].get("category") != "Mineral":
            missing.append(x["name"])
    if not have:
        return []
    total = sum(x["w"] * r["normalized"]["value"] for x, r in have)
    unc = [x["w"] * float((r.get("uncertainty") or {}).get("value")) for x, r in have if (r.get("uncertainty") or {}).get("value") is not None]
    sd = (sum(u * u for u in unc)) ** 0.5 if len(unc) == len(have) else None
    text = f"Hexanal in the formulation ≈ {total:.3g} mg/kg by mass balance" + (f" ± {sd:.2g} mg/kg (propagated SD)" if sd is not None else "")
    if missing:
        text += f" — lower bound: no approved hexanal data for {', '.join(missing)}"
    return [_stmt("aroma", text + ".", "predicted", basis, needs=[f"hexanal content of {m}" for m in missing], uncertainty=sd,
                  assumptions=["no formation or loss of hexanal during mixing and processing (lipid oxidation during heating can increase it)"],
                  value=total, unit="mg/kg")]


def _technical(L, mats, T_proc) -> list[dict]:
    from .science import nutrition
    st = []
    ings_lines = [nutrition.FormulationLine(x["ing"], x["w"] * 100) for x in L]
    if ings_lines:
        c = nutrition.composition(ings_lines).composition
        prov = sorted({(x["ing"].get("provenance") or {}).get("nutrition", "missing") for x in L})
        st.append(_stmt("technical", f"Composition (mass balance): protein {c['protein']:.3g} %, fat {c['fat']:.3g} %, moisture {c['moisture']:.3g} %, carbohydrate {c['carbohydrate']:.3g} %.",
                        "calculated", [{"kind": "ingredient_table", "provenance": prov}], assumptions=["exact linear mass balance of ingredient-table values (" + ", ".join(prov) + ")"]))
    for x in L:
        if x["ing"].get("category") != "Protein":
            continue
        dens = _approved(mats.get(x["id"]), ["denaturation_temperature"])
        if not dens:
            st.append(_stmt("technical", f"{x['name']}: heat-set gelation temperature not predicted — needs the denaturation temperature (DSC) of this ingredient.", "not_predicted",
                            needs=[f"denaturation temperature of {x['name']} (DSC)"]))
            continue
        b = _basis(dens[0], x["name"])
        Td = dens[0]["normalized"]["value"]
        if T_proc is None:
            st.append(_stmt("technical", f"{x['name']}: denaturation reported at {Td:.4g} °C. Whether the process reaches it is not evaluated — needs the process temperature.", "literature", [b],
                            needs=["maximum product temperature in the process"]))
        else:
            ok = T_proc >= Td
            st.append(_stmt("technical", f"{x['name']}: denaturation at {Td:.4g} °C (paper) vs process {T_proc:.4g} °C — {'heat-set gel network expected (rule R2)' if ok else 'process stays below denaturation: limited gelation (rule R2)'}.",
                            "predicted", [b, {"kind": "rule", "rule": "R2"}], assumptions=["product core reaches the process temperature (check with a Digital Twin study)"]))
    return st


# ------------------------------------------------------------------ interactions
def _poly_charge(name: str) -> str | None:
    n = name.lower()
    for k, v in POLYSACCHARIDE_CHARGE.items():
        if k in n:
            return v
    return None


def _scenes_between(ma: dict | None, mb: dict | None) -> list[dict]:
    if not ma or not mb:
        return []
    mols = db.list_docs("molecules")
    a_ids = {m["id"] for m in mols if ma["id"] in (m.get("material_ids") or [])}
    b_ids = {m["id"] for m in mols if mb["id"] in (m.get("material_ids") or [])}
    out = []
    for s in db.list_docs("scenes"):
        if (s.get("a") in a_ids and s.get("b") in b_ids) or (s.get("a") in b_ids and s.get("b") in a_ids):
            out.append({"kind": "scene", "scene_id": s["id"], "computed": s.get("computed"), "label": s.get("label"), "a": s.get("a"), "b": s.get("b"),
                        "interaction_energy_kcal_mol": s.get("interaction_energy_kcal_mol"), "hydrogen_bonds": s.get("hydrogen_bonds")})
    return out


def interactions(lines: list[dict], ph: float | None = None, process_temperature_c: float | None = None) -> dict:
    ings = {i["id"]: i for i in db.list_docs("ingredients")}
    L = [x for x in _lines(lines, ings) if ROLE.get(x["ing"].get("category")) != "water"]
    mats = _materials_for([x["id"] for x in L])
    rows = []
    for i in range(len(L)):
        for j in range(i + 1, len(L)):
            a, b = L[i], L[j]
            ra, rb = ROLE.get(a["ing"].get("category")), ROLE.get(b["ing"].get("category"))
            ma, mb = mats.get(a["id"]), mats.get(b["id"])
            pair = {"a": a["name"], "b": b["name"], "a_id": a["id"], "b_id": b["id"]}
            found = []
            # cited paper: approved 'ingredient_interaction' records naming the partner material
            for m, partner in ((ma, mb), (mb, ma)):
                for rec in _approved(m, ["ingredient_interaction"]):
                    if partner and rec.get("partner_material_id") == partner["id"] and rec.get("rating") in ("compatible", "caution", "incompatible"):
                        found.append({"mechanism": rec.get("value_text") or "reported interaction", "rating": rec["rating"], "basis_type": "cited paper",
                                      "basis": [_basis(rec, m["name"])], "needs": []})
            if {ra, rb} == {"protein", "polysaccharide"}:
                found.append(_r1(a if ra == "protein" else b, b if ra == "protein" else a, mats, ph))
            if {ra, rb} == {"protein", "lipid"}:
                found.append(_r4(a if ra == "protein" else b, mats))
            if {ra, rb} == {"protein", "salt"}:
                found.append(_r5(a if ra == "protein" else b, b if ra == "protein" else a, mats))
            if "protein" in (ra, rb):
                other = b if ra == "protein" else a
                prot = a if ra == "protein" else b
                sug = _approved(mats.get(other["id"]), ["reducing_sugars"])
                if sug or ROLE.get(other["ing"].get("category")) == "sugar":
                    found.append(_r3(prot, other, sug, process_temperature_c))
            scenes = _scenes_between(ma, mb)
            if not found:
                found.append({"mechanism": "no documented mechanism for this pair", "rating": "unknown", "basis_type": "none", "basis": [],
                              "needs": [f"a reported observation of {a['name']} with {b['name']} (approve it as an 'ingredient interaction' record)"]})
            for f in found:
                rows.append({**pair, **f, "scenes": scenes})
    # protein self-interaction on heating (R2)
    for x in L:
        if ROLE.get(x["ing"].get("category")) == "protein":
            rows.append({"a": x["name"], "b": "(heating)", "a_id": x["id"], "b_id": None, **_r2(x, mats, process_temperature_c), "scenes": []})
    return {"interactions": rows, "inputs": {"ph": ph, "process_temperature_c": process_temperature_c},
            "note": "Ratings: compatible / caution / incompatible only with a stated basis (cited paper, computed scene or documented rule R1–R5); otherwise unknown."}


def _pi(prot, mats):
    recs = _approved(mats.get(prot["id"]), ["isoelectric_point"])
    return (recs[0]["normalized"]["value"], _basis(recs[0], prot["name"])) if recs else (None, None)


def _r1(prot, poly, mats, ph):
    charge = _poly_charge(poly["name"])
    base = {"mechanism": "protein–polysaccharide complexation (electrostatic)", "basis_type": "documented rule R1"}
    if charge is None:
        return {**base, "rating": "unknown", "basis": [], "needs": [f"charge type of {poly['name']} (not in the documented rule table)"]}
    if charge == "neutral":
        return {**base, "rating": "compatible", "basis": [{"kind": "rule", "rule": "R1", "detail": f"{poly['name']} is a neutral polysaccharide: no electrostatic complexation; competes for water during heating"}], "needs": []}
    pi, b = _pi(prot, mats)
    needs = ([] if ph is not None else ["pH of the formulation"]) + ([] if pi is not None else [f"isoelectric point of {prot['name']} (approved record, e.g. from Molecules)"])
    if needs:
        return {**base, "rating": "unknown", "basis": [{"kind": "rule", "rule": "R1", "detail": f"{poly['name']} is {charge}"}], "needs": needs}
    if charge == "anionic":
        below = ph < pi
        return {**base, "rating": "caution" if below else "compatible",
                "basis": [b, {"kind": "rule", "rule": "R1", "detail": f"pH {ph:g} {'<' if below else '>'} pI {pi:.3g}: {'protein net positive, anionic ' + poly['name'] + ' → complexation / coacervation possible' if below else 'both negatively charged → electrostatic complexation not expected'}"}],
                "needs": []}
    below = ph < pi
    return {**base, "rating": "compatible" if below else "caution", "basis": [b, {"kind": "rule", "rule": "R1", "detail": f"cationic polysaccharide, pH {ph:g} vs pI {pi:.3g}"}], "needs": []}


def _r2(prot, mats, T):
    base = {"mechanism": "heat-induced unfolding and disulfide cross-linking", "basis_type": "documented rule R2"}
    recs = _approved(mats.get(prot["id"]), ["denaturation_temperature"])
    needs = ([] if recs else [f"denaturation temperature of {prot['name']} (DSC, approved record)"]) + ([] if T is not None else ["maximum product temperature in the process"])
    if needs:
        return {**base, "rating": "unknown", "basis": [], "needs": needs}
    Td = recs[0]["normalized"]["value"]
    ok = T >= Td
    return {**base, "rating": "compatible" if ok else "caution",
            "basis": [_basis(recs[0], prot["name"]), {"kind": "rule", "rule": "R2", "detail": f"process {T:g} °C {'≥' if ok else '<'} denaturation {Td:.4g} °C"}], "needs": []}


def _r3(prot, other, sug_recs, T):
    base = {"mechanism": "Maillard reaction (reducing sugars + amino groups on heating)", "basis_type": "documented rule R3"}
    if T is None:
        return {**base, "rating": "unknown", "basis": [_basis(r, other["name"]) for r in sug_recs], "needs": ["process heating temperature"]}
    return {**base, "rating": "caution", "basis": [_basis(r, other["name"]) for r in sug_recs] + [{"kind": "rule", "rule": "R3", "detail": f"heating to {T:g} °C with reducing sugars present: browning and flavour formation possible"}], "needs": []}


def _r4(prot, mats):
    base = {"mechanism": "protein–lipid emulsification", "basis_type": "documented rule R4"}
    recs = _approved(mats.get(prot["id"]), ["emulsifying_activity", "emulsion_stability"])
    if not recs:
        return {**base, "rating": "unknown", "basis": [], "needs": [f"emulsifying activity index or emulsion stability of {prot['name']} (approved record)"]}
    return {**base, "rating": "compatible", "basis": [_basis(r, prot["name"]) for r in recs] + [{"kind": "rule", "rule": "R4", "detail": "protein reported to stabilise emulsions"}], "needs": []}


def _r5(prot, salt, mats):
    base = {"mechanism": "salt effect on protein solubility / gelation", "basis_type": "documented rule R5"}
    recs = [r for r in _approved(mats.get(prot["id"]), ["solubility"]) if (r.get("conditions") or {}).get("salt_concentration") is not None or (r.get("conditions") or {}).get("ionic_strength") is not None]
    if not recs:
        return {**base, "rating": "unknown", "basis": [], "needs": [f"solubility of {prot['name']} at a stated salt concentration (approved record)"]}
    return {**base, "rating": "caution", "basis": [_basis(r, prot["name"]) for r in recs] + [{"kind": "rule", "rule": "R5", "detail": "solubility depends on ionic strength; check the reported values against the formulation's salt level"}], "needs": []}


def process_temperature(project_id: str | None) -> dict | None:
    """Highest set temperature in the project's process flows (heaters, cookers, extruders)."""
    best = None
    for f in db.list_docs("process_flows"):
        if project_id and f.get("project_id") != project_id:
            continue
        for n in f.get("nodes", []):
            p = (n.get("data") or {}).get("params") or {}
            for k in ("outlet_temperature_c", "barrel_temperature_c", "core_temperature_c", "product_temperature_c"):
                v = p.get(k)
                if isinstance(v, (int, float)) and (n.get("data") or {}).get("kind") not in ("cooler", "chiller") and (best is None or v > best["value"]):
                    best = {"value": float(v), "unit": "°C", "source": f"process flow '{f.get('name')}', unit '{(n.get('data') or {}).get('label')}' ({k})", "provenance": "illustrative"}
    return best
