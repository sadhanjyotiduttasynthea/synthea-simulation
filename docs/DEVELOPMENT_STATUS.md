# Synthea Simulation — Development Status

Branch: `development`

## Phase 2 — Desktop scientific workstation (in progress)

| Milestone | Status |
|---|---|
| R1 Desktop & interface architecture | done — Tauri 2 shell, ribbon, model builder, graphics window, settings, messages |
| R2 Global scientific library manager | done |
| R3 Research-paper PDF ingestion | done |
| R4 AI scientific extraction & review | done |
| R5 Scientific model registry | done |
| R6 Geometry editor | done |
| R7 Molecular visualization | done |
| R8 Digital twin, solvers, results | done |
| R9 Desktop packaging & final integration | planned |

### R1 — Desktop & interface architecture
- COMSOL-inspired workspace: top ribbon (File, Home, Materials, Geometry, Physics, Mesh, Study, Results, AI Assistant)
  with context tools; Model Builder tree (expand/collapse, right-click actions, live counts); central view area;
  Settings inspector (pages publish their settings into it); bottom panel (Results, Plots, Equations with KaTeX,
  Solver Log, Warnings, AI Assistant, Experimental Data). Panels are resizable, hideable (Ctrl+1/2/3), layout persisted.
- Reusable engineering graphics window (Three.js/R3F): perspective/orthographic, orbit/pan/zoom, camera presets,
  fit-to-view, grid/axes, solid/wireframe/transparent, section plane, two-point measurement, view gizmo.
- Command bus shared by ribbon, native menus and shortcuts (F5 compute, Ctrl+S/Shift+S/O).
- Global definitions: ordered project parameters with the safe parser + CODATA constants.
- Tauri 2 desktop shell (`desktop/`): native menus, file dialogs (dialog/fs plugins), compute engine started as a
  sidecar on 127.0.0.1 with a random port and per-session token (requests without token → 401), engine stopped on
  exit, per-user data folder. PyInstaller sidecar build script; Windows installer workflow (NSIS/MSI) on
  `windows-latest`. Linux debug build compiled and run under Xvfb in the build session (screenshot in
  `docs/screenshots/desktop-workspace.png`).
### R2 — Global scientific library manager
- Multiple global libraries (8 starter libraries) with folders, rename, archive, export/import (`synthea-library/1`);
  a material is one global record placed in several libraries (no duplication on import — existing records are linked).
- Material records: category, synonyms, tags, identity/processing history, versions (new version copies records and
  keeps sources), change history; search across libraries (names, synonyms, tags, property names) and tag filter.
- Condition-aware property records: value / range / text, unit + automatic normalisation (pint; dimensional errors
  reported), uncertainty and n, experimental conditions, method, sample composition, source (paper, page, passage,
  table), evidence type (direct, calculated, fitted, author prediction, AI-inferred, manual, illustrative), review status
  (extracted → reviewed → approved; rejected/deprecated), quality indicator with flags, full version history; approved
  records are deprecated rather than deleted.
- Compare across sources: plot vs any condition with error bars, side-by-side table, automatic conflict warnings for
  comparable conditions (>25 % difference) — never averaged.
- Data migration: existing ingredient-table data migrated into library materials/records with provenance preserved;
  idempotent; renormalisation pass when the unit catalogue changes.
- Overview page redesigned around the knowledge → simulation pipeline (cost KPIs removed from the overview).
- Tests: +5 backend tests (units, migration idempotence, coexistence/conflicts, history/deprecation, export/import).

### R8 — Digital twins, numerical solvers and results
- Digital twin = geometry object + material (formulation → Choi & Okos T-dependent properties, or library material →
  approved records) + physics + initial/boundary conditions + process parameters + mesh + study + results +
  experimental validation; dependency/provenance graph (papers → records/models → material → twin → study → results →
  validation).
