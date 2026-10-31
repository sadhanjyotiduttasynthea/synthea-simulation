"""Synthea Process: sausage units, twin from a heating unit, texture classes, runs and the optimized product."""
import pytest

from app import jobs, seed, texture


def _lines():
    return [{"ingredient_id": k, "percent": v} for k, v in seed.BASELINE.items()]


def test_texture_classes_ranges_and_sources(client):
    pid = seed.PROJECT_ID
    r = client.post("/api/process/texture", json={"project_id": pid, "lines": _lines()}).json()
    assert r["class"] is None and r["label"] == "unclassified — needs texture data" and r["provenance"] == "missing" and r["needs"]
    sch = client.get("/api/texture/classes").json()
    assert [c["id"] for c in sch["classes"]] == ["TX-01", "TX-02", "TX-03", "TX-04", "TX-05"] and sch["provenance"] == "illustrative"
    assert texture.classes_for_interval(25, 35, sch["classes"]) == ["TX-03", "TX-04"]
    assert texture.label_for(["TX-03", "TX-04"]) == "TX-03 to TX-04"
    # (a) measured replicates of this formulation
    comp = {k: v for k, v in seed.BASELINE.items()}
    for h in (36.0, 38.0, 37.0):
        client.post("/api/experiments", json={"project_id": pid, "name": "TPA", "data_type": "measured", "composition": comp,
                                              "measurements": {"hardness_n": h, "springiness": 0.85, "cohesiveness": 0.6}})
    r = client.post("/api/process/texture", json={"project_id": pid, "lines": _lines()}).json()
    assert r["class"] == "TX-04" and r["provenance"] == "measured" and r["n"] == 3 and r["hardness_n"] == pytest.approx(37.0)
    assert {s["parameter"]: s["status"] for s in r["secondary"]}["springiness"] == "typical"
    # wide scatter -> range
    client.post("/api/experiments", json={"project_id": pid, "name": "TPA", "data_type": "measured", "composition": comp, "measurements": {"hardness_n": 52.0}})
    r = client.post("/api/process/texture", json={"project_id": pid, "lines": _lines()}).json()
    assert r["class"] is None and r["label"].startswith("TX-0") and " to " in r["label"]


def test_texture_from_gp_surrogate_has_band_and_q2(client):
    pid = seed.PROJECT_ID
    assert client.post("/api/experiments/synthetic", json={"project_id": pid, "n": 14}).json()["added"] == 14
    r = client.post("/api/process/texture", json={"project_id": pid, "lines": _lines()}).json()
    assert r["source"] == "GP surrogate" and r["provenance"] == "predicted" and r["band"] == "95 %"
    assert "loo_q2" in r and r["interval_n"][0] < r["hardness_n"] < r["interval_n"][1] and r["classes"]
    assert any("SYNTHETIC" in w for w in r["warnings"])


def test_twin_from_cooking_unit_flows_back(client):
    pid = seed.PROJECT_ID
    p = client.post("/api/papers/sample").json()
    client.post("/api/extractions/run", json={"paper_id": p["id"]})
    for c in client.get(f"/api/papers/{p['id']}/extractions").json():
        if c["kind"] == "equation" and c["equation"].get("template") == "first_order_arrhenius":
            client.post(f"/api/extractions/{c['id']}/approve", json={"material_id": "mat-faba-protein-isolate", "review_status": "approved"})
    flow = client.get(f"/api/process-flows?project_id={pid}").json()[0]
    f = client.get("/api/formulations", params={"project_id": pid}).json()[0]
    out = client.post("/api/process/twin", json={"flow_id": flow["id"], "node_id": "n5", "formulation_id": f["id"], "inlet_temperature_c": 10}).json()
    t = out["twin"]
    assert out["kinetics_enabled"] and t["geometry"]["params"]["diameter"] == 24.0 and t["physics"][0]["settings"]["target_c"] == 72.0
    assert t["physics"][0]["bcs"]["default"]["ambient"] == 75.0
    inp = client.get(f"/api/twins/{t['id']}/inputs").json()
    assert inp["ready"] and inp["quantities"]["thermal_conductivity"]["origin"] == "calculated" and "formulation" in inp["quantities"]["thermal_conductivity"]["method"]
    assert client.post("/api/process/twin", json={"flow_id": flow["id"], "node_id": "n3", "formulation_id": f["id"]}).status_code == 400  # chopper is not a heating unit
    job = client.post(f"/api/twins/{t['id']}/studies").json()
    assert jobs.wait(job["id"], 300)["status"] == "done"
    flow = client.get(f"/api/process-flows?project_id={pid}").json()[0]
    assert next(n for n in flow["nodes"] if n["id"] == "n5")["data"]["twin_id"] == t["id"]
    sim = client.post("/api/process/simulate", json={"flow": flow, "lines": f["lines"]}).json()
    cook = next(u for u in sim["units"] if u["id"] == "n5")
    assert cook["twin"]["provenance"] == "calculated" and cook["twin"]["study_id"] and cook["twin"]["core_temperature_c"] > 10
    assert cook["twin"]["native_fraction_mean"] is not None
    keys = {x["key"] for x in sim["summary"]["technical"]}
    assert {"twin_core_temperature_c", "twin_native_fraction"} <= keys


