"""Synthea Print: arbitrary slicing, STL I/O, extrusion methods, manufacturability index and G-code."""
import math

import numpy as np
import pytest

from app import geometry3d as G
from app import printing

HB = {"yield_stress_pa": 400.0, "consistency_index_pa_sn": 60.0, "flow_behaviour_index": 0.4, "source": "measured: test flow curve"}


def gen(objects, **kw):
    p = {"shape": "geometry", "geometry": {"objects": objects}, "nozzle_diameter_mm": 1.2, "layer_height_mm": 1.0, "print_speed_mm_s": 20,
         "infill_pct": 40, "density_kg_m3": 1080, "extrusion": {"method": "piston"}}
    p.update(kw)
    return printing.generate(p)


def test_meshes_slices_and_stl_roundtrip():
    for o, exact in [({"kind": "box", "params": {"width": 30, "depth": 20, "height": 15}}, 9000.0),
                     ({"kind": "sphere", "params": {"diameter": 20}}, 4 / 3 * math.pi * 1000)]:
        V, F = G.object_mesh(o)
        info = G.mesh_info(V, F)
        assert info["closed_orientation_ok"] and info["volume_mm3"] == pytest.approx(exact, rel=0.02)
    V, F = G.object_mesh({"kind": "ring", "params": {"diameter": 30, "inner_diameter": 15, "height": 10}, "position": [20, 5, 0]})
    regs = G.slice_mesh(V, F, 5.0)
    assert len(regs) == 1 and len(regs[0][1]) == 1  # one region with one hole
    hole = regs[0][1][0]
    assert np.allclose(hole.mean(0), [20, 5], atol=0.1) and np.linalg.norm(hole - [20, 5], axis=1).max() == pytest.approx(7.5, rel=0.01)
    V2, F2 = G.read_stl(G.write_stl(V, F))
    assert G.mesh_info(V2, F2)["volume_mm3"] == pytest.approx(G.mesh_info(V, F)["volume_mm3"], rel=1e-6)
    with pytest.raises(ValueError):
        G.read_stl(b"not an stl at all, too short")


def test_toolpath_from_arbitrary_geometry_with_offset_hole():
    out = gen([{"kind": "ring", "params": {"diameter": 30, "inner_diameter": 15, "height": 6}, "position": [20, 5, 0]}])
    pts = np.array([p[:2] for p in out["path"] if p[3]])
    r = np.linalg.norm(pts - [20, 5], axis=1)
    assert r.min() > 7.5 and r.max() < 15  # all extrusion between the hole and the outer wall, around the offset centre
    assert out["layer_count"] == 6 and out["extrusion"]["method"] == "piston"


def test_overhang_and_feature_checks():
    mushroom = gen([{"kind": "cylinder", "params": {"diameter": 10, "height": 10}},
                    {"kind": "cylinder", "params": {"diameter": 30, "height": 4}, "position": [0, 0, 10]}])
    ov = next(c for c in mushroom["manufacturability"]["checks"] if c["id"] == "overhang")
    assert ov["value"] > 80 and ov["status"] == "fail"
    taper = gen([{"kind": "cone", "params": {"diameter": 10, "top_diameter": 30, "height": 20}}])  # widening by 10 mm over 20 mm
    ov = next(c for c in taper["manufacturability"]["checks"] if c["id"] == "overhang")
    assert ov["value"] == pytest.approx(math.degrees(math.atan2(10, 20)), abs=8) and ov["status"] == "pass"
    upright = gen([{"kind": "cone", "params": {"diameter": 30, "top_diameter": 10, "height": 20}}])
    assert next(c for c in upright["manufacturability"]["checks"] if c["id"] == "overhang")["value"] < 5
    thin = gen([{"kind": "rectangle", "params": {"width": 30, "depth": 0.6, "height": 4}}])  # wall thinner than the 1.2 mm nozzle
    ft = next(c for c in thin["manufacturability"]["checks"] if c["id"] == "feature_size")
    assert ft["status"] == "fail" and ft["value"] > 50
    block = gen([{"kind": "box", "params": {"width": 30, "depth": 20, "height": 6}}])
    assert next(c for c in block["manufacturability"]["checks"] if c["id"] == "feature_size")["status"] == "pass"


def test_score_without_rheology_excludes_checks():
    out = gen([{"kind": "box", "params": {"width": 30, "depth": 20, "height": 6}}])
    m = out["manufacturability"]
    assert m["n_evaluated"] == 3 and m["based_on"] == "based on 3 of 5 checks" and "not a success probability" in m["label"]
    assert {c["id"] for c in m["checks"] if c["status"] == "not evaluated"} == {"pressure", "shape_retention"}
    assert m["score_pct"] == pytest.approx(100.0)
    assert out["extrusion"]["pressure"]["status"] == "not computed"
    assert sum(m["weights"].values()) == 100


