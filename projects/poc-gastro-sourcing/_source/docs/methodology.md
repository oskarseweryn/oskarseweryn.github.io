# Metodologia — co agent zakłada, co weryfikuje, czego NIE robi

## Co snapshot pokrywa

Każde uruchomienie `/gastro-sourcing` weryfikuje predefiniowaną pulę dostawców z `data/vendors_seed.json` (~20 dostawców) wobec predefiniowanego koszyka z `data/basket_seed.json` (~25 SKU w 7 kategoriach) dla klienta zdefiniowanego w `data/client_profile.json`.

Pula jest zamknięta — agent **nie szuka nowych dostawców** ani **nie dodaje nowych SKU** podczas refreshu. Skalę puli zmienia się przez edycję plików seed; agent dopiero wtedy przy następnym uruchomieniu pokrywa nowy zakres.

## Hierarchia decyzji

1. **categories_served** filtruje koszyk per dostawca. Rzeźnik (`carnivor-pl`) dostaje tylko SKU z kategorii `meat`. Diversey (`diversey-pl`) tylko `chemistry`. Makro (`makro-pl`) — wszystkie 6 kategorii oprócz `grill_fuel`.
2. **quality_grade** chroni przed niepasującym matchem. Premium SKU (ribeye dry-aged 30d) **nie jest** mapowany do commodity ribeye (świeży, choice grade). Jeśli najbliższy dostępny match jest commodity, agent flaguje to w `vendor.notes` i zostawia `unit_price_pln: null`.
3. **freshness** wyklucza dostawców niespełniających cold-chain. Mięso (`fresh`) z CN nie wchodzi nigdy. EU mięso wymaga deklaracji łańcucha chłodniczego — bez tego flag w notes "weryfikacja cold chain".
4. **Region toggle UI** filtruje wyświetlanie. CN dostawcy są obsługiwani tylko dla kategorii `accessories` przez konstrukcję `categories_served` w seed.

## Co agent weryfikuje

- **Cena katalogowa per SKU** — przez `WebFetch` strony produktu lub kategorii. Ceny brutto detaliczne (PL) / netto B2B po zalogowaniu / EUR netto (EU).
- **Email kontaktowy B2B** — preferencja: `biuro@`, `b2b@`, `hurt@`, `gastro@`, `horeca@`. Cloudflare obfuscation (`__cf_email__`) jest dekodowane lokalnie w agencie.
- **Lead time** jeśli widoczny na stronie ("dostawa 24h", "1-3 dni").
- **Min order value** z karty B2B / regulaminu sklepu.
- **Atesty HACCP / cold chain** — flag w notes jeśli widoczne (chemia) lub deklarowane (mięso/fresh).

## Czego agent NIE zakłada

- **Brak rabatów hurtowych w snapshot.** Wszystkie ceny to katalog/detal. Realne ceny B2B wracają przez RFQ wysłane stąd.
- **Brak zmyślonych emaili.** Jeśli dostawca publikuje tylko formularz, `email: null` + `contact_url` wypełniony.
- **Brak fabrykowanych cen FOB dla CN.** CN dostawcy = `line_items: []` z założenia. Email RFQ w EN jest deliverablem.
- **Brak predykcji cen mięsa świeżego.** Ceny premium beef zmieniają się tygodniowo — snapshot reprezentuje stan dnia odświeżania.
- **Brak doliczania cła + VAT do CN cen.** Jeśli odpowiedź RFQ wraca z fabryki w USD FOB, użytkownik liczy landed-PLN samodzielnie (cło 0-12% + VAT 23% na FOB+cło+fracht). v2 backlog: kalkulator landed-cost.
- **Brak doliczania kosztów logistyki cross-border.** Cena z METRO Deutschland to cena hurtowni w DE; transport do Krakowa negocjowany osobno.

## Inferencje agenta (oznaczone)

Jedyne wnioskowania które agent wykonuje:
- **Konwersja FX** EUR/USD/GBP/CNY → PLN po stałych kursach z `snapshot.fx_note`. Kurs jest oznaczony w `unit_price_label` (np. `"€18,90/kg (~81 PLN/kg)"`).
- **Mapowanie equivalent-SKU w obrębie tego samego quality_grade** — np. "ribeye dry-aged 30 dni IE origin" ↔ "antrykot dojrzewany 30+ dni IE/UK". Różnice spec są flagowane w `vendor.notes` jeśli istotne (np. dostępna tylko kalibracja 250-280 g zamiast 280-320 g).
- **Walidacja min order value** — jeśli suma koszyka u dostawcy < `min_order_value_pln`, flag w UI ("⚠ koszyk poniżej min. zamówienia").

## Schemat snapshot.json

```jsonc
{
  "last_updated": "YYYY-MM-DD",
  "client": { "name": "...", "city": "...", "ship_to": "...", "currency": "PLN" },
  "categories": [{ "id": "meat", "name_pl": "Mięso", "icon": "🥩", "color": "#b91c1c" }],
  "fx_note": "...",
  "pricing_note": "...",
  "basket": [
    {
      "id": "ribeye-dry-aged-30d",
      "category": "meat",
      "name": "...",
      "spec": "...",
      "unit": "kg" | "l" | "szt" | "opak" | "para",
      "qty_default": 60,
      "quality_grade": "premium" | "commodity",
      "freshness": "fresh" | "frozen" | "ambient",
      "use": "..."
    }
  ],
  "vendors": [
    {
      "id": "kebab-case",
      "name": "...",
      "country": "PL",
      "region": "PL" | "EU" | "CN",
      "language": "pl" | "de" | "en",
      "homepage": "https://...",
      "contact_url": "https://...",
      "email": "biuro@..." | null,
      "lead_time": "24-48h" | null,
      "min_order_value_pln": 500,
      "categories_served": ["meat", "fresh", ...],
      "notes": "...",
      "line_items": [
        {
          "part_id": "ribeye-dry-aged-30d",
          "unit_price_pln": 89,
          "unit_price_label": "89 PLN/kg",
          "product_url": "https://..."
        }
      ],
      "email_draft": { "subject": "...", "body": "..." } | null
    }
  ]
}
```

`email_draft: null` oznacza dostawcę typu "sklep z publicznymi cenami" — UI pokazuje przycisk "Otwórz sklep" zamiast generatora RFQ. Dla `region: "CN"` `line_items` zawsze `[]`.

## Walidacja jakości danych

Pre-write checklist agenta:
- [ ] Każdy `unit_price_pln` ma towarzyszący `product_url`.
- [ ] Brak `email` z domeny innej niż `vendor.homepage` (chroni przed copy-paste z innego źródła).
- [ ] Każdy `line_item.part_id` istnieje w `basket`.
- [ ] Każdy `vendor.categories_served` element istnieje w `categories`.
- [ ] Dla `region: "CN"` — `line_items: []` i `email_draft.language: "en"`.
- [ ] Dla `freshness: "fresh"` w meat/fresh — żaden `line_item` od dostawcy z `region: "CN"`.

Niespełnienie któregokolwiek powoduje warning w summary.
