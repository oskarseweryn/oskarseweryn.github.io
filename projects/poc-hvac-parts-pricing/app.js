"use strict";

// Static frontend for HVAC parts sourcing comparison.
// Reads `snapshot.json` (rewritten by /hvac-parts-pricing slash command).
// No backend, no LLM calls at view time.

const FX_TO_PLN = { PLN: 1, EUR: 4.30, USD: 4.00, GBP: 5.10, CNY: 0.55 };

const fmtPLN = (n) =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(n);

const fmtPLNCompact = (n) =>
  new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(n);

let SNAPSHOT = null;
let CURRENT_REGION = "PL";
// BASKET_STATE: { [part_id]: { enabled: bool, qty: number } }
// Drives both the vendor totals and the SKU x Vendor matrix.
let BASKET_STATE = {};

async function loadSnapshot() {
  const res = await fetch("./snapshot.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot.json: ${res.status}`);
  return res.json();
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function logoUrl(v) {
  const domain = getDomain(v.product_url || v.contact_url || v.homepage || "");
  if (!domain) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function initBasketState() {
  BASKET_STATE = {};
  for (const p of SNAPSHOT.basket) {
    BASKET_STATE[p.id] = { enabled: true, qty: p.qty_default };
  }
}

function enabledParts() {
  return SNAPSHOT.basket.filter(p => BASKET_STATE[p.id]?.enabled);
}

function qtyFor(partId) {
  const s = BASKET_STATE[partId];
  return s && s.enabled ? Math.max(0, s.qty | 0) : 0;
}

function findLineItem(vendor, partId) {
  if (!vendor.line_items) return null;
  return vendor.line_items.find(li => li.part_id === partId) || null;
}

function basketTotalForVendor(v) {
  if (v.region === "CN") return null; // RFQ-only
  let total = 0;
  let anyPriced = false;
  for (const part of enabledParts()) {
    const li = findLineItem(v, part.id);
    if (li && li.unit_price_pln != null) {
      total += li.unit_price_pln * qtyFor(part.id);
      anyPriced = true;
    }
  }
  return anyPriced ? Math.round(total) : null;
}

function coverageForVendor(v) {
  const enabled = enabledParts();
  if (!v.line_items) return { found: 0, total: enabled.length };
  const found = enabled.filter(p => {
    const li = findLineItem(v, p.id);
    return li && (li.unit_price_pln != null || li.product_url);
  }).length;
  return { found, total: enabled.length };
}

function vendorMatchesRegion(v, region) {
  if (region === "PL") return v.region === "PL";
  if (region === "ALL") return v.region === "PL" || v.region === "EU";
  return true; // GLOBAL — includes CN
}

function fillTemplate(text) {
  if (text == null) return "";
  const enabled = enabledParts();
  const summary = enabled.length === 0
    ? "(brak wybranych pozycji)"
    : enabled
        .map((p, i) => `${i + 1}. ${p.name.split("(")[0].trim()} (${p.spec}) — ${qtyFor(p.id)} szt`)
        .join("\n");

  // Strip any sentence containing the obsolete {scale} placeholder (legacy from earlier draft).
  // Then replace {basket} with the numbered list.
  return String(text)
    .replace(/[^\n]*\{scale\}[^\n]*\n?/g, "")
    .replace(/\{basket\}/g, summary);
}

function render() {
  if (!SNAPSHOT) return;
  document.getElementById("last-updated").textContent = SNAPSHOT.last_updated;
  document.getElementById("pricing-note").textContent = SNAPSHOT.pricing_note;

  renderBasket();
  renderVendors();
  renderMatrix();
}

function renderBasket() {
  const tbody = document.getElementById("basket-rows");
  tbody.innerHTML = "";
  SNAPSHOT.basket.forEach(p => {
    const state = BASKET_STATE[p.id] || { enabled: true, qty: p.qty_default };
    const tr = document.createElement("tr");
    if (!state.enabled) tr.classList.add("disabled");
    tr.innerHTML = `
      <td class="check-col">
        <input class="sku-check" type="checkbox" data-part="${escape(p.id)}" ${state.enabled ? "checked" : ""}>
      </td>
      <td>
        <span class="sku-name">${escape(p.name)}</span>
      </td>
      <td><span class="sku-spec">${escape(p.spec)}</span></td>
      <td class="num qty-col">
        <input class="qty-input" type="number" min="0" max="100000" step="1"
               value="${state.qty}" data-part="${escape(p.id)}" ${state.enabled ? "" : "disabled"}>
      </td>
      <td><span class="sku-spec">${escape(p.use)}</span></td>
    `;
    tbody.appendChild(tr);
  });

  // wire events
  tbody.querySelectorAll(".sku-check").forEach(cb => {
    cb.addEventListener("change", e => {
      const id = e.target.dataset.part;
      BASKET_STATE[id].enabled = e.target.checked;
      render();
    });
  });
  tbody.querySelectorAll(".qty-input").forEach(inp => {
    inp.addEventListener("input", e => {
      const id = e.target.dataset.part;
      const n = parseInt(e.target.value, 10);
      if (!isNaN(n) && n >= 0 && n <= 100000) {
        BASKET_STATE[id].qty = n;
        renderVendors();
        renderMatrix();
      }
    });
  });
}

function renderVendors() {
  const tbody = document.getElementById("vendor-rows");
  tbody.innerHTML = "";

  const visible = SNAPSHOT.vendors.filter(v => vendorMatchesRegion(v, CURRENT_REGION));

  visible
    .slice()
    .sort((a, b) => {
      const ta = basketTotalForVendor(a);
      const tb = basketTotalForVendor(b);
      // RFQ / no-price rows sort to the bottom
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    })
    .forEach(v => {
      tbody.appendChild(buildVendorRow(v));
      tbody.appendChild(buildDetailRow(v));
    });
}

function buildVendorRow(v) {
  const tr = document.createElement("tr");
  tr.className = "vendor-row";
  tr.dataset.id = v.id;

  const total = basketTotalForVendor(v);
  const coverage = coverageForVendor(v);
  let coverageCell;
  if (v.region === "CN") {
    coverageCell = `<span class="rfq-tag">RFQ</span>`;
  } else if (coverage.total === 0) {
    coverageCell = `<span class="coverage-none">—</span>`;
  } else if (coverage.found === coverage.total) {
    coverageCell = `<span class="coverage-pct coverage-full">${coverage.found} / ${coverage.total}</span>`;
  } else if (coverage.found > 0) {
    coverageCell = `<span class="coverage-pct coverage-partial">${coverage.found} / ${coverage.total}</span>`;
  } else {
    coverageCell = `<span class="coverage-none">brak danych</span>`;
  }

  const totalCell = total == null
    ? `<span class="rfq-tag">RFQ</span>`
    : `<strong>${fmtPLN(total)}</strong>`;

  const isShop = !v.email_draft;
  let emailCell;
  if (v.email) {
    emailCell = `<a href="mailto:${escape(v.email)}" onclick="event.stopPropagation()">${escape(v.email)}</a>`;
  } else if (isShop) {
    emailCell = `<span class="shop-cell"><a href="${escape(v.homepage || v.contact_url || '#')}" target="_blank" rel="noopener" onclick="event.stopPropagation()">sklep online →</a></span>`;
  } else if (v.contact_url) {
    emailCell = `<span class="no-email">brak adresu — <a href="${escape(v.contact_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">formularz</a></span>`;
  } else {
    emailCell = `<span class="no-email">—</span>`;
  }

  const logo = logoUrl(v);
  const logoHTML = logo
    ? `<img class="vendor-logo" src="${logo}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<div class="vendor-logo" style="visibility:hidden"></div>`;

  tr.innerHTML = `
    <td>
      <div class="vendor-name-cell">
        ${logoHTML}
        <div class="vendor-text">
          <div class="vendor-name">${escape(v.name)}</div>
          <div class="sku-spec">${escape(v.notes || "")}</div>
        </div>
      </div>
    </td>
    <td>${escape(v.country)}</td>
    <td class="num">${coverageCell}</td>
    <td class="num">${totalCell}</td>
    <td>${escape(v.lead_time || "—")}</td>
    <td class="email-cell">${emailCell}</td>
    <td><button class="toggle" type="button">szczegóły ▾</button></td>
  `;

  tr.addEventListener("click", () => toggleRow(v.id));
  return tr;
}

function buildDetailRow(v) {
  const tr = document.createElement("tr");
  tr.className = "email-row";
  tr.dataset.id = v.id;

  const enabled = enabledParts();

  const lineRows = enabled.map(part => {
    const li = findLineItem(v, part.id);
    const qty = qtyFor(part.id);
    let unitLabel, lineTotal;
    if (li && li.unit_price_pln != null) {
      unitLabel = li.unit_price_label || `${li.unit_price_pln} PLN`;
      lineTotal = fmtPLN(li.unit_price_pln * qty);
    } else if (v.region === "CN") {
      unitLabel = li?.unit_price_label || "—";
      lineTotal = `<span class="rfq-tag">RFQ</span>`;
    } else {
      unitLabel = li?.unit_price_label || "—";
      lineTotal = `<span class="missing">brak w ofercie</span>`;
    }
    const productLink = li?.product_url
      ? `<a href="${escape(li.product_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">→</a>`
      : "";
    return `
      <tr>
        <td>${escape(part.name)} ${productLink}</td>
        <td class="num">${qty}</td>
        <td class="num">${escape(unitLabel)}</td>
        <td class="num">${lineTotal}</td>
      </tr>
    `;
  }).join("");

  const lineRowsHTML = enabled.length === 0
    ? `<tr><td colspan="4" class="missing">Wszystkie pozycje koszyka są odznaczone — zaznacz przynajmniej jedną pozycję powyżej.</td></tr>`
    : lineRows;

  const isShop = !v.email_draft;
  const recipient = v.email || (v.contact_url ? `(formularz: ${v.contact_url})` : "(brak adresu)");
  const subject = v.email_draft ? fillTemplate(v.email_draft.subject) : "";
  const body = v.email_draft ? fillTemplate(v.email_draft.body) : "";
  const mailto = v.email
    ? `mailto:${encodeURIComponent(v.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : (v.contact_url || v.homepage || "#");
  const langLabel = { pl: "PL", de: "DE", en: "EN" }[v.language] || (v.language || "—").toUpperCase();

  let secondSection;
  if (isShop) {
    // Shop-type vendor: no RFQ — direct purchase
    secondSection = `
      <div class="detail-section">
        <h3>Sklep z publicznymi cenami — zamówienie online</h3>
        <p class="email-meta">${escape(v.notes || "")}</p>
        <div class="email-actions">
          <a class="primary" href="${escape(v.homepage || mailto)}" target="_blank" rel="noopener">Otwórz sklep →</a>
        </div>
      </div>
    `;
  } else {
    // RFQ vendor
    secondSection = `
      <div class="detail-section">
        <h3>Wzór zapytania ofertowego</h3>
        <p class="email-meta">Do: ${escape(recipient)} · Język: ${langLabel} · Region: ${escape(v.region)}</p>
        <div class="email-actions">
          <button type="button" class="copy-subject" ${subject ? "" : "disabled"}>Kopiuj temat</button>
          <button type="button" class="copy-body" ${body ? "" : "disabled"}>Kopiuj treść</button>
          <a class="primary" href="${mailto}" target="_blank" rel="noopener">${v.email ? "Otwórz w poczcie" : "Otwórz formularz"}</a>
        </div>
        <div class="email-content">
          <p class="label">Temat</p>
          <pre class="subj"></pre>
          <p class="label">Treść</p>
          <pre class="body"></pre>
        </div>
      </div>
    `;
  }

  tr.innerHTML = `
    <td colspan="7">
      <div class="detail-section">
        <h3>Pozycje koszyka u tego dostawcy</h3>
        <table class="line-items">
          <thead>
            <tr>
              <th>SKU</th>
              <th class="num">Ilość</th>
              <th class="num">Cena jedn.</th>
              <th class="num">Suma</th>
            </tr>
          </thead>
          <tbody>${lineRowsHTML}</tbody>
        </table>
      </div>
      ${secondSection}
    </td>
  `;

  if (!isShop) {
    tr.querySelector(".subj").textContent = subject;
    tr.querySelector(".body").textContent = body;
    const copySubj = tr.querySelector(".copy-subject");
    const copyBody = tr.querySelector(".copy-body");
    if (copySubj) copySubj.addEventListener("click", e => { e.stopPropagation(); copyText(subject, e.target); });
    if (copyBody) copyBody.addEventListener("click", e => { e.stopPropagation(); copyText(body, e.target); });
  }

  return tr;
}

function renderMatrix() {
  const enabled = enabledParts();
  const visibleVendors = SNAPSHOT.vendors.filter(v => vendorMatchesRegion(v, CURRENT_REGION));
  const matrix = document.getElementById("matrix");

  if (enabled.length === 0 || visibleVendors.length === 0) {
    matrix.innerHTML = `<thead><tr><th class="sku-header-col">SKU</th></tr></thead>
      <tbody><tr><td class="sku-cell" colspan="1">${enabled.length === 0 ? "Brak wybranych SKU." : "Brak dostawców w tym regionie."}</td></tr></tbody>`;
    return;
  }

  // Header row
  let header = `<thead><tr><th class="sku-header-col">SKU</th>`;
  visibleVendors.forEach(v => {
    const isCN = v.region === "CN";
    header += `<th class="vendor-col" title="${escape(v.name)}">${escape(shortVendorName(v.name))}${isCN ? `<span class="vendor-col-flag">CN · RFQ</span>` : `<span class="vendor-col-flag">${escape(v.country)}</span>`}</th>`;
  });
  header += `</tr></thead>`;

  // Find cheapest vendor per SKU (PLN, only priced PL/EU cells)
  const cheapestByPart = {};
  enabled.forEach(part => {
    let best = null;
    visibleVendors.forEach(v => {
      if (v.region === "CN") return;
      const li = findLineItem(v, part.id);
      if (li && li.unit_price_pln != null) {
        if (best == null || li.unit_price_pln < best.price) {
          best = { vendor: v.id, price: li.unit_price_pln };
        }
      }
    });
    if (best) cheapestByPart[part.id] = best.vendor;
  });

  // Body rows
  let body = `<tbody>`;
  enabled.forEach(part => {
    body += `<tr><td class="sku-cell">${escape(shortPartName(part.name))}<br><span class="sku-spec">${escape(part.spec)}</span></td>`;
    visibleVendors.forEach(v => {
      const li = findLineItem(v, part.id);
      if (v.region === "CN") {
        body += `<td class="cell-rfq">RFQ</td>`;
      } else if (li && li.unit_price_pln != null) {
        const isCheapest = cheapestByPart[part.id] === v.id && Object.values(cheapestByPart).filter(x => x).length > 0;
        const priceTxt = li.product_url
          ? `<a href="${escape(li.product_url)}" target="_blank" rel="noopener">${fmtPLNCompact(li.unit_price_pln)}</a>`
          : fmtPLNCompact(li.unit_price_pln);
        body += `<td class="cell-priced ${isCheapest ? "cell-cheapest" : ""}">${priceTxt}</td>`;
      } else {
        body += `<td class="cell-empty">—</td>`;
      }
    });
    body += `</tr>`;
  });
  body += `</tbody>`;

  // Footer: per-vendor coverage count
  let footer = `<tfoot><tr><td class="sku-cell">Pokrycie SKU</td>`;
  visibleVendors.forEach(v => {
    if (v.region === "CN") {
      footer += `<td>RFQ</td>`;
    } else {
      const cov = enabled.filter(part => {
        const li = findLineItem(v, part.id);
        return li && li.unit_price_pln != null;
      }).length;
      footer += `<td>${cov} / ${enabled.length}</td>`;
    }
  });
  footer += `</tr></tfoot>`;

  matrix.innerHTML = header + body + footer;
}

function shortVendorName(name) {
  // Compress long vendor names for matrix headers
  return name
    .replace(/\.pl$/i, "")
    .replace(/\.de$/i, "")
    .replace(/\s+\(.*?\)\s*/g, " ")
    .replace(/\bSp\.?\s*z\s*o\.?o\.?/gi, "")
    .trim();
}

function shortPartName(name) {
  // Compress long SKU names for matrix rows
  return name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

function toggleRow(id) {
  document.querySelectorAll("tr.vendor-row").forEach(r => {
    if (r.dataset.id === id) r.classList.toggle("open");
    else r.classList.remove("open");
  });
  document.querySelectorAll("tr.email-row").forEach(r => {
    if (r.dataset.id === id) r.classList.toggle("open");
    else r.classList.remove("open");
  });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "✓ skopiowano";
    setTimeout(() => { btn.textContent = orig; }, 1400);
  } catch {
    btn.textContent = "błąd kopiowania";
  }
}

function escape(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- bootstrap ---------- //

document.querySelectorAll('input[name="region"]').forEach(radio => {
  radio.addEventListener("change", e => {
    CURRENT_REGION = e.target.value;
    renderVendors();
    renderMatrix();
  });
});

document.getElementById("reset-basket").addEventListener("click", () => {
  initBasketState();
  render();
});

document.getElementById("toggle-all").addEventListener("click", e => {
  const anyEnabled = Object.values(BASKET_STATE).some(s => s.enabled);
  Object.values(BASKET_STATE).forEach(s => { s.enabled = !anyEnabled; });
  e.target.textContent = anyEnabled ? "Zaznacz wszystkie" : "Odznacz wszystkie";
  render();
});

loadSnapshot()
  .then(data => {
    SNAPSHOT = data;
    initBasketState();
    render();
  })
  .catch(err => {
    document.getElementById("vendor-rows").innerHTML =
      `<tr><td colspan="7" style="padding:24px;color:#b91c1c">Nie udało się załadować snapshot.json: ${escape(err.message)}</td></tr>`;
  });
