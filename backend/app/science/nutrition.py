"""Nutritional mass balance and ingredient cost models.

All composition values are expressed in g per 100 g (i.e. mass %) of the
ingredient "as is". Formulation fractions are mass % that must sum to 100.

Model: linear mass balance. For any additive (conserved) component c,

    c_formulation = sum_i  w_i * c_i

where w_i is the mass fraction of ingredient i. This is exact for mixing
without mass loss (no evaporation, no reaction). Processing losses (e.g.
moisture loss during heating) are NOT included here.

Energy uses the EU Regulation (EU) No 1169/2011, Annex XIV general
conversion factors: protein 4 kcal/g, carbohydrate 4 kcal/g, fat 9 kcal/g,
fibre 2 kcal/g (17, 17, 37, 8 kJ/g).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

NUTRIENT_KEYS = ("protein", "carbohydrate", "fat", "moisture", "fibre", "ash", "sodium")

ATWATER_KCAL = {"protein": 4.0, "carbohydrate": 4.0, "fat": 9.0, "fibre": 2.0}
ATWATER_KJ = {"protein": 17.0, "carbohydrate": 17.0, "fat": 37.0, "fibre": 8.0}

TOLERANCE = 1e-6


@dataclass
class FormulationLine:
    ingredient: dict
    percent: float


@dataclass
class CompositionResult:
    total_percent: float
    composition: dict  # g / 100 g
    energy_kcal_100g: float
    energy_kj_100g: float
    cost_per_kg: float | None
    cost_breakdown: list = field(default_factory=list)
    cost_per_serving: float | None = None
    cost_per_g_protein: float | None = None
    warnings: list = field(default_factory=list)
    missing_data: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def ingredient_energy_kcal(nutrition: dict) -> float:
    """Energy (kcal / 100 g) from proximate composition, EU general factors."""
    return sum((nutrition.get(k) or 0.0) * f for k, f in ATWATER_KCAL.items())


def composition(lines: Iterable[FormulationLine], serving_size_g: float = 30.0) -> CompositionResult:
    lines = list(lines)
    total = sum(l.percent for l in lines)
    comp = {k: 0.0 for k in NUTRIENT_KEYS}
    missing: list[str] = []
    warnings: list[str] = []

    if abs(total - 100.0) > 0.01:
        warnings.append(
            f"Mass fractions sum to {total:.3f} % (must equal 100 %). Results are computed on the "
            "given fractions and are not normalised."
        )

    cost = 0.0
    cost_known = True
    breakdown = []
    for l in lines:
        w = l.percent / 100.0
        nut = l.ingredient.get("nutrition", {}) or {}
        for k in NUTRIENT_KEYS:
            v = nut.get(k)
            if v is None:
                if w > 0 and k != "sodium":
                    missing.append(f"{l.ingredient['name']}: {k} value missing (treated as 0)")
                v = 0.0
            comp[k] += w * v
        price = (l.ingredient.get("economics", {}) or {}).get("price_per_kg")
        if price is None:
            cost_known = False
            missing.append(f"{l.ingredient['name']}: price per kg missing")
            breakdown.append({"ingredient": l.ingredient["name"], "percent": l.percent, "price_per_kg": None, "contribution": None})
        else:
            contrib = w * price
            cost += contrib
            breakdown.append({"ingredient": l.ingredient["name"], "percent": l.percent, "price_per_kg": price, "contribution": contrib})

    kcal = sum(comp[k] * f for k, f in ATWATER_KCAL.items())
    kj = sum(comp[k] * f for k, f in ATWATER_KJ.items())
    cost_per_kg = cost if cost_known else None
    cps = cost_per_kg * serving_size_g / 1000.0 if cost_per_kg is not None else None
    cpgp = None
    if cost_per_kg is not None and comp["protein"] > 0:
        # cost per kg / (g protein per kg)
        cpgp = cost_per_kg / (comp["protein"] * 10.0)
    for b in breakdown:
        if b["contribution"] is not None and cost > 0:
            b["share"] = b["contribution"] / cost
    return CompositionResult(
        total_percent=total,
        composition=comp,
        energy_kcal_100g=kcal,
        energy_kj_100g=kj,
        cost_per_kg=cost_per_kg,
        cost_breakdown=breakdown,
        cost_per_serving=cps,
        cost_per_g_protein=cpgp,
        warnings=warnings,
        missing_data=missing,
    )


def salt_equivalent(sodium_g_100g: float) -> float:
    """Salt equivalent = sodium x 2.5 (Regulation (EU) No 1169/2011, Annex I)."""
    return sodium_g_100g * 2.5
