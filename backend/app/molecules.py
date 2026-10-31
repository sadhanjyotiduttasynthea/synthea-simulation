"""Molecular structures: any small molecule (SMILES / MOL / SDF), peptides and proteins (sequence,
PDB / AlphaFold structure files), computed properties that feed simulations, and interaction scenes.

Sources and labelling
---------------------
* Small molecules: 3-D conformer generated with RDKit ETKDG v3 (fixed seed) and minimised with
  the MMFF94 force field (UFF if MMFF parameters are missing). Labelled *computed conformer*.
* Proteins: experimental or predicted structures are only shown when the user supplies a PDB
  file (or downloads one from RCSB PDB / AlphaFold DB, with attribution). A sequence alone has
  no 3-D structure; short peptides (<= 40 residues) can get a computed *unfolded* conformer.
* Interaction scenes between small molecules are *computed* with MMFF94 (gas phase, local
  minimum, interaction energy -- not a binding free energy). Scenes involving proteins are
  *conceptual* placements without numbers.

Equations used for numbers that feed the simulations
----------------------------------------------------
* Net charge  Z(pH) = sum_pos n_i / (1 + 10^(pH - pKa_i)) - sum_neg n_j / (1 + 10^(pKa_j - pH))
  (EMBOSS pKa set); isoelectric point = root of Z(pH) = 0 (Brent's method).
* Stokes-Einstein  D = k_B T / (6 pi eta(T) R_h); water viscosity eta(T) from the Vogel
  equation eta = 2.414e-5 * 10^(247.8 / (T - 140)) Pa s.
* R_h: small molecules -- radius of a sphere with the molecular (vdW) volume; proteins --
  1.25 * R_min with R_min = 0.066 M^(1/3) nm (Erickson 2009, compact globular protein), or
  R_g / 0.775 (sphere) when a structure is available.
* Extinction coefficient at 280 nm (Pace et al. 1995): 5500 W + 1490 Y + 125 cystine.
* Hydropathy: Kyte & Doolittle (1982) GRAVY. Amino-acid score vs the FAO (2013) pattern for
  older children, adolescents and adults (digestibility not included -- not a DIAAS).
"""
from __future__ import annotations

import math
import re
import uuid
from datetime import datetime, timezone

import numpy as np
from scipy.optimize import brentq
from scipy.spatial import cKDTree

from . import db, knowledge

KB = 1.380649e-23
SEED = 0x5EED

AA3 = {"ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C", "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I", "LEU": "L", "LYS": "K",
       "MET": "M", "PHE": "F", "PRO": "P", "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V", "SEC": "U", "MSE": "M"}
RESIDUE_MASS = {"A": 71.0788, "R": 156.1875, "N": 114.1038, "D": 115.0886, "C": 103.1388, "E": 129.1155, "Q": 128.1307, "G": 57.0519, "H": 137.1411,
                "I": 113.1594, "L": 113.1594, "K": 128.1741, "M": 131.1926, "F": 147.1766, "P": 97.1167, "S": 87.0782, "T": 101.1051, "W": 186.2132,
                "Y": 163.1760, "V": 99.1326}
WATER = 18.01528
PKA = {"Nterm": 8.6, "Cterm": 3.6, "C": 8.5, "D": 3.9, "E": 4.1, "H": 6.5, "K": 10.8, "R": 12.5, "Y": 10.1}  # EMBOSS
KD = {"A": 1.8, "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5, "Q": -3.5, "E": -3.5, "G": -0.4, "H": -3.2, "I": 4.5, "L": 3.8, "K": -3.9, "M": 1.9, "F": 2.8,
      "P": -1.6, "S": -0.8, "T": -0.7, "W": -0.9, "Y": -1.3, "V": 4.2}
FAO_2013 = {"His": (16, "H"), "Ile": (30, "I"), "Leu": (61, "L"), "Lys": (48, "K"), "SAA (Met+Cys)": (23, "MC"), "AAA (Phe+Tyr)": (41, "FY"),
            "Thr": (25, "T"), "Trp": (6.6, "W"), "Val": (40, "V")}

