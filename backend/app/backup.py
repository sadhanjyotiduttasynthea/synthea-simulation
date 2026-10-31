"""Off-site snapshots of the data folder for hosts with temporary disks (e.g. free Hugging Face Spaces).

Enabled when SYNTHEA_BACKUP_REPO is set (a *private* Hugging Face dataset repo such as "my-team/synthea-data") together
with HF_TOKEN (a write token). Nothing is sent anywhere otherwise.

* At start-up, before the database is opened, the latest snapshot is restored if the local data folder is empty.
* Every SYNTHEA_BACKUP_MINUTES (default 5) a snapshot is uploaded if anything changed: a consistent copy of the
  SQLite database (sqlite3 backup API) and a tar.gz of the stored research PDFs.
* On shutdown a final snapshot is attempted. POST /api/backup/now forces one.

The storage backend is pluggable (Hugging Face dataset or a local folder, the latter used by the tests).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tarfile
import tempfile
import threading
from datetime import datetime, timezone

DB_NAME = "synthea.db"
PAPERS_NAME = "papers.tar.gz"


class LocalStore:
    def __init__(self, folder: str):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)

    def upload(self, local: str, name: str):
        shutil.copyfile(local, os.path.join(self.folder, name))

    def download(self, name: str, dest: str) -> bool:
        src = os.path.join(self.folder, name)
        if not os.path.exists(src):
            return False
        shutil.copyfile(src, dest)
        return True


class HFStore:
    def __init__(self, repo: str, token: str):
        from huggingface_hub import HfApi
        self.repo, self.token = repo, token
        self.api = HfApi(token=token)
        self.api.create_repo(repo, repo_type="dataset", private=True, exist_ok=True)

    def upload(self, local: str, name: str):
        self.api.upload_file(path_or_fileobj=local, path_in_repo=name, repo_id=self.repo, repo_type="dataset",
                             commit_message=f"Synthea snapshot {datetime.now(timezone.utc).isoformat(timespec='seconds')}")

    def download(self, name: str, dest: str) -> bool:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.utils import EntryNotFoundError
        try:
            p = hf_hub_download(self.repo, name, repo_type="dataset", token=self.token, force_download=True)
        except EntryNotFoundError:
            return False
        shutil.copyfile(p, dest)
        return True


_state = {"enabled": False, "repo": None, "last_backup": None, "last_error": None, "restored": None, "hashes": {}}
_lock = threading.Lock()
_store = None
_stop = threading.Event()


def _data_dir() -> str:
    from . import db
    return db.data_dir()


def store_from_env():
    repo, token = os.environ.get("SYNTHEA_BACKUP_REPO"), os.environ.get("HF_TOKEN")
    local = os.environ.get("SYNTHEA_BACKUP_DIR")  # local folder (testing / NAS)
    if local:
        return LocalStore(local), local
    if repo and token:
        return HFStore(repo, token), repo
    return None, None


def _digest(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def restore(store, data_dir: str) -> dict:
    """Restore the latest snapshot into an empty data folder (never overwrites an existing database)."""
    db_path = os.path.join(data_dir, DB_NAME)
    if os.path.exists(db_path):
        return {"restored": False, "reason": "local database present"}
    os.makedirs(data_dir, exist_ok=True)
    got_db = store.download(DB_NAME, db_path)
    papers = False
    with tempfile.TemporaryDirectory() as tmp:
        arc = os.path.join(tmp, PAPERS_NAME)
        if store.download(PAPERS_NAME, arc):
            with tarfile.open(arc, "r:gz") as t:
                t.extractall(data_dir, filter="data")
            papers = True
    return {"restored": got_db, "papers": papers}


def snapshot(store, data_dir: str, conn: sqlite3.Connection | None = None, force: bool = False) -> dict:
    """Upload a consistent copy of the database and the PDFs if they changed."""
    from . import db
    out = {"database": False, "papers": False}
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, DB_NAME)
        src = conn or db.connect()
        with db._lock:  # consistent copy while no other statement runs
            dst = sqlite3.connect(copy)
            src.backup(dst)
            dst.close()
        h = _digest(copy)
        if force or h != _state["hashes"].get(DB_NAME):
            store.upload(copy, DB_NAME)
            _state["hashes"][DB_NAME] = h
            out["database"] = True
        pdir = os.path.join(data_dir, "papers")
        if os.path.isdir(pdir):
            names = sorted(os.listdir(pdir))
            sig = hashlib.sha256("|".join(f"{n}:{os.path.getsize(os.path.join(pdir, n))}" for n in names).encode()).hexdigest()
            if force or sig != _state["hashes"].get(PAPERS_NAME):
                arc = os.path.join(tmp, PAPERS_NAME)
                with tarfile.open(arc, "w:gz") as t:
                    t.add(pdir, arcname="papers")
                store.upload(arc, PAPERS_NAME)
                _state["hashes"][PAPERS_NAME] = sig
                out["papers"] = True
    _state["last_backup"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return out


def start():
    """Called at start-up before the database is opened."""
    global _store
    try:
        _store, label = store_from_env()
    except Exception as e:  # noqa: BLE001 -- backups must never stop the app
        _state["last_error"] = f"backup store unavailable: {e}"
        return
    if not _store:
        return
    _state.update({"enabled": True, "repo": label})
    try:
        _state["restored"] = restore(_store, _data_dir())
    except Exception as e:  # noqa: BLE001
        _state["last_error"] = f"restore failed: {e}"
    minutes = float(os.environ.get("SYNTHEA_BACKUP_MINUTES", "5"))

    def loop():
        while not _stop.wait(minutes * 60):
            now()
    threading.Thread(target=loop, daemon=True, name="synthea-backup").start()


def now(force: bool = False) -> dict:
    if not _store:
        return {"enabled": False}
    with _lock:
        try:
            r = snapshot(_store, _data_dir(), force=force)
            _state["last_error"] = None
            return {"ok": True, **r}
        except Exception as e:  # noqa: BLE001
            _state["last_error"] = f"{type(e).__name__}: {e}"
            return {"ok": False, "error": _state["last_error"]}


def stop():
    _stop.set()
    if _store:
        now()


def status() -> dict:
    return {k: v for k, v in _state.items() if k != "hashes"}

