from app import seed


def test_health_and_seed(client):
    r = client.get("/api/health").json()
    assert r["status"] == "ok" and r["ingredients"] == 6
    projects = client.get("/api/projects").json()
    assert projects[0]["name"] == "Affordable Pea Protein Snack"


def test_ingredient_crud(client):
    new = {"name": "Faba bean protein concentrate", "category": "Protein", "nutrition": {"protein": 60}, "economics": {"price_per_kg": 3.0}}
    r = client.post("/api/ingredients", json=new)
    assert r.status_code == 200
    iid = r.json()["id"]
    upd = r.json()
    upd["supplier"] = "X"
    r = client.put(f"/api/ingredients/{iid}", json=upd)
    assert r.json()["version"] == 2
    assert client.delete(f"/api/ingredients/{iid}").status_code == 200
    # ingredient in use cannot be deleted
    assert client.delete("/api/ingredients/water").status_code == 409


def test_evaluate_and_optimize(client):
    f = client.get("/api/formulations", params={"project_id": seed.PROJECT_ID}).json()[0]
    r = client.post("/api/formulations/evaluate", json={"lines": f["lines"], "serving_size_g": 30}).json()
    assert abs(r["composition"]["protein"] - 16.03) < 1e-9
    assert r["thermal"]["model"].startswith("Choi")
    assert "not available" in r["predictive_models"]["viscosity"]
    proj = client.get(f"/api/projects/{seed.PROJECT_ID}").json()
    req = {**proj["optimizer"], "baseline": {l["ingredient_id"]: l["percent"] for l in f["lines"]}, "project_id": seed.PROJECT_ID}
    r = client.post("/api/optimize", json=req).json()
    assert r["status"] == "optimal" and len(r["candidates"]) == 3


def test_experiments_csv_roundtrip_and_recommend(client):
    pid = seed.PROJECT_ID
    assert client.post("/api/experiments/synthetic", json={"project_id": pid, "n": 8}).json()["added"] == 8
    csv_text = client.get("/api/experiments/export-csv", params={"project_id": pid}).text
    assert "pct_water" in csv_text
    r = client.post("/api/experiments/import-csv", json={"project_id": pid, "csv": csv_text}).json()
    assert r["imported"] == 8
    rec = client.post("/api/experiments/recommend", json={"project_id": pid, "k": 3}).json()
    assert rec["phase"] == "active_learning"


def test_process_print_models_assistant_report(client):
    pid = seed.PROJECT_ID
    flow = client.get("/api/process-flows", params={"project_id": pid}).json()[0]
    f = client.get("/api/formulations", params={"project_id": pid}).json()[0]
    sim = client.post("/api/process/simulate", json={"flow": flow, "lines": f["lines"]}).json()
    assert sim["summary"]["product_kg_h"] > 0
    tp = client.post("/api/print/toolpath", json={"shape": "ring", "geometry": {"diameter": 40, "inner_diameter": 15, "height": 5}, "lines": f["lines"]}).json()
    assert tp["material_mass_g"] > 0
    assert client.get("/api/models").json()
    assert client.post("/api/expressions/evaluate", json={"expression": "a*b", "variables": {"a": 2, "b": 3}}).json()["value"] == 6
    assert client.post("/api/expressions/evaluate", json={"expression": "__import__('os')"}).json()["ok"] is False
    a = client.post("/api/assistant", json={"question": "explain", "page": "process", "context": {"process": sim}}).json()
    assert a["mode"] == "local" and "kW" in a["answer"]
    pdf = client.post("/api/reports/pdf", json={"title": "T", "project": "P", "sections": [{"title": "S", "paragraphs": ["x"], "tables": [{"headers": ["a", "b"], "rows": [[1, 2]]}]}]})
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"


def test_project_export_import_duplicate(client):
    b = client.get(f"/api/projects/{seed.PROJECT_ID}/export").json()
    p = client.post("/api/projects/import", json=b).json()
    assert p["id"] != seed.PROJECT_ID
    fs = client.get("/api/formulations", params={"project_id": p["id"]}).json()
    assert len(fs) == 1 and p["active_formulation_id"] == fs[0]["id"]
    d = client.post(f"/api/projects/{seed.PROJECT_ID}/duplicate").json()
    assert d["name"].endswith("(copy)")