def test_runs_compare_and_optimized_product(client):
    pid = seed.PROJECT_ID
    flow = client.get(f"/api/process-flows?project_id={pid}").json()[0]
    f = client.get("/api/formulations", params={"project_id": pid}).json()[0]
    sim = client.post("/api/process/simulate", json={"flow": flow, "lines": f["lines"]}).json()
    tex = client.post("/api/process/texture", json={"project_id": pid, "formulation_id": f["id"]}).json()
    r1 = client.post("/api/process/runs", json={"project_id": pid, "flow_id": flow["id"], "formulation_id": f["id"], "formulation_name": f["name"], "summary": sim["summary"], "texture": tex}).json()
    r2 = client.post("/api/process/runs", json={"project_id": pid, "flow_id": flow["id"], "formulation_id": f["id"], "formulation_name": f["name"], "summary": sim["summary"], "texture": tex, "name": "B"}).json()
    runs = client.get(f"/api/process/runs?project_id={pid}").json()
    assert {r["id"] for r in runs} == {r1["id"], r2["id"]}
    op = client.post(f"/api/process/runs/{r2['id']}/optimized").json()
    assert op["run_id"] == r2["id"] and op["formulation_id"] == f["id"] and op["technical"]
    proj = client.get(f"/api/projects/{pid}").json()
    assert proj["optimized_product"]["run_id"] == r2["id"]
    stale = {k: v for k, v in proj.items() if k != "optimized_product"}
    client.put(f"/api/projects/{pid}", json={**stale, "active_formulation_id": f["id"]})  # client with an older copy
    assert client.get(f"/api/projects/{pid}").json()["optimized_product"]["run_id"] == r2["id"]


def test_texture_from_approved_product_records(client):
    m = client.post("/api/materials", json={"name": "Faba sausage prototype A", "library_ids": ["lib-custom"]}).json()
    client.post("/api/properties", json={"material_id": m["id"], "property": "hardness", "value": 22.0, "unit": "N", "uncertainty": {"type": "sd", "value": 2.0},
                                         "conditions": {}, "evidence_type": "directly_reported", "review_status": "approved", "source": {"citation": "lab report", "page": 1}})
    r = client.post("/api/process/texture", json={"project_id": seed.PROJECT_ID, "lines": _lines(), "product_material_id": m["id"]}).json()
    assert r["class"] == "TX-03" and r["provenance"] == "literature" and r["interval_n"] == [18.0, 26.0]
    # an unreviewed record is not used
    client.post("/api/properties", json={"material_id": m["id"], "property": "springiness", "value": 0.2, "unit": "", "conditions": {}, "review_status": "extracted"})
    r = client.post("/api/process/texture", json={"project_id": seed.PROJECT_ID, "lines": _lines(), "product_material_id": m["id"]}).json()
    assert all(s["parameter"] != "springiness" or s["value"] is None for s in r["secondary"])
