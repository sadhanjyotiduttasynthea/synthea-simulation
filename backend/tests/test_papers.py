from app import papers, sample_docs


def test_sample_pdf_ingestion_metadata_tables_and_search(client):
    p = client.post("/api/papers/sample").json()
    assert p["page_count"] == 2
    m = p["metadata"]
    assert m["doi"] == "10.0000/synthea.test.0001"
    assert m["year"] == 2026
    assert "Testauthor" in m["citation"]
    assert m["journal"] == "Synthea Test Documents"
    full = client.get(f"/api/papers/{p['id']}").json()
    tables = [t for pg in full["pages"] for t in pg["tables"]]
    assert tables and tables[0]["rows"][1] == ["10", "25", "4.2", "1.8", "0.62", "0.998"]
    assert "2.4 ± 0.2 Pa·s" in full["pages"][0]["text"]
    r = client.get(f"/api/papers/{p['id']}/search", params={"page": 1, "q": "2.4 ± 0.2 Pa"}).json()
    assert len(r["rects"]) == 1
    png = client.get(f"/api/papers/{p['id']}/page/1.png")
    assert png.status_code == 200 and png.content[:4] == b"\x89PNG"
    assert client.get(f"/api/papers/{p['id']}/file").content[:4] == b"%PDF"


def test_duplicate_pdf_detected_and_non_pdf_rejected(client):
    content = sample_docs.build_sample_pdf()
    a = client.post("/api/papers", files={"file": ("a.pdf", content, "application/pdf")}).json()
    b = client.post("/api/papers", files={"file": ("b.pdf", content, "application/pdf")}).json()
    assert b["id"] == a["id"] and b.get("duplicate") is True
    bad = client.post("/api/papers", files={"file": ("x.pdf", b"hello", "application/pdf")})
    assert bad.status_code == 400


def test_metadata_edit_and_citation(client):
    p = client.post("/api/papers/sample").json()
    r = client.put(f"/api/papers/{p['id']}", json={"metadata": {"authors": ["Ann Smith", "Bo Li"], "year": 2025}}).json()
    assert r["metadata"]["citation"].startswith("Smith & Li (2025)")
    assert papers.citation({"authors": [], "title": "T"}).startswith("Unknown author")
