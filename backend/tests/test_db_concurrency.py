"""The single shared SQLite connection must be safe under concurrent API threads and background jobs."""
from concurrent.futures import ThreadPoolExecutor

from app import db


def test_concurrent_reads_and_writes(client):
    ids = [db.put_doc("molecules", {"name": f"m{i}", "payload": "x" * 2000})["id"] for i in range(20)]

    def work(k):
        for i in range(40):
            d = db.get_doc("molecules", ids[(k + i) % len(ids)])
            assert d and d["payload"] == "x" * 2000
            assert len(db.list_docs("molecules")) >= 20
            db.put_doc("molecules", {**d, "touched": k})
        return True

    with ThreadPoolExecutor(8) as ex:
        assert all(ex.map(work, range(8)))
