"""Digital twin: solver verification against analytic solutions and the paper -> library -> twin workflow."""
import math

import numpy as np
import pytest

from app import jobs
from app.science import rheology
from app.twin import solvers as S
from app.twin.geometry import Grid, polygons, properties


# ------------------------------------------------------------------ geometry / mesh
def test_shapes_and_mesh_convergence():
    for shape in ("rectangle", "circle", "ellipse", "annulus", "l_shape", "hexagon", "star", "polygon"):
        outer, holes = polygons({"shape": shape})
        assert len(outer) >= 3
    ring = properties({"shape": "annulus", "params": {"outer_diameter": 40, "inner_diameter": 16}})
    assert ring["area_mm2"] == pytest.approx(math.pi / 4 * (40 ** 2 - 16 ** 2), rel=1e-3)
    errs = [abs(Grid({"shape": "circle", "params": {"diameter": 30}}, {"cells_across": n}).info()["area_error_pct"]) for n in (20, 80, 160)]
    assert errs[2] < errs[0] and errs[2] < 1.0
    g = Grid({"shape": "annulus"}, {"level": "coarse"})
    assert (g.b_group == "inner").sum() > 0 and (g.b_group == "outer").sum() > (g.b_group == "inner").sum()
    star = Grid({"shape": "star"}, {"level": "normal"})
    assert set(star.b_group) == {f"edge{k}" for k in range(1, 11)}  # every face belongs to a named edge
    rect = Grid({"shape": "rectangle", "params": {"width": 40, "height": 10}}, {"cells_across": 40})
    assert (rect.b_group == "bottom").sum() == 40 and (rect.b_group == "left").sum() == 10
    with pytest.raises(ValueError):
        polygons({"shape": "annulus", "params": {"outer_diameter": 10, "inner_diameter": 20}})


# ------------------------------------------------------------------ verification
def test_heat_conduction_matches_fourier_series():
    L = 0.01
    g = Grid({"shape": "rectangle", "params": {"width": 4, "height": 10}, "depth": 10}, {"cells_across": 50})
    k, rho, cp, t = 0.5, 1050.0, 3600.0, 60.0
    a = k / (rho * cp)
    r = S.solve_scalar(g, cond=k, cap=rho * cp, bcs={"top": {"type": "temperature", "value": 100}, "bottom": {"type": "temperature", "value": 100}},
                       initial=20, t_end=t, dt=0.05)
    y = g.yc_mm / 1000
    exact = 100 - 80 * sum(4 / (m * math.pi) * np.sin(m * math.pi * y / L) * np.exp(-a * (m * math.pi / L) ** 2 * t) for m in range(1, 400, 2))
    assert np.abs(np.array(r["frames"][-1]) - exact).max() < 0.1
    # energy conservation: stored heat = integral of boundary inflow (checked at steady state)
    s = S.solve_scalar(g, cond=k, cap=0, bcs={"top": {"type": "temperature", "value": 80}, "bottom": {"type": "convection", "h": 20, "ambient": 20}}, initial=0, steady=True)
    assert abs(s["balance"]["total_inflow"]) < 1e-9 * max(abs(v) for v in s["balance"]["boundary_inflow"].values())


def test_heat_with_kinetics_and_target():
    g = Grid({"shape": "circle", "params": {"diameter": 10}}, {"cells_across": 30})
    r = S.solve_scalar(g, cond=0.5, cap=3.9e6, bcs={"outer": {"type": "temperature", "value": 90}}, initial=20,
                       t_end=1200, kinetics={"k_ref": 2.1e-3, "Ea": 250e3, "T_ref_c": 85.0}, target=85.0)
    assert r["target"]["time_all_cells_reached_s"] is not None
    assert 0 < r["history"]["x_mean"][-1] < 1 and r["history"]["x_min"][-1] <= r["history"]["x_mean"][-1]


def test_duct_flow_newtonian_power_law_and_herschel_bulkley():
    g = Grid({"shape": "circle", "params": {"diameter": 10}}, {"cells_across": 100})
    R, G = 0.005, 1e4
    r = S.solve_duct_flow(g, law={"K": 2.0, "n": 1.0}, pressure_gradient=G)
    assert r["flow_rate_m3_s"] == pytest.approx(math.pi * R ** 4 * G / (8 * 2.0), rel=0.02)
    assert r["force_balance"]["relative_error"] < 1e-9
    K, n = 5.0, 0.5
    r = S.solve_duct_flow(g, law={"K": K, "n": n}, pressure_gradient=G)
    assert r["flow_rate_m3_s"] == pytest.approx(math.pi * R ** 3 * n / (3 * n + 1) * (G * R / 2 / K) ** (1 / n), rel=0.03)
    q_hb = rheology.flow_rate_from_wall_stress(G * R / 2, R, 5.0, K, n)
    r = S.solve_duct_flow(g, law={"tau0": 5.0, "K": K, "n": n}, pressure_gradient=G)
    assert r["flow_rate_m3_s"] == pytest.approx(q_hb, rel=0.03) and r["unyielded_fraction"] > 0
    inv = S.solve_duct_flow(g, law={"tau0": 5.0, "K": K, "n": n}, mode="flow_rate", flow_rate_m3_s=r["flow_rate_m3_s"])
    assert inv["pressure_gradient_pa_m"] == pytest.approx(G, rel=0.01)


