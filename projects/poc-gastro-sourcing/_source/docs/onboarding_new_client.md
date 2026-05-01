# Onboarding nowej restauracji

POC jest zaprojektowany generycznie: pula dostawców (`data/vendors_seed.json`) i kategorie (`data/categories.json`) są **branżowe** i nie zmieniają się między klientami. Per restaurację zmienia się **tylko** profil i koszyk.

## Krok 1 — sklonuj repo lub fork

```bash
gh repo fork oskarseweryn/poc-gastro-sourcing --clone --fork-name=gastro-sourcing-MOJA-RESTAURACJA
cd gastro-sourcing-MOJA-RESTAURACJA
```

Albo, jeśli jest to drugi klient w tym samym repo, wystarczy podmiana 2 plików (patrz krok 4).

## Krok 2 — uzupełnij `data/client_profile.json`

Pola do edycji:
- `client.id` — kebab-case, używany w mailto/RFQ
- `client.name` — wyświetlany w nagłówku strony i RFQ
- `client.type` — `steakhouse` / `casual_dining` / `pizzeria` / `cafe` / ... — wpływa na ton emaila
- `client.tagline` — jednolinijkowy opis, widoczny na stronie
- `client.city`, `client.ship_to`, `client.country` — ważne dla cold chain i regionu kontrastywnego
- `client.monthly_food_cost_target_pct` — referencyjny target (zwykle 28-32%)
- `client.kitchen_profile` — jaki rodzaj kuchni, źródło ognia, profil dań — wpływa na to, które kategorie są dla klienta priorytetowe
- `client.procurement_pain_points` — lista bieżących bólów; agent może je referować w treści RFQ

## Krok 3 — przebuduj `data/basket_seed.json`

Koszyk to ~15-30 SKU pokrywających kategorie istotne dla danej restauracji. Per SKU:
- `id` — kebab-case unique
- `category` — musi istnieć w `data/categories.json` (`meat` / `fresh` / `spices` / `dry_goods` / `chemistry` / `accessories` / `grill_fuel`)
- `name`, `spec` — w PL, używane w UI i mailach
- `unit` — `kg` / `l` / `szt` / `opak` / `para`
- `qty_default` — typowa **miesięczna** ilość przy bieżącej skali ruchu
- `quality_grade` — `premium` / `commodity` (chroni przed niewłaściwym matchem podczas refreshu)
- `freshness` — `fresh` / `frozen` / `ambient`
- `use` — krótki opis zastosowania kulinarnego

### Wskazówki per typ restauracji

- **Steakhouse** — mocna obsada `meat` (6-8 SKU różnych kawałków + grades), umiarkowana `fresh`, mocna `grill_fuel`.
- **Pizzeria** — minimalna `meat`, mocna `dry_goods` (mąka, oliwa), mocna `fresh` (pomidory, mozzarella, bazylia), `accessories` (akcesoria do pieca).
- **Sushi bar** — bardzo mocna `fresh` (ryby, wodorosty), `dry_goods` (ryż, ocet ryżowy, sos sojowy), specyficzne `accessories` (maty bambusowe, noże).
- **Cafe / brunch** — głównie `fresh` + `dry_goods` (mąki, kawa), `accessories` (filtry, młynki), `chemistry` (mycie ekspresów).

W każdym przypadku `chemistry` i częściowo `accessories` pozostają zbliżone — to "opex floor" każdej kuchni.

## Krok 4 — opcjonalnie: dodaj branżowych dostawców

Jeśli restauracja jest specyficzna (sushi, pizzeria), dodaj 2-5 dostawców z jej niszy do `data/vendors_seed.json`:

```jsonc
{
  "id": "sushi-station-pl",
  "name": "Sushi Station Hurt",
  "country": "PL",
  "region": "PL",
  "url": "https://sushistation.pl",
  "categories_served": ["fresh", "dry_goods"],  // ryby + ryż/sosy
  "min_order_value_pln": 800,
  "delivery_areas": "PL nationwide chłodnicza",
  "notes": "Specjalista sushi-grade ryb i akcesoriów japońskich."
}
```

`vendor.id` musi być unikalny w pliku.

## Krok 5 — odśwież snapshot

```bash
claude
> /gastro-sourcing
```

Slash command:
1. Załaduje `client_profile.json`, `basket_seed.json`, `vendors_seed.json`, `categories.json`.
2. Per dostawca PL/EU: filtruje koszyk po `categories_served`, WebFetch'uje strony, zbiera ceny + emaile.
3. Generuje per-vendor `email_draft` w odpowiednim języku, referując **konkretny basket nowego klienta**.
4. Zapisuje `site/snapshot.json`.

## Krok 6 — deploy

```bash
git add data/ site/snapshot.json
git commit -m "Onboard nowego klienta: <nazwa>"
git push
```

Jeśli forkowałeś repo, ustaw GitHub Pages: `Settings → Pages → main → /site`.

## Multi-tenant w jednym repo (v2)

Dla obsługi N restauracji bez forkowania, struktura `tenants/` w v2:

```
poc-gastro-sourcing/
├── tenants/
│   ├── butchers-grill-krakow/
│   │   ├── client_profile.json
│   │   ├── basket_seed.json
│   │   └── snapshot.json
│   └── another-restaurant/
│       ├── client_profile.json
│       ├── basket_seed.json
│       └── snapshot.json
├── data/
│   ├── categories.json         # globalne, współdzielone
│   └── vendors_seed.json       # globalne, współdzielone
└── site/
    └── index.html?tenant=butchers-grill-krakow  # query param wybiera tenant
```

Slash command z arg: `/gastro-sourcing tenant=another-restaurant`.

Nie wdrożone w v1 — POC trzyma się 1 klient = 1 repo dla prostoty narracji portfolio.
