"""CLI: refresh site/snapshot.json with live PL/EU prices.

Usage:
    python backend/main.py refresh                      # refresh all priced vendors
    python backend/main.py refresh --vendor carnivor-pl # one vendor
    python backend/main.py refresh --dry-run            # don't write, just print

Excludes CN by design (RFQ-only). Excludes B2B-gated vendors (Makro, Selgros, Bidfood,
Diversey, Ecolab, etc.) — they get marked with `pricing_status: b2b_login_required` so
the UI shows a clear note instead of silent emptiness.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

import httpx

import scrapers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gastro-refresh")

ROOT = Path(__file__).resolve().parent.parent
# Override with env var GASTRO_SNAPSHOT_PATH for deployments where snapshot.json
# lives directly at project root (e.g. portfolio site at oskarseweryn.github.io
# under projects/poc-gastro-sourcing/snapshot.json).
SNAPSHOT_PATH = Path(os.environ["GASTRO_SNAPSHOT_PATH"]) if os.environ.get("GASTRO_SNAPSHOT_PATH") else ROOT / "site" / "snapshot.json"


def load_snapshot() -> dict:
    with open(SNAPSHOT_PATH, encoding="utf-8") as f:
        return json.load(f)


def write_snapshot(snap: dict) -> None:
    with open(SNAPSHOT_PATH, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)


async def refresh_one(client: httpx.AsyncClient, vendor: dict, basket: list[dict]) -> dict:
    """Run all SKUs for one vendor that has an adapter; return updated vendor dict (in place ok)."""
    adapter = scrapers.ADAPTERS.get(vendor["id"])
    if adapter is None:
        return vendor  # no-op for vendors we don't try

    served = set(vendor.get("categories_served", []))
    relevant = [sku for sku in basket if sku.get("category") in served]
    log.info("[%s] %d relevant SKU (categories: %s)", vendor["id"], len(relevant), ", ".join(served))

    line_items: list[dict] = []
    successes = 0
    failures: list[str] = []

    # Sequential — be gentle with each vendor's site (no parallel hammering of one host)
    for sku in relevant:
        try:
            li = await scrapers.scrape_vendor_sku(client, adapter, sku)
        except Exception as e:  # noqa: BLE001
            log.warning("[%s] %s exception: %s", vendor["id"], sku["id"], e)
            li = None
        if li:
            line_items.append(li)
            successes += 1
            log.info("[%s] ✓ %s → %s PLN  (%s)", vendor["id"], sku["id"],
                     li["unit_price_pln"], li["matched_title"][:60] if li.get("matched_title") else "?")
        else:
            failures.append(sku["id"])

    log.info("[%s] DONE — %d/%d priced, failures: %s",
             vendor["id"], successes, len(relevant),
             ",".join(failures[:8]) + ("..." if len(failures) > 8 else ""))
    vendor["line_items"] = line_items
    vendor["pricing_status"] = "scraped" if successes else "scrape_failed"
    return vendor


async def refresh_all(only_vendor: str | None, dry_run: bool) -> None:
    snap = load_snapshot()
    basket: list[dict] = snap["basket"]
    vendors: list[dict] = snap["vendors"]

    started = time.time()

    # Mark B2B-gated vendors with pricing_status (no scrape attempt)
    for v in vendors:
        if v["id"] in scrapers.B2B_GATED:
            v["line_items"] = []
            v["pricing_status"] = "b2b_login_required"
        elif v.get("region") == "CN":
            v["line_items"] = []
            v["pricing_status"] = "rfq_only"
        elif v["id"] not in scrapers.ADAPTERS:
            # No adapter built yet — leave as-is, mark unknown
            if not v.get("line_items"):
                v["pricing_status"] = "no_adapter"

    targets = [
        v for v in vendors
        if v["id"] in scrapers.ADAPTERS and (only_vendor is None or v["id"] == only_vendor)
    ]

    if not targets:
        log.warning("no targets to refresh (only_vendor=%s)", only_vendor)
        if dry_run:
            return
        snap["last_updated"] = time.strftime("%Y-%m-%d")
        write_snapshot(snap)
        return

    log.info("refreshing %d vendors: %s", len(targets), ", ".join(v["id"] for v in targets))

    async with httpx.AsyncClient(
        timeout=scrapers.TIMEOUT, follow_redirects=True, headers=scrapers.UA
    ) as client:
        # Run vendors in parallel (different hosts), SKUs within a vendor sequential
        await asyncio.gather(*(refresh_one(client, v, basket) for v in targets))

    snap["last_updated"] = time.strftime("%Y-%m-%d")
    snap["pricing_note"] = (
        "Ceny pobrane z publicznych katalogów PL/EU dostawców (JSON-LD/OpenGraph). "
        "Brak rabatów hurtowych — realny B2B wraca przez RFQ. Dostawcy z polityką B2B-login "
        "(Makro, Selgros, Bidfood, Diversey, Ecolab, METRO) widnieją z notatką 'wymaga rejestracji B2B'."
    )

    elapsed = time.time() - started
    if dry_run:
        log.info("DRY RUN — not writing. Elapsed %.1fs", elapsed)
        for v in targets:
            log.info("[%s] %d line_items", v["id"], len(v.get("line_items", [])))
        return

    write_snapshot(snap)
    log.info("✓ snapshot.json written. Elapsed %.1fs", elapsed)

    # Summary
    total_priced = sum(len(v.get("line_items", [])) for v in targets)
    log.info("SUMMARY — %d vendors refreshed, %d total line_items priced", len(targets), total_priced)


def main() -> int:
    ap = argparse.ArgumentParser(description="Refresh gastro snapshot.json with live PL/EU prices.")
    sp = ap.add_subparsers(dest="cmd", required=True)
    rp = sp.add_parser("refresh", help="scrape vendors and write snapshot.json")
    rp.add_argument("--vendor", help="restrict to one vendor_id")
    rp.add_argument("--dry-run", action="store_true", help="don't write snapshot.json")
    sp.add_parser("list", help="list known adapters and B2B-gated vendors")
    args = ap.parse_args()

    if args.cmd == "list":
        print("Adapters configured:")
        for vid in sorted(scrapers.ADAPTERS):
            print(f"  - {vid}")
        print("\nB2B-gated (no scrape, marked with pricing_status):")
        for vid in sorted(scrapers.B2B_GATED):
            print(f"  - {vid}")
        return 0

    if args.cmd == "refresh":
        asyncio.run(refresh_all(only_vendor=args.vendor, dry_run=args.dry_run))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
