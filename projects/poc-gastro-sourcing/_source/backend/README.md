# Backend — scraper cen dostawców gastronomicznych

CLI Pythonowy, który pobiera ceny detaliczne z publicznych sklepów PL/EU i wpisuje je do `site/snapshot.json` jako `line_items`. Strona statyczna potem renderuje matrix porównawczy bez kosztu runtime.

## Wykluczone

- **Region CN** — wykluczony z założenia (per polecenie klienta).
- **Dostawcy B2B-login** (Makro, Selgros, Bidfood, Diversey, Ecolab, METRO, Iglotex, Polish Premium Beef, Voigt, Stalgast, Weber, lokalny rzeźnik, hurtownie warzywne) — nie da się pobrać cen anonimowo, oznaczeni `pricing_status: "b2b_login_required"` w UI.

## Adaptery (zweryfikowane)

| Vendor | Platform | Kategorie | Test | Trafność |
|---|---|---|---|---|
| `beef-pl` | WooCommerce | meat | JSON-LD | 4/6 SKU |
| `bbq-pl` | PrestaShop | meat, spices, accessories, grill_fuel | JSON-LD + microdata | 7/16 SKU |
| `we-are-bbq-de` | WooCommerce (DE) | spices, grill_fuel | JSON-LD | 1/6 SKU |

Ostatni przebieg: 12 line_items na 3 dostawcach w 11 sekund.

## Użycie

```bash
# Stwórz venv, zainstaluj zależności (jednorazowo)
cd poc-gastro-sourcing
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt

# Pełny refresh
.venv/bin/python backend/main.py refresh

# Tylko jeden dostawca
.venv/bin/python backend/main.py refresh --vendor bbq-pl

# Dry run (bez zapisu snapshot.json)
.venv/bin/python backend/main.py refresh --dry-run

# Lista wszystkich znanych adapterów + B2B-gated
.venv/bin/python backend/main.py list
```

## Jak działa

1. **Załaduj** `site/snapshot.json` (basket + vendors + categories).
2. **Per dostawca z adapterem** (PL/EU shop-style):
   - Filtruje koszyk do `vendor.categories_served`.
   - Per SKU buduje progresywne zapytania (`tokens[:4]`, `tokens[:3]`, `tokens[:2]`, `tokens[0]`) — najbardziej szczegółowe pierwsze.
   - Wysyła do `vendor.search_url_template`, parsuje listę wyników CSS-selektorami z adaptera.
   - Dla każdego URL bierze najdłuższy widoczny tytuł (anchor z imageemtem ma czasem pusty tekst).
   - Score: % nakładki tokenów (z polskim stemowaniem do 5 znaków — `polędwica` ↔ `polędwicy`) + gate `quality_grade` (premium SKU musi mieć premium-hint w tytule).
   - Najlepszy (score ≥ 0.25) wybierany; jeśli wszystkie poniżej progu → odrzucone (`failures` log).
3. **Per dostawca B2B-gated** — `line_items: []` + `pricing_status: "b2b_login_required"`. UI pokaże żółtą plakietkę "B2B login".
4. **Per dostawca CN** — usunięty z seed.
5. **Zapis** `site/snapshot.json` z `pricing_status` per dostawcę.

## Schemat line_item zapisany w snapshot.json

```json
{
  "part_id": "ribeye-dry-aged-30d",
  "unit_price_pln": 132,
  "unit_price_label": "132 PLN/kg",
  "product_url": "https://beef.pl/produkt/...",
  "matched_title": "RibEye z urugwajskiej wołowiny Angus"
}
```

`matched_title` jest renderowany w UI jako kursywa pod nazwą SKU — pozwala użytkownikowi zweryfikować dopasowanie agenta (np. zobaczyć, że `tomahawk-bone-in` zostało dopasowane do `Tomahawk Premium – Jałówka`, a nie do innego steaka).

## Znane ograniczenia

- **bbq.pl ceny per cała sztuka, nie per kg** — dla SKU sprzedawanych jako całość (np. polędwica 2.5 kg za 974 PLN) mój label `974 PLN/kg` jest mylący. JSON-LD nie eksponuje per-kg jako osobne pole. Workaround: `matched_title` w UI pokazuje "Polędwica wołowa Black Angus USA" — użytkownik widzi, że chodzi o całą sztukę.
- **Polska odmiana fleksyjna** — stemmer prefiksowy 5-znakowy łapie większość przypadków (`polędwica`/`polędwicy`/`polędwicę`), ale nie radzi sobie z drastyczną odmianą (`mięso`/`mięsa`). Dla najgorszych przypadków warto rozszerzyć `_STOPWORDS` lub dodać alias w basket entry.
- **Search returning fallback "best seller" gdy brak match** — niektóre PrestaShop-y (bbq.pl) zamiast pustej listy zwracają popularne produkty. Mój scoring odrzuca je jako 0.00 (poprawnie), ale wpisy `failures: tomahawk-bone-in (best='Stek z antrykotu')` w logu mogą sugerować błąd dopasowania, gdy w rzeczywistości to brak SKU u dostawcy.
- **Brak walidacji świeżości** — nie sprawdzam dat ani stocku; przyjmuję, że jeśli produkt jest na stronie z ceną, to jest dostępny.

## Rozszerzanie

Aby dodać nowy adapter, edytuj `backend/scrapers.py` → słownik `ADAPTERS`:

```python
"new-vendor-id": VendorAdapter(
    vendor_id="new-vendor-id",
    base_url="https://example.pl",
    search_url_template="https://example.pl/szukaj?q={query}",
    result_link_selectors=(
        # CSS selectors for product card anchors on search results page
        ".product-list .product a",
        ".items article h3 a",
    ),
    currency="PLN",  # or "EUR" for DE/IT/ES vendors
),
```

Następnie usuń ten ID z `B2B_GATED` (jeśli tam był) i uruchom `python backend/main.py refresh --vendor new-vendor-id --dry-run`.
