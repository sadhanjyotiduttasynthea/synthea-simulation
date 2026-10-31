import math

import pytest

from app import db, sci_registry


@pytest.fixture()
def paper(client):
    p = client.post("/api/papers/sample").json()
    r = client.post("/api/extractions/run", json={"paper_id": p["id"]}).json()
    assert r["extractor"] == "rule-based v1"
    return p, client.get(f"/api/papers/{p['id']}/extractions").json()


def _find(cands, prop, value):
    return next(c for c in cands if c["kind"] == "property" and c["property"] == prop and abs((c["value"] or 0) - value) < 1e-9)


def test_rule_extraction_values_conditions_and_provenance(paper):
    _, cands = paper
    v25 = _find(cands, "viscosity", 2.4)
    assert v25["uncertainty"]["value"] == 0.2 and v25["n"] == 3
    assert v25["conditions"] == {"concentration": 15.0, "temperature": 25.0, "shear_rate": 10.0}
    assert v25["page"] == 1 and v25["snippet"].startswith("The apparent viscosity")
    assert v25["verification"] == {"snippet_on_page": True, "value_in_snippet": True, "notes": []}
    v50 = _find(cands, "viscosity", 1.3)
    assert v50["conditions"]["temperature"] == 50.0 and "shear_rate" not in v50["conditions"]  # not stated -> not invented
    k = _find(cands, "consistency_index", 9.6)
    assert k["evidence_type"] == "fitted_parameter" and k["conditions"] == {"concentration": 15.0, "temperature": 25.0}
    assert _find(cands, "denaturation_temperature", 84.6)["conditions"] == {}
    assert _find(cands, "thermal_conductivity", 0.52)["normalized"]["value"] == 0.52
    # no false positives from the concentration range '10-20 % (w/w)'
    assert not any(c["kind"] == "property" and c["property"] == "protein" and c["value"] == 20.0 for c in cands)
    templates = {c["equation"]["template"] for c in cands if c["kind"] == "equation"}
    assert templates == {"herschel_bulkley", "arrhenius_viscosity", "first_order_arrhenius"}


def test_review_approval_creates_traceable_records_and_models(client, paper):
    p, cands = paper
    v25 = _find(cands, "viscosity", 2.4)
    r = client.post(f"/api/extractions/{v25['id']}/approve", json={"material_id": "mat-pea-protein-isolate", "review_status": "approved"}).json()
    rec = db.get_doc("properties", r["created"][0]["id"])
    assert rec["review_status"] == "approved" and rec["source"]["paper_id"] == p["id"] and rec["source"]["page"] == 1
    assert rec["source"]["extraction_id"] == v25["id"] and rec["conditions"]["temperature"] == 25.0
    # approving twice is refused
    assert client.post(f"/api/extractions/{v25['id']}/approve", json={"material_id": "mat-pea-protein-isolate"}).status_code == 409
    hb = next(c for c in cands if c["kind"] == "equation" and c["equation"]["template"] == "herschel_bulkley")
    out = client.post(f"/api/extractions/{hb['id']}/approve", json={"material_id": "mat-pea-protein-isolate", "review_status": "approved"}).json()
    assert len(out["created"]) == 4  # one condition-specific model per fitted parameter set
    models = [db.get_doc("sci_models", c["id"]) for c in out["created"]]
    assert all(m["dimension_check"]["ok"] for m in models)
    m15 = next(m for m in models if m["conditions"] == {"concentration": 15.0, "temperature": 25.0})
    assert {p_["symbol"]: p_["value"] for p_ in m15["parameters"]} == {"tau0": 18.5, "K": 9.6, "n": 0.48}
    assert m15["validity"] == {"gamma_dot": [0.1, 100.0]} and m15["source"]["page"] == 2
    res = client.get("/api/science/resolve", params={"material_id": "mat-pea-protein-isolate", "quantity": "rheology_hb", "temperature": 25, "concentration": 15}).json()
    assert res["models"][0]["id"] == m15["id"] and res["models"][0]["exact_conditions"]


def test_unreviewed_and_extrapolation_guards(client, paper):
    _, cands = paper
    arr = next(c for c in cands if c["kind"] == "equation" and c["equation"]["template"] == "arrhenius_viscosity")
    out = client.post(f"/api/extractions/{arr['id']}/approve", json={"material_id": "mat-pea-protein-isolate", "review_status": "reviewed"}).json()
    m = db.get_doc("sci_models", out["created"][0]["id"])
    assert {x["symbol"]: x["value"] for x in m["parameters"]} == {"A": 0.00081, "Ea": 19800.0}  # kJ/mol -> J/mol
    assert m["dimension_check"]["ok"] is True
    r = client.post(f"/api/sci-models/{m['id']}/evaluate", json={"inputs": {"T": 300}})
    assert r.status_code == 400 and "reviewed" in r.json()["detail"]  # only approved models are usable
    client.post(f"/api/sci-models/{m['id']}/status", json={"status": "approved"})
    ok = client.post(f"/api/sci-models/{m['id']}/evaluate", json={"inputs": {"T": 310}}).json()
    assert abs(ok["value"] - 0.00081 * math.exp(19800 / (8.314462618 * 310))) < 1e-12
    assert client.post(f"/api/sci-models/{m['id']}/evaluate", json={"inputs": {"T": 360}}).status_code == 400  # outside 25-50 degC
    # validated requires a validation result
    assert client.post(f"/api/sci-models/{m['id']}/status", json={"status": "validated"}).status_code == 400
    v = client.post(f"/api/sci-models/{m['id']}/validate", json={"data": [{"inputs": {"T": 298.15}, "observed": 2.4}, {"inputs": {"T": 323.15}, "observed": 1.3}]}).json()
    assert v["n"] == 2 and v["rmse"] > 0
    assert client.post(f"/api/sci-models/{m['id']}/status", json={"status": "validated"}).json()["status"] == "validated"


def test_reject_manual_entry_and_dimension_error(client, paper):
    p, cands = paper
    c = cands[0]
    assert client.post(f"/api/extractions/{c['id']}/reject", json={"reason": "wrong sample"}).json()["status"] == "rejected"
    man = client.post("/api/extractions", json={"paper_id": p["id"], "property": "gel_strength", "value": 1.0, "unit": "N", "page": 2, "snippet": "not in document"}).json()
    assert man["verification"]["snippet_on_page"] is False
    bad = sci_registry.dimension_check({"expression": "A * exp(Ea / (R * T))", "dependent": {"unit": "Pa*s"}, "variables": [{"symbol": "T", "unit": "K"}],
                                        "parameters": [{"symbol": "A", "unit": "Pa*s", "value": 1}, {"symbol": "Ea", "unit": "J", "value": 1}],
                                        "constants": {"R": {"value": 8.314, "unit": "J/(mol*K)"}}})
    assert bad["ok"] is False
