"""'Summarize all PDFs' library report: consolidated tables, ranges (no averaging), disagreements, traceable numbers."""
from app import library_report


def _setup(client):
    p = client.post("/api/papers/sample").json()  # filed in lib-plant-protein and lib-rheology
    client.post("/api/extractions/run", json={"paper_id": p["id"]})
    cands = client.get(f"/api/papers/{p['id']}/extractions").json()
    v = next(c for c in cands if c["kind"] == "property" and c["property"] == "viscosity" and c["value"] == 2.4)
    client.post(f"/api/extractions/{v['id']}/approve", json={"material_id": "mat-faba-protein-isolate", "review_status": "approved"})
    # a second value for the same property under comparable conditions (as if from another page) that disagrees
    client.post("/api/properties", json={"material_id": "mat-faba-protein-isolate", "property": "viscosity", "value": 1.2, "unit": "Pa*s",
                                         "conditions": {"temperature": 26, "concentration": 15, "shear_rate": 10}, "evidence_type": "directly_reported",
                                         "review_status": "reviewed", "source": {"paper_id": p["id"], "page": 2, "snippet": "test value"}})
    return p


def test_library_report_tables_ranges_and_disagreements(client):
    p = _setup(client)
    r = client.post("/api/libraries/lib-plant-protein/report", json={}).json()
    assert r["counts"]["papers"] == 1 and r["papers"][0]["synthetic"] and r["warnings"]
    visc = [x for x in r["properties"] if x["property"] == "viscosity" and x["material"] == "Faba bean protein isolate" and x["origin"] == "library record"]
    assert {x["status"] for x in visc} == {"approved", "reviewed"} and all(x["paper_id"] == p["id"] and x["page"] for x in visc)
    assert any(x["status"] == "pending" for x in r["properties"])  # candidates awaiting review are shown and labelled
    kn = next(k for k in r["key_numbers"] if k["property"] == "viscosity" and k["material"] == "Faba bean protein isolate")
    assert kn["min"] == 1.2 and kn["max"] == 2.4 and kn["n_values"] == 3  # range over 2.4, 1.2 and the pending 1.3 (50 °C): not an average
    d = next(d for d in r["disagreements"] if d["property"] == "viscosity")
    assert {d["a"]["value"], d["b"]["value"]} == {2.4, 1.2} and d["relative_difference"] > 0.25
    templates = {e["template"] for e in r["equations"]}
    assert {"herschel_bulkley", "gab_sorption", "first_order_arrhenius"} <= templates
    gab = next(e for e in r["equations"] if e["template"] == "gab_sorption")
    assert {q["symbol"]: q["value"] for q in gab["parameters"]} == {"Xm": 0.071, "C": 9.4, "K": 0.86} and gab["page"] == 2
    pdf = client.post("/api/libraries/lib-plant-protein/report.pdf", json={"report": r})
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
    # Claude narrative is refused without key / opt-in (no data leaves the machine)
    assert client.post("/api/libraries/lib-plant-protein/report", json={"method": "claude"}).status_code == 400


def test_untraceable_numbers_are_masked():
    allowed = {"2.4", "25", "15"}
    text, n = library_report.mask_untraceable_numbers("Viscosity was 2.4 Pa·s at 25 °C; about 3.7 Pa·s at 15 %, and 2 papers agree.", allowed)
    assert n == 1 and "3.7" not in text and "2.4" in text and "2 papers" in text
