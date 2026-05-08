// FMCG Arbitrage Scanner — static site logic.
// Loads snapshot.json + catalog_seed.json + markets_seed.json, computes landed cost
// for every (offer, sell_country) pair, identifies best-buy / best-sell country per
// variant, and renders: top arbitrage paths, per-variant matrices, brand summaries.

const COUNTRIES = ['PL', 'DE', 'FR', 'IT', 'ES', 'NL'];

let SNAPSHOT = null;
let CATALOG = null;
let MARKETS = null;
let MODE = 'B2B'; // 'B2B' (palletized parallel-import) or 'CONSUMER' (parcel)
let SHOW_ALL_PATHS = false;

(async function init() {
  SNAPSHOT = await fetch('snapshot.json').then(r => r.json());
  CATALOG = { brands: SNAPSHOT.brands, variants: SNAPSHOT.variants };
  MARKETS = { countries: SNAPSHOT.countries };
  renderMeta();
  document.querySelectorAll('input[name=mode]').forEach(el => {
    el.addEventListener('change', e => { MODE = e.target.value; renderAll(); });
  });
  const showAllEl = document.getElementById('show-all-paths');
  if (showAllEl) showAllEl.addEventListener('change', e => { SHOW_ALL_PATHS = e.target.checked; renderTopPaths(); });
  renderAll();
})();

// ---------- helpers ----------

function variantById(id) { return CATALOG.variants.find(v => v.id === id); }
function brandById(id) { return CATALOG.brands.find(b => b.id === id); }
function vatCategoryFor(variant) {
  // Map variant → VAT category key used in markets_seed.json
  const brand = brandById(variant.brand_id);
  if (brand.category === 'hazelnut_cocoa_spread') return 'food_spread';
  if (brand.category === 'energy_drink') return 'energy_drink';
  if (variant.flavor === 'zero_sugar' || variant.flavor === 'sugarfree') return 'diet_beverage';
  return 'sweetened_beverage';
}
function offersFor(variantId, country) {
  return SNAPSHOT.offers.filter(o => o.variant_id === variantId && o.country === country && o.in_stock);
}
function toEur(price, currency) { return price * SNAPSHOT.fx_to_eur[currency]; }

// ---------- sugar tax computation ----------

function sugarTaxPerUnitEur(variant, country) {
  const m = MARKETS.countries[country];
  const tax = m.sugar_tax;
  if (!tax || tax.type === 'none' || tax.type === 'deferred' || tax.type === 'regional_only') return 0;
  const sizeMl = variant.size_ml;
  if (!sizeMl) return 0; // applies only to beverages
  const liters = sizeMl / 1000;

  if (tax.type === 'tiered_per_liter') {
    // Poland: 0.50 PLN fixed if has_sugar OR has_sweetener; +0.05 PLN per g sugar excess >5g/100ml; +0.10 PLN/L if caffeine/taurine; cap 1.20 PLN/L.
    const sugar = variant.sugar_g_per_100ml || 0;
    const isDietWithSweetener = sugar === 0 && (variant.flavor === 'zero_sugar' || variant.flavor === 'sugarfree');
    const fixed = (sugar > 0 || isDietWithSweetener) ? tax.fixed_charge_per_l_pln : 0;
    const excess = Math.max(0, sugar - tax.excess_threshold_g_per_100ml);
    const variable = excess * tax.variable_charge_per_g_excess_pln;
    const ct = (variant.contains_caffeine || variant.contains_taurine) ? tax.caffeine_taurine_extra_per_l_pln : 0;
    let perL = fixed + variable + ct;
    perL = Math.min(perL, tax.cap_per_l_pln);
    return perL * liters * SNAPSHOT.fx_to_eur.PLN;
  }
  if (tax.type === 'tiered_per_hl') {
    // France: tiers + diet rate + taurine
    const sugarPerL = (variant.sugar_g_per_100ml || 0) * 10;
    let perHl = 0;
    if (sugarPerL === 0 && (variant.flavor === 'zero_sugar' || variant.flavor === 'sugarfree')) {
      perHl = tax.diet_beverage_per_hl;
    } else {
      const tier = tax.tiers_eur_per_hl.find(t => sugarPerL <= t.sugar_g_per_l_max) || tax.tiers_eur_per_hl[tax.tiers_eur_per_hl.length - 1];
      perHl = tier.rate_per_hl;
    }
    if (variant.contains_taurine) perHl += tax.taurine_per_hl;
    return (perHl / 100) * liters; // /100 because per hl
  }
  if (tax.type === 'flat_per_liter') {
    // Netherlands verbruiksbelasting
    if (!tax.applies_to.includes(vatCategoryFor(variant))) return 0;
    return tax.rate_per_l_eur * liters;
  }
  return 0;
}

