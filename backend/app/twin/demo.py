"""Demonstration twins built through the real paper workflow on the SYNTHETIC test document.

Steps (each one is the same API path a user takes): import the synthetic PDF, run the local
extractor, approve its candidates for *Pea protein isolate* (marked as demo approvals),
approve the fitted Herschel-Bulkley model at 15 % w/w / 25 degC and the kinetics model, then
create four twins. Every value stays traceable to the (clearly synthetic) source page.
"""
from __future__ import annotations

from .. import db, extraction
from . import service

MAT = "mat-pea-protein-isolate"


def _paper() -> dict:
    from ..routes_papers import import_sample
    for p in db.list_docs("papers"):
        if p.get("synthetic_test_document"):
            return p
    return db.get_doc("papers", import_sample()["id"])


def build(project_id: str | None) -> dict:
    from ..routes_science import approve
    paper = _paper()
    exts = db.list_children("extractions", paper["id"])
    if not exts:
        extraction.run(paper["id"], "rule")
        exts = db.list_children("extractions", paper["id"])
    approved = 0
    for e in exts:
        if e.get("status") != "pending":
            continue
        body = {"material_id": MAT, "review_status": "approved"}
        if e["kind"] == "equation":
            tpl = (e.get("equation") or {}).get("template")
            if tpl == "herschel_bulkley":
                sets = (e["equation"].get("parameter_sets") or [])
                idx = [i for i, s in enumerate(sets) if s.get("conditions") == {"concentration": 15.0, "temperature": 25.0}]
                body["parameter_sets"] = idx or [0]
            elif tpl != "first_order_arrhenius":
                continue
        elif e.get("property") in ("protein", "moisture", "viscosity", "activation_energy_flow"):
            continue  # not needed by the demo twins
        try:
            approve(e["id"], body)
            approved += 1
        except Exception:  # noqa: BLE001 -- a candidate that cannot be approved is simply skipped
            continue
    twins = []

    def mk(name, physics, geometry, mesh, conditions=None, edit=None):
        t = service.new_twin(project_id, name, physics, MAT)
        t["geometry"] = geometry
        t["mesh"] = mesh
        t["conditions"] = conditions or {"temperature_c": 25.0}
        t["demo"] = True
        if edit:
            edit(t)
        twins.append(service.save(t))

    def bake(t):
        h = t["physics"][0]
        h["settings"].update({"initial_c": 20.0, "t_end_s": 300.0, "target_c": 85.0, "kinetics": {"enabled": True}})
        h["bcs"] = {"default": {"type": "convection", "h": 25.0, "ambient": 180.0}, "bottom": {"type": "temperature", "value": 160.0}}  # tray contact

    def die(t):
        t["physics"][0]["settings"].update({"mode": "flow_rate", "flow_rate_l_h": 6.0})

    def overhang(t):
        t["physics"][0]["settings"].update({"plane": "stress", "gravity": True})
        t["physics"][0]["bcs"] = {"default": {"type": "free"}, "edge1": {"type": "fixed"}}  # printed on the bed along edge 1

    def soak(t):
        d = t["physics"][0]
        d["settings"].update({"initial": 0.0, "t_end_s": 86400.0, "unit": "relative moisture"})
        d["bcs"] = {"default": {"type": "concentration", "value": 1.0}, "bottom": {"type": "impermeable"}}

    mk("Snack bar baking (heat + denaturation)", ["heat"], {"shape": "rectangle", "params": {"width": 40.0, "height": 12.0}, "depth": 80.0}, {"level": "normal"}, edit=bake)
    mk("Extrusion die (Herschel–Bulkley flow)", ["flow"], {"shape": "circle", "params": {"diameter": 6.0}, "depth": 40.0}, {"level": "fine"}, edit=die)
    mk("Printed overhang under self-weight", ["structural"], {"shape": "polygon", "params": {"points": [[0, 0], [12, 0], [12, 22], [27, 22], [27, 30], [0, 30]]}, "depth": 20.0},
       {"level": "fine"}, edit=overhang)
    mk("Gel cube moisture uptake (diffusion)", ["diffusion"], {"shape": "rectangle", "params": {"width": 20.0, "height": 20.0}, "depth": 20.0}, {"level": "coarse"}, edit=soak)
    return {"paper_id": paper["id"], "approved": approved, "twins": [t["id"] for t in twins],
            "note": "Demo approvals of SYNTHETIC test values; replace with your own papers for real work."}
