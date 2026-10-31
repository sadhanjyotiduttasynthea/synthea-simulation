# Synthea Simulation — Development Status

Branch: `development`

## Completed milestones
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

## In progress
- M9 experiments UI, M6 process simulator, M7 3D printing lab, M8 assistant/reports UI.

## Outstanding
- Frontend modules, CI workflow, documentation, end-to-end demo verification.

## Known issues
- None recorded yet.

## Latest verified commit
- (updated after push)