STARTERS = [
    {"name": "Water", "smiles": "O", "category": "solvent"},
    {"name": "Glucose (β-D-glucopyranose)", "smiles": "OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O", "category": "sugar"},
    {"name": "Sucrose", "smiles": "OC[C@H]1O[C@@](CO)(O[C@H]2O[C@H](CO)[C@@H](O)[C@H](O)[C@H]2O)[C@@H](O)[C@@H]1O", "category": "sugar"},
    {"name": "Maltotriose (starch fragment)", "smiles": "OC[C@H]1O[C@H](O[C@H]2[C@H](O)[C@@H](O)[C@H](O[C@H]3[C@H](O)[C@@H](O)[C@@H](O)O[C@@H]3CO)O[C@@H]2CO)[C@H](O)[C@@H](O)[C@@H]1O", "category": "polysaccharide fragment"},
    {"name": "Oleic acid", "smiles": "CCCCCCCC/C=C\\CCCCCCCC(=O)O", "category": "lipid"},
    {"name": "Linoleic acid", "smiles": "CCCCC/C=C\\C/C=C\\CCCCCCCC(=O)O", "category": "lipid"},
    {"name": "Glycerol", "smiles": "OCC(O)CO", "category": "polyol"},
    {"name": "L-Lysine", "smiles": "NCCCC[C@H](N)C(=O)O", "category": "amino acid"},
    {"name": "L-Leucine", "smiles": "CC(C)C[C@H](N)C(=O)O", "category": "amino acid"},
    {"name": "L-Glutamic acid", "smiles": "N[C@@H](CCC(=O)O)C(=O)O", "category": "amino acid"},
    {"name": "Vanillin", "smiles": "COc1cc(C=O)ccc1O", "category": "flavour"},
    {"name": "Hexanal (beany off-flavour marker in legumes)", "smiles": "CCCCCC=O", "category": "flavour"},
    {"name": "Caffeine", "smiles": "Cn1cnc2c1c(=O)n(C)c(=O)n2C", "category": "bioactive"},
    {"name": "Phytic acid", "smiles": "OP(=O)(O)O[C@@H]1[C@H](OP(=O)(O)O)[C@@H](OP(=O)(O)O)[C@H](OP(=O)(O)O)[C@@H](OP(=O)(O)O)[C@H]1OP(=O)(O)O", "category": "antinutrient"},
    {"name": "Sodium chloride (ion pair)", "smiles": "[Na+].[Cl-]", "category": "salt"},
]


def _now():
    return datetime.now(timezone.utc).isoformat()


def water_viscosity(T_c: float) -> float:
    """Dynamic viscosity of water [Pa s] (Vogel equation, approx. +/-2.5 % for 0-370 degC)."""
    T = T_c + 273.15
    return 2.414e-5 * 10 ** (247.8 / (T - 140.0))


def stokes_einstein(rh_m: float, T_c: float) -> float:
    return KB * (T_c + 273.15) / (6 * math.pi * water_viscosity(T_c) * rh_m)


# ------------------------------------------------------------------ proteins / peptides
def clean_sequence(seq: str) -> str:
    lines = [l for l in seq.strip().splitlines() if not l.startswith(">")]
    s = re.sub(r"[\s\d*]", "", "".join(lines)).upper()
    bad = sorted(set(s) - set(RESIDUE_MASS))
    if bad:
        raise ValueError(f"Unknown residue letters in sequence: {''.join(bad)} (use the 20 standard one-letter codes)")
    if len(s) < 2:
        raise ValueError("Sequence needs at least two residues")
    return s


def net_charge(seq: str, pH: float) -> float:
    c = {k: seq.count(k) for k in "CDEHKRY"}
    pos = 1 / (1 + 10 ** (pH - PKA["Nterm"])) + sum(c[k] / (1 + 10 ** (pH - PKA[k])) for k in "HKR")
    neg = 1 / (1 + 10 ** (PKA["Cterm"] - pH)) + sum(c[k] / (1 + 10 ** (PKA[k] - pH)) for k in "CDEY")
    return pos - neg