// ---------- transport ----------

function transportPerUnitEur(variant, fromC, toC) {
  if (fromC === toC) return 0;
  const m = MARKETS.countries[toC].transport;
  if (MODE === 'B2B') {
    const ftlEur = m.ftl_b2b['from_' + fromC];
    if (ftlEur == null) return 5; // fallback
    // Allocate by units per pallet × FTL pallet capacity, weight-limited
    const palletsPerTruck = m.ftl_b2b.ftl_capacity_pallets;
    const unitsPerPallet = variant.units_per_pallet || 1000;
    const unitsPerTruck = palletsPerTruck * unitsPerPallet;
    // Weight check: don't exceed 24 t
    const maxByWeight = m.ftl_b2b.ftl_capacity_weight_kg / variant.weight_kg_per_unit;
    const trueUnitsPerTruck = Math.min(unitsPerTruck, maxByWeight);
    return ftlEur / trueUnitsPerTruck;
  }
  // CONSUMER mode — parcel courier; assume a 24-pack case as the consumer order unit.
  const parcel = m.parcel_consumer['from_' + fromC] ?? 30;
  const caseUnits = variant.size_ml ? 24 : 6; // 24-can case for beverages, 6-jar pack for spreads
  return parcel / caseUnits;
}

// ---------- landed cost ----------

function landedCostPerUnit(offer, sellC) {
  const variant = variantById(offer.variant_id);
  const buyC = offer.country;
  const buyEur = toEur(offer.price_local, offer.currency);
  const ship = transportPerUnitEur(variant, buyC, sellC);
  const vatCat = vatCategoryFor(variant);
  const buyVat = MARKETS.countries[buyC].vat_rates[vatCat];
  const sellVat = MARKETS.countries[sellC].vat_rates[vatCat];
  const sourceSugarTax = sugarTaxPerUnitEur(variant, buyC);
  const targetSugarTax = sugarTaxPerUnitEur(variant, sellC);

  const breakdown = [];
  let total;

  if (MODE === 'CONSUMER') {
    if (buyC === sellC) {
      breakdown.push({ label: 'cena VAT-incl', value: buyEur });
      total = buyEur;
    } else {
      // EU intra-community consumer: VAT and sugar-tax already paid in source country, no top-up
      breakdown.push({ label: `cena ${buyC} (VAT ${(buyVat*100).toFixed(1)}% + sugar tax ${buyC} incl.)`, value: buyEur });
      breakdown.push({ label: `parcel ${buyC}→${sellC} (per szt., 24-pack koszyk)`, value: ship });
      total = buyEur + ship;
    }
    return { eur: total, breakdown, scenario: buyC === sellC ? 'lokalna sprzedaż' : 'EU→EU consumer (parcel, brak doliczeń podatkowych)' };
  }

  // B2B mode — VAT-EU registered, intra-EU zero-rated supply at source, owe destination VAT on resale.
  // Sugar tax is excise/levy: paid in country of consumption (target). Not refundable on export.
  // Source net = buyEur / (1 + sourceVat) — but source sugar tax is INCLUDED in net price (excise is built into net).
  // So net price = (gross - sourceSugarTax) / (1 + sourceVat) + sourceSugarTax = (gross + sourceSugarTax * sourceVat) / (1 + sourceVat)
  // Simpler formulation: assume sugar tax is part of the producer's pre-VAT price (regulatory practice in PL, NL).
  const buyNet = buyEur / (1 + buyVat);

  if (buyC === sellC) {
    breakdown.push({ label: 'cena lokalna VAT-incl', value: buyEur });
    return { eur: buyEur, breakdown, scenario: 'lokalna sprzedaż' };
  }

  // For arbitrage: when reselling in target country, you owe target sugar tax (registered as taxpayer) AND target VAT.
  // Landed cost (net basis, before reselling at target retail) = buyNet + ship + targetSugarTax
  // Then to compare with target retail (gross), we add target VAT on (buyNet + ship + targetSugarTax).
  const preVatTarget = buyNet + ship + targetSugarTax;
  const targetVatOwed = preVatTarget * sellVat;
  total = preVatTarget + targetVatOwed;

  breakdown.push({ label: `cena ${buyC} netto (zero-rated B2B; sugar tax ${buyC} wliczony w netto)`, value: buyNet });
  breakdown.push({ label: `transport FTL ${buyC}→${sellC} (per szt.)`, value: ship });
  if (targetSugarTax > 0.001) {
    breakdown.push({ label: `sugar tax ${sellC} do odprowadzenia w kraju sprzedaży`, value: targetSugarTax });
  }
  breakdown.push({ label: `VAT ${sellC} ${(sellVat*100).toFixed(1)}% do odprowadzenia`, value: targetVatOwed });

  return {
    eur: total,
    breakdown,
    scenario: `EU→EU B2B z VAT-UE: zakup netto, odprowadzasz VAT ${(sellVat*100).toFixed(1)}% i lokalną opłatę cukrową w ${sellC}`
  };
}