- Finite-volume solvers (implicit backward Euler; sparse LU or Jacobi-PCG): 3-D hexahedral (cuboid), axisymmetric r–z
  (cylinder), spherical shells; heat conduction with convection / fixed-T / insulated boundaries per face; mass diffusion
  (Dirichlet or mass-transfer coefficient); first-order kinetics integrated cell-wise on the temperature history (approved
  model only); fully developed laminar Herschel–Bulkley channel flow (velocity, shear rate, viscosity, pressure fields).
- Verification: centre temperature vs exact plane-wall series solution (< 0.2 % error), energy balance closes to
  round-off, Newtonian-limit ΔP and parabolic profile, numerical flow-rate check.
- Validity enforcement: refusal outside property-model temperature range, model shear-rate range, or when no model exists
  for the requested concentration/temperature ("characterise the material experimentally") unless extrapolation is
  explicitly allowed per twin — then results are flagged.
- Mesh section: automatic/target cell size, cell counts, min/max size, aspect ratio, quality grade, grid preview.
- Studies: time-dependent, stationary, parametric sweep (h, ambient T, initial T, time), one-at-a-time sensitivity
  (normalised coefficients); solver progress/log to the Solver Log tab, warnings to the Warnings tab.
- Results: animated 2-D field maps with contours and colour bar (mid-planes / r–z section), computed field rendered on a
  section plane inside the 3-D geometry, probe histories and volume mean, radial profiles, flow profiles and section
  fields, sweep and sensitivity charts, reaction-progress map, experimental comparison (RMSE, bias, MAE, R², residuals),
  CSV/JSON export, provenance table.
- Not claimed: no general 3-D FEM/CFD, no free-surface or developing flow, no coupled heat–flow (viscous heating).
- Tests: +6 (analytic verification, HB channel limits, formulation heat twin + comparison + extrapolation policy, sweep and
  sensitivity signs, flow twin approved-model/validity/condition guards, kinetics coupling).

### R7 — Molecular visualization
- Own R3F molecular viewer (instanced atoms/bonds; CPK colours, Bondi vdW radii): ball-and-stick, sticks, space-filling,
  atom labels, rotation/zoom, auto-rotate; handles tens of thousands of atoms. (Mol* was considered; a lighter viewer was
  chosen for bundle size and integration with the workspace.)
- Built-in molecules (water, sugars, maltose, glycerol, fatty acids, amino acids, a dipeptide) as RDKit ETKDGv3 + MMFF94
  conformers, labelled *computed, not experimental*; exact formula/molar mass and labelled descriptor estimates
  (TPSA, Crippen logP, H-bond donors/acceptors).
- User structures: PDB, SDF/MOL, XYZ (connectivity perception) — e.g. experimentally determined protein structures.
- Interaction scenes, each labelled: water H-bond network (tetrahedral, O···O 2.76 Å), amino-acid hydration (first-shell
  waters at polar atoms), starch gelatinisation order/disorder, emulsion droplet schematic — all *conceptual*; protein
  aggregation becomes *model-driven* only when an approved first-order denaturation model exists for the material
  (X = 1 − exp(−k(T)t)); emulsion physics evaluates Laplace pressure and Stokes velocity from inputs.
- Synchronised equation panel (bottom Equations tab) for each view.
- Tests: +6 (water geometry, exact mass, H-bond geometry, file parsing, emulsion relations, approved-model switch).

### R6 — Geometry editor
- One geometry document per project (saved with the project and in `.synthea` files): points, lines, rectangles,
  circles, polygons, cuboids, cylinders, spheres, polygon extrusions and imported STL meshes; engineering coordinates
  (mm, z up).
- Create from the ribbon, Model Builder context menu or palette; geometry tree with visibility toggles (mirrored in the
  Model Builder); click-to-select in the graphics window with highlight; inspector for name, dimensions, vertices,
  position, rotation, scale, colour and material assignment (library material or project formulation); duplicate/delete;
  autosave.
- Graphics: solid/wireframe/transparent, section plane, measurement tool, grid/axes, camera presets, fit, 2D (XY) mode,
  colour-by-material with legend.
