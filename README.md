# Synthea Simulation

**AI-assisted virtual food formulation and engineering platform** — built for the *Hack the Fork* hackathon.

Synthea Simulation helps researchers develop affordable alternative-protein foods with fewer physical experiments. It
evaluates formulations virtually, optimises them mathematically, recommends the most informative experiments, and
simulates processing and 3D food printing. Every number comes from a documented computation, and every value is
labelled as *measured*, *literature*, *calculated*, *predicted*, *illustrative*, *synthetic* or *missing*.

> Six ingredients at ten concentration levels already span 10⁶ unconstrained theoretical combinations; processing
> parameters multiply this further. These figures illustrate combinatorial complexity, not the number of experiments
> companies actually run.

![Optimizer](docs/screenshots/optimizer.png)

## The three modules

| Module | Pages | What it does | Core methods |
|---|---|---|---|
| **Synthea Materials** | Libraries, Papers, Extraction Review, Models, Materials, Formulation, Optimizer, Molecules | Builds the faba bean ingredient knowledge base from uploaded research PDFs (batch import, extraction → human review → library records with paper and page; paper summaries; "Summarize all PDFs" library report with consolidated tables, equations and disagreements), lists every extracted equation/model (power law, Herschel–Bulkley, Arrhenius, first-order kinetics, GAB, Fourier), shows a sourced sensory & technical profile and an ingredient interaction panel for the formulation, keeps the ingredient table with provenance, and runs the virtual formulation lab and the optimiser (cost / protein / processing constraints, Pareto front, infeasibility diagnosis). Molecular structures feed computed properties into the libraries. | PyMuPDF extraction + rule-based extractor; linear mass balance; EU energy factors; Choi & Okos (1986); LP (HiGHS via SciPy), ε-constraint Pareto front, elastic LP, Monte Carlo; RDKit ETKDG + MMFF94 |
| **Synthea Process** | Process Simulator, Digital Twin | Plant-based sausage line (hydration, emulsifying/chopping, high-moisture extrusion, stuffing/casing, cooking, chilling) with mass and energy balances, residence times, heat duties and operating cost; heating units open 2-D Digital Twin studies (heat + denaturation kinetics) whose results flow back; technical outputs with provenance; Texture Class IDs TX-01…TX-05 from measured TPA, approved records or the GP surrogate; side-by-side runs and the optimized product sent to Print. | Steady-state lumped flowsheet; HB laminar flow; finite-volume / Q4 finite-element 2-D solvers (NumPy/SciPy) |
| **Synthea Print** | Geometry, 3D Printing Lab | Prototype geometry drawn in the Geometry editor or imported as STL and sliced into toolpaths (perimeters + ±45° infill); piston or screw extrusion with its own flow/pressure model; Prototype Manufacturability Score (compatibility index from five weighted checks — not a success probability); STL and G-code export; uses the formulation from Materials and the optimized product from Process. | Mesh slicing; polygon offset + scan-line fill; bead geometry Q = w·h·v; HB capillary flow; raster overhang and thin-feature analysis |

Shared pages: Dashboard, Global Definitions, Experiments (records, DoE → active learning, cost-reduction calculator),
Reports and Settings. The optimiser is part of Synthea Materials (there is no separate "Optimize" module). The navigation
(routes, model tree, dashboard, breadcrumb) is generated from `frontend/src/lib/modules.ts`.

**Digital twin** — 2-D cross-section models (any shape, editable) solved with NumPy/SciPy: heat transfer
with protein-denaturation kinetics, Herschel–Bulkley duct flow, solid mechanics and diffusion, with 3-D result views.
Every material input comes from approved library records extracted from your papers.
**Molecular structures** — any small molecule (SMILES/MOL/SDF), peptides and proteins (sequence, PDB,
AlphaFold); computed properties (pI, charge, diffusion, amino-acid score, …) feed the libraries and twins; force-field
interaction scenes. See [`docs/DESIGN_DECISIONS_ALI.md`](docs/DESIGN_DECISIONS_ALI.md).

There is also a **scientific assistant** on every page. It works without any external API using a built-in
deterministic explainer. A server-side Claude integration is optional. The assistant never generates numbers; it only
explains numbers produced by the engine. In addition there are **PDF / JSON / CSV reports**, a **scientific model
registry** with live evaluation, a **safe custom-equation evaluator**, project save/load and dark mode.

## Quick start

Requirements: Python ≥ 3.11, Node.js ≥ 20.