def test_elasticity_uniaxial_compression_is_exact():
    g = Grid({"shape": "rectangle", "params": {"width": 20, "height": 10}, "depth": 5}, {"cells_across": 30})
    E, nu, p = 5e4, 0.3, 1000.0
    r = S.solve_elasticity(g, E=E, nu=nu, density=None, gravity=False,
                           bcs={"bottom": {"type": "roller"}, "left": {"type": "roller"}, "top": {"type": "pressure", "pressure": p}})
    assert r["min_sigma_yy_pa"] == pytest.approx(-p, rel=1e-9) and r["max_sigma_yy_pa"] == pytest.approx(-p, rel=1e-9)
    assert r["max_displacement_m"] == pytest.approx(math.hypot(p * 0.01 / E, nu * p * 0.02 / E), rel=1e-6)
    assert r["equilibrium"]["residual_n"] < 1e-9
    with pytest.raises(ValueError, match="supported"):
        S.solve_elasticity(g, E=E, nu=nu, density=1000, bcs={"bottom": {"type": "roller"}})


# ------------------------------------------------------------------ paper -> library -> twin
def _approve(client, cands, prop, value, mid="mat-faba-protein-isolate"):
    c = next(c for c in cands if c["kind"] == "property" and c["property"] == prop and abs((c["value"] or 0) - value) < 1e-9)
    assert client.post(f"/api/extractions/{c['id']}/approve", json={"material_id": mid, "review_status": "approved"}).status_code == 200


def test_twin_workflow_from_paper_to_study(client):
    p = client.post("/api/papers/sample").json()
    client.post("/api/extractions/run", json={"paper_id": p["id"]})
    cands = client.get(f"/api/papers/{p['id']}/extractions").json()
    t = client.post("/api/twins", json={"name": "Dough slab", "physics": ["heat", "flow"]}).json()
    inp = client.get(f"/api/twins/{t['id']}/inputs").json()
    assert not inp["ready"] and inp["missing"]  # nothing approved yet -> refuses to invent data
    job = client.post(f"/api/twins/{t['id']}/studies").json()
    assert jobs.wait(job["id"])["status"] == "failed"

    _approve(client, cands, "thermal_conductivity", 0.52)
    _approve(client, cands, "specific_heat", 3.75)
    hb = next(c for c in cands if c["kind"] == "equation" and c["equation"].get("template") == "herschel_bulkley")
    client.post(f"/api/extractions/{hb['id']}/approve", json={"material_id": "mat-faba-protein-isolate", "review_status": "approved", "parameter_sets": [0]})
    for m in client.get("/api/sci-models").json():
        client.post(f"/api/sci-models/{m['id']}/status", json={"status": "approved"})
    inp = client.get(f"/api/twins/{t['id']}/inputs").json()
    q = inp["quantities"]
    assert q["thermal_conductivity"]["value"] == pytest.approx(0.52) and q["thermal_conductivity"]["source"]["paper_id"] == p["id"]
    assert q["specific_heat"]["value"] == pytest.approx(3750)
    assert q["rheology"]["origin"] == "model"
    assert "density" in inp["missing"][0].lower()  # no approved density record yet
    t["material"]["sources"] = {"density": {"mode": "choi_okos"}}
    t = client.put(f"/api/twins/{t['id']}", json=t).json()
    dens = client.get(f"/api/twins/{t['id']}/inputs").json()["quantities"]["density"]
    assert dens["value"] is None and "composition" in dens["message"]  # placeholder composition is not reviewed
    t["material"]["sources"] = {"density": {"mode": "manual", "value": 1080}}
    t["physics"][0]["settings"]["t_end_s"] = 120
    t = client.put(f"/api/twins/{t['id']}", json=t).json()
    assert client.get(f"/api/twins/{t['id']}/inputs").json()["ready"]
    job = client.post(f"/api/twins/{t['id']}/studies").json()
    done = jobs.wait(job["id"], 300)
    assert done["status"] == "done", done["log"][-3:]
    st = client.get(f"/api/studies/{done['result']['study_id']}").json()
    heat = next(r for r in st["results"].values() if r["kind"] == "heat")
    flow = next(r for r in st["results"].values() if r["kind"] == "flow")
    assert len(heat["frames"]) > 2 and heat["history"]["mean"][-1] > 20
    assert flow["flow_rate_m3_s"] == pytest.approx(20 / 1000 / 3600, rel=1e-3)
    assert st["inputs"]["quantities"]["density"]["origin"] == "manual"
    assert any("manual entry" in w for w in st["warnings"])
    assert any("SYNTHETIC" in w for w in st["warnings"])
    assert client.get(f"/api/twins/{t['id']}/studies").json()[0]["id"] == st["id"]
    tree = client.get(f"/api/workspace/tree?project_id={t['project_id']}").json()
    assert tree is not None


def test_demo_twins_run(client):
    out = client.post("/api/twins/demo", json={"project_id": None}).json()
    assert len(out["twins"]) == 4 and out["approved"] > 5
    for tid in out["twins"]:
        inp = client.get(f"/api/twins/{tid}/inputs").json()
        assert inp["ready"], inp["missing"]
        done = jobs.wait(client.post(f"/api/twins/{tid}/studies").json()["id"], 300)
        assert done["status"] == "done", done["log"][-3:]
    st = client.get(f"/api/twins/{out['twins'][2]}/studies").json()[0]
    s = client.get(f"/api/studies/{st['id']}").json()
    r = next(iter(s["results"].values()))
    assert r["kind"] == "structural" and r["safety_factor"] > 0 and abs(r["equilibrium"]["residual_n"]) < 1e-6