// ---------- aggregations ----------

function bestBuyOffer(variantId, country) {
  const offers = offersFor(variantId, country);
  if (offers.length === 0) return null;
  return offers.reduce((best, o) =>
    !best || toEur(o.price_local, o.currency) < toEur(best.price_local, best.currency) ? o : best, null);
}

function medianRetailEur(variantId, country) {
  const eurs = offersFor(variantId, country).map(o => toEur(o.price_local, o.currency)).sort((a, b) => a - b);
  if (eurs.length === 0) return null;
  const mid = Math.floor(eurs.length / 2);
  return eurs.length % 2 ? eurs[mid] : (eurs[mid - 1] + eurs[mid]) / 2;
}

function bestPath(variantId, buyC, sellC) {
  const buyOffer = bestBuyOffer(variantId, buyC);
  if (!buyOffer) return null;
  const lc = landedCostPerUnit(buyOffer, sellC);
  return { offer: buyOffer, landed: lc };
}

// ---------- rendering ----------

function fmtEur(x) {
  if (Math.abs(x) < 0.5) return '€' + x.toFixed(3);
  if (Math.abs(x) < 10) return '€' + x.toFixed(2);
  return '€' + x.toFixed(0);
}
function fmtPct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
function fmtMargin(x) { return (x >= 0 ? '+' : '') + fmtEur(x); }

function renderMeta() {
  document.getElementById('meta-generated').textContent = `${SNAPSHOT.generated_at} (${SNAPSHOT.generated_by})`;
  const fx = SNAPSHOT.fx_to_eur;
  document.getElementById('meta-fx').textContent = `1 PLN = ${fx.PLN.toFixed(4)} EUR`;
}

function renderAll() {
  renderTopPaths();
  renderBestBuySellSummary();
  renderVariants();
}

