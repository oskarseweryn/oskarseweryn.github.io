// Electronics Arbitrage Scanner — static site logic.
// Loads snapshot.json, computes landed cost for every (offer, sell_country) pair,
// and renders: top paths table, per-SKU matrices + retailer details, promo code log.

const COUNTRIES = ['PL', 'DE', 'LT', 'UK'];
const VAT = { PL: 0.23, DE: 0.19, LT: 0.21, UK: 0.20 };
const BROKERAGE_INTO_EU_FROM_UK = 25; // EUR
const UK_TCA_DUTY_PCT = 0.0;          // 0% under Trade and Cooperation Agreement for these HS codes

let SNAPSHOT = null;
let MODE = 'B2C'; // 'B2C' or 'B2B'

(async function init() {
  SNAPSHOT = await fetch('snapshot.json').then(r => r.json());
  renderMeta();
  document.querySelectorAll('input[name=mode]').forEach(el => {
    el.addEventListener('change', e => { MODE = e.target.value; renderAll(); });
  });
  renderAll();
})();

function renderAll() {
  renderTopPaths();
  renderSkus();
  renderCodes();
}

function renderMeta() {
  document.getElementById('meta-generated').textContent =
    `${SNAPSHOT.generated_at} (${SNAPSHOT.generated_by})`;
  const fx = SNAPSHOT.fx_to_eur;
  document.getElementById('meta-fx').textContent =
    `1 PLN = ${fx.PLN.toFixed(4)} EUR · 1 GBP = ${fx.GBP.toFixed(4)} EUR`;
}

// ---------- pricing ----------

function toEur(price, currency) {
  return price * SNAPSHOT.fx_to_eur[currency];
}

function bestBuyOffer(sku, buyCountry) {
  // Lowest EUR-equivalent (VAT-included) offer in buyCountry
  const offers = sku.offers.filter(o => o.country === buyCountry && o.in_stock);
  if (offers.length === 0) return null;
  return offers.reduce((best, o) =>
    !best || toEur(o.price_local, o.currency) < toEur(best.price_local, best.currency) ? o : best, null);
}

function medianRetailEur(sku, sellCountry) {
  const eurs = sku.offers
    .filter(o => o.country === sellCountry && o.in_stock)
    .map(o => toEur(o.price_local, o.currency))
    .sort((a, b) => a - b);
  if (eurs.length === 0) return null;
  const mid = Math.floor(eurs.length / 2);
  return eurs.length % 2 ? eurs[mid] : (eurs[mid - 1] + eurs[mid]) / 2;
}

function shipping(buyC, sellC) {
  return SNAPSHOT.shipping_eur[`${buyC}_to_${sellC}`] ?? 30;
}