def protein_properties(seq: str, T_c: float = 25.0, pH: float = 7.0, rg_nm: float | None = None) -> dict:
    n = len(seq)
    mw = sum(RESIDUE_MASS[a] for a in seq) + WATER
    pi = brentq(lambda p: net_charge(seq, p), 0.0, 14.0, xtol=1e-6)
    counts = {a: seq.count(a) for a in sorted(RESIDUE_MASS)}
    res_mass = sum(RESIDUE_MASS[a] for a in seq)
    mg_g = {a: 1000 * counts[a] * RESIDUE_MASS[a] / res_mass for a in counts}
    score = {}
    for name, (ref, letters) in FAO_2013.items():
        v = sum(mg_g[a] for a in letters)
        score[name] = {"mg_per_g": v, "reference_mg_per_g": ref, "ratio": v / ref}
    limiting = min(score, key=lambda k: score[k]["ratio"])
    nC, nW, nY = counts["C"], counts["W"], counts["Y"]
    eps_ox = 5500 * nW + 1490 * nY + 125 * (nC // 2)
    eps_red = 5500 * nW + 1490 * nY
    rmin = 0.066 * mw ** (1 / 3)  # nm
    rh = 1.25 * rmin
    rh_src = "1.25 × R_min, R_min = 0.066·M^(1/3) nm (Erickson 2009; compact globular protein assumed)"
    if rg_nm:
        rh = rg_nm / 0.775
        rh_src = "R_g / 0.775 from the 3-D structure (sphere approximation)"
    D = stokes_einstein(rh * 1e-9, T_c)
    curve = [{"ph": float(p), "charge": net_charge(seq, float(p))} for p in np.linspace(1, 13, 49)]
    return {
        "kind": "protein", "residues": n, "molar_mass_g_mol": mw, "isoelectric_point": pi, "net_charge_at_ph": net_charge(seq, pH), "ph": pH,
        "extinction_280_oxidised": eps_ox, "extinction_280_reduced": eps_red, "abs_0_1pct_oxidised": eps_ox / mw,
        "gravy": sum(KD[a] for a in seq) / n, "aliphatic_index": 100 * (counts["A"] + 2.9 * counts["V"] + 3.9 * (counts["I"] + counts["L"])) / n,
        "composition": {a: {"count": counts[a], "mol_pct": 100 * counts[a] / n, "mg_per_g": mg_g[a]} for a in counts if counts[a]},
        "amino_acid_score": {"pattern": "FAO 2013, older child/adolescent/adult", "per_amino_acid": score, "limiting": limiting, "score": score[limiting]["ratio"],
                             "note": "Chemical score from the sequence only; digestibility is not included (not a DIAAS)."},
        "hydrodynamic_radius_nm": rh, "hydrodynamic_radius_method": rh_src, "temperature_c": T_c, "water_viscosity_pa_s": water_viscosity(T_c),
        "diffusion_coefficient_m2_s": D, "charge_curve": curve,
        "equations": {"charge": r"Z(\mathrm{pH})=\sum_{i\in +}\frac{n_i}{1+10^{\mathrm{pH}-\mathrm{p}K_i}}-\sum_{j\in -}\frac{n_j}{1+10^{\mathrm{p}K_j-\mathrm{pH}}}",
                      "diffusion": r"D=\frac{k_B T}{6\pi\eta(T)R_h}"},
    }


# ------------------------------------------------------------------ small molecules (RDKit)
def _rdkit():
    from rdkit import Chem
    from rdkit.Chem import AllChem, Crippen, Descriptors, rdMolDescriptors
    return Chem, AllChem, Crippen, Descriptors, rdMolDescriptors


def _embed(mh):
    Chem, AllChem, *_ = _rdkit()
    p = AllChem.ETKDGv3()
    p.randomSeed = SEED
    if AllChem.EmbedMolecule(mh, p) < 0:
        p.useRandomCoords = True
        if AllChem.EmbedMolecule(mh, p) < 0:
            raise ValueError("Could not generate 3-D coordinates for this molecule")
    return _minimise(mh)


def _minimise(mh, max_its=2000):
    _, AllChem, *_ = _rdkit()
    if AllChem.MMFFHasAllMoleculeParams(mh):
        props = AllChem.MMFFGetMoleculeProperties(mh)
        ff = AllChem.MMFFGetMoleculeForceField(mh, props)
        ff.Minimize(maxIts=max_its)
        return {"force_field": "MMFF94", "energy_kcal_mol": float(ff.CalcEnergy())}
    if AllChem.UFFHasAllMoleculeParams(mh):
        ff = AllChem.UFFGetMoleculeForceField(mh)
        ff.Minimize(maxIts=max_its)
        return {"force_field": "UFF", "energy_kcal_mol": float(ff.CalcEnergy())}
    return {"force_field": None, "energy_kcal_mol": None}


def _atoms_bonds(mol) -> tuple[list, list]:
    conf = mol.GetConformer()
    atoms = [{"el": a.GetSymbol(), "x": round(conf.GetAtomPosition(i).x, 4), "y": round(conf.GetAtomPosition(i).y, 4), "z": round(conf.GetAtomPosition(i).z, 4),
              "charge": a.GetFormalCharge()} for i, a in enumerate(mol.GetAtoms())]
    bonds = [[b.GetBeginAtomIdx(), b.GetEndAtomIdx(), float(b.GetBondTypeAsDouble())] for b in mol.GetBonds()]
    return atoms, bonds


def small_properties(mh, T_c: float = 25.0, ff: dict | None = None) -> dict:
    Chem, AllChem, Crippen, Descriptors, rdMD = _rdkit()
    m = Chem.RemoveHs(mh)
    vol = AllChem.ComputeMolVolume(mh)  # A^3, grid-based vdW volume
    r = (3 * vol / (4 * math.pi)) ** (1 / 3) * 1e-10
    return {
        "kind": "small", "formula": rdMD.CalcMolFormula(mh), "molar_mass_g_mol": Descriptors.MolWt(m), "exact_mass": Descriptors.ExactMolWt(m),
        "heavy_atoms": m.GetNumHeavyAtoms(), "logp_crippen": Crippen.MolLogP(m), "tpsa_a2": rdMD.CalcTPSA(m), "h_bond_donors": rdMD.CalcNumHBD(m),
        "h_bond_acceptors": rdMD.CalcNumHBA(m), "rotatable_bonds": rdMD.CalcNumRotatableBonds(m), "formal_charge": Chem.GetFormalCharge(m),
        "rings": rdMD.CalcNumRings(m), "vdw_volume_a3": vol, "radius_of_gyration_a": rdMD.CalcRadiusOfGyration(mh),
        "hydrodynamic_radius_nm": r * 1e9, "hydrodynamic_radius_method": "radius of a sphere with the molecular vdW volume",
        "temperature_c": T_c, "water_viscosity_pa_s": water_viscosity(T_c), "diffusion_coefficient_m2_s": stokes_einstein(r, T_c),
        "diffusion_note": "Stokes–Einstein estimate in water; small solutes typically diffuse up to ~1.5× faster than predicted.",
        **({"force_field": ff["force_field"], "conformer_energy_kcal_mol": ff["energy_kcal_mol"]} if ff else {}),
        "smiles": Chem.MolToSmiles(m),
        "equations": {"diffusion": r"D=\frac{k_B T}{6\pi\eta(T)R_h},\quad R_h=\left(\frac{3V_{vdW}}{4\pi}\right)^{1/3}"},
    }


def from_smiles(smiles: str, name: str | None = None) -> dict:
    Chem, *_ = _rdkit()
    m = Chem.MolFromSmiles(smiles.strip())
    if m is None:
        raise ValueError("Invalid SMILES")
    if m.GetNumHeavyAtoms() > 300:
        raise ValueError("More than 300 heavy atoms: use a structure file (PDB) for macromolecules")
    mh = Chem.AddHs(m)
    ff = _embed(mh)
    atoms, bonds = _atoms_bonds(mh)
    return {"name": name or smiles, "kind": "small", "source": {"type": "smiles", "value": smiles.strip()}, "atoms": atoms, "bonds": bonds,
            "molblock": Chem.MolToMolBlock(mh), "structure_label": f"computed conformer (RDKit ETKDG v3 + {ff['force_field'] or 'no force field'})",
            "properties": small_properties(mh, ff=ff)}


def from_molblock(text: str, name: str | None = None, filename: str = "") -> dict:
    Chem, AllChem, *_ = _rdkit()
    block = text.split("$$$$")[0]
    m = Chem.MolFromMolBlock(block, removeHs=False)
    if m is None:
        raise ValueError("Could not read the MOL/SDF file")
    has3d = m.GetNumConformers() and any(abs(m.GetConformer().GetAtomPosition(i).z) > 1e-4 for i in range(m.GetNumAtoms()))
    mh = Chem.AddHs(m, addCoords=bool(has3d))
    ff = _minimise(mh, 0) if has3d else _embed(mh)
    atoms, bonds = _atoms_bonds(mh)
    return {"name": name or (m.GetProp("_Name") if m.HasProp("_Name") and m.GetProp("_Name").strip() else filename or "molecule"), "kind": "small",
            "source": {"type": "file", "filename": filename}, "atoms": atoms, "bonds": bonds, "molblock": Chem.MolToMolBlock(mh),
            "structure_label": "coordinates from the uploaded file" if has3d else "computed conformer (RDKit ETKDG v3)", "properties": small_properties(mh, ff=ff)}


# ------------------------------------------------------------------ PDB structures
COV = {"H": 0.31, "C": 0.76, "N": 0.71, "O": 0.66, "S": 1.05, "P": 1.07, "SE": 1.20, "FE": 1.32, "ZN": 1.22, "MG": 1.41, "CA": 1.76, "NA": 1.66, "CL": 1.02}
MASS = {"H": 1.008, "C": 12.011, "N": 14.007, "O": 15.999, "S": 32.06, "P": 30.974}


def parse_pdb(text: str, keep_water: bool = False) -> dict:
    atoms, ca, helix, sheet, title = [], [], [], [], []
    for line in text.splitlines():
        rec = line[:6].strip()
        if rec in ("ATOM", "HETATM"):
            res = line[17:20].strip()
            if res in ("HOH", "WAT") and not keep_water:
                continue
            name = line[12:16].strip()
            el = (line[76:78].strip() or re.sub(r"[^A-Za-z]", "", name)[:1]).upper()
            try:
                x, y, z = float(line[30:38]), float(line[38:46]), float(line[46:54])
            except ValueError:
                continue
            b = float(line[60:66]) if line[60:66].strip() else 0.0
            a = {"el": el.capitalize(), "x": x, "y": y, "z": z, "name": name, "res": res, "chain": line[21].strip() or "A",
                 "seq": int(line[22:26]) if line[22:26].strip().lstrip("-").isdigit() else 0, "het": rec == "HETATM", "b": b}
            atoms.append(a)
            if name == "CA" and res in AA3 and rec == "ATOM":
                ca.append(len(atoms) - 1)
        elif rec == "HELIX":
            helix.append((line[19].strip(), int(line[21:25]), int(line[33:37])))
        elif rec == "SHEET":
            sheet.append((line[21].strip(), int(line[22:26]), int(line[33:37])))
        elif rec == "TITLE":
            title.append(line[10:].strip())
        elif rec == "ENDMDL":
            break  # first model only
    if not atoms:
        raise ValueError("No ATOM/HETATM records found in the PDB file")
    xyz = np.array([[a["x"], a["y"], a["z"]] for a in atoms])
    # covalent bonds from distances
    tree = cKDTree(xyz)
    rad = np.array([COV.get(a["el"].upper(), 0.8) for a in atoms])
    bonds = []
    for i, j in tree.query_pairs(2.2):
        d = float(np.linalg.norm(xyz[i] - xyz[j]))
        if 0.4 < d <= 1.2 * (rad[i] + rad[j]):
            bonds.append([int(i), int(j), 1.0])
    trace = []
    for i in ca:
        a = atoms[i]
        ss = "coil"
        if any(c == a["chain"] and s <= a["seq"] <= e for c, s, e in helix):
            ss = "helix"
        elif any(c == a["chain"] and s <= a["seq"] <= e for c, s, e in sheet):
            ss = "sheet"
        trace.append({"x": a["x"], "y": a["y"], "z": a["z"], "chain": a["chain"], "seq": a["seq"], "res": AA3[a["res"]], "ss": ss, "b": a["b"]})
    chains: dict[str, str] = {}
    for t in trace:
        chains[t["chain"]] = chains.get(t["chain"], "") + t["res"]
    m = np.array([MASS.get(a["el"].upper(), 12.0) for a in atoms])
    c = (xyz * m[:, None]).sum(0) / m.sum()
    rg = float(np.sqrt((m * ((xyz - c) ** 2).sum(1)).sum() / m.sum()))
    return {"atoms": atoms, "bonds": bonds, "trace": trace, "chains": chains, "title": " ".join(title), "rg_a": rg,
            "max_dimension_a": float(np.max(np.ptp(xyz, axis=0))), "has_secondary_structure": bool(helix or sheet)}


def from_pdb(text: str, name: str | None = None, source: dict | None = None, T_c: float = 25.0) -> dict:
    p = parse_pdb(text)
    seq = "".join(p["chains"].values())
    kind = "protein" if len(seq) >= 2 else "small"
    if kind == "small":
        Chem, *_ = _rdkit()
        m = Chem.MolFromPDBBlock(text, removeHs=False)
        if m is None:
            raise ValueError("Could not read this PDB file")
        mh = Chem.AddHs(m, addCoords=True)
        atoms, bonds = _atoms_bonds(mh)
        return {"name": name or p["title"] or "structure", "kind": "small", "source": source or {"type": "file"}, "atoms": atoms, "bonds": bonds,
                "molblock": Chem.MolToMolBlock(mh), "structure_label": "coordinates from the PDB file", "properties": small_properties(mh)}
    props = protein_properties(seq, T_c, rg_nm=p["rg_a"] / 10)
    props.update({"chains": {k: len(v) for k, v in p["chains"].items()}, "radius_of_gyration_nm": p["rg_a"] / 10, "max_dimension_nm": p["max_dimension_a"] / 10,
                  "structure_atoms": len(p["atoms"])})
    label = (source or {}).get("label") or "coordinates from the PDB file"
    return {"name": name or p["title"][:80] or "protein", "kind": "protein", "source": source or {"type": "file"}, "sequence": seq,
            "atoms": [{k: a[k] for k in ("el", "x", "y", "z", "res", "chain", "seq", "name", "b")} for a in p["atoms"]], "bonds": p["bonds"], "trace": p["trace"],
            "structure_label": label, "properties": props, "has_secondary_structure": p["has_secondary_structure"]}


def from_sequence(seq: str, name: str | None = None, build_conformer: bool = True, T_c: float = 25.0, pH: float = 7.0) -> dict:
    s = clean_sequence(seq)
    doc = {"name": name or (s[:12] + ("…" if len(s) > 12 else "")), "kind": "protein", "source": {"type": "sequence"}, "sequence": s,
           "atoms": [], "bonds": [], "trace": [], "structure_label": "sequence only — no 3-D structure (load a PDB / AlphaFold file to view the fold)",
           "properties": protein_properties(s, T_c, pH)}
    if build_conformer and len(s) <= 40:
        Chem, *_ = _rdkit()
        mh = Chem.AddHs(Chem.MolFromSequence(s))
        _embed(mh)
        p = parse_pdb(Chem.MolToPDBBlock(mh))
        doc.update({"atoms": [{k: a[k] for k in ("el", "x", "y", "z", "res", "chain", "seq", "name", "b")} for a in p["atoms"]], "bonds": p["bonds"], "trace": p["trace"],
                    "structure_label": "computed conformer of the UNFOLDED peptide (RDKit ETKDG + MMFF94) — not a folded structure"})
    return doc


def fetch_structure(source: str, ident: str) -> tuple[str, dict]:
    """Download a structure from RCSB PDB (CC0) or AlphaFold DB (CC-BY 4.0)."""
    import urllib.request
    ident = ident.strip()
    if source == "pdb":
        if not re.fullmatch(r"[0-9][A-Za-z0-9]{3}", ident):
            raise ValueError("A PDB ID has four characters, e.g. 1CRN")
        url = f"https://files.rcsb.org/download/{ident.upper()}.pdb"
        meta = {"type": "rcsb_pdb", "id": ident.upper(), "url": url, "license": "CC0 1.0 (RCSB PDB)", "label": f"experimental structure PDB {ident.upper()}"}
    elif source == "alphafold":
        if not re.fullmatch(r"[A-Za-z0-9]{6,10}", ident):
            raise ValueError("Give a UniProt accession, e.g. P13915")
        url = f"https://alphafold.ebi.ac.uk/files/AF-{ident.upper()}-F1-model_v4.pdb"
        meta = {"type": "alphafold", "id": ident.upper(), "url": url, "license": "CC-BY 4.0 — cite Jumper et al. 2021 and Varadi et al. 2024",
                "label": f"PREDICTED structure (AlphaFold DB, UniProt {ident.upper()}); colour by pLDDT for confidence"}
    else:
        raise ValueError("source must be 'pdb' or 'alphafold'")
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.read().decode("utf-8", "replace"), meta
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"Download failed ({type(e).__name__}). This computer may be offline or the host is blocked — download the file in a browser and upload it.") from e