```bash
# development (backend on :8000 with reload, frontend on :5173)
./scripts/dev.sh
```

Open <http://localhost:5173>.

```bash
# single-port production-style run (FastAPI serves the built frontend)
./scripts/serve.sh        # then open http://localhost:8000
```

Manual setup:

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --port 8000
```

```bash
cd frontend
npm ci
npm run dev
```

The SQLite database is created automatically at `backend/data/synthea.db` and seeded with the demo project. Use
**Settings → Data → Reset demo data** to restore it.

### Hosting on a Mac for the team (same Wi-Fi)

Double-click **`Start-Synthea.command`** (Docker Desktop required): it builds and starts the app in Docker, asks once for
a team password, and prints the address for everyone on the same Wi-Fi (e.g. `http://192.168.1.23:8000`).
`Stop-Synthea.command` stops it, `Backup-Synthea.command` saves the data. Guide and checklist:
[`docs/HOSTING_MAC.md`](docs/HOSTING_MAC.md). Other options (own server, off-site backups): [`docs/DEPLOY_FREE.md`](docs/DEPLOY_FREE.md).

### Quickest on Windows (no installer, no Node.js)

1. Install **Python 3.12** from <https://www.python.org/downloads/> and tick **"Add python.exe to PATH"**.
2. Download this branch as a ZIP and unzip it.
3. Double-click **`Start-Synthea.bat`**. The first run installs the scientific packages (a few minutes); the browser
   then opens <http://localhost:8000>. Keep the black window open while you work; close it to stop.

The whole interface is the single file [`standalone/Synthea-Simulation.html`](standalone/Synthea-Simulation.html)
(rebuild with `cd frontend && npm run build:standalone`). The compute engine serves it; opened directly from disk it
shows a start page that waits for the engine and then opens the platform. Everything runs on `127.0.0.1` only.

### Desktop application (Tauri 2)

The desktop app starts its own local compute engine (a packaged Python process) bound to `127.0.0.1` on a random port
with a per-session token, stores data in the per-user application folder, and stops the engine on exit.

* **Windows installer:** the [Desktop build workflow](.github/workflows/desktop.yml) builds NSIS (`.exe`) and MSI
  installers on `windows-latest` (run it from the Actions tab; artifacts are attached to the run).
* **Linux:** `npx tauri build --bundles deb,appimage` in `desktop/` (verified in the build environment).

Build steps (any OS):

```bash
pip install -r backend/requirements.txt pyinstaller
```

```bash
python scripts/build_sidecar.py
```

```bash
cd frontend && npm ci && cd ../desktop && npm ci && npx tauri build
```

Development window: `cd desktop && SYNTHEA_DEV_PYTHON=/path/to/python npx tauri dev` (uses the backend sources).

### Optional: Claude-powered assistant

Set `ANTHROPIC_API_KEY` in the backend environment before starting it (optionally `SYNTHEA_AI_MODEL`). The key stays on
the server. Without it, everything still works with the built-in explainer.

## Hackathon demo — *Faba Bean Plant-Based Sausage*

| # | Step | Where |
|---|---|---|
| 1 | Open the preloaded project | Dashboard (walkthrough checklist) |
| 2 | Inspect the seven ingredients (faba bean protein isolate FBPI and concentrate FBPC, water, potato starch, sunflower oil, xanthan gum, salt) and their provenance | Materials Library |
| 3–4 | Edit the baseline formulation; nutrition and cost update immediately | Formulation Studio |
| 5–8 | Protein ≥ 12 %, cost ≤ €1.60/kg → **Run optimiser** → compare *Lowest cost / Balanced (Pareto) / Highest protein*; try protein ≥ 60 % to see the infeasibility diagnosis | Materials → Optimizer |
| 9 | Edit the illustrative savings scenario (200 vs 60 experiments, €170, 2 kg, software cost) | Experiments → Cost-reduction calculator |
| 10–11 | **To process** → **Run simulation** | Materials → Optimizer → Process → Process Simulator |
| 12–13 | **To 3D print** → toolpath animates automatically | Materials → Optimizer → Print → 3D Printing Lab |
| 14 | **Generate PDF report** (or JSON / CSV) | Reports |

Expected optimiser results with the illustrative demo data (output of the engine, all prices illustrative): lowest cost
12.0 % protein at €0.814/kg (FBPC only, no FBPI); Pareto knee 19.7 % at €1.262/kg; highest protein 24.4 % at the
€1.60/kg budget. Excluding the "faba" allergen makes the problem infeasible (no other protein source).

