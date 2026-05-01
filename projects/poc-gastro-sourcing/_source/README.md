# POC: Gastro Sourcing — porównywarka cen dostawców HoReCa dla restauracji

> **Statyczna strona, która porównuje polskich + unijnych + chińskich dostawców
> gastronomicznych bok-w-bok i daje gotowe, spersonalizowane zapytanie B2B (RFQ)
> pod każdego z nich.**
> Zbudowany na potrzeby steakhouse'u "Butchers Grill" w Krakowie (cel: obniżenie food cost),
> ale architektura jest generyczna — zmiana koszyka i profilu klienta = onboarding kolejnej
> restauracji bez dotykania kodu strony. Działa na GitHub Pages, odświeżany przez slash command Claude Code.

[**→ live demo**](./site/index.html)
[**→ snapshot data**](./site/snapshot.json)
[**→ onboarding nowej restauracji**](./docs/onboarding_new_client.md)

---

## Co widać

Jedna strona, w niej:

- **7 kategorii produktów** (Mięso · Świeże · Przyprawy · Suchy magazyn · Chemia · Akcesoria · Paliwa grillowe) — pills u góry filtrują koszyk i tabelę dostawców do wybranej kategorii albo pokazują wszystko
- **Region**: Tylko Polska · Polska + UE · Polska + UE + Chiny (akcesoria — CN nie obsługuje świeżych)
- **Koszyk SKU pogrupowany po kategoriach**: zaznacz/odznacz pozycje, edytuj miesięczne ilości; każdy SKU oznaczony badge'ami `premium`/`commodity` (chroni przed niewłaściwym matchem) i `fresh`/`ambient` (wpływa na cold-chain logistykę)
- **Tabela porównawcza dostawców**: dostawca · kraj · kategorie obsługiwane · pokrycie SKU · suma koszyka w PLN · czas dostawy · email
- **Klik w wiersz** → szczegóły rozwijają się pod spodem: lista pozycji koszyka u tego dostawcy (filtrowana do jego categories_served) z cenami jednostkowymi i sumami, oraz spersonalizowane RFQ B2B w odpowiednim języku (PL · DE · EN), z kopiowaniem do schowka i `mailto:` jednym kliknięciem
- **Matryca cen jednostkowych SKU × Dostawca** — sticky-column tabela z grupowaniem po kategorii, najtańszy dostawca per SKU oznaczony zielonym tłem
- **Min order value flag** — jeśli koszyk u dostawcy jest poniżej minimum B2B, wiersz dostaje żółty znacznik

Brak założenia rabatu hurtowego. Suma koszyka to ceny katalogowe × ilość miesięczna. Realne wartości B2B wracają z odpowiedzi na RFQ wysłane stąd.

### Region CN — RFQ-only, tylko akcesoria

Chińskie fabryki HoReCa B2B **nie publikują cen jednostkowych** na stronach — wyceniają każde zamówienie indywidualnie (FOB USD). Wiersze CN pokazują żółtą plakietkę "RFQ" zamiast ceny, są sortowane na koniec tabeli, a treść maila jest deliverable. Z założenia CN obsługuje **tylko kategorię `accessories`** — fartuchy skórzane, noże, deski, termometry, szczotki do rusztu. Mięso świeże, warzywa i mleko nie wchodzą w grę z powodu cold-chain i regulacji weterynaryjnych UE.

RFQ pyta o:
- cenę FOB USD per SKU + tier ×1 i ×2,
- MOQ + lead time,
- fracht morski (Gdańsk) + lotniczy (próbka),
- politykę próbek + Trade Assurance,
- certyfikaty (CE dla termometrów, REACH dla skórzanych fartuchów),
- OEM/branding (logo lokalu na deskach do serwowania).

## Dlaczego to działa dla klienta (steakhouse)

Właściciel restauracji nie musi:
- ręcznie kontaktować 15-20 dostawców HoReCa w 6 kategoriach (mięso, świeże, chemia, akcesoria, paliwo, przyprawy),
- znajdować emaila B2B na każdej stronie (większość HoReCa wholesalerów nie publikuje cen — wymagana rejestracja + account manager),
- tłumaczyć zapytania na DE i EN przy zamówieniach z UE / Chin,
- śledzić, który dostawca pokrywa które kategorie (rzeźnik nie sprzedaje chemii; Diversey nie sprzedaje mięsa),
- pisać tego samego maila do 15 dostawców rozbitego po kategoriach,
- pamiętać o wskazaniu wymogów branżowych (atest HACCP dla chemii, cold chain dla mięsa, atest QMP dla polskiej premium wołowiny, certyfikat F-Gaz... znaczy, to było HVAC).