# ------------------------------------------------------------------ storage
def save(doc: dict, project_id: str | None = None) -> dict:
    doc = dict(doc)
    doc.setdefault("id", f"mol-{uuid.uuid4().hex[:10]}")
    doc.setdefault("created", _now())
    doc.setdefault("material_ids", [])
    doc.setdefault("project_id", project_id)
    return db.put_doc("molecules", doc)


def summary(d: dict) -> dict:
    p = d.get("properties") or {}
    return {k: d.get(k) for k in ("id", "name", "kind", "source", "structure_label", "material_ids", "created")} | {
        "formula": p.get("formula"), "molar_mass_g_mol": p.get("molar_mass_g_mol"), "atoms": len(d.get("atoms") or []), "residues": p.get("residues")}


def recompute(d: dict, T_c: float, pH: float) -> dict:
    if d["kind"] == "protein":
        props = protein_properties(d["sequence"], T_c, pH, rg_nm=(d.get("properties") or {}).get("radius_of_gyration_nm"))
        for k in ("chains", "radius_of_gyration_nm", "max_dimension_nm", "structure_atoms"):
            if k in (d.get("properties") or {}):
                props[k] = d["properties"][k]
    else:
        Chem, *_ = _rdkit()
        mh = Chem.MolFromMolBlock(d["molblock"], removeHs=False)
        old = d.get("properties") or {}
        props = small_properties(mh, T_c, {"force_field": old.get("force_field"), "energy_kcal_mol": old.get("conformer_energy_kcal_mol")} if old.get("force_field") else None)
    d["properties"] = props
    return d


