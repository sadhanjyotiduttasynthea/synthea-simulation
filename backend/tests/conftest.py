import os
import pytest

os.environ["SYNTHEA_DB"] = ":memory:"
os.environ.pop("ANTHROPIC_API_KEY", None)


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient
    from app import db
    db.reset_connection()
    from app.main import app
    with TestClient(app) as c:
        yield c
    db.reset_connection()