function renderTopPaths() {
  const rows = [];
  for (const v of CATALOG.variants) {
    for (const buyC of COUNTRIES) {
      for (const sellC of COUNTRIES) {
        if (buyC === sellC) continue;
        const bp = bestPath(v.id, buyC, sellC);
        if (!bp) continue;
        const sellEur = medianRetailEur(v.id, sellC);
        if (!sellEur) continue;
        const margin = sellEur - bp.landed.eur;
        const marginPct = margin / sellEur;
        const palletUnits = MODE === 'B2B' ? (v.units_per_pallet || 1000) : 24;
        const palletMargin = margin * palletUnits;
        rows.push({
          variant: v, buyC, sellC,
          buyOffer: bp.offer,
          buyLocal: bp.offer.price_local,
          buyCurrency: bp.offer.currency,
          landed: bp.landed.eur,
          sellEur,
          marginEur: margin,
          marginPct,
          palletUnits,
          palletMargin,
        });
      }
    }
  }
  rows.sort((a, b) => (MODE === 'B2B' ? b.palletMargin - a.palletMargin : b.marginEur - a.marginEur));
  const tbody = document.querySelector('#top-paths tbody');
  const display = SHOW_ALL_PATHS ? rows : rows.slice(0, 15);
  tbody.innerHTML = display.map((r, i) => {
    const sizeLbl = r.variant.size_ml ? `${r.variant.size_ml}ml` : `${r.variant.size_g}g`;
    return `
      <tr class="path-row${i === 0 && r.palletMargin > 0 ? ' path-row-best' : ''}" onclick="openPathDetail('${r.variant.id}','${r.buyC}','${r.sellC}')">
        <td>${i + 1}</td>
        <td>${brandById(r.variant.brand_id).name} <span class="muted">·</span> ${shortName(r.variant.name)} <span class="muted">${sizeLbl}</span></td>
        <td><strong>${r.buyC}</strong> <span class="muted">${r.buyOffer.retailer}</span></td>
        <td><strong>${r.sellC}</strong></td>
        <td class="num">${r.buyLocal.toLocaleString('pl-PL')} ${r.buyCurrency}</td>
        <td class="num">${fmtEur(r.landed)}</td>
        <td class="num">${fmtEur(r.sellEur)}</td>
        <td class="num ${r.marginEur >= 0 ? 'margin-pos' : 'margin-neg'}">${fmtMargin(r.marginEur)}</td>
        <td class="num ${r.marginEur >= 0 ? 'margin-pos' : 'margin-neg'}">${fmtPct(r.marginPct)}</td>
        <td class="num ${r.palletMargin >= 0 ? 'margin-pos' : 'margin-neg'}">${fmtEur(r.palletMargin)}</td>
      </tr>
    `;
  }).join('');
  const lblEl = document.getElementById('volume-label');
  if (lblEl) lblEl.textContent = MODE === 'B2B' ? 'marża per pallet (B2B FTL)' : 'marża per case (24-pack)';
}

function renderBestBuySellSummary() {
  // For each variant: cheapest country to buy from, most expensive country to sell to.
  const tbody = document.querySelector('#best-buysell tbody');
  tbody.innerHTML = CATALOG.variants.map(v => {
    const perCountry = COUNTRIES.map(c => {
      const o = bestBuyOffer(v.id, c);
      if (!o) return null;
      return { country: c, eur: toEur(o.price_local, o.currency), retailer: o.retailer, offer: o };
    }).filter(Boolean);
    if (perCountry.length === 0) return '';
    const cheapest = perCountry.reduce((a, b) => a.eur < b.eur ? a : b);
    const dearest  = perCountry.reduce((a, b) => a.eur > b.eur ? a : b);
    const spread = dearest.eur - cheapest.eur;
    const spreadPct = spread / cheapest.eur;
    const sizeLbl = v.size_ml ? `${v.size_ml}ml` : `${v.size_g}g`;
    return `<tr>
      <td><span class="brand-pill">${brandById(v.brand_id).name}</span> ${shortName(v.name)} <span class="muted">${sizeLbl}</span></td>
      <td><code class="ean">${v.ean}</code></td>
      <td><strong>${cheapest.country}</strong> · ${cheapest.retailer} <span class="muted">(${fmtEur(cheapest.eur)})</span></td>
      <td><strong>${dearest.country}</strong> · ${dearest.retailer} <span class="muted">(${fmtEur(dearest.eur)})</span></td>
      <td class="num">${fmtEur(spread)}</td>
      <td class="num ${spreadPct >= 0.5 ? 'margin-pos' : ''}">${fmtPct(spreadPct)}</td>
    </tr>`;
  }).join('');
}

function renderVariants() {
  const root = document.getElementById('variant-list');
  // Group by brand for visual structure
  const byBrand = {};
  for (const v of CATALOG.variants) (byBrand[v.brand_id] ||= []).push(v);
  root.innerHTML = Object.entries(byBrand).map(([brandId, variants]) => {
    const brand = brandById(brandId);
    return `
      <div class="brand-group">
        <h3 class="brand-header">${brand.name} <span class="muted">· ${brand.manufacturer} · ${variants.length} wariantów</span></h3>
        ${variants.map(v => renderVariantBlock(v)).join('')}
      </div>
    `;
  }).join('');
}

