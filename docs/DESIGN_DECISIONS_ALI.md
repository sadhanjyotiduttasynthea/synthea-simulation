# Design decisions — digital twin (R8) and molecular structures (R7)

Branch `ali`, based on `development` @ `f011d76`. These decisions were agreed with the team and then implemented.

## Agreed decisions

| # | Question | Decision | How it is implemented |
|---|---|---|---|
| 1 | What the solver solves | 2-D, NumPy/SciPy | Finite volumes and Q4 finite elements on a uniform grid, solved with SciPy sparse solvers. Not 3-D CFD/FEA. |
| 2 | Geometry | Start from simple shapes; the user can change them | Rectangle, circle, ellipse, ring, L-shape, hexagon, star, plus a free polygon (any vertex list). All dimensions are editable, and every shape has a depth (extrusion length). |
| 3 | Physics | Heat transfer, fluid flow, structural properties | Transient/steady heat conduction (with optional first-order Arrhenius kinetics, e.g. protein denaturation). Fully developed laminar duct flow: Newtonian, power law, or Herschel–Bulkley (yield-stress) fluids. Plane stress/strain linear elasticity. Mass diffusion was added because the molecules feed it. |
| 4 | Where material data comes from | Libraries are folders; users upload papers, the app extracts the data and can summarise each paper | Twins only use library records *approved for calculation* (or approved registry models), and each one links to its paper and page. Every paper also gets a summary (local verbatim key statements; optional Claude). Manual values and Choi–Okos estimates are allowed only as an explicit choice, and they are flagged. |
| 5 | Calibration against experiments | Out of scope | Not implemented. Twins read only the data extracted from uploaded PDFs (plus computed molecular data). |
| 6 | Long runs | Background jobs | Studies run in a thread pool with progress, cancel, and output to the Solver Log. Each finished study is stored with a snapshot of the twin, the inputs (with their sources), the mesh statistics and the results. |
| 7 | Mesh / visual | 3-D | The 2-D cross-section is drawn as an extruded 3-D body coloured by the field. The mesh tab shows the cell wireframe. Values are uniform along the depth, as the 2-D model assumes. |
| 8 | What the molecules are for | Feed numbers into simulations | Computed properties become library records (evidence type "computed from structure"). Once approved, twins use them; for example, the diffusion coefficient feeds the diffusion physics. |
| 9 | Which molecules | All | Any small molecule (SMILES, MOL/SDF, food starter set), peptides and proteins (sequence/FASTA, PDB files, RCSB PDB or AlphaFold DB download). |
| 10 | Viewer | Either option | Built in-house with Three.js (same graphics window as the rest of the app): ball & stick, sticks, space-filling, and a backbone tube coloured by secondary structure, chain, hydropathy or pLDDT. |
| 11 | Interaction scenes | Required | Small-molecule pairs get an MMFF94 interaction energy and hydrogen bonds. Scenes involving proteins are labelled *conceptual*. |
| 12 | Link molecules to materials | Yes | `molecule.material_ids`, plus records written into the material's library entry. |

## Decisions made during implementation (please review)

1. **Boundary conditions are set per geometry edge**, with a default for the rest. The edges are bottom/right/top/left for a rectangle, "edge n" for polygons, and outer/inner for curved shapes. Each staircase face is assigned to its nearest edge.
2. **"Fluid dynamics" means fully developed flow through a duct cross-section**: the axial velocity over the section of a die, pipe or nozzle. In-plane 2-D Navier–Stokes (for example flow around obstacles) is a possible next step.
3. **Only approved records feed a twin by default.** Reviewed records can still be chosen explicitly, and the study then carries a warning.
4. **Demo twins** ("Load demo twins") run the real pipeline on the clearly labelled SYNTHETIC test PDF. That PDF now also states density, Young's modulus, Poisson's ratio, fracture stress and moisture diffusivity, all invented. A narrow rule extracts dimensionless values such as Poisson's ratio.
5. **A sequence alone gives no 3-D fold.** Short peptides (≤ 40 residues) get a computed *unfolded* conformer, labelled as such. Real folds come from PDB/AlphaFold files.
6. **Interaction energies are force-field values in vacuum** (a single local minimum), not binding free energies. The label in the UI says so.
7. **SQLite reads now take the same lock as writes.** Background jobs made the existing race condition on the shared connection visible.

## Verification

- Heat: matches the Fourier-series solution for a slab to < 0.1 K.
- Flow: Hagen–Poiseuille (Newtonian), power-law and Herschel–Bulkley pipe flow within 2–3 % on a 100-cell mesh. Force balance holds to machine precision. When the plug fills most of the pipe, a refine-mesh warning is shown.
- Structural: uniaxial compression is exact (σ and displacement). Reaction forces balance the applied loads.
- Molecules: pI is the root of the charge equation; extinction coefficients, molar masses and water viscosity are checked against reference values; the sucrose diffusion estimate falls in the measured range.
- `pytest`: 59 tests. `e2e/twin-molecules-smoke.mjs`: 6/6 checks.

## Known limitations / next steps

- 2-D only. Constant properties per study (no temperature-dependent k, cp or viscosity yet). No evaporation or moisture loss during baking. Small-strain elasticity only.
- Duct flow assumes fully developed flow (no entrance length or die swell).
- PDB/AlphaFold download needs internet access from the compute engine. mmCIF is not supported yet (use PDB format).
- `e2e/demo-walkthrough.mjs` (Milestone 9) has been failing on `development` since the R1 layout redesign because it waits for a `<main>` element. This is unrelated to this branch.
