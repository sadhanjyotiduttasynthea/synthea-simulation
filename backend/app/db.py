"""SQLite document store.

Each collection is a table (id TEXT PK, project_id TEXT, name TEXT, data JSON,
updated_at TEXT). The repository API is intentionally small so it can be
re-implemented on PostgreSQL (JSONB) without touching the service layer.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

COLLECTIONS = ("projects", "ingredients", "formulations", "experiments", "process_flows", "settings")

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def db_path() -> str:
    return os.environ.get("SYNTHEA_DB", os.path.join(os.path.dirname(__file__), "..", "data", "synthea.db"))


def connect(path: str | None = None) -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            p = path or db_path()
            if p != ":memory:":
                os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
            _conn = sqlite3.connect(p, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            for c in COLLECTIONS:
                _conn.execute(
                    f"CREATE TABLE IF NOT EXISTS {c} (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, data TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
            _conn.commit()
        return _conn


def reset_connection():
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _check(c: str):
    if c not in COLLECTIONS:
        raise ValueError(f"unknown collection {c}")


def list_docs(collection: str, project_id: str | None = None) -> list[dict]:
    _check(collection)
    conn = connect()
    if project_id is None:
        rows = conn.execute(f"SELECT data FROM {collection} ORDER BY updated_at").fetchall()
    else:
        rows = conn.execute(f"SELECT data FROM {collection} WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at", (project_id,)).fetchall()
    return [json.loads(r["data"]) for r in rows]


def get_doc(collection: str, doc_id: str) -> dict | None:
    _check(collection)
    row = connect().execute(f"SELECT data FROM {collection} WHERE id = ?", (doc_id,)).fetchone()
    return json.loads(row["data"]) if row else None


def put_doc(collection: str, doc: dict) -> dict:
    _check(collection)
    doc = dict(doc)
    doc.setdefault("id", uuid.uuid4().hex[:12])
    doc["updated_at"] = _now()
    conn = connect()
    with _lock:
        conn.execute(
            f"INSERT INTO {collection} (id, project_id, name, data, updated_at) VALUES (?,?,?,?,?) "
            f"ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name, data=excluded.data, updated_at=excluded.updated_at",
            (doc["id"], doc.get("project_id"), doc.get("name"), json.dumps(doc), doc["updated_at"]),
        )
        conn.commit()
    return doc


def delete_doc(collection: str, doc_id: str) -> bool:
    _check(collection)
    conn = connect()
    with _lock:
        cur = conn.execute(f"DELETE FROM {collection} WHERE id = ?", (doc_id,))
        conn.commit()
    return cur.rowcount > 0


def delete_where_project(collection: str, project_id: str):
    _check(collection)
    conn = connect()
    with _lock:
        conn.execute(f"DELETE FROM {collection} WHERE project_id = ?", (project_id,))
        conn.commit()


def count(collection: str) -> int:
    _check(collection)
    return connect().execute(f"SELECT COUNT(*) AS n FROM {collection}").fetchone()["n"]
