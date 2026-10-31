"""Molecular structures: RDKit conformers, protein calculations, PDB parsing, library records and interactions."""
import math

import pytest

from app import jobs, molecules


def test_small_molecule_from_smiles(client):
    m = client.post("/api/molecules", json={"smiles": "OC[C@H]1O[C@@](CO)(O[C@H]2O[C@H](CO)[C@@H](O)[C@H](O)[C@H]2O)[C@@H](O)[C@@H]1O", "name": "Sucrose"}).json()
    p = m["properties"]
    assert p["formula"] == "C12H22O11" and p["molar_mass_g_mol"] == pytest.approx(342.30, abs=0.01)
    assert len(m["atoms"]) == 45 and p["force_field"] == "MMFF94" and "computed conformer" in m["structure_label"]
    # Stokes-Einstein estimate is in the right range for sucrose in water at 25 degC (measured ~5.2e-10 m2/s)
    assert 3e-10 < p["diffusion_coefficient_m2_s"] < 8e-10
    assert client.post("/api/molecules", json={"smiles": "C1CC"}).status_code == 400


def test_protein_sequence_calculations():
    # pI of a sequence of only Lys + termini -> very basic; of Asp/Glu only -> acidic
    assert molecules.protein_properties("KKKKKK")["isoelectric_point"] > 10
    assert molecules.protein_properties("DDEEDD")["isoelectric_point"] < 4
    p = molecules.protein_properties("MWYC" * 3 + "C")
    assert abs(molecules.net_charge("MWYC" * 3 + "C", p["isoelectric_point"])) < 1e-6
    assert p["extinction_280_oxidised"] == 3 * 5500 + 3 * 1490 + 2 * 125
    assert p["molar_mass_g_mol"] == pytest.approx(sum(molecules.RESIDUE_MASS[a] for a in "MWYC" * 3 + "C") + 18.01528)
    # water viscosity (Vogel) ~ 0.890 mPa s at 25 degC
    assert molecules.water_viscosity(25) == pytest.approx(8.9e-4, rel=0.02)
    # protein D for ~66 kDa (BSA-like) of the order of 6e-11 m2/s
    D = molecules.protein_properties("A" * 600)["diffusion_coefficient_m2_s"]
    assert 3e-11 < D < 1.2e-10
    with pytest.raises(ValueError):
        molecules.clean_sequence("ACDXZ")


def test_peptide_conformer_pdb_roundtrip_and_upload(client):
    m = client.post("/api/molecules", json={"sequence": ">pep\nLEGALEK", "name": "pep"}).json()
    assert m["kind"] == "protein" and len(m["trace"]) == 7 and "UNFOLDED" in m["structure_label"]
    from rdkit import Chem
    from rdkit.Chem import AllChem
    mh = Chem.AddHs(Chem.MolFromSequence("ACDEFGHIK"))
    AllChem.EmbedMolecule(mh, randomSeed=1)
    pdb = Chem.MolToPDBBlock(mh)
    up = client.post("/api/molecules/upload", files={"file": ("pep.pdb", pdb.encode(), "chemical/x-pdb")}).json()
    assert up["sequence"] == "ACDEFGHIK" and up["properties"]["radius_of_gyration_nm"] > 0 and len(up["bonds"]) > len(up["atoms"]) * 0.9
    r = client.post("/api/molecules/fetch", json={"source": "pdb", "id": "bad"})
    assert r.status_code == 400


def test_properties_feed_library_and_twin(client):
    m = client.post("/api/molecules", json={"smiles": "OCC(O)CO", "name": "Glycerol"}).json()
    r = client.post(f"/api/molecules/{m['id']}/properties", json={"temperature_c": 40}).json()
    assert r["properties"]["temperature_c"] == 40
    out = client.post(f"/api/molecules/{m['id']}/to-library", json={"material_id": "mat-water", "properties": ["diffusion_coefficient", "molar_mass"], "review_status": "approved"}).json()
    assert len(out["created"]) == 2
    rec = next(x for x in out["records"] if x["property"] == "diffusion_coefficient")
    assert rec["evidence_type"] == "computed_structure" and rec["conditions"] == {"temperature": 40.0} and rec["source"]["molecule_id"] == m["id"]
    assert "mat-water" in client.get(f"/api/molecules/{m['id']}").json()["material_ids"]
    t = client.post("/api/twins", json={"name": "Glycerol uptake", "physics": ["diffusion"], "material_id": "mat-water"}).json()
    t["conditions"] = {"temperature_c": 40}
    t["physics"][0]["settings"]["t_end_s"] = 600
    client.put(f"/api/twins/{t['id']}", json=t)
    inp = client.get(f"/api/twins/{t['id']}/inputs").json()
    assert inp["ready"] and inp["quantities"]["diffusion_coefficient"]["record_id"] == rec["id"]
    assert jobs.wait(client.post(f"/api/twins/{t['id']}/studies").json()["id"], 120)["status"] == "done"


def test_interaction_scene_computed_and_conceptual(client):
    w = client.post("/api/molecules", json={"smiles": "O", "name": "Water"}).json()
    g = client.post("/api/molecules", json={"smiles": "OCC(O)CO", "name": "Glycerol"}).json()
    r = client.post("/api/molecules/interaction", json={"a": g["id"], "b": w["id"], "orientations": 12}).json()
    assert r["computed"] and -15 < r["interaction_energy_kcal_mol"] < -1  # attractive H-bonded pair
    assert r["hydrogen_bonds"] and len(r["a"]["xyz"]) == len(g["atoms"]) and len(r["b"]["xyz"]) == len(w["atoms"])
    p = client.post("/api/molecules", json={"sequence": "LEGALEKLEGALEK"}).json()
    c = client.post("/api/molecules/interaction", json={"a": p["id"], "b": w["id"]}).json()
    assert c["computed"] is False and "CONCEPTUAL" in c["label"]