Strona dostarcza: ranking dostawców po sumie koszyka per kategoria, email pod każdego, gotowe RFQ z konkretnymi SKU, które dany dostawca obsługuje. **Klika "Otwórz w poczcie" i wysyła.**

## Architektura

```
   ┌──────────────────────────────────────────────────────────┐
   │ GitHub Pages (statyczne)                                 │
   │   site/index.html  +  style.css  +  app.js               │
   │           ↓ fetch                                        │
   │   site/snapshot.json                                     │
   └──────────────────────────────────────────────────────────┘
                              ↑ rewrites
                              │
   ┌──────────────────────────────────────────────────────────┐
   │ /gastro-sourcing  (slash command Claude Code)            │
   │   • Załaduj client_profile + categories + basket_seed    │
   │     + vendors_seed                                       │
   │   • Per dostawca PL/EU: filtruj koszyk po                │
   │     categories_served → WebFetch ceny + email            │
   │   • Per dostawca CN: line_items=[], wygeneruj EN RFQ     │
   │   • Personalizuj email_draft (PL/DE/EN) per dostawca     │
   │   • Zapisz site/snapshot.json                            │
   └──────────────────────────────────────────────────────────┘
```

Strona jest **w pełni statyczna** — zero kosztu runtime per odwiedzający. Odświeżanie offline przez slash command, **rozliczane z subskrypcji Claude Code Max**, nie z metered API. Odwiedzający nigdy nie wywołuje LLMa.

## Generyczność: jeden silnik, N restauracji

Pula dostawców (`data/vendors_seed.json`) i kategorie (`data/categories.json`) są **branżowe** i nie zmieniają się między klientami. Per restaurację zmienia się **tylko**:

- `data/client_profile.json` — nazwa, lokalizacja, profil kuchni, pain points
- `data/basket_seed.json` — własny koszyk SKU (15-30 pozycji w 7 kategoriach)

Onboarding nowego klienta = podmiana tych 2 plików + uruchomienie `/gastro-sourcing`. Bez dotykania HTML, CSS, JS, slash command, ani puli dostawców.

Pełna instrukcja: [docs/onboarding_new_client.md](./docs/onboarding_new_client.md).

## Layout repo

```
poc-gastro-sourcing/
├── README.md                                  # ten plik
├── site/                                      # ← root deployu GitHub Pages
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── snapshot.json                          # przepisywane przez slash command
├── .claude/
│   └── commands/
│       └── gastro-sourcing.md                 # slash command odświeżania
├── data/
│   ├── categories.json                        # 7 kategorii (zamknięta lista, pod UI)
│   ├── client_profile.json                    # profil klienta — Butchers Grill Kraków
│   ├── basket_seed.json                       # 25 SKU koszyka (per klient)
│   └── vendors_seed.json                      # ~20 dostawców PL/EU/CN (branżowy)
├── docs/
│   ├── methodology.md                         # jak agent rozumuje, co NIE jest zakładane
│   └── onboarding_new_client.md               # jak sklonować POC pod inną restaurację
└── reports/                                   # wcześniejsze wersje (CLI / markdown)
```

## Deployment

```
Settings → Pages → Source: Deploy from a branch → main → /site
```

Bez build stepu, bez backendu.

## Workflow odświeżania

```bash
$ cd poc-gastro-sourcing
$ claude
> /gastro-sourcing

→ odświeża site/snapshot.json: ceny SKU, pokrycie per kategoria, emaile, RFQ
→ commit + push → GitHub Pages podchwytuje automatycznie
```

Slash command bierze opcjonalny argument `client_id` (domyślnie z `data/client_profile.json`). Strona pozwala skalować ilości miesięczne live; refresh nie zmienia ilości w `basket_seed.json` — domyślnie używa `qty_default`.

## Backlog v2

