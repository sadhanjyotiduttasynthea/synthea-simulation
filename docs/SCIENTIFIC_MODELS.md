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

## Digital twin solvers (branch `ali`, `backend/app/twin/`)

All solvers use a uniform square grid of size *h* restricted to the cross-section (staircase boundary; the area error is
reported). Fields are 2-D and uniform along the depth.

| Physics | Equation | Discretisation | Verification |
|---|---|---|---|
| Heat transfer | ρc_p ∂T/∂t = ∇·(k∇T) + Q; BCs: temperature, convection h(T∞−T), flux, insulated | cell-centred FV, implicit Euler, sparse LU | 1-D Fourier series (< 0.1 K); steady energy balance |
| Kinetics (coupled) | dX/dt = −k(T)X, k = k_ref·exp[−Eₐ/R(1/T − 1/T_ref)] | exact exponential update per step | — |
| Duct flow | ∇·(μ(γ̇)∇w) = −G, w = 0 on walls; μ = Kγ̇ⁿ⁻¹ + τ₀(1−e^(−mγ̇))/γ̇ (Papanastasiou, m = 1000 s) | FV with harmonic face viscosity, Picard iteration; secant on G for a prescribed flow rate | Hagen–Poiseuille, power-law and HB pipe flow (≤ 3 %); force balance τ̄_w·P = G·A |
| Solid mechanics | ∇·σ + ρg = 0, σ = D ε(u), plane stress or strain | bilinear Q4 elements (2×2 Gauss), supports fixed / roller, pressure loads | uniaxial compression exact; reaction = applied load |
| Diffusion | ∂c/∂t = ∇·(D∇c) | as heat transfer | — |

Assumptions: constant properties per study (taken at the operating temperature from approved library records), no
phase change or evaporation, laminar fully developed duct flow, small strains. Warnings are issued for T outside
−40…150 °C, unyielded fraction > 50 % (refine mesh), Re_gen > 2100, displacements > 5 % of the body size and stresses
above an approved fracture stress.

## Molecular properties (branch `ali`, `backend/app/molecules.py`)

- Net charge Z(pH) = Σ n_i/(1+10^(pH−pK_i)) − Σ n_j/(1+10^(pK_j−pH)) with the EMBOSS pKa set; pI = root of Z = 0.
- Stokes–Einstein D = k_BT/(6πη(T)R_h); η(T) water, Vogel equation 2.414·10⁻⁵·10^(247.8/(T−140)) Pa·s.
- R_h: small molecules from the vdW volume (sphere); proteins 1.25·0.066·M^(1/3) nm (Erickson 2009) or R_g/0.775 when a
  structure is available. These are estimates for dilute aqueous solution.
- ε280 = 5500·W + 1490·Y + 125·cystine (Pace et al. 1995); GRAVY (Kyte & Doolittle 1982); amino-acid score vs FAO 2013
  (digestibility not included).
- Conformers: RDKit ETKDG v3 + MMFF94. Interaction energy E_int = E_AB − E_A − E_B (MMFF94, vacuum, local minimum).

## Synthea Materials — equation templates, library report and formulation insights

### Recognised equation templates (`backend/app/extraction.py`, `sci_registry.TEMPLATES`)
| Template | Form | Parameters | Typical use in faba bean literature |
|---|---|---|---|
| Power law | τ = K·γ̇ⁿ | K [Pa·sⁿ], n [–] | dispersion / batter flow curves |
| Herschel–Bulkley | τ = τ₀ + K·γ̇ⁿ | τ₀ [Pa], K, n | pastes with a yield stress |
| Arrhenius viscosity | η = A·exp(Eₐ/RT) | A [Pa·s], Eₐ [J/mol] | temperature dependence of viscosity |
| First-order / Arrhenius kinetics | dX/dt = −k(T)X, k = k_ref·exp[−Eₐ/R(1/T − 1/T_ref)] | k_ref [1/s], Eₐ, T_ref [K] | protein denaturation |
| GAB sorption | X = X_m·C·K·a_w / [(1 − K·a_w)(1 − K·a_w + C·K·a_w)] | X_m, C, K [–] | moisture sorption isotherms |
| Fourier conduction | q = −k·dT/dx | k [W/(m·K)] | heat transfer |

