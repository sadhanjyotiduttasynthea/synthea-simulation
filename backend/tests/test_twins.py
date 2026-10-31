import math

import numpy as np
import pytest

from app import db, sci_registry, solvers


def test_fv_conduction_matches_analytic_series():
    L, k, rc, h = 5e-3, 0.5, 4.0e6, 50.0
    m = solvers.mesh_slab(10, n=80)
    r = solvers.solve_diffusion(m, lambda u: np.full(m.n, k), lambda u: np.full(m.n, rc),
                                {"x-": {"type": "convection", "h": h, "T_inf": 100}, "x+": {"type": "convection", "h": h, "T_inf": 100}}, 20, 600, 1.0)
    T = r["frames"][-1]
    Fo, Bi = k / rc * 600 / L ** 2, h * L / k
    exact = 100 + (20 - 100) * solvers.slab_series(0.0, Fo, Bi)
    assert abs(0.5 * (T[39] + T[40]) - exact) / (exact - 20) < 2e-3
    assert r["balance"]["relative_error"] < 1e-9


def test_hb_channel_reproduces_flow_rate_and_newtonian_limit():
    f = solvers.hb_channel(1e-6, None, 2e-3, 20e-3, 18.5, 9.6, 0.48, 1100)
    assert abs(f["flow_rate_m3_s"] - 1e-6) / 1e-6 < 5e-3
    n = solvers.hb_channel(1e-6, None, 2e-3, 20e-3, 0.0, 1.0, 1.0, 1000, nr=400)
    assert abs(n["pressure_drop_pa"] - 8 * 1.0 * 20e-3 * 1e-6 / (math.pi * (2e-3) ** 4)) / n["pressure_drop_pa"] < 1e-6
    assert abs(n["max_velocity_m_s"] - 2 * n["mean_velocity_m_s"]) / n["max_velocity_m_s"] < 1e-3  # parabolic profile


def _twin(client, **kw):
    body = {"project_id": "demo-pea-snack", "name": "t", "geometry_object_id": "obj-bar", "material": {"type": "formulation", "id": "baseline-pea-snack"},
            "physics": [{"kind": "heat", "enabled": True}]}
    client.get("/api/geometries", params={"project_id": "demo-pea-snack"})
    body.update(kw)
    return client.post("/api/twins", json=body).json()


def test_heat_twin_with_formulation_properties(client):
    t = _twin(client)
    t["study"]["t_end"], t["study"]["dt"] = 600, 20
    client.put(f"/api/twins/{t['id']}", json=t)
    s = client.post(f"/api/twins/{t['id']}/run").json()
    m = s["heat"]["metrics"]
    assert 20 < m["final_centre_C"] < m["final_max_C"] <= 90
    assert s["mesh"]["type"] == "cartesian3d" and s["mesh"]["cells"] > 1000
    assert any("Choi & Okos" in p["source"] for p in s["provenance"])
    assert s["heat"]["balance"]["relative_error"] < 1e-6
    assert not s["extrapolated"]
    # experimental comparison
    v = client.post(f"/api/studies/{s['id']}/compare", json={"probe": "centre", "data": [[0, 20], [300, 50], [600, 65]], "label": "lab"}).json()
    assert v["n"] == 3 and v["rmse"] >= 0
    assert client.get(f"/api/studies/{s['id']}").json()["validation"]["metrics"]["label"] == "lab"
    # out-of-range ambient for the property model is refused, then allowed and flagged
    t["boundaries"]["default"]["T_inf"] = 200
    client.put(f"/api/twins/{t['id']}", json=t)
    assert client.post(f"/api/twins/{t['id']}/run").status_code == 400
    t["allow_extrapolation"] = True
    client.put(f"/api/twins/{t['id']}", json=t)
    assert client.post(f"/api/twins/{t['id']}/run").json()["extrapolated"] is True


