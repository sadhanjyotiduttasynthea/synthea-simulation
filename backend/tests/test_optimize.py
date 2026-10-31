import numpy as np
import pytest

from app import experiments, optimize, printing, process, seed

INGS = seed.ingredients()
PROJ = seed.demo_project()


def demo_req(**kw):
    r = {"min_protein": 15.0, "max_cost": 2.20, "bounds": PROJ["optimizer"]["bounds"],
         "nutrient_limits": PROJ["optimizer"]["nutrient_limits"], "baseline": seed.BASELINE, "serving_size_g": 30}
    r.update(kw)
    return r


def test_demo_three_candidates_feasible():
    out = optimize.optimise(INGS, demo_req())
    assert out["status"] == "optimal"
    labels = [c["label"] for c in out["candidates"]]
    assert labels == ["Lowest cost", "Balanced (Pareto)", "Highest protein"]
    for c in out["candidates"]:
        assert c["all_satisfied"]
        assert sum(f["percent"] for f in c["formulation"]) == pytest.approx(100, abs=1e-6)
        assert c["composition"]["protein"] >= 15 - 1e-6
        assert c["cost_per_kg"] <= 2.20 + 1e-6
    lc, bal, hp = out["candidates"]
    assert lc["cost_per_kg"] <= bal["cost_per_kg"] <= hp["cost_per_kg"]
    assert lc["composition"]["protein"] <= bal["composition"]["protein"] <= hp["composition"]["protein"]
    # lowest cost hits protein minimum exactly (protein is the costly component)
    assert lc["composition"]["protein"] == pytest.approx(15.0, abs=1e-6)
    # highest protein is limited by budget
    assert hp["cost_per_kg"] == pytest.approx(2.20, abs=1e-6)
    assert len(out["pareto"]) > 5


def test_lp_matches_brute_force_grid():
    """Cross-check LP optimum against a coarse random search: no sample beats the LP."""
    out = optimize.optimise(INGS, demo_req(mode="lowest_cost"))
    best = out["candidates"][0]["cost_per_kg"]
    prob = optimize.build_problem(INGS, demo_req())
    cands = experiments.candidate_set(prob.ids, PROJ["optimizer"]["bounds"], n=4096)
    A, b = prob.A, prob.b
    feas = cands[np.all(cands @ A.T <= b + 1e-9, axis=1)]
    assert len(feas) > 0
    assert (feas @ prob.price / 100).min() >= best - 1e-9


def test_infeasible_diagnosis():
    out = optimize.optimise(INGS, demo_req(min_protein=40.0, max_cost=1.0))
    assert out["status"] == "infeasible"
    inf = out["infeasibility"]
    assert inf["relaxations"]
    assert any("cost" in s.lower() or "protein" in s.lower() for s in inf["suggestions"])


def test_allergen_exclusion():
    out = optimize.optimise(INGS, demo_req(excluded_allergens=["pea"]))
    assert any(e["id"] == "pea-protein-isolate" for e in out["excluded"])
    assert out["status"] == "infeasible"  # no other protein source can reach 15 %


def test_processing_requires_data_then_works():
    req = demo_req(mode="processing", processing={"response": "viscosity_pa_s", "lower": 50, "upper": 200})
    out = optimize.optimise(INGS, req, [])
    c = out["candidates"][0]
    assert c["status"] == "insufficient_data"
    ids = list(PROJ["optimizer"]["bounds"].keys())
    syn = experiments.synthetic_dataset(ids, PROJ["optimizer"]["bounds"], 14)
    out = optimize.optimise(INGS, req, syn)
    c = out["candidates"][0]
    assert c["status"] in ("optimal", "window_not_reached")
    assert any("SYNTHETIC" in w for w in c["model_warnings"])
    if c["status"] == "optimal":
        assert 50 - 1e-3 <= c["prediction"]["value"] <= 200 + 1e-3


def test_doe_then_active_learning():
    ids = list(PROJ["optimizer"]["bounds"].keys())
    names = {i["id"]: i["name"] for i in INGS}
    r = experiments.recommend(ids, names, PROJ["optimizer"]["bounds"], [], "viscosity_pa_s", 5)
    assert r["phase"] == "design_of_experiments" and len(r["recommendations"]) == 5
    for rec in r["recommendations"]:
        assert sum(rec["composition"].values()) == pytest.approx(100, abs=0.01)
    syn = experiments.synthetic_dataset(ids, PROJ["optimizer"]["bounds"], 12)
    r = experiments.recommend(ids, names, PROJ["optimizer"]["bounds"], syn, "viscosity_pa_s", 4)
    assert r["phase"] == "active_learning" and len(r["recommendations"]) == 4
    assert "q2" in r["cv"]


