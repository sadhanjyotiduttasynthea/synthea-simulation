"""Molecular structures and qualified interaction scenes.

Structures
----------
* Built-in small molecules are generated from SMILES with RDKit: 3D conformer by ETKDGv3
  (fixed random seed) followed by MMFF94 force-field optimisation. They are *computed
  conformers*, not experimental structures.
* User files (PDB, SDF/MOL, XYZ) are parsed with RDKit and rendered as supplied.

Scenes
------
Interaction scenes are *conceptual illustrations* assembled from the computed molecules
using standard geometric facts (e.g. tetrahedral hydrogen-bond geometry with O···O ≈ 2.8 Å).
They are not molecular-dynamics simulations. Quantities are only "predicted" when an approved
model from the registry is used (e.g. first-order denaturation kinetics), or when a textbook
physical relation is evaluated with user inputs (Laplace pressure, Stokes velocity).
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem, Crippen, Descriptors, Lipinski, rdDetermineBonds, rdMolDescriptors

from . import db, sci_registry

BUILTIN = {
    "water": ("Water", "O", "solvent"),
    "glucose": ("α-D-Glucose (pyranose)", "OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O", "sugar"),
    "fructose": ("β-D-Fructose (pyranose)", "OC[C@@]1(O)OC[C@@H](O)[C@@H](O)[C@@H]1O", "sugar"),
    "sucrose": ("Sucrose", "OC[C@H]1O[C@@](CO)(O[C@H]2O[C@H](CO)[C@@H](O)[C@H](O)[C@H]2O)[C@@H](O)[C@@H]1O", "sugar"),
    "maltose": ("Maltose (starch repeat unit pair)", "OC[C@H]1O[C@H](O[C@H]2[C@H](O)[C@@H](O)[C@@H](O)O[C@@H]2CO)[C@H](O)[C@@H](O)[C@@H]1O", "carbohydrate"),
    "glycerol": ("Glycerol", "OCC(O)CO", "lipid component"),
    "oleic_acid": ("Oleic acid", r"CCCCCCCC/C=C\CCCCCCCC(=O)O", "lipid"),
    "palmitic_acid": ("Palmitic acid", "CCCCCCCCCCCCCCCC(=O)O", "lipid"),
    "glycine": ("Glycine", "NCC(=O)O", "amino acid"),
    "alanine": ("L-Alanine", "C[C@H](N)C(=O)O", "amino acid"),
    "leucine": ("L-Leucine", "CC(C)C[C@H](N)C(=O)O", "amino acid"),
    "lysine": ("L-Lysine", "NCCCC[C@H](N)C(=O)O", "amino acid"),
    "glutamic_acid": ("L-Glutamic acid", "N[C@@H](CCC(=O)O)C(=O)O", "amino acid"),
    "cysteine": ("L-Cysteine", "N[C@@H](CS)C(=O)O", "amino acid"),
    "phenylalanine": ("L-Phenylalanine", "N[C@@H](Cc1ccccc1)C(=O)O", "amino acid"),
    "gly_ala": ("Gly-Ala dipeptide (peptide bond)", "NCC(=O)N[C@@H](C)C(=O)O", "peptide"),
}
CONFORMER_METHOD = "RDKit ETKDGv3 conformer (seed 42) + MMFF94 optimisation — computed, not an experimental structure"


def _mol_json(mol: Chem.Mol, name: str, provenance: str, conf_id: int = -1) -> dict:
    conf = mol.GetConformer(conf_id)
    atoms = []
    for a in mol.GetAtoms():
        p = conf.GetAtomPosition(a.GetIdx())
        info = a.GetPDBResidueInfo()
        atoms.append({"el": a.GetSymbol(), "x": round(p.x, 4), "y": round(p.y, 4), "z": round(p.z, 4), "charge": a.GetFormalCharge(),
                      "res": f"{info.GetResidueName()}{info.GetResidueNumber()}" if info else None,
                      "donor": a.GetSymbol() in ("O", "N") and a.GetTotalNumHs() > 0, "acceptor": a.GetSymbol() in ("O", "N")})
    bonds = [{"a": b.GetBeginAtomIdx(), "b": b.GetEndAtomIdx(), "order": b.GetBondTypeAsDouble()} for b in mol.GetBonds()]
    try:
        noH = Chem.RemoveHs(mol)
        props = {
            "formula": rdMolDescriptors.CalcMolFormula(mol), "molar_mass_g_mol": round(Descriptors.MolWt(mol), 3),
            "monoisotopic_mass": round(Descriptors.ExactMolWt(mol), 4), "heavy_atoms": noH.GetNumAtoms(),
            "hbond_donors": Lipinski.NumHDonors(mol), "hbond_acceptors": Lipinski.NumHAcceptors(mol),
            "rotatable_bonds": Lipinski.NumRotatableBonds(mol), "tpsa_A2": round(rdMolDescriptors.CalcTPSA(mol), 2),
            "logP_crippen": round(Crippen.MolLogP(mol), 3),
        }
    except Exception:
        props = {"formula": rdMolDescriptors.CalcMolFormula(mol)}
    return {"name": name, "atoms": atoms, "bonds": bonds, "properties": props, "provenance": provenance,
            "property_note": "Formula and molar mass are exact for the structure; TPSA, logP (Crippen) and H-bond counts are computed estimates (RDKit)."}


@lru_cache(maxsize=64)
def builtin(key: str) -> dict:
    if key not in BUILTIN:
        raise KeyError(key)
    name, smi, cls = BUILTIN[key]
    mol = Chem.AddHs(Chem.MolFromSmiles(smi))
    params = AllChem.ETKDGv3()
    params.randomSeed = 42
    if AllChem.EmbedMolecule(mol, params) != 0:
        raise ValueError(f"conformer embedding failed for {name}")
    AllChem.MMFFOptimizeMolecule(mol, maxIters=2000)
    d = _mol_json(mol, name, CONFORMER_METHOD)
    d.update({"key": key, "smiles": smi, "class": cls})
    return d


def catalog() -> list[dict]:
    return [{"key": k, "name": v[0], "class": v[2], "smiles": v[1]} for k, v in BUILTIN.items()]


def parse_file(text: str, filename: str) -> dict:
    fn = filename.lower()
    mol = None
    if fn.endswith(".pdb") or fn.endswith(".ent"):
        mol = Chem.MolFromPDBBlock(text, removeHs=False, sanitize=False, proximityBonding=True)
    elif fn.endswith((".sdf", ".mol")):
        mol = Chem.MolFromMolBlock(text.split("$$$$")[0], removeHs=False)
    elif fn.endswith(".xyz"):
        mol = Chem.MolFromXYZBlock(text)
        if mol is not None:
            try:
                rdDetermineBonds.DetermineConnectivity(mol)
            except Exception:
                pass
    if mol is None or mol.GetNumConformers() == 0:
        raise ValueError("Could not read a 3D structure from this file (supported: PDB, SDF/MOL, XYZ with coordinates).")
    if mol.GetNumAtoms() > 60000:
        raise ValueError("Structure too large for the interactive viewer (> 60 000 atoms).")
    d = _mol_json(mol, filename, f"User-supplied structure file ({filename}); coordinates rendered as provided")
    d["key"] = "file"
    return d


# ------------------------------------------------------------------ scenes
def _place(mol: dict, origin, rot: np.ndarray | None = None) -> list[dict]:
    xyz = np.array([[a["x"], a["y"], a["z"]] for a in mol["atoms"]])
    xyz = xyz - xyz.mean(axis=0)
    if rot is not None:
        xyz = xyz @ rot.T
    xyz = xyz + np.asarray(origin)
    return [{**a, "x": float(p[0]), "y": float(p[1]), "z": float(p[2])} for a, p in zip(mol["atoms"], xyz)]


def _rot_to(v_from, v_to):
    a, b = np.asarray(v_from, float), np.asarray(v_to, float)
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else -np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def _merge(parts: list[tuple[dict, list[dict]]]) -> dict:
    atoms, bonds = [], []
    for mol, placed in parts:
        off = len(atoms)
        atoms += placed
        bonds += [{"a": b["a"] + off, "b": b["b"] + off, "order": b["order"]} for b in mol["bonds"]]
    return {"atoms": atoms, "bonds": bonds}


def _water_oriented(o_pos, h_dir):
    """Water with its O at o_pos and one O-H pointing along h_dir (donating an H-bond)."""
    w = builtin("water")
    xyz = np.array([[a["x"], a["y"], a["z"]] for a in w["atoms"]])
    o = xyz[0]
    xyz = xyz - o
    rot = _rot_to(xyz[1], h_dir)
    xyz = xyz @ rot.T + np.asarray(o_pos)
    return w, [{**a, "x": float(p[0]), "y": float(p[1]), "z": float(p[2])} for a, p in zip(w["atoms"], xyz)]


def scene_water() -> dict:
    """Central water with four neighbours in tetrahedral directions at O···O = 2.76 Å (ice-like local order)."""
    d_oo = 2.76
    w = builtin("water")
    center_xyz = np.array([[a["x"], a["y"], a["z"]] for a in w["atoms"]])
    o = center_xyz[0]
    h1, h2 = center_xyz[1] - o, center_xyz[2] - o
    h1, h2 = h1 / np.linalg.norm(h1), h2 / np.linalg.norm(h2)
    lp_axis = -(h1 + h2) / np.linalg.norm(h1 + h2)
    perp = np.cross(h1, h2) / np.linalg.norm(np.cross(h1, h2))
    lp1 = (lp_axis * math.cos(math.radians(54.75)) + perp * math.sin(math.radians(54.75)))
    lp2 = (lp_axis * math.cos(math.radians(54.75)) - perp * math.sin(math.radians(54.75)))
    parts = [(w, [{**a, "x": float(p[0] - o[0]), "y": float(p[1] - o[1]), "z": float(p[2] - o[2])} for a, p in zip(w["atoms"], center_xyz)])]
    hbonds = []
    for direction, donate in ((h1, True), (h2, True), (lp1, False), (lp2, False)):
        pos = direction * d_oo
        if donate:  # central H points to the neighbour O; the neighbour accepts and points one H outward
            mol, placed = _water_oriented(pos, direction)
            hbonds.append({"from": 1 if direction is h1 else 2, "to_offset": len(parts) * 3, "kind": "O–H···O"})
        else:  # neighbour donates an H toward central O
            mol, placed = _water_oriented(pos, -direction)
            hbonds.append({"from_offset_h": len(parts) * 3 + 1, "to": 0, "kind": "O–H···O"})
        parts.append((mol, placed))
    m = _merge(parts)
    hb = []
    for h in hbonds:
        if "from" in h:
            hb.append({"a": h["from"], "b": h["to_offset"]})
        else:
            hb.append({"a": h["from_offset_h"], "b": h["to"]})
    return {**m, "hbonds": hb, "title": "Hydrogen-bond network of water",
            "kind": "conceptual", "provenance": "Conceptual: computed water conformers placed in tetrahedral (ice-like) geometry with O···O = 2.76 Å. Not a molecular-dynamics simulation.",
            "facts": ["Each water molecule can donate two and accept two hydrogen bonds (tetrahedral coordination).",
                      "O···O distance of a hydrogen bond in ice Ih ≈ 2.76 Å; the first peak of the O–O pair distribution in liquid water at room temperature lies near 2.8 Å.",
                      "In the liquid the network is dynamic; this static arrangement shows the local geometry only."]}


def scene_hydration(key: str = "glutamic_acid") -> dict:
    """Amino acid / peptide with water molecules placed at 2.8 Å from polar (O, N) atoms."""
    mol = builtin(key)
    parts = [(mol, _place(mol, (0, 0, 0)))]
    placed = parts[0][1]
    xyz = np.array([[a["x"], a["y"], a["z"]] for a in placed])
    centroid = xyz.mean(axis=0)
    hb = []
    for i, a in enumerate(placed):
        if a["el"] not in ("O", "N"):
            continue
        out = xyz[i] - centroid
        if np.linalg.norm(out) < 1e-6:
            continue
        out = out / np.linalg.norm(out)
        pos = xyz[i] + out * 2.8
        if np.min(np.linalg.norm(xyz - pos, axis=1)) < 2.2:
            continue
        w, wp = _water_oriented(pos, -out) if a["acceptor"] else _water_oriented(pos, out)
        off = sum(len(p[1]) for p in parts)
        parts.append((w, wp))
        hb.append({"a": i, "b": off + 1} if a["acceptor"] else {"a": i, "b": off})
    m = _merge(parts)
    return {**m, "hbonds": hb, "title": f"Hydration of {mol['name']}", "kind": "conceptual",
            "provenance": "Conceptual: computed conformer; water molecules placed 2.8 Å outward from each polar O/N atom to illustrate first-shell hydrogen bonding. Not a simulated hydration shell.",
            "facts": ["Polar and charged groups (–COOH/–COO⁻, –NH₂/–NH₃⁺, –OH) bind water through hydrogen bonds; non-polar side chains do not.",
                      "Protein water-holding capacity and solubility depend on the exposure of such groups, pH relative to the isoelectric point, and ionic strength."]}


def _dla(n: int, seed: int = 7, step=1.0) -> np.ndarray:
    """Off-lattice diffusion-limited aggregation (sticking on contact) — illustrative fractal aggregates."""
    rng = np.random.default_rng(seed)
    pts = [np.zeros(3)]
    rmax = 1.0
    for _ in range(n - 1):
        while True:
            v = rng.standard_normal(3)
            p = v / np.linalg.norm(v) * (rmax + 5)
            for _ in range(3000):
                p = p + rng.standard_normal(3) * step
                d = np.linalg.norm(np.array(pts) - p, axis=1)
                if d.min() < 2.0:
                    pts.append(p)
                    rmax = max(rmax, np.linalg.norm(p))
                    break
                if np.linalg.norm(p) > rmax + 15:
                    break
            else:
                continue
            if len(pts) and np.array_equal(pts[-1], p):
                break
    return np.array(pts)


def scene_aggregation(temperature_c: float, time_s: float, material_id: str | None, n_particles: int = 220) -> dict:
    """Gel-network formation illustration. If an approved first-order denaturation model exists for the material,
    the fraction of denatured (aggregation-competent) protein X = 1 - exp(-k(T) t) is computed from it."""
    model, frac, note = None, None, None
    if material_id:
        for m in db.list_docs("sci_models"):
            if m.get("material_id") == material_id and m.get("template") == "first_order_arrhenius" and m.get("status") in sci_registry.USABLE:
                model = m
                break
    if model:
        try:
            r = sci_registry.evaluate(model, {"T": temperature_c + 273.15}, allow_extrapolation=False)
            frac = 1 - math.exp(-r["value"] * time_s)
            note = f"Denatured fraction computed with approved model '{model['name']}': k(T) = {r['value']:.3g} 1/s at {temperature_c:g} °C, X = 1 − exp(−k·t) = {frac:.3f} after {time_s:g} s."
        except ValueError as e:
            note = f"Approved kinetic model exists but cannot be evaluated here: {e}. Showing conceptual illustration."
    n_agg = max(2, int(round((frac if frac is not None else 0.5) * n_particles)))
    pts = _dla(n_agg)
    rng = np.random.default_rng(3)
    free = rng.uniform(-25, 25, size=(n_particles - n_agg, 3))
    return {"particles": [{"x": float(p[0]), "y": float(p[1]), "z": float(p[2]), "state": "aggregated"} for p in pts] +
                         [{"x": float(p[0]), "y": float(p[1]), "z": float(p[2]), "state": "native"} for p in free],
            "title": "Heat-induced protein aggregation and gel-network formation",
            "kind": "model-driven" if frac is not None else "conceptual", "denatured_fraction": frac, "model_id": model["id"] if model else None,
            "provenance": (note or "No approved denaturation-kinetics model for this material: the aggregated fraction (50 %) is illustrative.") +
                          " Aggregate shapes come from an off-lattice diffusion-limited-aggregation algorithm (fractal clusters); they are not protein simulations.",
            "facts": ["Heating above the denaturation temperature exposes hydrophobic and sulfhydryl groups; unfolded proteins aggregate and, above a critical concentration, form a space-spanning gel network.",
                      "Aggregate structure (fine-stranded vs particulate) depends on pH relative to the isoelectric point and on ionic strength."]}


def scene_starch(order: float) -> dict:
    """Conceptual: double-helical amylopectin side chains (ordered) unwinding on gelatinisation."""
    order = min(max(order, 0.0), 1.0)
    glc = builtin("glucose")
    parts = []
    helix_r, rise, per_turn = 6.0, 3.5, 6
    for strand in range(2):
        for k in range(14):
            ang = 2 * math.pi * k / per_turn + strand * math.pi
            z = k * rise
            ordered = np.array([helix_r * math.cos(ang), helix_r * math.sin(ang), z])
            rng = np.random.default_rng(100 * strand + k)
            disordered = ordered + rng.normal(0, 9, 3) + np.array([strand * 12 - 6, 0, 0])
            pos = order * ordered + (1 - order) * disordered
            parts.append((glc, _place(glc, pos)))
    m = _merge(parts)
    return {**m, "hbonds": [], "title": "Starch gelatinisation (double-helix order → disorder)", "kind": "conceptual",
            "provenance": "Conceptual: computed glucose conformers arranged on two helical paths (ordered) and displaced (disordered). Glycosidic bonds are not drawn; this is not an atomistic starch model.",
            "facts": ["Amylopectin side chains in native granules form double helices packed into crystalline lamellae.",
                      "On heating in excess water, granules swell and the helices melt (gelatinisation), typically detected by DSC as an endotherm; the temperature range depends on botanical source and water content."]}


def emulsion_physics(radius_um: float, gamma_mN_m: float, rho_d: float, rho_c: float, mu_c: float) -> dict:
    """Laplace pressure and Stokes creaming velocity (textbook relations evaluated with the given inputs)."""
    r = radius_um * 1e-6
    lap = 2 * gamma_mN_m * 1e-3 / r
    v = 2 * (rho_d - rho_c) * 9.80665 * r * r / (9 * mu_c)
    return {"laplace_pressure_pa": lap, "stokes_velocity_m_s": v,
            "assumptions": "Laplace: spherical droplet, uniform interfacial tension. Stokes: isolated rigid sphere, creeping flow (Re ≪ 1), Newtonian continuous phase, no hindered settling or Brownian motion."}
