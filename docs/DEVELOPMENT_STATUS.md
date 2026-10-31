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

## In progress
- M4 optimiser UI, M5 experiments UI, M6 process simulator, M7 3D printing lab, M8 assistant/reports UI.

## Outstanding
- Frontend modules, CI workflow, documentation, end-to-end demo verification.

## Known issues
- None recorded yet.

## Latest verified commit
- (updated after push)