# ------------------------------------------------------------------ properties -> library records
def library_candidates(d: dict, ph: float | None = None) -> list[dict]:
    p = d["properties"]
    T = p["temperature_c"]
    out = [{"property": "molar_mass", "value": p["molar_mass_g_mol"], "unit": "g/mol", "conditions": {}},
           {"property": "hydrodynamic_radius", "value": p["hydrodynamic_radius_nm"], "unit": "nm", "conditions": {}, "method": p["hydrodynamic_radius_method"]},
           {"property": "diffusion_coefficient", "value": p["diffusion_coefficient_m2_s"], "unit": "m**2/s", "conditions": {"temperature": T},
            "method": "Stokes–Einstein in water, " + p["hydrodynamic_radius_method"]}]
    if d["kind"] == "protein":
        out += [{"property": "isoelectric_point", "value": p["isoelectric_point"], "unit": "", "conditions": {}, "method": "root of Z(pH)=0, EMBOSS pKa set"},
                {"property": "net_charge", "value": p["net_charge_at_ph"], "unit": "", "conditions": {"ph": p["ph"] if ph is None else ph}, "method": "Henderson–Hasselbalch, EMBOSS pKa set"},
                {"property": "amino_acid_score", "value": p["amino_acid_score"]["score"], "unit": "", "conditions": {},
                 "method": f"chemical score vs {p['amino_acid_score']['pattern']}; limiting: {p['amino_acid_score']['limiting']} (no digestibility)"}]
    return out


