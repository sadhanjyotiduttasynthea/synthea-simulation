from app import db, knowledge
from app.science import catalog


def test_unit_normalisation_and_dimension_errors():
    assert catalog.normalize(1200, "mPa·s", "Pa*s")["value"] == 1.2
    assert abs(catalog.normalize(298.15, "K", "degC")["value"] - 25) < 1e-9
    assert catalog.normalize(3.2, "kJ/(kg·K)", "J/(kg*K)")["value"] == 3200
    assert catalog.normalize(0.4, "g/100 g", "percent")["value"] == 0.4
    bad = catalog.normalize(2, "Pa", "Pa*s")
    assert bad["ok"] is False and "cannot convert" in bad["note"]


def test_seed_migrates_ingredients_into_shared_materials(client):
    libs = client.get("/api/libraries").json()
    assert len(libs) >= 8
    water = client.get("/api/materials/mat-water").json()
    assert set(water["library_ids"]) >= {"lib-custom", "lib-thermal"}  # one record, two libraries
    assert any(p["property"] == "density" and p["normalized"]["ok"] for p in water["properties"])
    # running the seed again must not duplicate anything
    n = db.count("properties")
    knowledge.ensure_seeded()
    assert db.count("properties") == n


def _prop(client, mid, value, conds, citation, status="approved", unit="Pa·s"):
    r = client.post("/api/properties", json={"material_id": mid, "property": "viscosity", "value": value, "unit": unit,
                                             "conditions": conds, "source": {"citation": citation, "page": 3, "snippet": "x"},
                                             "evidence_type": "directly_reported", "review_status": status, "method": "rheometer"})
    assert r.status_code == 200, r.text
    return r.json()


def test_condition_aware_records_coexist_and_conflicts_reported(client):
    m = client.post("/api/materials", json={"name": "Test pea protein", "library_ids": ["lib-plant-protein"]}).json()
    a = _prop(client, m["id"], 2.0, {"temperature": 25, "concentration": 15, "shear_rate": 10}, "Paper A")
    b = _prop(client, m["id"], 3500, {"temperature": 26, "concentration": 15, "shear_rate": 12}, "Paper B", unit="mPa·s")
    c = _prop(client, m["id"], 0.5, {"temperature": 60, "concentration": 15, "shear_rate": 10}, "Paper C")
    assert b["normalized"]["value"] == 3.5
    cmp = client.get(f"/api/properties/compare?material_id={m['id']}&property=viscosity").json()
    assert len(cmp["records"]) == 3  # nothing averaged or overwritten
    pairs = {(x["a"], x["b"]) for x in cmp["conflicts"]}
    assert (a["id"], b["id"]) in pairs  # comparable conditions, 43 % difference
    assert not any(c["id"] in p for p in pairs)  # 60 degC is not comparable to 25 degC
    assert "temperature" in cmp["condition_keys"]


def test_property_history_quality_and_deprecation(client):
    m = client.post("/api/materials", json={"name": "Hist material"}).json()
    p = _prop(client, m["id"], 1.0, {"temperature": 20}, "Paper X", status="extracted")
    assert p["quality"]["score"] > 0
    p["value"] = 1.1
    p2 = client.put(f"/api/properties/{p['id']}", json=p).json()
    assert p2["history"][-1]["changed"] == ["value"] and p2["history"][-1]["previous"]["value"] == 1.0
    p2["review_status"] = "approved"
    client.put(f"/api/properties/{p['id']}", json=p2)
    d = client.delete(f"/api/properties/{p['id']}").json()
    assert d["review_status"] == "deprecated"  # approved records are kept for traceability


def test_library_export_import_without_duplication(client):
    lib = client.post("/api/libraries", json={"name": "Export test"}).json()
    m = client.post("/api/materials", json={"name": "Faba protein", "library_ids": [lib["id"]]}).json()
    _prop(client, m["id"], 1.0, {"temperature": 25}, "Paper F")
    bundle = client.get(f"/api/libraries/{lib['id']}/export").json()
    assert bundle["format"] == "synthea-library/1" and len(bundle["materials"]) == 1
    n_mat = db.count("materials")
    r = client.post("/api/libraries/import", json=bundle).json()
    assert r["merged_materials"] == 1 and r["materials"] == 0
    assert db.count("materials") == n_mat
    v = client.post(f"/api/materials/{m['id']}/version").json()
    assert v["version"] == 2 and v["previous_version_id"] == m["id"]
    assert len(client.get(f"/api/materials/{v['id']}").json()["properties"]) == 1
