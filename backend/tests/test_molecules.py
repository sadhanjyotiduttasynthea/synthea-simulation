import math

import numpy as np

from app import molecules, sci_registry


def _xyz(a):
    return np.array([a["x"], a["y"], a["z"]])


def test_water_conformer_geometry():
    w = molecules.builtin("water")
    o, h1, h2 = (_xyz(a) for a in w["atoms"])
    d1, d2 = np.linalg.norm(h1 - o), np.linalg.norm(h2 - o)
    ang = math.degrees(math.acos(np.dot(h1 - o, h2 - o) / (d1 * d2)))
    assert 0.94 < d1 < 0.99 and abs(d1 - d2) < 1e-3
    assert 102 < ang < 107  # MMFF94 water angle close to the experimental 104.5 degrees
    assert w["properties"]["formula"] == "H2O" and "computed" in w["provenance"]


def test_builtin_properties_exact_mass():
    g = molecules.builtin("glucose")
    assert g["properties"]["formula"] == "C6H12O6"
    assert abs(g["properties"]["molar_mass_g_mol"] - 180.156) < 0.01


def test_water_scene_hbond_geometry():
    s = molecules.scene_water()
    o = [a for a in s["atoms"] if a["el"] == "O"]
    d = [math.dist((o[0]["x"], o[0]["y"], o[0]["z"]), (x["x"], x["y"], x["z"])) for x in o[1:]]
    assert all(abs(v - 2.76) < 1e-6 for v in d)
    assert len(s["hbonds"]) == 4 and s["kind"] == "conceptual"


def test_parse_structure_files():
    xyz = "3\nwater\nO 0 0 0\nH 0.9572 0 0\nH -0.24 0.9266 0\n"
    m = molecules.parse_file(xyz, "w.xyz")
    assert len(m["atoms"]) == 3 and len(m["bonds"]) == 2
    pdb = "HETATM    1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O\nEND\n"
    p = molecules.parse_file(pdb, "w.pdb")
    assert p["atoms"][0]["el"] == "O"


def test_emulsion_physics():
    r = molecules.emulsion_physics(1.0, 10.0, 920.0, 1000.0, 0.001)
    assert abs(r["laplace_pressure_pa"] - 2 * 0.010 / 1e-6) < 1e-6
    assert abs(r["stokes_velocity_m_s"] - 2 * (-80) * 9.80665 * 1e-12 / (9 * 0.001)) < 1e-15


def test_aggregation_uses_approved_kinetics_only(client):
    conceptual = molecules.scene_aggregation(85, 300, "mat-pea-protein-isolate")
    assert conceptual["kind"] == "conceptual" and conceptual["denatured_fraction"] is None
    m = sci_registry.from_template("first_order_arrhenius", material_id="mat-pea-protein-isolate", status="approved",
                                   validity={"T": [330.0, 370.0]})
    for p in m["parameters"]:
        p["value"] = {"k_ref": 2.1e-3, "Ea": 250000.0, "T_ref": 358.15}[p["symbol"]]
    sci_registry.save(m)
    s = molecules.scene_aggregation(85, 300, "mat-pea-protein-isolate")
    assert s["kind"] == "model-driven"
    assert abs(s["denatured_fraction"] - (1 - math.exp(-2.1e-3 * 300))) < 1e-9