def to_library(d: dict, material_id: str, keys: list[str], review_status: str = "reviewed") -> list[dict]:
    if review_status not in ("reviewed", "approved", "extracted"):
        raise ValueError("review_status must be extracted, reviewed or approved")
    knowledge.get_material(material_id)
    made = []
    for c in library_candidates(d):
        if c["property"] not in keys:
            continue
        rec = knowledge.save_property({
            "material_id": material_id, "property": c["property"], "value": float(c["value"]), "unit": c["unit"] or None, "conditions": c["conditions"],
            "method": c.get("method", ""), "evidence_type": "computed_structure", "review_status": review_status,
            "source": {"molecule_id": d["id"], "citation": f"Computed from molecular structure '{d['name']}' ({d.get('structure_label', '')}) in Synthea Simulation"},
            "notes": "Computed from structure/sequence; not a measurement.",
        }, note=f"computed from molecule {d['id']}")
        made.append(rec)
    if material_id not in d.get("material_ids", []):
        d["material_ids"] = d.get("material_ids", []) + [material_id]
        db.put_doc("molecules", d)
    return made


# ------------------------------------------------------------------ interaction scenes
def _rotations(n: int, seed: int = 11) -> list[np.ndarray]:
    from scipy.spatial.transform import Rotation
    return [np.eye(3)] + list(Rotation.random(n - 1, random_state=seed).as_matrix())