function renderVariantBlock(v) {
  const sizeLbl = v.size_ml ? `${v.size_ml}ml` : `${v.size_g}g`;
  return `
    <div class="variant-block" data-variant="${v.id}">
      <div class="variant-head" onclick="toggleVariant('${v.id}')">
        <div>
          <span class="name">${v.name}</span>
          <span class="muted"> · ${v.flavor} · ${v.format} · ${sizeLbl} · EAN <code class="ean">${v.ean}</code></span>
        </div>
        <div class="toggle">szczegóły</div>
      </div>
      <div class="variant-body">
        ${renderMatrix(v)}
        ${renderOffersTable(v)}
        <div class="detail-panel" id="detail-${v.id}"></div>
      </div>
    </div>
  `;
}

function renderMatrix(v) {
  let bestKey = null, bestMargin = 0;
  for (const buyC of COUNTRIES) {
    for (const sellC of COUNTRIES) {
      if (buyC === sellC) continue;
      const bp = bestPath(v.id, buyC, sellC);
      if (!bp) continue;
      const sellEur = medianRetailEur(v.id, sellC);
      if (!sellEur) continue;
      const m = sellEur - bp.landed.eur;
      if (m > bestMargin) { bestMargin = m; bestKey = `${buyC}__${sellC}`; }
    }
  }
  const head = `<tr><th></th>${COUNTRIES.map(c => `<th>sell ${c}</th>`).join('')}</tr>`;
  const rows = COUNTRIES.map(buyC => {
    const cells = COUNTRIES.map(sellC => {
      if (buyC === sellC) return `<td class="diag">—</td>`;
      const bp = bestPath(v.id, buyC, sellC);
      if (!bp) return `<td class="diag">brak</td>`;
      const sellEur = medianRetailEur(v.id, sellC);
      const m = sellEur - bp.landed.eur;
      const pct = m / sellEur;
      const isBest = `${buyC}__${sellC}` === bestKey;
      const cls = (m >= 0 ? 'pos' : 'neg') + (isBest ? ' cell-best' : '');
      const bestBadge = isBest ? '<div class="best-badge">BEST</div>' : '';
      return `
        <td class="cell ${cls}" data-buy="${buyC}" data-sell="${sellC}"
            onclick="openCellDetail('${v.id}','${buyC}','${sellC}')">
          ${bestBadge}
          <div class="pct">${fmtPct(pct)}</div>
          <div class="sub">${fmtMargin(m)} per szt.</div>
          <div class="sub">land ${fmtEur(bp.landed.eur)}</div>
          <div class="sub retailer-hint">→ ${bp.offer.retailer}</div>
        </td>
      `;
    }).join('');
    return `<tr><th>buy ${buyC}</th>${cells}</tr>`;
  }).join('');
  return `<table class="matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function renderOffersTable(v) {
  const all = SNAPSHOT.offers.filter(o => o.variant_id === v.id);
  const rows = all.map(o => {
    const eur = toEur(o.price_local, o.currency);
    const sugar = sugarTaxPerUnitEur(v, o.country);
    const vatCat = vatCategoryFor(v);
    const vatPct = MARKETS.countries[o.country].vat_rates[vatCat];
    return `<tr>
      <td><span class="country-tag">${o.country}</span> ${o.retailer}</td>
      <td class="num">${o.price_local.toLocaleString('pl-PL')} ${o.currency}</td>
      <td class="num">${fmtEur(eur)}</td>
      <td class="num muted">${(vatPct*100).toFixed(1)}%</td>
      <td class="num muted">${sugar > 0 ? fmtEur(sugar) : '—'}</td>
      <td>${o.in_stock ? '<span class="muted">w magazynie</span>' : '<span class="muted">brak</span>'}</td>
      <td><a href="${o.url}" target="_blank" rel="noopener">link</a></td>
    </tr>`;
  }).join('');
  return `<h4>Oferty per sklep</h4>
    <table class="offers-table">
      <thead><tr><th>Sklep</th><th class="num">Cena</th><th class="num">EUR</th><th class="num">VAT</th><th class="num">sugar tax/szt.</th><th>Stan</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function toggleVariant(id) {
  document.querySelector(`.variant-block[data-variant="${id}"]`).classList.toggle('open');
}

function openPathDetail(variantId, buyC, sellC) {
  const block = document.querySelector(`.variant-block[data-variant="${variantId}"]`);
  if (!block) return;
  block.classList.add('open');
  block.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => showDetail(variantId, buyC, sellC, false), 250);
  setTimeout(() => {
    const cell = block.querySelector(`td.cell[data-buy="${buyC}"][data-sell="${sellC}"]`);
    if (cell) {
      cell.classList.add('cell-flash');
      setTimeout(() => cell.classList.remove('cell-flash'), 1500);
    }
  }, 350);
}
function openCellDetail(variantId, buyC, sellC) {
  showDetail(variantId, buyC, sellC, true);
}

