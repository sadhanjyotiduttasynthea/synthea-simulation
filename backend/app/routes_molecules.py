"""REST endpoints for molecular structures, computed properties and interaction scenes."""
from __future__ import annotations

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from . import db, molecules

router = APIRouter(prefix="/api")
MAX_BYTES = 30 * 1024 * 1024


def _mol(mid: str) -> dict:
    m = db.get_doc("molecules", mid)
    if not m:
        raise HTTPException(404, "molecule not found")
    return m


def _wrap(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/molecules/starters")
def starters():
    return molecules.STARTERS


@router.get("/molecules")
def list_molecules(material_id: str | None = None):
    out = [molecules.summary(m) for m in db.list_docs("molecules") if not material_id or material_id in m.get("material_ids", [])]
    return sorted(out, key=lambda m: m.get("created") or "", reverse=True)


@router.post("/molecules")
def create_molecule(body: dict = Body(...)):
    name, pid = body.get("name") or None, body.get("project_id")
    if body.get("smiles"):
        doc = _wrap(molecules.from_smiles, body["smiles"], name)
    elif body.get("sequence"):
        doc = _wrap(molecules.from_sequence, body["sequence"], name, bool(body.get("build_conformer", True)))
    elif body.get("pdb"):
        doc = _wrap(molecules.from_pdb, body["pdb"], name)
    elif body.get("molblock"):
        doc = _wrap(molecules.from_molblock, body["molblock"], name)
    else:
        raise HTTPException(400, "Provide smiles, sequence, pdb or molblock")
    if body.get("material_ids"):
        doc["material_ids"] = list(body["material_ids"])
    return molecules.save(doc, pid)


@router.post("/molecules/upload")
async def upload_molecule(file: UploadFile = File(...), name: str = Form(""), project_id: str = Form("")):
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "File larger than 30 MB")
    text = raw.decode("utf-8", "replace")
    fn = (file.filename or "").lower()
    if fn.endswith((".pdb", ".ent")) or text.lstrip().startswith(("HEADER", "ATOM", "HETATM", "REMARK", "TITLE", "CRYST1", "MODEL")):
        doc = _wrap(molecules.from_pdb, text, name or None, {"type": "file", "filename": file.filename})
    elif fn.endswith((".mol", ".sdf", ".sd")) or "M  END" in text:
        doc = _wrap(molecules.from_molblock, text, name or None, file.filename or "")
    elif fn.endswith((".fasta", ".fa", ".txt")):
        doc = _wrap(molecules.from_sequence, text, name or None)
    else:
        raise HTTPException(400, "Supported files: PDB (.pdb), MOL/SDF (.mol, .sdf), FASTA (.fasta). mmCIF is not supported yet.")
    return molecules.save(doc, project_id or None)


@router.post("/molecules/fetch")
def fetch_molecule(body: dict = Body(...)):
    text, meta = _wrap(molecules.fetch_structure, body.get("source", "pdb"), body.get("id", ""))
    doc = _wrap(molecules.from_pdb, text, body.get("name") or None, meta)
    return molecules.save(doc, body.get("project_id"))


@router.get("/molecules/{mid}")
def get_molecule(mid: str):
    return _mol(mid)


@router.put("/molecules/{mid}")
def update_molecule(mid: str, body: dict = Body(...)):
    m = _mol(mid)
    for k in ("name", "material_ids", "notes"):
        if k in body:
            m[k] = body[k]
    return db.put_doc("molecules", m)


@router.delete("/molecules/{mid}")
def delete_molecule(mid: str):
    _mol(mid)
    db.delete_doc("molecules", mid)
    return {"deleted": mid}


@router.post("/molecules/{mid}/properties")
def recompute(mid: str, body: dict = Body(default={})):
    m = _mol(mid)
    m = _wrap(molecules.recompute, m, float(body.get("temperature_c", 25.0)), float(body.get("ph", 7.0)))
    return db.put_doc("molecules", m)


@router.get("/molecules/{mid}/library-candidates")
def candidates(mid: str):
    return molecules.library_candidates(_mol(mid))


@router.post("/molecules/{mid}/to-library")
def to_library(mid: str, body: dict = Body(...)):
    m = _mol(mid)
    try:
        recs = molecules.to_library(m, body["material_id"], body.get("properties") or [], body.get("review_status", "reviewed"))
    except KeyError:
        raise HTTPException(404, "material not found")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"created": [r["id"] for r in recs], "records": recs}


@router.post("/molecules/interaction")
def interaction(body: dict = Body(...)):
    a, b = _mol(body["a"]), _mol(body["b"])
    return _wrap(molecules.interaction, a, b, body.get("distance"), bool(body.get("optimise", True)), int(body.get("orientations", 24)))