def interaction(a: dict, b: dict, distance: float | None = None, optimise: bool = True, orientations: int = 24) -> dict:
    if a["kind"] != "small" or b["kind"] != "small" or len(a["atoms"]) + len(b["atoms"]) > 400:
        # conceptual placement only
        def centred(d):
            xyz = np.array([[t["x"], t["y"], t["z"]] for t in d["atoms"]]) if d["atoms"] else np.zeros((0, 3))
            return xyz - (xyz.mean(0) if len(xyz) else 0), (np.ptp(xyz, axis=0).max() / 2 if len(xyz) else 5.0)
        xa, ra = centred(a)
        xb, rb = centred(b)
        sep = distance or (ra + rb + 4.0)
        return {"computed": False, "label": "CONCEPTUAL scene — placement only, no energies (force-field interaction energies are computed for small-molecule pairs only).",
                "a": {"id": a["id"], "xyz": xa.round(3).tolist()}, "b": {"id": b["id"], "xyz": (xb + [sep, 0, 0]).round(3).tolist()}, "separation_a": sep}
    Chem, AllChem, *_ = _rdkit()
    ma = Chem.MolFromMolBlock(a["molblock"], removeHs=False)
    mb = Chem.MolFromMolBlock(b["molblock"], removeHs=False)
    for m in (ma, mb):
        if not AllChem.MMFFHasAllMoleculeParams(m):
            raise ValueError(f"MMFF94 has no parameters for {Chem.MolToSmiles(Chem.RemoveHs(m))}; interaction energy cannot be computed")

    def energy(m, ignore=True):
        ff = AllChem.MMFFGetMoleculeForceField(m, AllChem.MMFFGetMoleculeProperties(m), nonBondedThresh=100.0, ignoreInterfragInteractions=ignore)
        return ff

    ea = energy(ma).CalcEnergy()
    eb = energy(mb).CalcEnergy()
    xa = ma.GetConformer().GetPositions()
    xb = mb.GetConformer().GetPositions()
    xa = xa - xa.mean(0)
    xb0 = xb - xb.mean(0)
    na = len(xa)
    combo = Chem.CombineMols(ma, mb)
    Chem.SanitizeMol(combo)
    conf = combo.GetConformer()
    ff_c = energy(combo, ignore=False)

    def e_at(xbp):
        pos = np.vstack([xa, xbp]).ravel().tolist()
        return ff_c.CalcEnergy(pos) - ea - eb

    ra = np.linalg.norm(xa, axis=1).max()
    rb = np.linalg.norm(xb0, axis=1).max()
    rots = _rotations(orientations)
    d_lo = max(2.5, 0.45 * (ra + rb))
    ds = np.arange(d_lo, d_lo + 10.0, 0.25)
    scan, best = [], (np.inf, None, None)
    for d in ds:
        es = []
        for R in rots:
            xbp = xb0 @ R.T + [d, 0, 0]
            dmin = np.min(np.linalg.norm(xa[:, None, :] - xbp[None, :, :], axis=2))
            if dmin < 1.6:
                es.append(np.inf)
                continue
            e = e_at(xbp)
            es.append(e)
            if e < best[0]:
                best = (e, d, R)
        finite = [e for e in es if np.isfinite(e)]
        scan.append({"distance_a": float(d), "e_min_kcal_mol": float(min(finite)) if finite else None})
    if best[1] is None:
        raise ValueError("No clash-free placement found")
    e_rigid, d_best, R_best = best
    xb_best = xb0 @ R_best.T + [d_best, 0, 0]
    result_xyz = np.vstack([xa, xb_best])
    e_int, e_opt = e_rigid, None
    if optimise:
        for i, p in enumerate(result_xyz):
            conf.SetAtomPosition(i, p.tolist())
        ffo = energy(combo, ignore=False)
        ffo.Minimize(maxIts=5000)
        result_xyz = np.array(ffo.Positions()).reshape(-1, 3)
        e_complex = ffo.CalcEnergy()
        ma2, mb2 = Chem.Mol(ma), Chem.Mol(mb)
        fa, fb = energy(ma2), energy(mb2)
        fa.Minimize(maxIts=5000)
        fb.Minimize(maxIts=5000)
        e_opt = e_complex - fa.CalcEnergy() - fb.CalcEnergy()
        e_int = e_opt
    # hydrogen bonds between the two molecules in the final pose
    hb = []
    atoms = list(combo.GetAtoms())
    for i, at in enumerate(atoms):
        if at.GetSymbol() != "H":
            continue
        donor = at.GetNeighbors()[0] if at.GetDegree() else None
        if donor is None or donor.GetSymbol() not in ("N", "O"):
            continue
        di = donor.GetIdx()
        for j, acc in enumerate(atoms):
            if acc.GetSymbol() not in ("N", "O") or (j < na) == (di < na):
                continue
            dda = np.linalg.norm(result_xyz[di] - result_xyz[j])
            if dda > 3.5:
                continue
            v1 = result_xyz[di] - result_xyz[i]
            v2 = result_xyz[j] - result_xyz[i]
            ang = math.degrees(math.acos(np.clip(v1 @ v2 / (np.linalg.norm(v1) * np.linalg.norm(v2)), -1, 1)))
            if ang >= 120:
                hb.append({"donor": int(di), "hydrogen": i, "acceptor": j, "distance_a": float(dda), "angle_deg": ang})
    return {"computed": True, "method": "MMFF94 (RDKit), gas phase; rigid orientation search then full minimisation of the complex",
            "label": "Computed interaction energy E_int = E(complex) − E(A) − E(B): force-field energy, vacuum, single local minimum — not a binding free energy (no solvent, no entropy).",
            "interaction_energy_kcal_mol": float(e_int), "interaction_energy_kj_mol": float(e_int) * 4.184, "rigid_best_kcal_mol": float(e_rigid),
            "optimised": bool(optimise), "scan": scan, "orientations": len(rots), "hydrogen_bonds": hb,
            "a": {"id": a["id"], "xyz": result_xyz[:na].round(4).tolist()}, "b": {"id": b["id"], "xyz": result_xyz[na:].round(4).tolist()},
            "equation": r"E_{int} = E_{AB} - E_A - E_B"}
