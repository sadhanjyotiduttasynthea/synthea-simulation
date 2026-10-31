# Scientific models in Synthea Simulation

All models are implemented in `backend/app/` and listed live in **Settings → Scientific model library**. Validation
levels: **exact** (conservation law, exact when its assumptions hold), **literature** (published model, not validated
here for these specific formulations), **simplified** (order-of-magnitude engineering estimate), **user** (user-defined,
unvalidated).

## 1. Nutritional mass balance — *exact*
`c_mix = Σ wᵢ · cᵢ` for every conserved component (protein, fat, carbohydrate, moisture, fibre, ash, sodium), with
mass fractions `wᵢ` summing to 1. It assumes no mass loss or reaction during mixing. Processing losses are handled
separately (extruder flash-off in the process simulator).

Salt equivalent = sodium × 2.5 (Regulation (EU) No 1169/2011, Annex I).

## 2. Energy — *literature*
`E [kcal/100 g] = 4·protein + 4·carbohydrate + 9·fat + 2·fibre` (kJ: 17, 17, 37, 8), the general factors of
Regulation (EU) No 1169/2011, Annex XIV.

## 3. Ingredient cost — *exact*
`cost [€/kg] = Σ wᵢ · priceᵢ`; cost per serving = cost × serving mass; cost per g protein = cost / (10 · protein %).
This is raw-material cost only.

## 4. Thermophysical properties — Choi & Okos (1986) — *literature*
Each pure component (water, protein, fat, carbohydrate, fibre, ash) has polynomial ρ(T), cp(T) and k(T) for
T in °C. Mixing rules: `cp = Σ xᵢ cpᵢ`, `1/ρ = Σ xᵢ/ρᵢ`, `k = Σ vᵢ kᵢ` (volume fractions, parallel model).
The model is valid from 0 to 150 °C for unfrozen products and does not account for porosity or air inclusion. Note
that the published water-density polynomial gives ≈ 995 kg/m³ at 25 °C, versus 997 kg/m³ for pure water.

## 5. Herschel–Bulkley rheology and tube flow — *literature*
Constitutive law: `τ = τ₀ + K·γ̇ⁿ` for τ > τ₀. For steady, laminar, isothermal, fully developed flow without wall slip,
the Rabinowitsch–Mooney relation

`Q = (π R³ / τ_w³) ∫_{τ₀}^{τ_w} τ² γ̇(τ) dτ`, `ΔP = 2 τ_w L / R`

