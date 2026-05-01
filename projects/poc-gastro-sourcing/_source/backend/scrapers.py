"""Generic + per-vendor scrapers for poc-gastro-sourcing.

Strategy per (vendor, SKU):
  1. Build search query from SKU name + key spec keywords.
  2. Hit vendor's search endpoint (per-vendor URL template).
  3. Parse search results page; pick first result whose title overlaps SKU keywords above a threshold.
  4. Fetch the product page; extract price via JSON-LD → OG → microdata → listing-first-price.
  5. Validate quality_grade — for `premium` SKUs the matched product title must contain at least one
     premium signal (e.g., "dry-aged", "dojrzewan", "premium", "wagyu") otherwise reject.

If any step fails the (vendor, SKU) pair is omitted from line_items with a logged reason.

CN region is excluded by design (RFQ-only). B2B-login-gated vendors (Makro, Selgros, Bidfood,
Diversey, Ecolab, METRO, Iglotex, Polish Premium Beef) are not attempted — their entry in
PRICED_VENDORS is absent and main.py will skip them with a `pricing_status: b2b_login_required` note.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional, Sequence
from urllib.parse import quote_plus, urljoin

import httpx
from bs4 import BeautifulSoup

log = logging.getLogger("gastro-scrapers")

# ============================================================================
# HTTP basics
# ============================================================================

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.0 Safari/605.1.15 gastro-sourcing-bot/0.1"
    ),
    "Accept-Language": "pl,en;q=0.8,de;q=0.7",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
FX_TO_PLN = {"PLN": 1.0, "EUR": 4.30, "USD": 4.00, "GBP": 5.10, "CZK": 0.18}


async def fetch_html(client: httpx.AsyncClient, url: str) -> str:
    r = await client.get(url, headers=UA)
    r.raise_for_status()
    return r.text


# ============================================================================
# Generic price parsers (lifted from HVAC POC, proven on 12+ PL/EU shops)
# ============================================================================

def _norm_price(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).replace("\xa0", " ").strip()
    s = re.sub(r"[^\d,.\-]", "", s)
    if not s:
        return None
    if "," in s and "." in s:
        if s.find(".") < s.find(","):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _norm_avail(raw: Any) -> Optional[str]:
    if not raw:
        return None
    s = str(raw).strip()
    if "/" in s:
        s = s.rsplit("/", 1)[-1]
    return s


def parse_jsonld(html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "html.parser")
    for sc in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(sc.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        items = data if isinstance(data, list) else [data]
        flat = []
        for it in items:
            if isinstance(it, dict) and "@graph" in it:
                flat.extend(it["@graph"])
            else:
                flat.append(it)
        for it in flat:
            if not isinstance(it, dict):
                continue
            t = it.get("@type")
            types = t if isinstance(t, list) else [t]
            if "Product" not in types:
                continue
            offers = it.get("offers")
            if isinstance(offers, list) and offers:
                offers = offers[0]
            if isinstance(offers, dict):
                price = _norm_price(offers.get("price") or offers.get("lowPrice"))
                if price is not None:
                    return {
                        "price": price,
                        "currency": offers.get("priceCurrency"),
                        "availability": _norm_avail(offers.get("availability")),
                        "name": it.get("name"),
                    }
    return None


def parse_og(html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "html.parser")
    p = soup.find("meta", property="product:price:amount") or soup.find("meta", property="og:price:amount")
    cur = soup.find("meta", property="product:price:currency") or soup.find("meta", property="og:price:currency")
    title = soup.find("meta", property="og:title")
    if p and p.get("content"):
        price = _norm_price(p["content"])
        if price is not None:
            return {
                "price": price,
                "currency": cur["content"] if cur and cur.get("content") else None,
                "availability": None,
                "name": title["content"] if title and title.get("content") else None,
            }
    return None


def parse_microdata(html: str) -> Optional[dict]:
    soup = BeautifulSoup(html, "html.parser")
    el = soup.find(attrs={"itemprop": "price"})
    if not el:
        return None
    raw = el.get("content") or el.get_text(strip=True)
    price = _norm_price(raw)
    if price is None:
        return None
    cur_el = soup.find(attrs={"itemprop": "priceCurrency"})
    cur = cur_el.get("content") if cur_el else None
    name_el = soup.find(attrs={"itemprop": "name"})
    name = name_el.get_text(strip=True) if name_el else None
    return {"price": price, "currency": cur, "availability": None, "name": name}


def parse_listing_first(html: str, currency_hint: str = "PLN") -> Optional[dict]:
    soup = BeautifulSoup(html, "html.parser")
    selectors = [
        ".product-price-and-shipping .price",
        ".woocommerce-Price-amount",
        "span.price.product-price",
        ".price ins .amount",
        ".price > .amount",
        ".price-final",
        "span.price",
        ".price",
    ]
    for sel in selectors:
        for el in soup.select(sel):
            txt = el.get_text(" ", strip=True)
            if not txt or len(txt) > 40:
                continue
            price = _norm_price(txt)
            if price and price > 1:
                return {"price": price, "currency": currency_hint, "availability": None, "name": None}
    return None


async def scrape_product(client: httpx.AsyncClient, url: str, currency_hint: str = "PLN") -> Optional[dict]:
    """Returns {'price', 'currency', 'name', 'availability'} or None on failure."""
    try:
        html = await fetch_html(client, url)
    except httpx.HTTPError as e:
        log.warning("scrape_product fetch failed %s: %s", url, e)
        return None
    for fn in (parse_jsonld, parse_og, parse_microdata):
        out = fn(html)
        if out and out.get("price") is not None:
            if not out.get("currency"):
                out["currency"] = currency_hint
            return out
    out = parse_listing_first(html, currency_hint=currency_hint)
    return out


def to_pln(price: Optional[float], currency: Optional[str]) -> Optional[int]:
    if price is None:
        return None
    rate = FX_TO_PLN.get((currency or "PLN").upper(), 1.0)
    return round(price * rate)


# ============================================================================
# SKU keyword extraction & match scoring
# ============================================================================

_STOPWORDS = {
    "do", "z", "i", "w", "na", "po", "lub", "oraz", "dla", "ze", "od",
    "kg", "g", "l", "ml", "szt", "szt.", "opak", "opak.", "para", "pary", "pak",
    "ok", "ok.", "min", "min.", "max", "max.", "około",
    # Verbose descriptors that rarely appear in product titles
    "dni", "sucho", "suchy", "kompozytowy", "uniwersalny", "świeże",
    "klasa", "klasy", "biały", "czarny", "blend",
    # numbers/dimensions usually break exact match
}

_PREMIUM_HINTS = (
    "dry-aged", "dry aged", "dojrzewan", "dojrzewa", "dojrzewa", "premium",
    "wagyu", "angus", "hereford", "tomahawk", "ribeye",
    "extra vergine", "evoo",
    "maldon", "płatkow",
    "tellicherry", "kampot",
)

_QUALITY_FILTERS = {
    "meat": _PREMIUM_HINTS,
    "spices": ("maldon", "płatkow", "tellicherry", "kampot", "premium", "demi-glace"),
    "dry_goods": ("extra vergine", "evoo", "balsamic", "modena"),
    "grill_fuel": ("dębow", "hickory", "jabłon", "premium", "restaurant", "long"),
}


def sku_keywords(sku: dict) -> list[str]:
    """Token list extracted from SKU name (lowercase, normalized). Used both for query
    construction and substring matching (with prefix-stem for Polish inflection)."""
    name = sku["name"].lower()
    name = re.sub(r"\s*\([^)]*\)\s*", " ", name)  # strip parenthetical
    # Replace slashes/dashes with spaces (e.g. "80/20" → "80 20", which then drops as numeric)
    name = re.sub(r"[/\-]", " ", name)
    name = re.sub(r"[^\wąćęłńóśźż\s]", " ", name, flags=re.UNICODE)
    tokens = []
    for t in name.split():
        if len(t) < 3:
            continue
        if t in _STOPWORDS:
            continue
        if t.isdigit():
            continue
        tokens.append(t)
    return tokens


# Polish-aware: stem token to its first 5 letters (handles "polędwica" → "polędw" matching "polędwicy")
def _stem(t: str) -> str:
    return t[:5] if len(t) > 5 else t


def search_queries(sku: dict) -> list[str]:
    """Progressive queries — try most specific first, then broader."""
    tokens = sku_keywords(sku)
    if not tokens:
        return []
    # Anglicized keywords often appear in PL premium-beef product titles ("ribeye", "tomahawk", "picanha")
    # so single-word query is often better than multi-word for these vendors.
    # Build progressive: full → first 3 → first 2 → first 1
    qs = []
    if len(tokens) >= 4:
        qs.append(" ".join(tokens[:4]))
    if len(tokens) >= 3:
        qs.append(" ".join(tokens[:3]))
    if len(tokens) >= 2:
        qs.append(" ".join(tokens[:2]))
    qs.append(tokens[0])
    # Dedup keeping order
    seen = set()
    out = []
    for q in qs:
        if q not in seen:
            seen.add(q)
            out.append(q)
    return out


def primary_query(sku: dict) -> str:
    """Single most-likely query — used by single-shot adapters. Use the first 2 tokens."""
    qs = search_queries(sku)
    return qs[-2] if len(qs) >= 2 else (qs[0] if qs else "")


def score_match(sku: dict, candidate_title: str) -> float:
    """Return 0..1 score. Uses Polish-aware prefix-stem substring matching."""
    if not candidate_title:
        return 0.0
    title = candidate_title.lower()
    sku_toks = sku_keywords(sku)
    if not sku_toks:
        return 0.0
    # A token "matches" the title if its 5-char stem appears in the title (handles inflection)
    overlap = sum(1 for t in sku_toks if _stem(t) in title)
    base = overlap / len(sku_toks)

    # Quality grade gate — premium SKU must have at least one premium hint in title
    if sku.get("quality_grade") == "premium":
        cat_hints = _QUALITY_FILTERS.get(sku.get("category"))
        if cat_hints:
            if not any(h in title for h in cat_hints):
                base *= 0.6  # penalty, may still win if very high overlap
    return base


# ============================================================================
# Per-vendor search adapters — public retail e-shops only
# ============================================================================

@dataclass
class VendorAdapter:
    vendor_id: str
    base_url: str
    search_url_template: str  # {query} placeholder
    result_link_selectors: Sequence[str]
    currency: str = "PLN"
    # Optional override: keep just the query-string-relevant part if needed
    query_transform: Optional[callable] = None  # type: ignore[type-arg]


# Adapters — only for verified, e-commerce vendors with public retail prices.
# Verified 2026-05-01 by HTTP probe + HTML inspection (JSON-LD/WooCommerce/PrestaShop signals).
ADAPTERS: dict[str, VendorAdapter] = {
    "beef-pl": VendorAdapter(
        vendor_id="beef-pl",
        base_url="https://beef.pl",
        search_url_template="https://beef.pl/?s={query}&post_type=product",
        result_link_selectors=(
            "h2.woocommerce-loop-product__title a",
            "a.woocommerce-LoopProduct-link",
            ".products .product .woocommerce-LoopProduct-link",
        ),
    ),
    "bbq-pl": VendorAdapter(
        vendor_id="bbq-pl",
        base_url="https://bbq.pl",
        search_url_template="https://bbq.pl/szukaj?controller=search&s={query}",
        result_link_selectors=(
            ".product-miniature h3.product-title a",
            ".product-miniature h2.product-title a",
            "article.js-product-miniature h3 a",
            "article.js-product-miniature .product-title a",
            ".product-miniature a[title]",
        ),
    ),
    "we-are-bbq-de": VendorAdapter(
        vendor_id="we-are-bbq-de",
        base_url="https://we-are-bbq.de",
        search_url_template="https://we-are-bbq.de/?s={query}&post_type=product",
        result_link_selectors=(
            "h2.woocommerce-loop-product__title a",
            "ul.products li.product a.woocommerce-loop-product__link",
            ".products .product .woocommerce-LoopProduct-link",
        ),
        currency="EUR",
    ),
}


# B2B-gated or no-public-catalog vendors — won't attempt scrape, marked with pricing_status.
B2B_GATED = {
    "makro-pl", "selgros-pl", "bidfood-farutex", "iglotex-pl",
    "polish-premium-beef", "diversey-pl", "ecolab-pl", "metro-de",
    "horeca-it-iberico", "krakowski-rzeznik", "warzywniak-hurt",
    "voigt-pl", "stalgast-pl", "weber-grills-pl",
}


def _resolve_link(base_url: str, href: str) -> str:
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("http"):
        return href
    return urljoin(base_url + "/", href.lstrip("/"))


def _extract_title(a) -> str:
    """Best-effort title extraction from a product anchor — text > title attr > img alt."""
    txt = a.get_text(" ", strip=True)
    if txt and len(txt) >= 3 and txt.lower() not in {"wybierz opcje", "dodaj do koszyka", "zobacz"}:
        return txt
    if a.get("title"):
        return a["title"]
    img = a.find("img")
    if img and img.get("alt"):
        return img["alt"]
    return txt or ""


async def _search_one_query(
    client: httpx.AsyncClient, adapter: VendorAdapter, query: str
) -> dict[str, str]:
    """Run a single search query and return {url: best_title} for product cards on the result page."""
    search_url = adapter.search_url_template.format(query=quote_plus(query))
    try:
        html = await fetch_html(client, search_url)
    except httpx.HTTPError as e:
        log.warning("search HTTP error %s [%s]: %s", adapter.vendor_id, query, e)
        return {}

    soup = BeautifulSoup(html, "html.parser")
    by_url: dict[str, str] = {}
    for sel in adapter.result_link_selectors:
        for a in soup.select(sel):
            href = a.get("href")
            if not href or href.startswith("javascript:") or href == "#":
                continue
            full = _resolve_link(adapter.base_url, href)
            # Filter obvious non-product URLs
            if "/szukaj" in full or "/search" in full:
                continue
            if any(seg in full for seg in ("/koszyk", "/cart", "/account", "/login", "/register")):
                continue
            title = _extract_title(a)
            if title and len(title) > len(by_url.get(full, "")):
                by_url[full] = title
            elif full not in by_url:
                by_url[full] = title
    return by_url


async def find_product_url(
    client: httpx.AsyncClient, adapter: VendorAdapter, sku: dict
) -> Optional[tuple[str, str]]:
    """Try progressive queries; return (product_url, candidate_title) of best match across all queries."""
    queries = search_queries(sku)
    if not queries:
        return None

    all_candidates: dict[str, str] = {}  # union over all queries
    for q in queries:
        found = await _search_one_query(client, adapter, q)
        for url, title in found.items():
            if title and len(title) > len(all_candidates.get(url, "")):
                all_candidates[url] = title
            elif url not in all_candidates:
                all_candidates[url] = title
        # If first query already has plenty of decent candidates, don't bother broadening
        if len(found) >= 5:
            break

    if not all_candidates:
        log.info("no candidates for %s [%s] (tried %d queries)", adapter.vendor_id, sku["id"], len(queries))
        return None

    scored = [(score_match(sku, title), url, title) for url, title in all_candidates.items() if title]
    scored.sort(key=lambda x: -x[0])
    if not scored:
        return None
    best_score, best_url, best_title = scored[0]
    if best_score < 0.25:
        log.info("best match too weak %.2f for %s [%s] (best='%s')",
                 best_score, adapter.vendor_id, sku["id"], best_title[:60])
        return None
    return best_url, best_title


async def scrape_vendor_sku(
    client: httpx.AsyncClient, adapter: VendorAdapter, sku: dict
) -> Optional[dict]:
    """Returns line_item dict or None."""
    found = await find_product_url(client, adapter, sku)
    if not found:
        return None
    product_url, candidate_title = found
    parsed = await scrape_product(client, product_url, currency_hint=adapter.currency)
    if not parsed or parsed.get("price") is None:
        return None

    price = parsed["price"]
    currency = (parsed.get("currency") or adapter.currency).upper()
    price_pln = to_pln(price, currency)
    unit = sku.get("unit", "szt")

    if currency == "PLN":
        label = f"{round(price)} PLN/{unit}"
    else:
        sym = {"EUR": "€", "USD": "$", "GBP": "£"}.get(currency, currency)
        label = f"{sym}{price:.2f}/{unit} (~{price_pln} PLN)"

    return {
        "part_id": sku["id"],
        "unit_price_pln": price_pln,
        "unit_price_label": label,
        "product_url": product_url,
        "matched_title": candidate_title or parsed.get("name"),
    }
