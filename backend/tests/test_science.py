import math

import pytest

from app import seed
from app.science import expression, nutrition, registry, rheology, thermal

ING = {i["id"]: i for i in seed.ingredients()}


def lines(d):
    return [nutrition.FormulationLine(ING[k], v) for k, v in d.items()]


def test_baseline_mass_balance_and_cost():
    r = nutrition.composition(lines(seed.BASELINE), 30)
    # protein = 0.20*80 + 0.25*0.1 + 0.005*1.0
    assert r.composition["protein"] == pytest.approx(16.03, abs=1e-9)
    assert r.composition["fat"] == pytest.approx(0.2 * 6 + 0.25 * 0.1 + 0.08 * 100, abs=1e-9)
    expected_cost = 0.2 * 4.8 + 0.45 * 0.003 + 0.25 * 1.1 + 0.08 * 1.7 + 0.005 * 14 + 0.015 * 0.35
    assert r.cost_per_kg == pytest.approx(expected_cost)
    assert r.cost_per_serving == pytest.approx(expected_cost * 0.03)
    assert r.cost_per_g_protein == pytest.approx(expected_cost / 160.3)
    assert r.total_percent == pytest.approx(100)
    assert not r.warnings
    c = r.composition
    assert r.energy_kcal_100g == pytest.approx(4 * c["protein"] + 4 * c["carbohydrate"] + 9 * c["fat"] + 2 * c["fibre"])


def test_sum_warning():
    r = nutrition.composition(lines({"water": 50, "salt": 10}))
    assert r.warnings and "60" in r.warnings[0]


def test_missing_price_reported():
    ing = dict(ING["water"])
    ing["economics"] = {"price_per_kg": None}
    r = nutrition.composition([nutrition.FormulationLine(ing, 100)])
    assert r.cost_per_kg is None
    assert any("price" in m for m in r.missing_data)


def test_choi_okos_water():
    p = thermal.properties({"moisture": 100}, 25)
    # Choi-Okos water fit gives ~995 kg/m3 at 25 degC (true value 997): within 0.5 %
    assert p["density_kg_m3"] == pytest.approx(997.0, rel=5e-3)
    assert p["specific_heat_kj_kgk"] == pytest.approx(4.18, abs=0.01)
    assert p["conductivity_w_mk"] == pytest.approx(0.61, abs=0.01)


def test_choi_okos_mixture_between_components():
    p = thermal.properties({"moisture": 50, "protein": 50}, 25)
    pw = thermal.properties({"moisture": 100}, 25)
    pp = thermal.properties({"protein": 100}, 25)
    assert pp["specific_heat_kj_kgk"] < p["specific_heat_kj_kgk"] < pw["specific_heat_kj_kgk"]
    assert p["specific_heat_kj_kgk"] == pytest.approx((pp["specific_heat_kj_kgk"] + pw["specific_heat_kj_kgk"]) / 2)


def test_hb_newtonian_limit_matches_hagen_poiseuille():
    mu, D, L, Q = 0.5, 0.02, 2.0, 1e-4
    r = rheology.pipe_flow(Q, D, L, 0.0, mu, 1.0)
    hp = 128 * mu * L * Q / (math.pi * D ** 4)
    assert r["pressure_drop_pa"] == pytest.approx(hp, rel=1e-6)


def test_power_law_analytic():
    K, n, D, L, Q = 10.0, 0.5, 0.01, 1.0, 2e-6
    R = D / 2
    r = rheology.pipe_flow(Q, D, L, 0.0, K, n)
    # analytic: tau_w = K * ((3n+1)/(4n) * 4Q/(pi R^3))^n
    gw = (3 * n + 1) / (4 * n) * 4 * Q / (math.pi * R ** 3)
    assert r["wall_shear_stress_pa"] == pytest.approx(K * gw ** n, rel=1e-6)


def test_buckingham_reiner_bingham():
    ty, mu, D, L, Q = 20.0, 1.0, 0.02, 1.0, 5e-5
    r = rheology.pipe_flow(Q, D, L, ty, mu, 1.0)
    tw = r["wall_shear_stress_pa"]
    R = D / 2
    phi = ty / tw
    q_br = math.pi * R ** 3 * tw / (4 * mu) * (1 - 4 / 3 * phi + phi ** 4 / 3)
    assert q_br == pytest.approx(Q, rel=1e-6)
    assert r["plug_radius_m"] == pytest.approx(R * phi)


def test_expression_safe():
    assert expression.evaluate("2*x + sqrt(y)", {"x": 3, "y": 16}) == 10
    assert expression.variables_in("a*b + pi") == ["a", "b"]
    for bad in ["__import__('os')", "x.__class__", "[1,2]", "lambda: 1", "open('f')", "9**9**9"]:
        with pytest.raises(expression.ExpressionError):
            expression.evaluate(bad, {"x": 1})
    with pytest.raises(expression.ExpressionError):
        expression.evaluate("1/0", {})


def test_registry_compute():
    r = registry.compute("heat_balance", {"mass_flow_kg_h": 3600, "cp_kj_kgk": 4.0, "t_in_c": 20, "t_out_c": 30, "efficiency": 1.0})
    assert r["heat_duty_kw"] == pytest.approx(40.0)
    r = registry.compute("residence_time", {"volume_l": 100, "fill_fraction": 0.5, "mass_flow_kg_h": 3600, "density_kg_m3": 1000})
    assert r["mean_residence_time_s"] == pytest.approx(50.0)
    assert all("validation" in m for m in registry.list_models())