def test_score_with_rheology_pressure_and_shape_retention():
    out = gen([{"kind": "box", "params": {"width": 30, "depth": 20, "height": 20}}], rheology=HB, limits={"max_pressure_kpa": 50.0})
    m = out["manufacturability"]
    assert m["n_evaluated"] == 5
    pr = next(c for c in m["checks"] if c["id"] == "pressure")
    assert pr["value"] == pytest.approx(out["nozzle"]["pressure_drop_kpa"]) and pr["status"] == ("fail" if pr["value"] > 50 else pr["status"])
    sr = next(c for c in m["checks"] if c["id"] == "shape_retention")
    assert sr["value"] == pytest.approx(400 / (1080 * 9.81 * 20 / 1000)) and sr["status"] == "pass"
    w = m["weights"]
    expect = 100 * sum(w[c["id"]] * c["score"] for c in m["checks"]) / 100
    assert m["score_pct"] == pytest.approx(expect)
    assert m["limiting"]["id"] == min(m["checks"], key=lambda c: (c["score"], c.get("margin", 0), -c["weight"]))["id"] and m["limiting"]["advice"]


def test_extrusion_methods_and_gcode():
    piston = gen([{"kind": "box", "params": {"width": 20, "depth": 20, "height": 3}}], extrusion={"method": "piston", "barrel_diameter_mm": 20})
    A = math.pi * 100
    ex = piston["extrusion"]
    assert ex["ram_speed_mm_s"] == pytest.approx(piston["required_volumetric_flow_mm3_s"] / A)
    assert ex["ram_displacement_mm"] == pytest.approx(piston["deposited_volume_cm3"] * 1000 / A)
    params = {"layer_height_mm": 1.0, "print_speed_mm_s": 20, "nozzle_diameter_mm": 1.2}
    g = printing.gcode(piston, params)
    assert g.startswith("; ") and "G21" in g and "M83" in g
    e_total = sum(float(l.split(" E")[1].split()[0]) for l in g.splitlines() if l.startswith("G1") and " E" in l)
    assert e_total == pytest.approx(ex["ram_displacement_mm"], rel=1e-3)
    screw = gen([{"kind": "box", "params": {"width": 20, "depth": 20, "height": 3}}], extrusion={"method": "screw", "screw_diameter_mm": 10, "channel_depth_mm": 2, "pitch_mm": 8, "fill_fraction": 1.0})
    q_rev = math.pi / 4 * (100 - 36) * 8
    assert screw["extrusion"]["screw_speed_rpm"] == pytest.approx(screw["required_volumetric_flow_mm3_s"] / q_rev * 60)
    assert "revolutions" in screw["extrusion"]["e_axis"]


def test_geometry_api_stl_and_gcode(client):
    pid = "demo-faba-sausage"
    objs = [{"kind": "cylinder", "name": "Patty", "params": {"diameter": 40, "height": 8}}]
    doc = client.put("/api/geometry", json={"project_id": pid, "objects": objs}).json()
    assert doc["objects"][0]["id"].startswith("obj-")
    stl = client.post("/api/geometry/stl", json={"objects": doc["objects"]})
    assert stl.status_code == 200 and len(stl.content) == 84 + 50 * len(G.object_mesh(objs[0])[1])
    up = client.post("/api/geometry/import-stl", files={"file": ("patty.stl", stl.content, "model/stl")}).json()
    assert up["kind"] == "mesh" and up["info"]["volume_mm3"] == pytest.approx(math.pi * 400 * 8, rel=0.01)
    tp = client.post("/api/print/toolpath", json={"shape": "geometry", "project_id": pid, "nozzle_diameter_mm": 1.2, "layer_height_mm": 1.0}).json()
    assert tp["layer_count"] == 8 and tp["manufacturability"]["score_pct"] is not None
    gc = client.post("/api/print/gcode", json={"shape": "geometry", "project_id": pid, "nozzle_diameter_mm": 1.2, "layer_height_mm": 1.0, "extrusion": {"method": "screw"}})
    assert gc.status_code == 200 and "auger revolutions" in gc.text
    assert client.put("/api/geometry", json={"project_id": pid, "objects": [{"kind": "ring", "params": {"diameter": 10, "inner_diameter": 20}}]}).status_code == 400