- Measurements (calculated): analytic volume/area for primitives and extrusions, triangle-mesh integration for STL.
- STL import (binary/ASCII) and binary STL export of visible 3D objects.
- Tests: +4 vitest (analytic measures, scaling, extrusion, STL round trip).
- Not claimed: no CAD Boolean operations, no fillets, no constraint solver.

### R5 — Scientific model registry
- Model records: name, template, LaTeX display form (KaTeX), machine-readable expression for the restricted parser,
  dependent/independent variables and parameters with units, constants, material, experimental conditions, validity
  ranges, source (paper, page, table row, passage), fit quality, limitations, validation results, version history.
- Templates: Herschel–Bulkley, power law, Newtonian, Arrhenius viscosity, first-order kinetics with Arrhenius rate
  constant, linear temperature dependence; custom equations.
- Dimensional validation with pint (exponent-dependent units such as Pa·sⁿ handled; `exp/log` arguments must be
  dimensionless); approval refused when the check fails; undeclared symbols rejected.
- Status workflow extracted → reviewed → approved for calculation → validated (requires attached comparison with data)
  → deprecated; editing an approved model resets it to reviewed.
- Evaluation API refuses non-approved models and out-of-range inputs unless extrapolation is explicitly allowed (then
  flagged); curves show validated range vs extrapolation; overlay of coexisting models (e.g. HB fits at 10/15/20 % w/w).
- Validation: paste observations → RMSE, MAE, R², MAPE, parity plot; attached to the model.
- Resolver (internal scientific model API, `/api/science/resolve`): approved models and records for a material and
  quantity ranked by condition distance with exact-match flag; explains when experimental characterisation is needed.

### R4 — Scientific extraction and human review
- Workflow: PDF → text/tables → extractor → structured candidates → source verification → human review → approved
  library records / registry models. Nothing enters a library without review.
- Local rule-based extractor (always available, offline): property values with units and ± uncertainty near catalogue
  aliases (multi-word aliases, value must follow its own alias, symbol-assignment and concentration guards), per-value
  experimental conditions from the same sentence (never invented), replicate counts, fitted parameters from table headers
  (τ0, K, n, R², condition columns), equation recognition (Herschel–Bulkley, power law, Arrhenius viscosity, first-order
  kinetics incl. text-stated models), parameter values with units, stated validity ranges, material and abbreviation
  detection. Evidence type distinguishes directly reported / fitted / calculated / author prediction / AI-inferred.
- Optional Claude extraction: only with an API key AND explicit opt-in with a data-transfer disclosure; structured
  JSON output; verified exactly like local output.
- Verification: passage must occur on the stated page and the value must occur in the passage; failures are flagged and
  confidence lowered.
- Review UI: candidate list (filters, confidence, verification flags, bulk actions), side-by-side source page with the
  passage highlighted, correction of value/unit/conditions/evidence, LaTeX equation editor with Greek/sub/superscript/unit
  palette and live KaTeX preview, material matching or creation, approve as *reviewed* or *approved for calculation*,
  reject with reason, re-open; manual entry fallback (scanned pages, complex notation).
- Approving a fitted equation creates one condition-specific model per selected parameter set (e.g. four HB models for
  10/15/20 % w/w and 25/50 °C), linked to the table row and page.
- Tests: +4 (values/conditions/no false positives, traceable approval and model creation, usage/extrapolation guards,
  rejection/manual entry/dimension error).

### R3 — Research-paper PDF ingestion
- Drag-and-drop / dialog import of multiple PDFs; originals stored locally (`<data dir>/papers`), SHA-256 de-duplication,
  80 MB limit, non-PDF rejection; papers linked to libraries.
- Local extraction with PyMuPDF: per-page text, ruled tables (cell-rectangle text), scanned-page detection (no text layer →
  warning, manual entry), bibliographic metadata (PDF metadata, largest-font title, DOI/year patterns, journal heuristic)
  marked *auto-detected* until the user verifies it; formatted citation.