function showDetail(variantId, buyC, sellC, openUrl) {
  const v = variantById(variantId);
  const bp = bestPath(variantId, buyC, sellC);
  if (!bp) return;
  const sellEur = medianRetailEur(variantId, sellC);
  const margin = sellEur - bp.landed.eur;
  const offer = bp.offer;
  const panel = document.getElementById(`detail-${variantId}`);

  if (openUrl && offer.url) window.open(offer.url, '_blank', 'noopener,noreferrer');

  const breakdown = bp.landed.breakdown.map(b => `
    <div class="label">${b.label}</div>
    <div class="num">${fmtEur(b.value)}</div>
  `).join('');

  const palletUnits = MODE === 'B2B' ? (v.units_per_pallet || 1000) : 24;
  const truckPallets = MARKETS.countries[sellC].transport.ftl_b2b.ftl_capacity_pallets;
  const truckUnits = palletUnits * truckPallets;
  const palletMargin = margin * palletUnits;
  const truckMargin = margin * truckUnits;

  panel.innerHTML = `
    <h4>Kup w ${offer.retailer} (${buyC}) → sprzedaj w ${sellC} <span class="muted">· tryb ${MODE}</span></h4>
    <p class="muted">${bp.landed.scenario || ''}</p>

    <div class="cta-row">
      <a class="cta-button" href="${offer.url}" target="_blank" rel="noopener">
        Otwórz ${offer.retailer} → ${offer.price_local.toLocaleString('pl-PL')} ${offer.currency} ↗
      </a>
    </div>

    <div class="breakdown">
      ${breakdown}
      <div class="label total">landed cost per szt. EUR (z VAT target)</div>
      <div class="num total">${fmtEur(bp.landed.eur)}</div>
      <div class="label">median retail w ${sellC} (z VAT)</div>
      <div class="num">${fmtEur(sellEur)}</div>
      <div class="label total">marża per sztuka</div>
      <div class="num total" style="color:${margin >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtMargin(margin)} (${fmtPct(margin / sellEur)})</div>
    </div>

    <div class="volume-row">
      <div class="vol-card"><div class="vol-label">${MODE === 'B2B' ? 'pallet' : 'case 24-pack'}</div><div class="vol-num">${palletUnits.toLocaleString('pl-PL')} szt.</div><div class="vol-margin" style="color:${palletMargin >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtMargin(palletMargin)}</div></div>
      ${MODE === 'B2B' ? `<div class="vol-card"><div class="vol-label">FTL (33 pallet)</div><div class="vol-num">${truckUnits.toLocaleString('pl-PL')} szt.</div><div class="vol-margin" style="color:${truckMargin >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtMargin(truckMargin)}</div></div>` : ''}
    </div>

    <p class="muted" style="margin-top:8px;font-size:11.5px">
      Założenia B2B: VAT-UE rejestracja w obu krajach (refund VAT ${buyC}, naliczasz VAT ${sellC}). Sugar tax rejestracja jako podatnik w kraju sprzedaży (jeśli kraj target ma SSB tax). Transport FTL palletyzowany — koszt rozproszony na ${palletUnits.toLocaleString('pl-PL')} szt./paleta. Marża nie uwzględnia kosztów magazynowych, kapitału obrotowego ani strat (~1-3%).
    </p>
  `;
  panel.classList.add('open');
}

function shortName(name) { return name.length > 50 ? name.slice(0, 48) + '…' : name; }

window.toggleVariant = toggleVariant;
window.openPathDetail = openPathDetail;
window.openCellDetail = openCellDetail;