def test_cost_scenario_defaults():
    r = experiments.cost_scenario({"conventional_experiments": 200, "planned_experiments": 60, "cost_per_experiment": 170, "material_per_experiment_kg": 2, "software_modelling_cost": 5000})
    assert r["conventional_cost"] == 34000
    assert r["planned_cost"] == 10200
    assert r["gross_avoided"] == 23800
    assert r["net_savings"] == 18800
    assert r["experiment_reduction_pct"] == pytest.approx(70)
    assert r["material_saved_kg"] == 280


def test_process_demo_mass_energy_balance():
    flow = seed.demo_process_flow()
    from app.science import nutrition
    comp = nutrition.composition([nutrition.FormulationLine({i["id"]: i for i in INGS}[k], v) for k, v in seed.BASELINE.items()]).composition
    r = process.simulate(flow, comp, 1.45, 0.2)
    s = r["summary"]
    assert s["feed_kg_h"] == 120
    assert abs(s["mass_balance_error_kg_h"]) < 1e-9
    assert s["product_kg_h"] == pytest.approx(120 - s["evaporated_kg_h"])
    assert s["evaporated_kg_h"] == pytest.approx(0.08 * 120)
    heater = next(u for u in r["units"] if u["kind"] == "heater")
    o = heater["outputs"]
    assert o["heat_duty_kw"] == pytest.approx(120 / 3600 * o["specific_heat_kj_kgk"] * (60 - o["inlet_temperature_c"]), rel=0.02)
    assert any(u["unsupported"] for u in r["units"])  # no rheology -> pressure unsupported


def test_process_with_rheology_and_cycle_error():
    flow = seed.demo_process_flow()
    flow["nodes"].append({"id": "p", "data": {"kind": "pipe", "label": "Pipe", "params": {"length_m": 3, "diameter_mm": 25}}})
    flow["edges"] = [e for e in flow["edges"] if e["target"] != "n4"] + [{"source": "n3", "target": "p"}, {"source": "p", "target": "n4"}]
    r = process.simulate(flow, {"moisture": 50, "protein": 16, "carbohydrate": 21, "fat": 9, "ash": 2, "fibre": 1}, 1.4, 0.2,
                         {"yield_stress_pa": 40, "consistency_index_pa_sn": 25, "flow_behaviour_index": 0.45})
    pipe = next(u for u in r["units"] if u["kind"] == "pipe")
    assert pipe["outputs"]["pressure_drop_bar"] > 0
    flow["edges"].append({"source": "n8", "target": "n1"})
    with pytest.raises(ValueError):
        process.simulate(flow, {"moisture": 100}, 1, 0.2)


@pytest.mark.parametrize("shape", ["cube", "cylinder", "ring", "hexagon", "star", "pyramid"])
def test_toolpath_shapes(shape):
    g = {"width": 30, "depth": 20, "diameter": 30, "inner_diameter": 12, "height": 6}
    r = printing.generate({"shape": shape, "geometry": g, "nozzle_diameter_mm": 1.2, "layer_height_mm": 1.0, "print_speed_mm_s": 20, "infill_pct": 50, "density_kg_m3": 1150})
    assert r["layer_count"] == 6
    assert r["extrusion_length_mm"] > 0
    pts = np.array(r["path"])
    assert pts[:, 2].max() == pytest.approx(6.0)
    assert r["print_time_s"] == pytest.approx(r["extrusion_length_mm"] / 20 + r["travel_length_mm"] / 60)
    assert r["material_mass_g"] == pytest.approx(r["deposited_volume_cm3"] * 1.15)
    # path stays within the footprint
    assert np.abs(pts[:, 0]).max() <= 15 + 1e-6


def test_toolpath_cube_extrusion_length_reasonable():
    # 100 % infill: extruded area per layer ~ footprint area, so L*w ~ A
    r = printing.generate({"shape": "cube", "geometry": {"width": 40, "depth": 40, "height": 1}, "nozzle_diameter_mm": 1.0, "line_width_mm": 1.0, "layer_height_mm": 1.0, "infill_pct": 100, "perimeters": 1})
    area = r["extrusion_length_mm"] * 1.0
    assert 0.85 * 1600 < area < 1.1 * 1600


def test_nozzle_pressure_with_rheology():
    r = printing.generate({"shape": "cylinder", "geometry": {"diameter": 20, "height": 3}, "nozzle_diameter_mm": 1.5, "layer_height_mm": 1.0,
                           "rheology": {"yield_stress_pa": 100, "consistency_index_pa_sn": 50, "flow_behaviour_index": 0.4}, "density_kg_m3": 1100})
    assert r["nozzle"]["pressure_drop_kpa"] > 0