- Document viewer: server-rendered pages, zoom, page navigation, highlight of a supporting passage located by text
  search (used to show the exact source of extracted values); text and table views; metadata editor.
- Papers cited by reviewed/approved records cannot be deleted (traceability).
- A clearly labelled SYNTHETIC test PDF (red banner on every page, invented values, fake `10.0000` DOI) is generated on
  demand to demonstrate the workflow; it is never presented as literature.
- Tests: +3 (ingestion/metadata/tables/search/render, de-duplication, metadata editing).

- Database: schema-migration table; v2 adds scientific collections and parent links without touching existing data
  (verified on a copy of an existing database).


## Phase 1 — Completed milestones
- **Backend core (part of M1–M8):** FastAPI app, SQLite document store, demo seed project, scientific model library
  (nutrition mass balance, EU energy factors, Choi & Okos thermophysical properties, Herschel–Bulkley pipe flow,
  heat balance, LMTD, residence time, pump power), safe expression parser, LP optimiser with Pareto front and
  infeasibility diagnosis, GP surrogate + DoE / active learning, experiment cost scenario, process flowsheet
  simulator, 3D-print toolpath generator, AI assistant (local + optional Claude), PDF reports. 33 pytest tests passing.

- **M1 – Application shell:** React 19 + TypeScript + Vite + Tailwind v4, routing for all 9 sections, design system
  (panels, provenance badges, numeric inputs, tabs, modals, toasts), dark mode, project selector, project
  create/duplicate/delete/save-to-file/load-from-file, GitHub Actions CI (pytest + typecheck + vitest + build).
- **M2 – Materials Library & Formulation Studio:** searchable/editable ingredient records (7 data tabs, provenance per
  section, versioning, JSON import/export, CSV export); three-panel formulation editor with sliders, numeric inputs,
  locking, proportional rebalancing, normalisation, save/duplicate/compare, formulation-level measured rheology.
- **M3 – Calculation engine in UI:** live nutrition, energy, salt equivalent, cost/kg, cost/serving, cost/g protein,
  composition/nutrient/cost charts, Choi & Okos thermal properties, explicit 'not predicted' warnings for viscosity/texture.

- **M4 – AI Optimizer:** objective modes (3-candidate comparison, lowest cost, highest protein, processing compatibility),
  editable protein/cost/nutrient limits, ingredient bounds & availability, allergen exclusions, uncertainty assumptions;
  candidate cards vs baseline, Pareto chart with budget line, composition comparison chart and table, constraint
  satisfaction with binding flags, LP dual sensitivities, Monte-Carlo intervals, infeasibility diagnosis with
  minimum relaxations; save candidate / open in studio / send to process / send to 3D print.

- **M5 – Experiments:** experiment records (formulation, processing conditions, viscosity, texture, extrusion
  behaviour, shape retention, cost, date, notes, data type) with add/edit/delete, CSV import/export, clearly-labelled
  synthetic demo data generator; planning tab switching from space-filling DoE (<6 responses) to GP active learning
  (uncertainty or target-seeking acquisition, kriging-believer batches) with LOO parity plot and Q²; recommendations
  can be added as planned experiments; editable cost-reduction calculator (defaults 200 vs 60 experiments, €170,
  2 kg, software cost) with net savings, break-even and sensitivity chart.

- **M6 – Process Simulator:** React Flow canvas with drag-and-drop equipment library (storage, mixer, heater, cooler,
  pump, pipe, extruder, conveyor, packaging), connect/remove units, editable unit settings, save/save-as/delete flows;
  backend flowsheet solver (topological order, mass balance with extruder flash-off, residence times, Choi–Okos
  heat duties, pump power, HB pipe/die pressure drops only when formulation rheology is supplied, energy and
  operating cost); temperature/mass-flow profile and power charts, per-unit results, explicit unsupported flags.