- **Reply parser** — wgranie odpowiedzi B2B (PDF / email body) → automatyczne wypełnienie cen hurtowych w tabeli. **Najsilniejszy ROI dla gastronomii** bo HoReCa wholesalerzy w 90% przypadków nie publikują cen B2B online; cały realny porównawczy materiał wraca w odpowiedziach.
- **Tygodniowy scheduled refresh** — scheduled GitHub Action: diff vs poprzedni snapshot → "Carnivor obniżył cenę ribeye dry-aged 30d o 8%" lub "Iglotex podniósł cenę mielonej brisket+chuck o 12%". Dla mięsa premium — tygodniowa zmienność cen jest realna i materialna.
- **Auto-przelicznik landed-cost CN** — po wprowadzeniu odpowiedzi z fabryki CN (FOB USD + fracht): doliczanie cła UE (0-12%), VAT 23%, opłat brokerskich → porównywalna cena PLN do EU akcesoriów.
- **Multi-tenant** — `tenants/butchers-grill-krakow/`, `tenants/inna-restauracja/` z osobnymi `basket_seed.json` i `client_profile.json`, ten sam vendor pool, kategorie, kod strony i slash command. Strona z `?tenant=...` query param.
- **Food cost calculator** — basket → recipe ratios → koszt na danie z karty → realny food cost % miesięczny jako KPI dashboard.
- **Owner-only refresh button** na stronie z `CLAUDE_CODE_OAUTH_TOKEN` — odświeżanie z dowolnego urządzenia bez lokalnego Claude Code.
- **Lokalni dostawcy bez sklepu online** — bazar Stary Kleparz, lokalni rzeźnicy bez strony, kontakt telefoniczny / WhatsApp; wpisywani ręcznie, snapshot zachowuje numer + WhatsApp link zamiast WebFetch.

## Notatki o jakości danych

Snapshot pokrywa ~20 predefiniowanych dostawców weryfikowanych przez `WebSearch` + `WebFetch`. Dla PL/EU dostawców z publicznymi cenami — cena to opublikowana cena katalogowa / detaliczna ze strony w dniu odświeżania. Dla dostawców HoReCa wymagających rejestracji B2B (Bidfood, Diversey, Ecolab) — `unit_price_pln: null` z notatką "B2B — login wymagany / kontakt z account managerem"; cena wraca przez RFQ.

**Brak założonych rabatów hurtowych, brak zmyślonych wycen, brak syntetycznych FOB.** Jedyna inferencja agenta to przeliczenie kursu (oznaczone w `unit_price_label`) i mapowanie equivalent-SKU **w obrębie tego samego quality_grade** — premium SKU nie jest dopasowywany do commodity i odwrotnie. W spornych przypadkach flag w `vendor.notes`.

CN wiersze pokazują "RFQ" zamiast ceny, ponieważ uczciwa reprezentacja "jeszcze nie wiemy" jest bardziej użyteczna niż wymyślona liczba.

## Notatki o tym POC

Zbudowany jako **kolejna iteracja silnika** sprawdzonego w `kimono-sourcing` (porównywarka kimon judo) i `poc-hvac-parts-pricing` (porównywarka części HVAC). Stos zostaje (statyczna strona + JSON + slash command), zmienia się domena i sposób kategoryzacji. Dla gastronomii dochodzi:
- 7-kategoriowy filtr (HoReCa jest naturalnie multi-kategorialna),
- `categories_served` per dostawca (specjalizacje mocniejsze niż w HVAC/judo),
- `quality_grade` + `freshness` (premium beef ≠ commodity beef, fresh ≠ ambient),
- `min_order_value_pln` (HoReCa wholesalerzy mają minima 200-2000 PLN),
- jednostki mieszane (kg/l/szt/opak/para zamiast jednoznacznego "szt").

To zamierzone: dowodzi, że paradygmat **predefiniowany koszyk × predefiniowani dostawcy → uzupełnione przez LLM podczas refreshu** skaluje się 1:1 między pionami (sport → HVAC → gastronomia), a kolejne pionki dodają tylko domain-specific fields, nie zmieniają architektury.

Czas budowy: ~60 min Claude Code z subskrypcji Max. Zewnętrzne integracje: tylko `WebSearch` + `WebFetch`. Strona to czysty HTML + vanilla JS, bez frameworka.
