"""Background computation jobs.

Studies run in a small thread pool so the interface stays responsive. Each job keeps a
progress fraction, a solver log and its final status; clients poll ``GET /api/jobs/{id}``.
Jobs live in memory (they are transient); finished studies are persisted in the database.
"""
from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable

_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="synthea-job")
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc).isoformat()


class JobContext:
    def __init__(self, job: dict):
        self.job = job

    def progress(self, frac: float, msg: str | None = None):
        with _lock:
            self.job["progress"] = max(self.job["progress"], min(1.0, float(frac)))
            if msg:
                self.log(msg)

    def log(self, msg: str, level: str = "info"):
        self.job["log"].append({"t": _now(), "level": level, "msg": msg})
        if len(self.job["log"]) > 400:
            del self.job["log"][:100]

    def cancelled(self) -> bool:
        return self.job["cancel_requested"]


def submit(kind: str, label: str, fn: Callable[[JobContext], dict], meta: dict | None = None) -> dict:
    job = {"id": f"job-{uuid.uuid4().hex[:10]}", "kind": kind, "label": label, "status": "queued", "progress": 0.0, "log": [], "created": _now(),
           "started": None, "finished": None, "result": None, "error": None, "cancel_requested": False, "meta": meta or {}}
    with _lock:
        _jobs[job["id"]] = job
        # keep the registry small
        done = [j for j in _jobs.values() if j["status"] in ("done", "failed", "cancelled")]
        for j in sorted(done, key=lambda j: j["created"])[:-50]:
            _jobs.pop(j["id"], None)
    ctx = JobContext(job)

    def run():
        if job["cancel_requested"]:
            job["status"] = "cancelled"
            return
        job["status"] = "running"
        job["started"] = _now()
        try:
            job["result"] = fn(ctx)
            job["status"] = "done"
            job["progress"] = 1.0
        except Exception as e:  # noqa: BLE001 -- reported to the user
            from .twin.solvers import Cancelled
            if isinstance(e, Cancelled):
                job["status"] = "cancelled"
                ctx.log("cancelled by user", "warn")
            else:
                job["status"] = "failed"
                job["error"] = str(e) or type(e).__name__
                ctx.log(f"failed: {job['error']}", "error")
                if not isinstance(e, ValueError):
                    ctx.log(traceback.format_exc(limit=3), "error")
        finally:
            job["finished"] = _now()

    _pool.submit(run)
    return public(job)


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k != "cancel_requested"}


def get(job_id: str) -> dict | None:
    j = _jobs.get(job_id)
    return public(j) if j else None


def cancel(job_id: str) -> dict | None:
    j = _jobs.get(job_id)
    if j and j["status"] in ("queued", "running"):
        j["cancel_requested"] = True
    return public(j) if j else None


def wait(job_id: str, timeout: float = 120.0) -> dict | None:
    """Block until a job finishes (used by tests)."""
    import time
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = _jobs.get(job_id)
        if not j or j["status"] in ("done", "failed", "cancelled"):
            return public(j) if j else None
        time.sleep(0.05)
    return get(job_id)
