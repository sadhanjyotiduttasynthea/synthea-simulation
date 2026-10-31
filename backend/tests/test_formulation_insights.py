"""Sensory/technical profile and interaction panel: every statement is sourced or 'not predicted — needs …'."""
from app import seed


def _lines():
    return [{"ingredient_id": k, "percent": v} for k, v in seed.BASELINE.items()]


def _approve(client, cands, prop, value):
    c = next(c for c in cands if c["kind"] == "property" and c["property"] == prop and abs((c["value"] or 0) - value) < 1e-9)
    assert client.post(f"/api/extractions/{c['id']}/approve", json={"material_id": "mat-faba-protein-isolate", "review_status": "approved"}).status_code == 200


def test_profile_without_evidence_is_not_predicted(client):
    r = client.post("/api/formulations/profile", json={"lines": _lines(), "project_id": seed.PROJECT_ID}).json()
    for attr in ("aroma", "flavour", "colour", "mouthfeel", "texture"):
        st = r["attributes"][attr]
        assert st and all(s["label"] == "not_predicted" and s["needs"] for s in st), attr
        assert "not predicted — needs" in st[-1]["text"]
    tech = r["attributes"]["technical"]
    assert tech[0]["label"] == "calculated" and "protein" in tech[0]["text"]
    assert any(s["label"] == "not_predicted" and "denaturation temperature" in s["text"] for s in tech)
    assert r["process_temperature"]["value"] == 120.0 and "process flow" in r["process_temperature"]["source"]  # demo extruder barrel


def test_profile_and_interactions_use_approved_records(client):
    p = client.post("/api/papers/sample").json()
    client.post("/api/extractions/run", json={"paper_id": p["id"]})
    cands = client.get(f"/api/papers/{p['id']}/extractions").json()
    _approve(client, cands, "denaturation_temperature", 84.6)
    _approve(client, cands, "elastic_modulus", 24.0)
    # hexanal content of FBPI with SD, entered as an approved record from the (synthetic) paper
    client.post("/api/properties", json={"material_id": "mat-faba-protein-isolate", "property": "hexanal_content", "value": 5.0, "unit": "mg/kg",
                                         "uncertainty": {"type": "sd", "value": 0.5}, "conditions": {}, "evidence_type": "directly_reported",
                                         "review_status": "approved", "source": {"paper_id": p["id"], "page": 2, "snippet": "test"}})
    r = client.post("/api/formulations/profile", json={"lines": _lines(), "project_id": seed.PROJECT_ID, "process_temperature_c": 90}).json()
    tex = r["attributes"]["texture"]
    lit = next(s for s in tex if s["label"] == "literature")
    assert lit["basis"][0]["paper_id"] == p["id"] and lit["basis"][0]["page"] and "Young" in lit["text"]
    assert tex[-1]["label"] == "not_predicted"  # ingredient modulus is not turned into a formulation texture
    hx = next(s for s in r["attributes"]["aroma"] if s["label"] == "predicted")
    assert abs(hx["value"] - 0.12 * 5.0) < 1e-9 and abs(hx["uncertainty"] - 0.12 * 0.5) < 1e-9 and "lower bound" in hx["text"]  # FBPC has no data
    den = next(s for s in r["attributes"]["technical"] if "denaturation at" in s["text"])
    assert den["label"] == "predicted" and "gel network expected" in den["text"]
    it = client.post("/api/formulations/interactions", json={"lines": _lines(), "process_temperature_c": 90}).json()["interactions"]
    heat = next(x for x in it if x["a"] == "Faba bean protein isolate" and x["b"] == "(heating)")
    assert heat["rating"] == "compatible" and heat["basis"][0]["page"]
    heat_c = next(x for x in it if x["a"] == "Faba bean protein concentrate" and x["b"] == "(heating)")
    assert heat_c["rating"] == "unknown" and heat_c["needs"]  # no denaturation record for FBPC
    xan = next(x for x in it if {x["a"], x["b"]} == {"Faba bean protein isolate", "Xanthan gum"})
    assert xan["rating"] == "unknown" and any("pH" in n for n in xan["needs"])  # needs pH and pI
    # with pH and an approved pI the rule gives a rating
    client.post("/api/properties", json={"material_id": "mat-faba-protein-isolate", "property": "isoelectric_point", "value": 4.8, "unit": "", "conditions": {},
                                         "evidence_type": "computed_structure", "review_status": "approved", "source": {"citation": "test"}})
    it = client.post("/api/formulations/interactions", json={"lines": _lines(), "ph": 6.8, "process_temperature_c": 90}).json()["interactions"]
    xan = next(x for x in it if {x["a"], x["b"]} == {"Faba bean protein isolate", "Xanthan gum"})
    assert xan["rating"] == "compatible" and "pH 6.8 > pI 4.8" in xan["basis"][1]["detail"]
    it = client.post("/api/formulations/interactions", json={"lines": _lines(), "ph": 4.0, "process_temperature_c": 90}).json()["interactions"]
    xan = next(x for x in it if {x["a"], x["b"]} == {"Faba bean protein isolate", "Xanthan gum"})
    assert xan["rating"] == "caution"
    starch = next(x for x in it if {x["a"], x["b"]} == {"Faba bean protein isolate", "Potato starch"})
    assert starch["rating"] == "compatible" and starch["basis"][0]["rule"] == "R1"
    oil = next(x for x in it if {x["a"], x["b"]} == {"Faba bean protein isolate", "Sunflower oil"})
    assert oil["rating"] == "unknown" and "emulsifying" in oil["needs"][0]
    assert all(x["rating"] in ("compatible", "caution", "incompatible", "unknown") for x in it)
    assert all(x["basis"] or x["rating"] == "unknown" for x in it)  # no rating without a basis


def test_reported_interaction_record_and_scene_are_cited(client):
    client.post("/api/properties", json={"material_id": "mat-faba-protein-isolate", "property": "ingredient_interaction", "value": None,
                                         "value_text": "complex coacervation observed at pH 4", "partner_material_id": "mat-xanthan-gum", "rating": "caution",
                                         "conditions": {"ph": 4}, "evidence_type": "directly_reported", "review_status": "approved", "source": {"citation": "test paper", "page": 3}})
    w = client.post("/api/molecules", json={"smiles": "O", "name": "Water", "material_ids": ["mat-faba-protein-isolate"]}).json()
    g = client.post("/api/molecules", json={"smiles": "OCC(O)CO", "name": "Glycerol", "material_ids": ["mat-xanthan-gum"]}).json()
    sc = client.post("/api/molecules/interaction", json={"a": w["id"], "b": g["id"], "orientations": 6}).json()
    assert sc["scene_id"]
    it = client.post("/api/formulations/interactions", json={"lines": _lines()}).json()["interactions"]
    rows = [x for x in it if {x["a"], x["b"]} == {"Faba bean protein isolate", "Xanthan gum"}]
    cited = next(x for x in rows if x["basis_type"] == "cited paper")
    assert cited["rating"] == "caution" and "coacervation" in cited["mechanism"]
    assert rows[0]["scenes"] and rows[0]["scenes"][0]["computed"]