// landed cost (EUR) for buying `offer` in offer.country and delivering to sellC
function landedCost(offer, sellC, sku, mode) {
  const buyC = offer.country;
  const buyEur = toEur(offer.price_local, offer.currency);
  const ship = shipping(buyC, sellC);
  const dutyPct = (sku.customs_duty_eu_pct ?? 0);

  if (buyC === sellC) {
    return { eur: buyEur, breakdown: [{ label: 'cena lokalna VAT-incl', value: buyEur }] };
  }

  const bothEU = buyC !== 'UK' && sellC !== 'UK';

  if (mode === 'B2C') {
    if (bothEU) {
      // Free movement within EU as consumer: VAT already paid in source country.
      // No additional VAT. Just transport.
      return {
        eur: buyEur + ship,
        scenario: 'EU→EU B2C: VAT zapłacony w kraju zakupu, brak doliczeń',
        breakdown: [
          { label: `cena ${buyC} (VAT ${(VAT[buyC]*100).toFixed(0)}% incl.)`, value: buyEur },
          { label: `transport ${buyC}→${sellC}`, value: ship },
        ]
      };
    }
    if (buyC === 'UK') {
      // UK→EU consumer: pays UK VAT, then EU import VAT on top → "double VAT"
      const customsValue = buyEur + ship;
      const duty = customsValue * dutyPct;
      const importVat = (customsValue + duty) * VAT[sellC];
      return {
        eur: buyEur + ship + duty + importVat + BROKERAGE_INTO_EU_FROM_UK,
        scenario: 'UK→EU B2C: UK VAT 20% + import VAT EU = podwójny VAT',
        breakdown: [
          { label: 'cena UK (VAT 20% incl.)', value: buyEur },
          { label: `transport UK→${sellC}`, value: ship },
          ...(dutyPct > 0 ? [{ label: `cło ${(dutyPct*100).toFixed(1)}% (HS ${sku.hs_code})`, value: duty }] : []),
          { label: `import VAT ${(VAT[sellC]*100).toFixed(0)}% (${sellC})`, value: importVat },
          { label: 'brokerage celny', value: BROKERAGE_INTO_EU_FROM_UK },
        ]
      };
    }
    // EU→UK consumer: pays EU VAT, then UK import VAT on top
    const customsValue = buyEur + ship;
    const importVat = customsValue * VAT.UK;
    return {
      eur: buyEur + ship + importVat,
      scenario: 'EU→UK B2C: lokalny VAT EU + UK import VAT 20%',
      breakdown: [
        { label: `cena ${buyC} (VAT ${(VAT[buyC]*100).toFixed(0)}% incl.)`, value: buyEur },
        { label: `transport ${buyC}→UK`, value: ship },
        { label: 'UK import VAT 20%', value: importVat },
      ]
    };
  }

  // B2B mode — VAT-EU registered, refund/zero-rate at source, owe destination VAT on resale
  const buyVatRate = VAT[buyC];
  const buyNet = buyEur / (1 + buyVatRate);

  if (bothEU) {
    // Intra-EU B2B: zero-rated supply at source (buy net), owe destination VAT when reselling.
    // Landed-to-resale-price-equivalent: buy_net + ship + dest_VAT_on_buy_net
    const sellVatOwed = buyNet * VAT[sellC];
    return {
      eur: buyNet + ship + sellVatOwed,
      scenario: `EU→EU B2B z VAT-UE: zakup netto, odprowadzasz VAT ${(VAT[sellC]*100).toFixed(0)}% w ${sellC}`,
      breakdown: [
        { label: `cena ${buyC} netto (zero-rated)`, value: buyNet },
        { label: `transport ${buyC}→${sellC}`, value: ship },
        { label: `VAT ${sellC} ${(VAT[sellC]*100).toFixed(0)}% do odprowadzenia`, value: sellVatOwed },
      ]
    };
  }
  if (buyC === 'UK') {
    // UK→EU B2B: refund UK VAT, pay EU import VAT once
    const customsValue = buyNet + ship;
    const duty = customsValue * dutyPct;
    const importVat = (customsValue + duty) * VAT[sellC];
    return {
      eur: buyNet + ship + duty + importVat + BROKERAGE_INTO_EU_FROM_UK,
      scenario: 'UK→EU B2B: UK VAT odzyskany jako eksporter, jeden VAT importowy EU',
      breakdown: [
        { label: 'cena UK netto (export refund)', value: buyNet },
        { label: `transport UK→${sellC}`, value: ship },
        ...(dutyPct > 0 ? [{ label: `cło ${(dutyPct*100).toFixed(1)}% (HS ${sku.hs_code})`, value: duty }] : []),
        { label: `import VAT ${(VAT[sellC]*100).toFixed(0)}% (${sellC})`, value: importVat },
        { label: 'brokerage celny', value: BROKERAGE_INTO_EU_FROM_UK },
      ]
    };
  }
  // EU→UK B2B: refund EU VAT, pay UK import VAT once
  const customsValue = buyNet + ship;
  const importVat = customsValue * VAT.UK;
  return {
    eur: buyNet + ship + importVat,
    scenario: 'EU→UK B2B: EU VAT odzyskany jako eksporter, UK import VAT 20%',
    breakdown: [
      { label: `cena ${buyC} netto (export refund)`, value: buyNet },
      { label: `transport ${buyC}→UK`, value: ship },
      { label: 'UK import VAT 20%', value: importVat },
    ]
  };
}

