"""Shared-password access for hosted deployments.

Enabled only when the environment variable SYNTHEA_PASSWORD is set (local and desktop runs are unaffected).
* Every page and API call requires a signed, HttpOnly session cookie, except /api/health (load-balancer checks),
  /login and /api/auth/login.
* The cookie value is "<expiry>.<HMAC-SHA256(secret, expiry)>"; the secret is SYNTHEA_SECRET (set it to a long
  random value in production) or, if absent, derived from the password. Changing either logs everyone out.
* Failed logins are delayed to slow down guessing. Use HTTPS (Render provides it) so the password and cookie are
  never sent in clear text.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import os
import time

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

COOKIE = "synthea_session"
SESSION_DAYS = 14
OPEN_PATHS = ("/api/health", "/login", "/api/auth/login", "/api/auth/logout", "/api/auth/status", "/favicon.svg")

router = APIRouter()


def password() -> str | None:
    return os.environ.get("SYNTHEA_PASSWORD") or None


def _secret() -> bytes:
    s = os.environ.get("SYNTHEA_SECRET") or ("synthea:" + (password() or ""))
    return hashlib.sha256(s.encode()).digest()


def make_token(now: float | None = None) -> str:
    exp = int((now or time.time()) + SESSION_DAYS * 86400)
    sig = hmac.new(_secret(), str(exp).encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def valid(token: str | None, now: float | None = None) -> bool:
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or int(exp) < (now or time.time()):
        return False
    good = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, good)


async def guard(request: Request, call_next):
    if not password() or request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if path in OPEN_PATHS or valid(request.cookies.get(COOKIE)):
        return await call_next(request)
    if path.startswith("/api"):
        return JSONResponse(status_code=401, content={"detail": "login required"})
    return RedirectResponse(url="/login", status_code=303)


LOGIN_PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Synthea Simulation — sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1114;color:#e5e7eb;font:15px/1.5 system-ui,sans-serif}
form{width:min(340px,90vw);background:#17191d;border:1px solid #2a2e35;border-radius:8px;padding:28px;display:grid;gap:14px}
h1{margin:0;font-size:18px} p{margin:0;color:#9ca3af;font-size:13px}
input{padding:10px;border-radius:5px;border:1px solid #3a3f47;background:#0f1114;color:#fff;font-size:15px}
input:focus-visible,button:focus-visible{outline:2px solid #e11d48;outline-offset:2px}
button{padding:10px;border:0;border-radius:5px;background:#e11d48;color:#fff;font-weight:600;font-size:15px;cursor:pointer}
.err{color:#fca5a5}</style></head><body>
<form method="post" action="/api/auth/login"><h1>Synthea Simulation</h1><p>Enter the team password.</p>
<label for="pw" style="font-size:13px">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
__ERR__<button type="submit">Sign in</button></form></body></html>"""


@router.get("/login", response_class=HTMLResponse)
def login_page(error: str | None = None):
    msg = f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ""
    return LOGIN_PAGE.replace("__ERR__", msg)


@router.post("/api/auth/login")
async def login(request: Request):
    ctype = request.headers.get("content-type", "")
    if "application/json" in ctype:
        supplied = (await request.json()).get("password", "")
        form = False
    else:
        supplied = (await request.form()).get("password", "")
        form = True
    pw = password()
    ok = bool(pw) and hmac.compare_digest(str(supplied).encode(), pw.encode())
    if not ok:
        await asyncio.sleep(1.0)  # slow down guessing
        if form:
            return RedirectResponse(url="/login?error=Wrong%20password", status_code=303)
        return JSONResponse(status_code=401, content={"detail": "wrong password"})
    resp = RedirectResponse(url="/", status_code=303) if form else JSONResponse({"ok": True})
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(COOKIE, make_token(), max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=secure)
    return resp


@router.post("/api/auth/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE)
    return resp


@router.get("/api/auth/status")
def status(request: Request):
    return {"password_protected": bool(password()), "signed_in": not password() or valid(request.cookies.get(COOKIE))}

