"""Databases created before the faba bean change are upgraded on start-up."""
from app import db, knowledge, seed


def _legacy(used_by_user: bool):
    db.reset_connection()
    db.connect(":memory:")
    old_ing = {**seed.ingredients()[0], "id": seed.LEGACY_INGREDIENT, "name": "Pea protein isolate (old demo)"}
    db.put_doc("ingredients", old_ing)
    db.put_doc("projects", {"id": seed.LEGACY_PROJECT, "name": "Old demo"})
    db.put_doc("formulations", {"id": "old-f", "project_id": seed.LEGACY_PROJECT, "name": "old", "lines": [{"ingredient_id": seed.LEGACY_INGREDIENT, "percent": 100}]})
    if used_by_user:
        db.put_doc("projects", {"id": "mine", "name": "My project"})
        db.put_doc("formulations", {"id": "my-f", "project_id": "mine", "name": "mine", "lines": [{"ingredient_id": seed.LEGACY_INGREDIENT, "percent": 100}]})
    knowledge.ensure_seeded()  # old material migration
    assert db.get_doc("materials", f"mat-{seed.LEGACY_INGREDIENT}")


def test_legacy_demo_removed_and_faba_added():
    _legacy(False)
    seed.seed()
    knowledge.ensure_seeded()
    assert db.get_doc("projects", seed.LEGACY_PROJECT) is None and db.get_doc("formulations", "old-f") is None
    assert db.get_doc("ingredients", seed.LEGACY_INGREDIENT) is None and db.get_doc("materials", f"mat-{seed.LEGACY_INGREDIENT}") is None
    assert db.get_doc("ingredients", seed.FBPI) and db.get_doc("ingredients", seed.FBPC) and db.get_doc("projects", seed.PROJECT_ID)
    assert db.get_doc("materials", f"mat-{seed.FBPI}")["synonyms"]
    db.reset_connection()


def test_legacy_ingredient_kept_when_user_formulation_uses_it():
    _legacy(True)
    seed.seed()
    old = db.get_doc("ingredients", seed.LEGACY_INGREDIENT)
    assert old and old["available"] is False and "legacy" in old["name"]
    assert db.get_doc("formulations", "my-f")  # user data untouched
    seed.seed()  # idempotent
    assert db.get_doc("ingredients", seed.LEGACY_INGREDIENT)["name"].count("legacy") == 1
    db.reset_connection()