// best path: minimum landed cost in sellC across all offers in buyC
function bestPath(sku, buyC, sellC, mode) {
  const offers = sku.offers.filter(o => o.country === buyC && o.in_stock);
  if (offers.length === 0) return null;
  let best = null;
  for (const o of offers) {
    const lc = landedCost(o, sellC, sku, mode);
    if (!best || lc.eur < best.landed.eur) best = { offer: o, landed: lc };
  }
  return best;
}

// ---------- rendering ----------

function fmtEur(x) { return '€' + x.toFixed(0); }
function fmtPct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

function renderTopPaths() {
  const rows = [];
  for (const sku of SNAPSHOT.skus) {
    for (const buyC of COUNTRIES) {
      for (const sellC of COUNTRIES) {
        if (buyC === sellC) continue;
        const best = bestPath(sku, buyC, sellC, MODE);
        if (!best) continue;
        const sellEur = medianRetailEur(sku, sellC);
        if (!sellEur) continue;
        const margin = sellEur - best.landed.eur;
        rows.push({
          sku, buyC, sellC,
          buyOffer: best.offer,
          buyLocal: best.offer.price_local,
          buyCurrency: best.offer.currency,
          landed: best.landed.eur,
          sellEur,
          marginEur: margin,
          marginPct: margin / sellEur,
        });
      }
    }
  }
  rows.sort((a, b) => b.marginEur - a.marginEur);
  const top = rows.slice(0, 10);

  const tbody = document.querySelector('#top-paths tbody');
  tbody.innerHTML = top.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.sku.brand} <span class="muted">·</span> ${shortName(r.sku.name)}</td>
      <td><strong>${r.buyC}</strong> <span class="muted">${r.buyOffer.retailer}</span></td>
      <td><strong>${r.sellC}</strong></td>
      <td class="num">${r.buyLocal.toLocaleString('pl-PL')} ${r.buyCurrency}</td>
      <td class="num">${fmtEur(r.landed)}</td>
      <td class="num">${fmtEur(r.sellEur)}</td>
      <td class="num ${r.marginEur >= 0 ? 'margin-pos' : 'margin-neg'}">${fmtEur(r.marginEur)}</td>
      <td class="num ${r.marginEur >= 0 ? 'margin-pos' : 'margin-neg'}">${fmtPct(r.marginPct)}</td>
    </tr>
  `).join('');
}

function renderSkus() {
  const root = document.getElementById('sku-list');
  root.innerHTML = SNAPSHOT.skus.map(sku => {
    return `
      <div class="sku-block" data-sku="${sku.id}">
        <div class="sku-head" onclick="toggleSku('${sku.id}')">
          <div>
            <span class="brand-pill">${sku.brand}</span>
            <span class="name">${sku.name}</span>
            <span class="muted"> · ${sku.category} · MSRP €${sku.msrp_eur}</span>
          </div>
          <div class="toggle">szczegóły</div>
        </div>
        <div class="sku-body">
          ${renderMatrix(sku)}
          ${renderOffersTable(sku)}
          <div class="detail-panel" id="detail-${sku.id}"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderMatrix(sku) {
  const rows = COUNTRIES.map(buyC => {
    const cells = COUNTRIES.map(sellC => {
      if (buyC === sellC) return `<td class="diag">—</td>`;
      const best = bestPath(sku, buyC, sellC, MODE);
      if (!best) return `<td class="diag">brak danych</td>`;
      const sellEur = medianRetailEur(sku, sellC);
      const margin = sellEur - best.landed.eur;
      const pct = margin / sellEur;
      const cls = margin >= 0 ? 'pos' : 'neg';
      const id = `${sku.id}__${buyC}__${sellC}`;
      return `
        <td class="cell ${cls}" onclick="showDetail('${sku.id}','${buyC}','${sellC}')">
          <div class="pct">${fmtPct(pct)}</div>
          <div class="sub">${fmtEur(margin)} marża</div>
          <div class="sub">landed ${fmtEur(best.landed.eur)} · target ${fmtEur(sellEur)}</div>
        </td>
      `;
    }).join('');
    return `<tr><th>kup ${buyC}</th>${cells}</tr>`;
  }).join('');
  const head = `<tr><th></th>${COUNTRIES.map(c => `<th>sprzedaj ${c}</th>`).join('')}</tr>`;
  return `<table class="matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function renderOffersTable(sku) {
  const rows = sku.offers.map(o => {
    const eur = toEur(o.price_local, o.currency);
    const promo = o.promo_code
      ? ` <span class="muted">· kod ${o.promo_code} (-${(o.promo_pct * 100).toFixed(0)}%)</span>` : '';
    return `<tr>
      <td><span class="country-tag">${o.country}</span> ${o.retailer}${promo}</td>
      <td class="num">${o.price_local.toLocaleString('pl-PL')} ${o.currency}</td>
      <td class="num">${fmtEur(eur)}</td>
      <td>${o.in_stock ? '<span class="muted">w magazynie</span>' : '<span class="muted">brak</span>'}</td>
      <td><a href="${o.url}" target="_blank" rel="noopener">link</a></td>
    </tr>`;
  }).join('');
  return `<h3 style="margin-top:14px">Oferty per sklep</h3>
    <table class="offers-table">
      <thead><tr><th>Sklep</th><th class="num">Cena</th><th class="num">EUR</th><th>Stan</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function toggleSku(id) {
  const el = document.querySelector(`.sku-block[data-sku="${id}"]`);
  el.classList.toggle('open');
}

function showDetail(skuId, buyC, sellC) {
  const sku = SNAPSHOT.skus.find(s => s.id === skuId);
  const best = bestPath(sku, buyC, sellC, MODE);
  const sellEur = medianRetailEur(sku, sellC);
  const margin = sellEur - best.landed.eur;
  const panel = document.getElementById(`detail-${skuId}`);

  const breakdown = best.landed.breakdown.map(b => `
    <div class="label">${b.label}</div>
    <div class="num">${fmtEur(b.value)}</div>
  `).join('');

  panel.innerHTML = `
    <h4>Breakdown: kup ${buyC} (${best.offer.retailer}) → sprzedaj ${sellC} · tryb ${MODE}</h4>
    <p class="muted">${best.landed.scenario || ''}</p>
    <div class="breakdown">
      ${breakdown}
      <div class="label total">landed cost EUR</div>
      <div class="num total">${fmtEur(best.landed.eur)}</div>
      <div class="label">median retail w ${sellC}</div>
      <div class="num">${fmtEur(sellEur)}</div>
      <div class="label total">marża per sztuka</div>
      <div class="num total" style="color:${margin >= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtEur(margin)} (${fmtPct(margin / sellEur)})</div>
    </div>
    <p class="muted" style="margin-top:8px">
      Wolumen 100 szt. → marża ${fmtEur(margin * 100)}.
      Wolumen 1000 szt. → marża ${fmtEur(margin * 1000)}.
      <em>Założenie: utrzymanie ceny rynkowej target country; w praktyce sprzedając wolumen schodzisz 3-8% poniżej.</em>
    </p>
  `;
  panel.classList.add('open');
}

function renderCodes() {
  const tbody = document.querySelector('#codes-table tbody');
  tbody.innerHTML = SNAPSHOT.promo_code_validation_log.map(c => {
    const sku = SNAPSHOT.skus.find(s => s.id === c.applies_to_sku);
    return `<tr>
      <td><code>${c.code}</code></td>
      <td>${c.retailer}</td>
      <td>${c.country}</td>
      <td>${sku ? shortName(sku.name) : c.applies_to_sku}</td>
      <td><span class="status status-${c.status}">${c.status.replace('_', ' ')}</span></td>
      <td class="num">${c.discount_pct ? '-' + (c.discount_pct * 100).toFixed(0) + '%' : '—'}</td>
      <td class="muted">${c.notes}</td>
    </tr>`;
  }).join('');
}

function shortName(name) {
  return name.length > 36 ? name.slice(0, 34) + '…' : name;
}

window.toggleSku = toggleSku;
window.showDetail = showDetail;
