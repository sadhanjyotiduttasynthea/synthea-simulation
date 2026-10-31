"""Shared-password gate for hosted deployments."""
import pytest


@pytest.fixture()
def protected(monkeypatch, client):
    monkeypatch.setenv("SYNTHEA_PASSWORD", "faba-team-secret")
    monkeypatch.setenv("SYNTHEA_SECRET", "x" * 40)
    return client


def test_open_when_no_password(client):
    assert client.get("/api/projects").status_code == 200
    assert client.get("/api/auth/status").json() == {"password_protected": False, "signed_in": True}


def test_login_required_and_session_cookie(protected):
    c = protected
    assert c.get("/api/health").status_code == 200  # health checks stay open
    assert c.get("/api/projects").status_code == 401
    r = c.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert "Sign in" in c.get("/login").text
    bad = c.post("/api/auth/login", data={"password": "nope"}, follow_redirects=False)
    assert bad.status_code == 303 and "error" in bad.headers["location"]
    assert c.get("/api/projects").status_code == 401
    ok = c.post("/api/auth/login", data={"password": "faba-team-secret"}, follow_redirects=False)
    assert ok.status_code == 303 and "synthea_session" in ok.headers["set-cookie"] and "HttpOnly" in ok.headers["set-cookie"]
    assert c.get("/api/projects").status_code == 200
    c.post("/api/auth/logout")
    c.cookies.clear()
    assert c.get("/api/projects").status_code == 401


def test_tokens_expire_and_are_signed(protected):
    from app import auth
    t = auth.make_token(now=1000.0)
    assert auth.valid(t, now=1001.0)
    assert not auth.valid(t, now=1000.0 + auth.SESSION_DAYS * 86400 + 1)
    exp, sig = t.split(".")
    assert not auth.valid(f"{int(exp) + 999999}.{sig}", now=1001.0)  # tampered expiry
    assert not auth.valid("garbage")