Equations are recognised from displayed lines and from sentences naming the model. Parameters are only filled from
the same text (GAB: X_m, C, K stated next to the model name); validity ranges only when stated. Unrecognised
equations keep the low-confidence manual-entry path. Nothing is used in calculations before approval.

### "Summarize all PDFs" (library report, `backend/app/library_report.py`)
* Papers filed in the library, each with up to five verbatim key statements and page numbers.
* Consolidated property table: library records (reviewed/approved) whose source is one of these papers plus extraction
  candidates still awaiting review (labelled), with value, uncertainty, conditions, paper and page.
* Equations and models: registry models citing the papers and pending equation candidates.
* Key numbers: min–max range per (material, property) in canonical units with the number of values and papers — never
  a mean.
* Disagreements: pairs of values for the same material and property whose conditions are comparable (temperature
  ± 5 °C, concentration ± 2 %, pH ± 0.5, shear rate within a factor 2, …) and that differ by more than 25 %; both are
  listed side by side.
* Optional Claude narrative: only from the verbatim statements and table rows; numbers in the narrative that do not
  occur in the records are masked. Exports: JSON and PDF (ReportLab).

### Sensory & technical profile (`backend/app/formulation_insights.py`)
Only APPROVED library records enter the profile. Per attribute (aroma, flavour incl. beany notes, colour, mouthfeel,
expected texture, technical):
* *literature*: an ingredient-level record quoted directly (paper + page), with its share in the formulation;
* *measured*: formulation-level data (e.g. the formulation's Herschel–Bulkley flow curve);
* *calculated*: exact mass balances (composition);
* *predicted*: the concentration of a compound (hexanal) as Σ wᵢcᵢ with propagated SD, assuming no formation or loss;
  a lower bound when some ingredients have no data; heat-set gelation from the denaturation record and the process
  temperature (rule R2);
* *not predicted — needs …* otherwise. Sensory scores, colour (L*a*b*) and texture are not additive and are never
  averaged over ingredients.

### Ingredient interaction rules (documented, qualitative)
Ratings: compatible / caution / incompatible only with a basis; otherwise unknown with the data that is missing.
A reviewed and approved "ingredient interaction" record from a paper (partner material + rating) takes precedence.
Computed Molecules scenes for the two materials are linked as context (vacuum force-field energies are not a
compatibility measure).

| Rule | Mechanism | Data needed | Rating |
|---|---|---|---|
| R1 | protein–polysaccharide electrostatic complexation | formulation pH, protein pI (approved record), polysaccharide charge type (anionic: xanthan, alginate, pectin, carrageenan, CMC, gum arabic; neutral: starch, methylcellulose, guar, locust bean gum; cationic: chitosan) | anionic & pH < pI → caution (complexation/coacervation); anionic & pH > pI → compatible; neutral → compatible (competes for water) |
| R2 | heat-induced unfolding, disulfide cross-linking | approved denaturation temperature, process temperature | T_process ≥ T_d → compatible (gel network); below → caution |
| R3 | Maillard reaction | approved reducing-sugar record, heating | caution (browning, flavour) |
| R4 | protein–lipid emulsification | approved emulsifying activity / emulsion stability | compatible; otherwise unknown |
| R5 | salt effect on protein solubility / gelation | approved solubility at a stated salt concentration | caution (check against the formulation salt level) |

## Synthea Process — sausage line, twin link, technical outputs and Texture Class IDs

### Plant-based sausage line units (`backend/app/process.py`)
| Unit | Model | Inputs that are not predicted |
|---|---|---|
| Hydration tank, emulsifier / bowl chopper, mixer | τ = V/Q; shaft power fully dissipated: ΔT = P/(ṁ·cp) (adiabatic upper bound) | degree of hydration, droplet size, fat/water binding (flagged *not predicted*) |
| Heater, cooking (water bath / steam) | Q = ṁ·cp·ΔT (Choi–Okos cp), energy = Q/η; cooking: product brought to the set medium temperature | cooking loss — only from a measured / literature / illustrative input with that label; otherwise yield is *not computed* |
| High-moisture extruder (cooling die) | extruder energy balance (SME input, barrel heating) + cooling-die duty Q = ṁ·cp·(T_barrel − T_die) | fibre formation / anisotropy (flagged) |
| Stuffer / casing | pump power ΔP·Q/η + drive power; sausages per hour = ṁ / portion | stuffing pressure (input); casing mass not in the balance |
| Cooler / chiller | Q = ṁ·cp·ΔT, electrical power = Q/COP | — |

The default unit settings are illustrative design inputs. Chopper and hydration powers are set so that the adiabatic
temperature rise stays in the range of chilled batter practice; replace them with plant data.

### Digital Twin study from a heating unit
"Open Digital Twin study" on a heater, cooker or extruder creates a 2-D heat-transfer twin of the product cross-section
(circle of the unit's caliber): thermal properties by Choi & Okos from the *formulation* composition (labelled
calculated), denaturation kinetics from the approved first-order model of the main protein (if one exists), initial
temperature = unit inlet temperature, convective boundary at the medium temperature with an ILLUSTRATIVE heat-transfer
coefficient (300 W/(m²·K), water bath — replace with a measured value), end time = hold time, target = the unit's core
temperature target. After the study is computed, the next process simulation reads the latest study back into the
unit: core and slowest-point temperature at the end of the hold time, time until every point reaches the target, and
mean remaining native protein (labelled calculated, with the study id).

### Technical outputs
Throughput, sausages per hour, product moisture (mass balance), cooking loss (input, with its label), yield (product /
feed; *not computed* without a cooking-loss value), specific energy and the twin results — each with provenance and basis.
Runs can be saved and compared side by side; one run is marked as the *optimized product* and is read by Synthea Print.

### Texture Class IDs (`backend/app/texture.py`)
Classes are a platform CONVENTION with ILLUSTRATIVE ranges (stored in the settings, editable via `PUT /api/texture/classes`);
they must be calibrated with reference products measured by the same protocol.

Protocol: TPA double compression to 50 % strain, cylindrical sample Ø 20 mm × 20 mm cut from the cooked product,
crosshead 1 mm/s, 5 s between cycles, 20 °C. Gumminess = hardness × cohesiveness; chewiness = gumminess × springiness.

| Class | Description | Hardness [N] (defines the class) | Typical springiness [–] | Typical cohesiveness [–] | Typical resilience [–] |
|---|---|---|---|---|---|
| TX-01 | soft paste | 0 – 5 | 0 – 0.5 | 0 – 0.4 | – |
| TX-02 | soft gel | 5 – 15 | 0.4 – 0.8 | 0.3 – 0.6 | – |
| TX-03 | tender, sliceable | 15 – 30 | 0.6 – 0.9 | 0.4 – 0.7 | – |
| TX-04 | firm, sausage-like | 30 – 50 | 0.7 – 0.95 | 0.45 – 0.8 | 0.2 – 0.5 |
| TX-05 | firm, fibrous, meat-like | ≥ 50 | 0.8 – 1.0 | 0.5 – 0.85 | 0.25 – 0.6 |

Hardness bands are contiguous; the secondary parameters are reported as typical / atypical but do not change the class.
Fibrousness (anisotropy) is not part of TPA and is not assessed by the class.

Assignment (first available source wins):
1. **Measured** — project experiments of type *measured* with the same composition (each ingredient within ±0.5 %):
   mean hardness of the replicates, band = mean ± 2 SD.
2. **Library records** — approved TPA records (hardness, springiness, …) of the product material linked to the
   formulation: band = value ± 2 × reported SD.
3. **Predicted** — Gaussian-process surrogate of hardness trained on recorded experiments (≥ 6): 95 % band
   (log-space for log-transformed responses), LOO Q² and extrapolation distance reported; synthetic training data flagged.

The class is every class whose hardness band intersects the uncertainty band: one class, or a range such as
"TX-03 to TX-04". With no data: "unclassified — needs texture data". Ingredient-level texture data are never averaged
into a product class.

## Synthea Print — geometry, slicing, extrusion methods, manufacturability and exports

### Geometry and slicing (`backend/app/geometry3d.py`)
Prototype geometry is drawn in the Geometry editor (sketches extruded in z: rectangle, circle, ring, polygon; primitives:
box, cylinder, cone/frustum, sphere) or imported as STL (ASCII or binary; placed on the bed and centred). Every object
is a closed triangle mesh (mm, z up). The toolpath generator slices the meshes at mid-layer heights (triangle–plane
intersection, segments chained into loops, outer/hole classification by even-odd nesting), so any shape — not only the
built-in prisms — is printed with perimeters and ±45° infill. Objects are not merged by boolean union: overlapping
objects are reported.

### Extrusion methods (`printing.extrusion`)
Required bead flow Q = w·h·v (rectangular bead).
* **Piston / syringe**: ram speed v = Q/A_barrel; ram displacement = deposited volume / A_barrel; refills from the barrel
  capacity; ram force = Δp_nozzle·A_barrel (barrel friction and contraction losses not included). G-code E = plunger mm.
* **Screw / auger**: positive-displacement conveying Q = f·(π/4)(D² − (D − 2h)²)·pitch·N (fill fraction f, channel depth
  h; leakage and pressure back-flow not modelled); required speed N compared with the maximum. G-code E = revolutions.
* Both use the Herschel–Bulkley capillary pressure drop in the nozzle; without τ₀, K, n the pressure is *not computed*.

### Prototype Manufacturability Score (`printing.manufacturability`)
A rule-based **compatibility index — not a success probability** (printing success probability is not predicted).
Five named checks with visible weights; each reports inputs, threshold, value, margin, status and provenance:

| Check | Weight | Value | Pass condition (default limit, editable; default limits are illustrative) | Data needed |
|---|---|---|---|---|
| Nozzle pressure vs printer limit | 25 | HB capillary Δp [kPa] | Δp ≤ p_max (600 kPa) | τ₀, K, n of the formulation |
| Yield stress vs hydrostatic load at the base | 25 | τ₀ / (ρ·g·H) | ≥ safety factor (1.0) | τ₀ and density |
| Overhang angle vs limit | 20 | max over layers of atan(d/h) | ≤ 45° from vertical | sliced geometry |
| Minimum feature size vs nozzle | 15 | % of a layer's area removed by a morphological opening with a disc of the nozzle diameter | ≤ 5 % | sliced geometry |
| Print time and layer count vs limits | 15 | time [min], layers | ≤ 60 min and ≤ 200 layers | toolpath |

Overhang: layers are rasterised on a common grid (cell = min(nozzle/4, extent/250)); d is the largest Euclidean distance
of a layer's material from the material of the layer below; floating layers count as 90°.

Margin m: (limit − value)/limit for upper limits, value/limit − 1 for lower limits. Status: pass (m ≥ 10 %), marginal
(0 ≤ m < 10 %), fail (m < 0), with sᵢ = 1, 0.5, 0. A check without data is *not evaluated* and excluded:

  score = 100 · Σ wᵢ·sᵢ / Σ wᵢ (over evaluated checks), shown as "based on N of 5 checks".

The limiting check is the one with the lowest sᵢ (then the smallest margin); the interface shows how to improve it.

### Exports
* **STL** (binary) of the visible geometry objects.
* **G-code** from the generated toolpath: G21/G90/M83, G0 travel and G1 moves with relative E per segment
  (piston: plunger mm = segment length × bead area / A_barrel; screw: revolutions = segment volume / displacement per rev),
  header comments with method, layers, time, the manufacturability index and its label. Validate on the printer.