- **M7 – 3D Printing Lab:** React Three Fiber printer (bed, frame, gantry, printhead, nozzle), backend toolpath
  generator (inset perimeters + rectilinear ±45° infill via scan-line even-odd fill) for block, cylinder, ring,
  hexagon, star, stepped pyramid and imported 2-D outlines (CSV/JSON); time-accurate animation of the printhead
  with layer-by-layer bead deposition (instanced beads, w × h), play/pause/restart/scrub/speed; print time, toolpath
  and extrusion length, volume, mass (Choi–Okos density), layer count, required flow and flow-mismatch warning;
  HB nozzle pressure/shear only when formulation rheology exists; success probability explicitly not predicted.

- **M8 – AI assistant & reports:** context-aware assistant drawer on every page (built-in deterministic explainer using
  only engine-computed values; optional server-side Claude integration via ANTHROPIC_API_KEY with no-fabrication
  instructions and graceful fallback); Reports page with selectable sections and PDF (ReportLab), JSON and CSV
  exports incl. assumptions/limitations and provenance legend; Settings with project settings, dark mode,
  scientific model registry (equations, parameters, units, assumptions, applicability, validation, live compute),
  safe custom-equation evaluator, AI configuration and data reset.

- **M9 – Testing, debugging, documentation, demo:** Playwright end-to-end script covering all 14 demo steps plus
  infeasibility and assistant checks (16/16 passing, 0 browser errors, both dev and single-port production mode);
  fixed a React effect-cleanup crash (Chromium `scrollIntoView` returns a Promise), container-query responsive
  layouts (three-panel layouts stack when the assistant drawer is open), README, scientific model documentation,
  run scripts (`scripts/dev.sh`, `scripts/serve.sh`) and screenshots.

## Current functionality
All nine sections (Dashboard, Materials Library, Formulation Studio, AI Optimizer, Process Simulator, 3D Printing Lab,
Experiments, Reports, Settings) are implemented and connected; the *Affordable Pea Protein Snack* demo runs end to end
without paid services.

## Test status
- Backend: `pytest` — 33 tests (mass balance, energy, Choi–Okos, HB vs analytic Newtonian/power-law/Bingham limits,
  expression-parser security, LP optimality vs random search, Pareto ordering, infeasibility diagnosis, allergen
  exclusion, GP processing mode, DoE/active learning, cost scenario, process mass/energy balance, toolpaths for all
  shapes, API CRUD/import/export/report).
- Frontend: `tsc -b` clean, `vitest` 8 tests (rebalancing/locking), production build succeeds.
- End-to-end: `node e2e/demo-walkthrough.mjs` — 16/16 checks.
- CI: `.github/workflows/ci.yml` runs backend and frontend jobs on push/PR to `main`/`development`.
  (CI run status could not be checked from the build session because the GitHub CLI token was invalid; verify in the
  repository's Actions tab.)

## Outstanding / possible next steps
- Replace illustrative ingredient compositions and prices with supplier certificates of analysis and quotations.
- Record measured flow curves (τ₀, K, n) for candidate formulations to enable pressure-drop and nozzle predictions.
- Replace synthetic demo experiments with real laboratory data; the GP workflow is ready for it.
- Optional: user authentication and multi-user projects; PostgreSQL deployment; residence-time distribution models;
  temperature-dependent rheology; die-swell/sagging models for printing once validated data exist.
- Optional: run Playwright E2E in CI (requires browser installation in the workflow).

## Known issues / limitations
- Results shown in Reports are the latest runs cached in the browser (localStorage) per project.
- Polygon inset for imported concave outlines uses a miter offset that is approximate for sharp concave corners.
- Large toolpaths (very large objects with dense infill) increase animation memory; typical food-scale prints are fine.
- Mixer temperature rise assumes all shaft power is dissipated as heat (upper bound).

## Latest verified commit
- See the end of this file (updated after each push).

- `af165dc` — Milestone 9 (pushed to `origin/development`, verified with `git ls-remote`; 33 pytest, 8 vitest, 16/16 E2E passing).