The whole demo runs without paid services. Run `node e2e/demo-walkthrough.mjs` (with Playwright available) to check all
14 steps automatically.

## Scientific integrity

* Ingredient values for the commercial ingredients and **all prices are illustrative demonstration values** and are
  labelled as such. Water and NaCl constants are standard reference data. No references, measurements or validations
  are invented.
* Mixture viscosity and texture are **never** computed by weighted averaging. They are reported as *not predicted*
  unless measured flow curves (Herschel–Bulkley τ₀, K, n) are entered for a formulation, or a surrogate is trained on
  recorded experiments.
* Surrogate models report leave-one-out Q², uncertainty bands and extrapolation distance. The synthetic demo-data
  generator is clearly labelled and can be removed in one click.
* The process simulator uses lumped steady-state balances. It is **not** CFD or multiphysics.
* Printing success probability is **not** predicted. The Prototype Manufacturability Score is a compatibility index from
  named checks with visible weights; checks without data are excluded and the score states on how many checks it is based.
* Texture Class IDs (TX-01…TX-05) use an illustrative, documented convention; a class is only assigned from measured TPA,
  approved records or the GP surrogate with its uncertainty band.
* Cost-saving figures are scenario calculations from user inputs, not measured outcomes.

See [`docs/SCIENTIFIC_MODELS.md`](docs/SCIENTIFIC_MODELS.md) for equations, assumptions and validity ranges.

## Architecture

```
backend/                    FastAPI + NumPy/SciPy/scikit-learn + SQLite
  app/main.py               REST API (+ serves frontend/dist in production)
  app/db.py                 document store (SQLite; JSON documents, portable to PostgreSQL JSONB)
  app/seed.py               demo project and provenance-labelled ingredient data
  app/science/              nutrition, thermal (Choi–Okos), rheology (HB), model registry, safe expression parser
  app/optimize.py           LP optimiser, Pareto front, infeasibility diagnosis, GP-constrained processing optimisation
  app/surrogate.py          Gaussian-process surrogate with LOO validation
  app/experiments.py        DoE, active learning, synthetic demo data, cost scenario
  app/process.py            flowsheet solver
  app/printing.py           toolpath generator and extrusion calculations
  app/assistant.py          deterministic explainer + optional Claude integration
  app/reports.py            PDF report (ReportLab)
  app/twin/                 digital twin: geometry + mesh, 2-D solvers, property resolution, demo twins
  app/jobs.py               background computation jobs (progress, log, cancel)
  app/molecules.py          RDKit conformers, protein calculations, PDB parsing, interaction energies
  app/paper_summary.py      extractive (and optional Claude) paper summaries
  tests/                    pytest (science, optimiser, API)
frontend/                   React 19 + TypeScript + Vite + Tailwind v4
  src/pages/                Dashboard, Materials, Formulation, Optimizer, Process (React Flow),
                            Printing (React Three Fiber), Experiments, Reports, Settings
  src/lib/                  API client, formulation rebalancing (vitest), formatting, hooks
e2e/demo-walkthrough.mjs    Playwright end-to-end check of the 14-step demo
docs/                       development status, scientific models, screenshots
.github/workflows/ci.yml    pytest + typecheck + vitest + build on push / PR
```

## Testing

```bash
cd backend
.venv/bin/pytest -q
```

```bash
cd frontend
npm run typecheck
npm test
npx vite build
```

```bash
node e2e/demo-walkthrough.mjs   # needs the running app and Playwright
node e2e/twin-molecules-smoke.mjs
```

## Screenshots

| Digital twin — heat + denaturation | Digital twin — Herschel–Bulkley die flow |
|---|---|
| ![](docs/screenshots/twin-heat.png) | ![](docs/screenshots/twin-flow.png) |

| Molecular structures | Interaction scene |
|---|---|
| ![](docs/screenshots/molecules-peptide.png) | ![](docs/screenshots/molecules-interaction.png) |

| Formulation Studio | Process Simulator |
|---|---|
| ![](docs/screenshots/formulation.png) | ![](docs/screenshots/process.png) |
| **3D Printing Lab** | **Experiments: active learning** |
| ![](docs/screenshots/printing.png) | ![](docs/screenshots/experiments.png) |

Development progress is tracked in [`docs/DEVELOPMENT_STATUS.md`](docs/DEVELOPMENT_STATUS.md).