is inverted numerically (Brent's method) for τ_w. Tests verify the Newtonian (Hagen–Poiseuille), power-law
(analytic) and Bingham (Buckingham–Reiner) limits. A Metzner–Reed Reynolds number is reported as a laminar-flow
indicator. Entrance losses, slip, thixotropy, viscoelasticity and viscous heating are **not** modelled. Inputs must be
measured flow-curve parameters for the formulation at the process temperature; they are never derived from
ingredient data.

Newtonian pipe flow uses Hagen–Poiseuille below Re = 2100 and the Blasius correlation above 4000, with a warning in
the transition region.

## 6. Process units (flowsheet) — *exact / simplified*
| Unit | Model |
|---|---|
| Storage | Source stream: mass flow, temperature, formulation composition |
| Mixer | τ = V·fill/Q_v; power dissipated as heat (adiabatic upper bound ΔT = P/(ṁ cp)) |
| Heater | Q = ṁ·cp(T̄)·ΔT; input = Q/η |
| Cooler | Q = ṁ·cp(T̄)·ΔT; electricity = Q/COP |
| Pump | P = ΔP·Q_v/η |
| Pipe | τ = V/Q_v; ΔP from HB tube flow when rheology is supplied, otherwise flagged unsupported |
| Extruder | Mechanical power = SME × ṁ (SME is a user input); sensible heat to barrel temperature; τ = V_free/Q_v; moisture flash-off (user input) with latent heat 2257 kJ/kg; die ΔP only with rheology |
| Conveyor / packaging | Residence time L/v, fixed power, packs per hour |

The solver processes units in topological order, mixes inlets adiabatically, splits outlets equally and checks the
mass balance. Cycles are rejected. Operating cost = electricity × price + raw-material cost. It excludes labour,
maintenance, depreciation, utilities other than electricity, and packaging materials.

## 7. Optimisation
* **LP** (HiGHS via `scipy.optimize.linprog`): variables are ingredient mass %, Σ = 100. Constraints cover ingredient
  bounds, nutrient min/max (linear in w), maximum cost, availability and allergen exclusion. Objectives are minimum
  cost or maximum protein (lexicographic tie-break by cost).
* **Pareto front**: ε-constraint method. Minimum cost is computed at each protein level between the attainable
  minimum and maximum. The *balanced* candidate is the knee (maximum distance from the chord between extremes), or
  the protein midpoint if there is no distinct knee.
* **Sensitivities**: LP dual values converted to the change of the optimum per unit change of each binding limit.
  They are valid locally.
* **Infeasibility**: an elastic LP minimises weighted slack on every constraint to report the minimum relaxation. It
  also adds single-constraint suggestions (lowest attainable cost, highest attainable nutrient) and checks bound sums.
* **Uncertainty**: Monte Carlo with *illustrative, user-editable* relative uncertainty on ingredient protein contents
  and prices. It reports 90 % intervals and the probability of meeting the protein and cost constraints.
* **Processing compatibility**: minimise cost subject to all linear constraints plus a GP-predicted response inside a
  target window (SLSQP, multi-start from LP vertices and their convex combinations). It reports prediction, ±1σ band,
  LOO Q² and distance to the nearest experiment, and refuses to run with fewer than 6 data points.

## 8. Experimental design and active learning
* **DoE** (fewer than 6 responses): a scrambled Sobol candidate pool over the bounded mixture region (the filler
  ingredient takes the remainder; infeasible points are rejected), followed by greedy maximin selection that also
  maximises distance to experiments already run.
* **Active learning**: GP regression (constant × Matern 5/2 with ARD + white noise, normalised targets, log transform
  for viscosity). Acquisition is either predictive standard deviation, or probability of getting closer to a target
  value. Batches use the kriging-believer heuristic. LOO Q² and a parity plot are shown.
* **Synthetic demo data** come from an arbitrary smooth function plus noise. They are labelled `synthetic_demo`
  everywhere and carry **no physical meaning**.

## 9. Experimental cost scenario — *exact arithmetic on illustrative inputs*
Conventional cost = N_conv × c; planned cost = N_plan × c; gross avoided = difference; net = gross − software &
modelling cost; reduction % = 1 − N_plan/N_conv; material saved = (N_conv − N_plan) × kg per experiment;
break-even = software cost / c.

## 10. 3D-printing toolpath
For each layer: inset perimeters (miter offset of the outline by half a line width; exact for convex shapes),
followed by rectilinear infill at the requested density with alternating ±45° direction, generated by scan-line
intersection with the even-odd rule (which supports holes, e.g. rings). Print time = extrusion length / print speed
+ travel / travel speed. Bead volume = length × line width × layer height (rectangular bead). Mass = volume ×
Choi–Okos density at the extrusion temperature. Required flow Q = w·h·v; a set flow differing by more than 10 % is
flagged. Nozzle ΔP, wall shear rate and the τ₀ / (ρ g H) self-weight ratio are computed only from measured HB
parameters, and the ratio is a screening indicator only. Acceleration, retraction, die swell, sagging and printing
success are not modelled.

## 11. Safe custom equations
User equations are parsed with Python's `ast` module and evaluated by a whitelist interpreter. It allows numbers,
variables, + − × ÷ ** %, unary ±, `sqrt exp log log10 sin cos tan tanh abs min max pow`, and the constants `pi` and
`e`. Attribute access, subscripts, comprehensions, lambdas and other calls are rejected, and large exponents and
overflow are guarded.
