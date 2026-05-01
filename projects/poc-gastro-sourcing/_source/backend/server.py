"""Minimal FastAPI wrapper around the scraper for the page's "Odśwież ceny" button.

Run locally from the project root:
    .venv/bin/uvicorn server:app --app-dir backend --port 8001

The web page on http://127.0.0.1:8765/ POSTs /refresh, this server runs the scraper
(same logic as `python backend/main.py refresh`), writes site/snapshot.json, and
returns a JSON summary. Page reloads to pick up new prices.

Production (GitHub Pages) does NOT use this server — refresh there goes through
GitHub Actions workflow_dispatch (see .github/workflows/refresh-gastro-prices.yml).
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# `--app-dir backend` makes these imports resolve against backend/ as sys.path[0]
import scrapers  # noqa: E402
from main import load_snapshot, refresh_all  # noqa: E402

app = FastAPI(title="gastro-sourcing backend", version="0.1.0")

_default_origins = [
    "http://localhost:8765",
    "http://127.0.0.1:8765",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]
allowed_origins = os.environ.get("ALLOWED_ORIGINS", ",".join(_default_origins)).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in allowed_origins if o.strip()],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "service": "gastro-sourcing backend",
        "adapters": sorted(scrapers.ADAPTERS.keys()),
        "b2b_gated": sorted(scrapers.B2B_GATED),
    }


@app.post("/refresh")
async def refresh(vendor: str | None = None):
    """Run the same refresh path as `python backend/main.py refresh` and return a summary."""
    await refresh_all(only_vendor=vendor, dry_run=False)
    snap = load_snapshot()
    priced_count = sum(len(v.get("line_items") or []) for v in snap.get("vendors", []))
    scraped_vendors = [
        {"id": v["id"], "name": v["name"], "line_items": len(v.get("line_items") or [])}
        for v in snap.get("vendors", []) if v.get("pricing_status") == "scraped"
    ]
    return {
        "ok": True,
        "last_updated": snap.get("last_updated"),
        "priced_count": priced_count,
        "scraped_vendors": scraped_vendors,
    }