def test_sweep_and_sensitivity(client):
    t = _twin(client)
    t["study"].update({"type": "sweep", "t_end": 300, "dt": 30, "sweep": {"parameter": "boundary_h", "values": [10, 50]}})
    client.put(f"/api/twins/{t['id']}", json=t)
    s = client.post(f"/api/twins/{t['id']}/run").json()
    rows = s["sweep"]["rows"]
    assert rows[1]["final_centre_C"] > rows[0]["final_centre_C"]  # higher h heats faster
    t["study"]["type"] = "sensitivity"
    client.put(f"/api/twins/{t['id']}", json=t)
    s = client.post(f"/api/twins/{t['id']}/run").json()
    sens = {r["parameter"]: r["normalised_sensitivity"] for r in s["sensitivity"]["rows"]}
    assert sens["volumetric heat capacity ρcp"] < 0 < sens["heat-transfer coefficient h"]


def _approve_hb(material_id="mat-pea-protein-isolate"):
    m = sci_registry.from_template("herschel_bulkley", material_id=material_id, status="approved", conditions={"concentration": 15.0, "temperature": 25.0},
                                   validity={"gamma_dot": [0.1, 100.0]})
    for p in m["parameters"]:
        p["value"] = {"tau0": 18.5, "K": 9.6, "n": 0.48}[p["symbol"]]
    return sci_registry.save(m)


def test_flow_twin_uses_approved_model_and_enforces_validity(client):
    t = _twin(client, geometry_object_id="obj-die", material={"type": "material", "id": "mat-pea-protein-isolate"},
              physics=[{"kind": "flow", "enabled": True}], conditions={"initial_temperature": 25, "concentration": 15})
    r = client.post(f"/api/twins/{t['id']}/run")
    assert r.status_code == 400 and "No approved" in r.json()["detail"]
    _approve_hb()
    t["flow"]["flow_rate_ml_min"] = 20
    client.put(f"/api/twins/{t['id']}", json=t)
    s = client.post(f"/api/twins/{t['id']}/run").json()
    assert s["flow"]["wall_shear_rate_1_s"] <= 100 and s["flow"]["pressure_drop_pa"] > 0
    assert any(p.get("type") == "approved registry model" for p in s["provenance"])
    t["flow"]["flow_rate_ml_min"] = 200  # beyond the validated shear-rate range
    client.put(f"/api/twins/{t['id']}", json=t)
    r = client.post(f"/api/twins/{t['id']}/run")
    assert r.status_code == 400 and "outside the validated shear-rate range" in r.json()["detail"]
    t["flow"]["flow_rate_ml_min"], t["conditions"]["concentration"] = 20, 20  # no model at 20 % w/w
    client.put(f"/api/twins/{t['id']}", json=t)
    r = client.post(f"/api/twins/{t['id']}/run")
    assert r.status_code == 400 and "characterise the material" in r.json()["detail"]
    deps = client.get(f"/api/twins/{t['id']}/dependencies").json()
    assert {"twin", "geo", "mat"} <= {n["id"] for n in deps["nodes"]}


def test_kinetics_coupled_only_with_approved_model(client):
    t = _twin(client, physics=[{"kind": "heat", "enabled": True}, {"kind": "kinetics", "enabled": True}], kinetics={"material_id": "mat-pea-protein-isolate", "initial_native_fraction": 1.0})
    t["study"]["t_end"], t["study"]["dt"] = 600, 20
    client.put(f"/api/twins/{t['id']}", json=t)
    s = client.post(f"/api/twins/{t['id']}/run").json()
    assert "reaction" not in s and any("no approved first-order model" in w for w in s["warnings"])
    m = sci_registry.from_template("first_order_arrhenius", material_id="mat-pea-protein-isolate", status="approved", validity={"T": [273.15, 373.15]})
    for p in m["parameters"]:
        p["value"] = {"k_ref": 2.1e-3, "Ea": 250000.0, "T_ref": 358.15}[p["symbol"]]
    sci_registry.save(m)
    s = client.post(f"/api/twins/{t['id']}/run").json()
    assert 0 < s["reaction"]["mean"] < 1
    assert s["reaction"]["centre"] >= s["reaction"]["mean"] - 1e-9  # the cooler centre denatures least
