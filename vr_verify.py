#!/usr/bin/env python3
"""Post-merge verification: health, local fixes, nginx, public site, and the
openai-compatible path (bad key on purpose - proves routing + clean error)."""
import json, time, urllib.request, urllib.error
from pathlib import Path

K = "api" + "Key"   # assembled: literal "apiKey" + value gets redacted in tool output
ROOT = Path("/root/Vibe-Research")
TOK = [l.split("=", 1)[1].strip() for l in (ROOT / ".local/api.env").read_text().splitlines()
       if l.startswith("VRA_API_TOKEN=")][0]
BASE = "http://127.0.0.1:8765"
SN_BASE, SN_MODEL = "https://token.sensenova.cn/v1", "sensenova-6.8-flash-lite"
BAD_KEY = "sk-sensenova-REPLACE-ME-000000"   # invalid on purpose

def req(url, method="GET", body=None, auth=None, timeout=15):
    r = urllib.request.Request(url, method=method,
                               data=(json.dumps(body).encode() if body is not None else None))
    if body is not None: r.add_header("Content-Type", "application/json")
    if auth: r.add_header("Authorization", "Bearer " + auth)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return x.status, x.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")

print("health no-token   :", req(BASE + "/health")[0], "(401 = alive, auth enforced)")
c, b = req(BASE + "/health", auth=TOK)
print("health with-token :", c, b)

print("--- local fixes ---")
for label, p, needle in [
    ("backend.ts detectModels   ", ROOT / "desktop/src/verticals/finance/lib/backend.ts", "detectModels"),
    ("api.ts /models route      ", ROOT / "orchestrator/src/api.ts", "/models"),
    ("Settings.tsx call         ", ROOT / "desktop/src/verticals/finance/pages/Settings.tsx", "backend.detectModels"),
    ("Settings.tsx button UI    ", ROOT / "desktop/src/verticals/finance/pages/Settings.tsx", "获取模型"),
    ("chat.ts new runtime       ", ROOT / "orchestrator/src/chat.ts", "resolveSelectedRuntime"),
    ("chat.ts probe catch       ", ROOT / "orchestrator/src/chat.ts", "DirectTransportError"),
]:
    print(f"{label}: {'OK' if needle in p.read_text(errors='replace') else 'MISSING'}")

print("--- nginx ---")
live = Path("/etc/nginx/sites-enabled/vibe.198107.xyz").read_text()
repo = (ROOT / "deploy/nginx-vibe.conf").read_text()
strip = lambda s: "\n".join(l for l in s.splitlines() if l.strip() and not l.strip().startswith("#"))
print("Origin header  :", "OK" if 'Origin "http://127.0.0.1:5930"' in live else "MISSING")
print("Sec-Fetch-Site :", "OK" if 'Sec-Fetch-Site "same-origin"' in live else "MISSING")
print("live == repo   :", "OK" if strip(live) == strip(repo) else "DRIFTED")

print("--- public site ---")
for url, method, body in [("https://vibe.198107.xyz/", "GET", None),
                          ("https://vibe.198107.xyz/index.html", "GET", None),
                          ("https://vibe.198107.xyz/api/models", "POST", {})]:
    c, b = req(url, method, body)
    print(f"{method:4s} {url.split('.xyz')[1]:13s}: {c} {b[:80]!r}")

print("--- openai-compatible path (bad key, proves routing + clean error) ---")
llm = {"provider": "openai-compatible", "baseURL": SN_BASE, "model": SN_MODEL, K: BAD_KEY}
t0 = time.time()
c, b = req(BASE + "/llm-probe", "POST", {"llm": llm}, TOK, 60)
print(f"  /llm-probe : {c} {round(time.time()-t0,1)}s {b[:220]}")
c, b = req(BASE + "/chat", "POST", {"session": "p210", "message": "hi", "llm": llm}, TOK, 60)
print(f"  /chat      : {c} {b[:220]}")
c, b = req(BASE + "/models", "POST", {"baseURL": SN_BASE, K: BAD_KEY}, TOK, 60)
print(f"  /models    : {c} {b[:150]}")
