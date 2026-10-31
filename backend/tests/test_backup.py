"""Off-site snapshots for temporary disks: snapshot, restore into an empty folder, change detection."""
import os
import sqlite3

from app import backup, db


def test_snapshot_and_restore_roundtrip(tmp_path):
    data = tmp_path / "data"
    (data / "papers").mkdir(parents=True)
    (data / "papers" / "paper-1.pdf").write_bytes(b"%PDF-1.4 test")
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.execute("create table t (x text)")
    conn.execute("insert into t values ('faba')")
    conn.commit()
    store = backup.LocalStore(str(tmp_path / "remote"))
    backup._state["hashes"].clear()
    r = backup.snapshot(store, str(data), conn=conn)
    assert r == {"database": True, "papers": True}
    assert backup.snapshot(store, str(data), conn=conn) == {"database": False, "papers": False}  # unchanged -> no upload
    conn.execute("insert into t values ('sausage')")
    conn.commit()
    assert backup.snapshot(store, str(data), conn=conn)["database"] is True
    fresh = tmp_path / "fresh"
    out = backup.restore(store, str(fresh))
    assert out == {"restored": True, "papers": True}
    assert [r[0] for r in sqlite3.connect(fresh / "synthea.db").execute("select x from t")] == ["faba", "sausage"]
    assert (fresh / "papers" / "paper-1.pdf").read_bytes() == b"%PDF-1.4 test"
    assert backup.restore(store, str(fresh))["restored"] is False  # never overwrites a local database


def test_disabled_without_configuration(client, monkeypatch):
    for k in ("SYNTHEA_BACKUP_REPO", "HF_TOKEN", "SYNTHEA_BACKUP_DIR"):
        monkeypatch.delenv(k, raising=False)
    assert backup.store_from_env() == (None, None)
    assert client.get("/api/backup/status").json()["enabled"] in (False, True)
    assert os.environ.get("SYNTHEA_DB") == ":memory:" and db is not None
