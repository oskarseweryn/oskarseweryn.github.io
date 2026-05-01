"use strict";

// Static frontend for gastro-sourcing comparison.
// Reads `snapshot.json` (rewritten by /gastro-sourcing slash command).
// Adds: 7-category filter, vendor categories_served chips, quality_grade + freshness badges,
// per-category section headers in basket and matrix tables.

const fmtPLN = (n) =>
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(n);

const fmtPLNCompact = (n) =>
  new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(n);

let SNAPSHOT = null;
let CURRENT_REGION = "PL";
let CURRENT_CATEGORY = "meat"; // domyślnie najmocniej pokryta kategoria — przełączalne przez pills
// BASKET_STATE: { [part_id]: { enabled: bool, qty: number } }
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
  const domain = getDomain(v.homepage || v.contact_url || "");
  if (!domain) return "";
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function getCategory(catId) {
  return SNAPSHOT.categories.find(c => c.id === catId) || null;
}

function initBasketState() {
  BASKET_STATE = {};
  for (const p of SNAPSHOT.basket) {
    BASKET_STATE[p.id] = { enabled: true, qty: p.qty_default };
  }
}

function activeCategoryFilter(p) {
  return CURRENT_CATEGORY === "ALL" || p.category === CURRENT_CATEGORY;
}

function enabledParts() {
  return SNAPSHOT.basket.filter(p => BASKET_STATE[p.id]?.enabled && activeCategoryFilter(p));
}

function qtyFor(partId) {
  const s = BASKET_STATE[partId];
  return s && s.enabled ? Math.max(0, s.qty | 0) : 0;
}

function findLineItem(vendor, partId) {
  if (!vendor.line_items) return null;
  return vendor.line_items.find(li => li.part_id === partId) || null;
}

function vendorMatchesRegion(v, region) {
  if (region === "PL") return v.region === "PL";
  if (region === "ALL") return v.region === "PL" || v.region === "EU";
  return true; // GLOBAL
}

function vendorMatchesCategoryFilter(v) {
  if (CURRENT_CATEGORY === "ALL") return true;
  return v.categories_served && v.categories_served.includes(CURRENT_CATEGORY);
}

function fillTemplate(text) {
  if (text == null) return "";
  const enabled = SNAPSHOT.basket.filter(p => BASKET_STATE[p.id]?.enabled);
  const summary = enabled.length === 0
    ? "(brak wybranych pozycji)"
    : enabled
        .map((p, i) => {
          const unit = p.unit || "szt";
          return `${i + 1}. ${p.name} — ${qtyFor(p.id)} ${unit}/mies. (${p.spec})`;
        })
        .join("\n");

  return String(text).replace(/\{basket\}/g, summary);
}

function fillTemplateForVendor(text, vendor) {
  if (text == null) return "";
  const enabled = SNAPSHOT.basket.filter(p =>
    BASKET_STATE[p.id]?.enabled
    && vendor.categories_served
    && vendor.categories_served.includes(p.category)
  );
  const summary = enabled.length === 0
    ? "(brak pasujących pozycji)"
    : enabled
        .map((p, i) => {
          const unit = p.unit || "szt";
          return `${i + 1}. ${p.name} — ${qtyFor(p.id)} ${unit}/mies. (${p.spec})`;
        })
        .join("\n");
  return String(text).replace(/\{basket\}/g, summary);
}

function render() {
  if (!SNAPSHOT) return;
  document.getElementById("last-updated").textContent = SNAPSHOT.last_updated;
  document.getElementById("pricing-note").textContent = SNAPSHOT.pricing_note || "";

  const c = SNAPSHOT.client;
  if (c) {
    document.getElementById("header-title").textContent = `Sourcing gastronomiczny — ${c.name || ""}`;
    document.getElementById("client-line").innerHTML =
      `<strong>${escape(c.name || "")}</strong> · ${escape(c.tagline || "")} · dostawa: ${escape(c.ship_to || "")}`;
  }

  renderCategoryNav();
  renderBasket();
  renderShoppingPlan();
  renderMatrices();
}

// ---------- Pricing helpers (avg, savings) ---------- //

// Returns { avg, n, prices: [{ vendor_id, price_pln }] } over visible non-CN vendors that
// (a) serve the SKU's category and (b) have a priced line_item for this part_id.
function vendorPricesForPart(part) {
  const visible = SNAPSHOT.vendors.filter(v =>
    vendorMatchesRegion(v, CURRENT_REGION) && v.region !== "CN"
  );
  const prices = [];
  visible.forEach(v => {
    if (!v.categories_served || !v.categories_served.includes(part.category)) return;
    const li = findLineItem(v, part.id);
    if (li && li.unit_price_pln != null) {
      prices.push({ vendor_id: v.id, price_pln: li.unit_price_pln });
    }
  });
  if (prices.length === 0) return { avg: null, n: 0, prices: [] };
  const avg = prices.reduce((s, p) => s + p.price_pln, 0) / prices.length;
  return { avg, n: prices.length, prices };
}

// ---------- Shopping plan ---------- //

function renderShoppingPlan() {
  const cardsEl = document.getElementById("plan-cards");
  const summaryEl = document.getElementById("plan-summary");
  const rfqEl = document.getElementById("plan-rfq");
  if (!cardsEl || !summaryEl || !rfqEl) return;

  const enabled = enabledParts();
  if (enabled.length === 0) {
    cardsEl.innerHTML = `<p class="plan-empty">Zaznacz pozycje w koszyku, żeby zobaczyć plan zakupów.</p>`;
    summaryEl.innerHTML = "";
    rfqEl.innerHTML = "";
    return;
  }

  const visibleVendors = SNAPSHOT.vendors.filter(v =>
    vendorMatchesRegion(v, CURRENT_REGION) && vendorMatchesCategoryFilter(v)
  );

  // For each enabled SKU, find cheapest vendor that has it priced
  const winnerByPart = {}; // part_id -> { vendor, price_pln, line_item }
  const uncovered = [];    // SKUs no priced vendor covers

  enabled.forEach(part => {
    let best = null;
    visibleVendors.forEach(v => {
      if (v.region === "CN") return;
      if (!v.categories_served || !v.categories_served.includes(part.category)) return;
      const li = findLineItem(v, part.id);
      if (li && li.unit_price_pln != null) {
        if (best == null || li.unit_price_pln < best.price_pln) {
          best = { vendor: v, price_pln: li.unit_price_pln, line_item: li };
        }
      }
    });
    if (best) {
      winnerByPart[part.id] = best;
    } else {
      uncovered.push(part);
    }
  });

  // Group SKUs by winning vendor + compute savings vs avg-across-vendors per item
  const byVendor = {};
  let totalSavings = 0;       // PLN/mies. saved vs buying everything at avg-cross-vendor price
  let totalAvgBasket = 0;     // sum of qty × avg-price (only for parts that have ≥2 priced vendors)
  let totalSingleSourceCount = 0; // # SKUs where only one vendor has price (no savings comparable)

  Object.entries(winnerByPart).forEach(([part_id, win]) => {
    const part = enabled.find(p => p.id === part_id);
    const qty = qtyFor(part_id);
    const line_total = win.price_pln * qty;
    const vid = win.vendor.id;
    if (!byVendor[vid]) byVendor[vid] = { vendor: win.vendor, items: [], total: 0, savings: 0 };

    const stats = vendorPricesForPart(part);
    let savings_pln = null;       // PLN/mies., null if not comparable
    let savings_pct = null;        // ratio vs avg, null if not comparable
    if (stats.n >= 2 && stats.avg != null) {
      const avg_line = stats.avg * qty;
      savings_pln = Math.round(avg_line - line_total);
      savings_pct = (stats.avg - win.price_pln) / stats.avg;
      totalAvgBasket += avg_line;
      totalSavings += savings_pln;
    } else {
      // Single-vendor SKU — no comparable avg
      totalAvgBasket += line_total;
      totalSingleSourceCount += 1;
    }

    byVendor[vid].items.push({
      part, line_item: win.line_item, qty, line_total,
      avg_pln: stats.avg, n_vendors: stats.n,
      savings_pln, savings_pct,
    });
    byVendor[vid].total += line_total;
    if (savings_pln != null) byVendor[vid].savings += savings_pln;
  });

  const vendorPlans = Object.values(byVendor).sort((a, b) => b.total - a.total);

  // Render plan cards
  cardsEl.innerHTML = vendorPlans.map(plan => buildPlanCard(plan)).join("") || `<p class="plan-empty">Brak żywych cen u dostawców z bieżącego filtra. Pozycje koszyka wymagają RFQ — sprawdź sekcję poniżej.</p>`;

  const grandTotal = vendorPlans.reduce((s, p) => s + p.total, 0);
  const numShops = vendorPlans.length;

  let summaryHTML = "";
  if (vendorPlans.length > 0) {
    summaryHTML += `<div class="plan-grand">
      <span class="plan-grand-label">Razem (${numShops} ${numShops === 1 ? "sklep" : numShops < 5 ? "sklepy" : "sklepów"}):</span>
      <strong>${fmtPLN(grandTotal)}</strong>
      <span class="plan-grand-sub">/ miesiąc · ${Object.keys(winnerByPart).length} z ${enabled.length} pozycji koszyka pokrytych</span>
    </div>`;

    // Savings vs avg-price-across-vendors (only on SKUs with ≥2 priced vendors)
    const comparableCount = Object.keys(winnerByPart).length - totalSingleSourceCount;
    if (totalSavings > 0 && comparableCount > 0) {
      const savingsPct = totalAvgBasket > 0 ? totalSavings / totalAvgBasket : 0;
      summaryHTML += `<div class="plan-savings-line">
        <span class="plan-savings-strong">↓ Oszczędność vs średnia cena rynku: ${fmtPLN(totalSavings)} / mies.</span>
        <span class="plan-savings-sub">(${(savingsPct * 100).toFixed(1)}% taniej niż średnia z ${comparableCount} pozycji porównywalnych)</span>
      </div>`;
    } else if (comparableCount === 0) {
      summaryHTML += `<div class="plan-savings-line plan-savings-none">
        Wskaźnik oszczędności nieliczalny — każdy SKU jest dostępny tylko u jednego sklepu w bieżącym filtrze.
      </div>`;
    }
  }
  summaryEl.innerHTML = summaryHTML;

  // Uncovered SKUs — RFQ candidates from B2B-gated vendors
  if (uncovered.length > 0) {
    const groupedByCategory = {};
    uncovered.forEach(p => {
      if (!groupedByCategory[p.category]) groupedByCategory[p.category] = [];
      groupedByCategory[p.category].push(p);
    });

    let rfqHTML = `<h3 class="rfq-title">⚠ Pozycje wymagające RFQ (brak żywej ceny u publicznych sklepów)</h3>`;
    rfqHTML += `<p class="rfq-sub">Te SKU obsługują głównie hurtownie B2B-login (Makro, Selgros, Bidfood, Diversey, Ecolab, METRO). Kliknij dostawcę aby zobaczyć gotowy szablon RFQ — kopiuj temat i treść, otwieraj w poczcie.</p>`;
    rfqHTML += `<ul class="rfq-list">`;
    SNAPSHOT.categories.forEach(cat => {
      const items = groupedByCategory[cat.id];
      if (!items || items.length === 0) return;
      const candidates = visibleVendors.filter(v =>
        v.region !== "CN" &&
        v.categories_served && v.categories_served.includes(cat.id) &&
        v.pricing_status !== "scraped"
      );
      rfqHTML += `<li>
        <div class="rfq-cat-row"><span class="cat-icon">${cat.icon || ""}</span> <strong>${escape(cat.name_pl)}</strong>: ${items.map(p => escape(p.name)).join(", ")}</div>`;
      if (candidates.length > 0) {
        const chips = candidates.map(v =>
          `<button type="button" class="rfq-chip" data-vendor-id="${escape(v.id)}" title="Kliknij aby zobaczyć szablon RFQ">${escape(v.name)}</button>`
        ).join(" ");
        rfqHTML += `<div class="rfq-candidates">→ kandydaci: ${chips}</div>
          <div class="rfq-expand" data-cat-id="${escape(cat.id)}"></div>`;
      }
      rfqHTML += `</li>`;
    });
    rfqHTML += `</ul>`;
    rfqEl.innerHTML = rfqHTML;

    // Wire chip clicks → expand inline RFQ panel
    rfqEl.querySelectorAll(".rfq-chip").forEach(chip => {
      chip.addEventListener("click", e => {
        e.preventDefault();
        const vid = chip.dataset.vendorId;
        const v = SNAPSHOT.vendors.find(x => x.id === vid);
        if (!v) return;
        const expandTarget = chip.closest("li").querySelector(".rfq-expand");
        const isOpenForThis = chip.classList.contains("active");
        // Reset state in this category row
        chip.closest("li").querySelectorAll(".rfq-chip").forEach(c => c.classList.remove("active"));
        if (isOpenForThis) {
          expandTarget.innerHTML = "";
          return;
        }
        chip.classList.add("active");
        expandTarget.innerHTML = `<div class="rfq-panel-wrap"><h4>${escape(v.name)} — szablon RFQ</h4>${buildRfqPanel(v)}</div>`;
        wireRfqPanelEvents(expandTarget);
      });
    });
  } else {
    rfqEl.innerHTML = "";
  }
}

function buildPlanCard(plan) {
  const v = plan.vendor;
  const sortedItems = plan.items.slice().sort((a, b) => b.line_total - a.line_total);
  const linesHTML = sortedItems.map(it => {
    const cat = getCategory(it.part.category);
    const url = it.line_item.product_url;
    const nameWithLink = url
      ? `<a href="${escape(url)}" target="_blank" rel="noopener">${escape(it.part.name)}</a>`
      : escape(it.part.name);

    let savingsBadge = "";
    if (it.savings_pln != null && it.savings_pct != null) {
      const pct = (it.savings_pct * 100).toFixed(1);
      if (it.savings_pln > 0) {
        savingsBadge = `<span class="plan-item-savings savings-positive" title="Średnia cena z ${it.n_vendors} sklepów: ${fmtPLNCompact(it.avg_pln)} PLN/${escape(it.part.unit || "szt")}">−${pct}% / ${fmtPLN(it.savings_pln)}</span>`;
      } else {
        savingsBadge = `<span class="plan-item-savings savings-flat" title="Średnia cena z ${it.n_vendors} sklepów">≈ średnia</span>`;
      }
    } else {
      savingsBadge = `<span class="plan-item-savings savings-single" title="SKU dostępne tylko u tego dostawcy">jedyny dostawca</span>`;
    }

    return `<li>
      <span class="plan-item-name"><span class="cat-icon">${cat?.icon || ""}</span> ${nameWithLink}</span>
      <span class="plan-item-calc">${escape(it.line_item.unit_price_label || "")} × ${it.qty} ${escape(it.part.unit || "szt")} ${savingsBadge}</span>
      <span class="plan-item-total">${fmtPLN(it.line_total)}</span>
    </li>`;
  }).join("");

  const emailLink = v.email
    ? `<a class="plan-card-action" href="mailto:${escape(v.email)}" onclick="event.stopPropagation()">📧 ${escape(v.email)}</a>`
    : v.contact_url
      ? `<a class="plan-card-action" href="${escape(v.contact_url)}" target="_blank" rel="noopener">📋 formularz</a>`
      : v.homepage
        ? `<a class="plan-card-action" href="${escape(v.homepage)}" target="_blank" rel="noopener">🛒 sklep online</a>`
        : "";

  const minOrderFlag = (v.min_order_value_pln && plan.total < v.min_order_value_pln)
    ? `<div class="min-order-flag">⚠ koszyk poniżej min. zamówienia (${fmtPLNCompact(v.min_order_value_pln)} PLN)</div>`
    : "";

  const savingsLine = plan.savings > 0
    ? `<div class="plan-card-savings">↓ Oszczędność vs średnia: <strong>${fmtPLN(plan.savings)}/mies.</strong></div>`
    : "";

  return `<article class="plan-card" data-vendor-id="${escape(v.id)}">
    <header class="plan-card-header">
      <h3>${escape(v.name)}</h3>
      <span class="plan-card-country">${escape(v.country)}</span>
    </header>
    <ul class="plan-card-items">${linesHTML}</ul>
    <footer class="plan-card-footer">
      <div class="plan-card-total">
        <span>Razem od ${escape(v.name)}</span>
        <strong>${fmtPLN(plan.total)}</strong>
      </div>
      ${savingsLine}
      ${minOrderFlag}
      ${emailLink}
    </footer>
  </article>`;
}

function renderCategoryNav() {
  const nav = document.getElementById("category-nav");
  nav.innerHTML = "";

  // "Wszystkie" pill
  const allCount = SNAPSHOT.basket.length;
  const allPill = document.createElement("button");
  allPill.type = "button";
  allPill.className = "category-pill" + (CURRENT_CATEGORY === "ALL" ? " active" : "");
  allPill.dataset.cat = "ALL";
  allPill.innerHTML = `Wszystkie kategorie <span class="pill-count">${allCount}</span>`;
  nav.appendChild(allPill);

  SNAPSHOT.categories.forEach(cat => {
    const count = SNAPSHOT.basket.filter(p => p.category === cat.id).length;
    if (count === 0) return;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "category-pill" + (CURRENT_CATEGORY === cat.id ? " active" : "");
    pill.dataset.cat = cat.id;
    pill.innerHTML = `<span class="cat-icon">${cat.icon || ""}</span>${escape(cat.name_pl)} <span class="pill-count">${count}</span>`;
    nav.appendChild(pill);
  });

  nav.querySelectorAll(".category-pill").forEach(p => {
    p.addEventListener("click", e => {
      CURRENT_CATEGORY = e.currentTarget.dataset.cat;
      render();
    });
  });
}

function renderBasket() {
  const tbody = document.getElementById("basket-rows");
  tbody.innerHTML = "";

  // Group basket items by category, in the order categories appear in SNAPSHOT.categories
  const filtered = SNAPSHOT.basket.filter(p => CURRENT_CATEGORY === "ALL" || p.category === CURRENT_CATEGORY);

  const byCat = {};
  filtered.forEach(p => {
    if (!byCat[p.category]) byCat[p.category] = [];
    byCat[p.category].push(p);
  });

  SNAPSHOT.categories.forEach(cat => {
    const items = byCat[cat.id];
    if (!items || items.length === 0) return;

    // Category section header row
    const headerTr = document.createElement("tr");
    headerTr.className = "basket-cat-header";
    headerTr.innerHTML = `<td colspan="5"><span class="cat-icon">${cat.icon || ""}</span>${escape(cat.name_pl)} <span style="opacity:0.7">— ${items.length} SKU</span></td>`;
    tbody.appendChild(headerTr);

    items.forEach(p => {
      const state = BASKET_STATE[p.id] || { enabled: true, qty: p.qty_default };
      const tr = document.createElement("tr");
      if (!state.enabled) tr.classList.add("disabled");
      const qualityBadge = p.quality_grade
        ? `<span class="badge badge-${escape(p.quality_grade)}">${escape(p.quality_grade)}</span>`
        : "";
      const freshBadge = p.freshness
        ? `<span class="badge badge-${escape(p.freshness)}">${escape(p.freshness)}</span>`
        : "";
      tr.innerHTML = `
        <td class="check-col">
          <input class="sku-check" type="checkbox" data-part="${escape(p.id)}" ${state.enabled ? "checked" : ""}>
        </td>
        <td>
          <span class="sku-name">${escape(p.name)}</span>
          ${qualityBadge}${freshBadge}
        </td>
        <td><span class="sku-spec">${escape(p.spec)}</span></td>
        <td class="num qty-col">
          <input class="qty-input" type="number" min="0" max="100000" step="1"
                 value="${state.qty}" data-part="${escape(p.id)}" ${state.enabled ? "" : "disabled"}>
          <span class="qty-unit">${escape(p.unit || "szt")}</span>
        </td>
        <td><span class="sku-spec">${escape(p.use || "")}</span></td>
      `;
      tbody.appendChild(tr);
    });
  });

  // Wire events
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
        renderShoppingPlan();
        renderMatrices();
      }
    });
  });
}

// ---------- Matrices: one table per category ---------- //

function renderMatrices() {
  const container = document.getElementById("matrices");
  if (!container) return;
  container.innerHTML = "";

  const enabled = enabledParts();
  if (enabled.length === 0) {
    container.innerHTML = `<p class="plan-empty">Brak wybranych SKU w bieżącym filtrze — zaznacz pozycje w koszyku.</p>`;
    return;
  }

  const allVisibleVendors = SNAPSHOT.vendors.filter(v =>
    vendorMatchesRegion(v, CURRENT_REGION) && v.region !== "CN"
  );

  // Group enabled SKUs by category
  const byCat = {};
  enabled.forEach(p => {
    if (!byCat[p.category]) byCat[p.category] = [];
    byCat[p.category].push(p);
  });

  let renderedAny = false;
  SNAPSHOT.categories.forEach(cat => {
    const items = byCat[cat.id];
    if (!items || items.length === 0) return;

    // Vendors that serve this category
    const catVendors = allVisibleVendors.filter(v =>
      v.categories_served && v.categories_served.includes(cat.id)
    );

    // Score each vendor: # of SKUs in this category they have priced — sort desc
    const vendorWithCoverage = catVendors.map(v => {
      const covered = items.filter(p => {
        const li = findLineItem(v, p.id);
        return li && li.unit_price_pln != null;
      }).length;
      return { vendor: v, covered };
    }).sort((a, b) => b.covered - a.covered);

    if (vendorWithCoverage.length === 0) return;

    // Cheapest vendor per SKU within this category
    const cheapestByPart = {};
    items.forEach(part => {
      let best = null;
      vendorWithCoverage.forEach(({ vendor: v }) => {
        const li = findLineItem(v, part.id);
        if (li && li.unit_price_pln != null) {
          if (best == null || li.unit_price_pln < best.price) {
            best = { vendor_id: v.id, price: li.unit_price_pln };
          }
        }
      });
      if (best) cheapestByPart[part.id] = best.vendor_id;
    });

    // Build header
    let header = `<thead><tr><th class="sku-header-col">SKU</th>`;
    vendorWithCoverage.forEach(({ vendor: v, covered }) => {
      const flag = covered === 0
        ? `<span class="vendor-col-flag vendor-col-empty">${escape(v.country)} · 0 cen</span>`
        : `<span class="vendor-col-flag">${escape(v.country)} · ${covered}/${items.length}</span>`;
      header += `<th class="vendor-col" title="${escape(v.name)}">${escape(shortVendorName(v.name))}${flag}</th>`;
    });
    header += `</tr></thead>`;

    // Body
    let body = `<tbody>`;
    items.forEach(part => {
      body += `<tr><td class="sku-cell">${escape(shortPartName(part.name))}<br><span class="sku-spec">${escape(part.spec)} · ${escape(part.unit || "szt")}</span></td>`;
      vendorWithCoverage.forEach(({ vendor: v }) => {
        const li = findLineItem(v, part.id);
        if (li && li.unit_price_pln != null) {
          const isCheapest = cheapestByPart[part.id] === v.id;
          const url = li.product_url;
          const inner = url
            ? `<a href="${escape(url)}" target="_blank" rel="noopener">${fmtPLNCompact(li.unit_price_pln)}</a>`
            : fmtPLNCompact(li.unit_price_pln);
          body += `<td class="cell-priced ${isCheapest ? "cell-cheapest" : ""}">${inner}</td>`;
        } else {
          body += `<td class="cell-empty">—</td>`;
        }
      });
      body += `</tr>`;
    });
    body += `</tbody>`;

    // Render section
    const section = document.createElement("section");
    section.className = "category-matrix";
    section.innerHTML = `
      <h3 class="category-matrix-title"><span class="cat-icon">${cat.icon || ""}</span> ${escape(cat.name_pl)} <span class="category-matrix-count">— ${items.length} ${items.length === 1 ? "SKU" : items.length < 5 ? "SKU" : "SKU"} · ${vendorWithCoverage.length} ${vendorWithCoverage.length === 1 ? "dostawca" : "dostawców"}</span></h3>
      <div class="matrix-scroll">
        <table class="category-matrix-table">${header}${body}</table>
      </div>
    `;
    container.appendChild(section);
    renderedAny = true;
  });

  if (!renderedAny) {
    container.innerHTML = `<p class="plan-empty">Brak dostawców obsługujących wybrane kategorie w bieżącym filtrze regionu.</p>`;
  }
}

// ---------- RFQ panel for a vendor (used inline by clickable RFQ candidates) ---------- //

function buildRfqPanel(v) {
  const recipient = v.email || (v.contact_url ? `(formularz: ${v.contact_url})` : "(brak adresu)");
  const subject = v.email_draft ? fillTemplateForVendor(v.email_draft.subject, v) : "";
  const body = v.email_draft ? fillTemplateForVendor(v.email_draft.body, v) : "";
  const mailto = v.email
    ? `mailto:${encodeURIComponent(v.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : (v.contact_url || v.homepage || "#");
  const langLabel = { pl: "PL", de: "DE", en: "EN" }[v.language] || (v.language || "—").toUpperCase();

  if (!v.email_draft) {
    return `
      <div class="rfq-panel">
        <p class="email-meta">${escape(v.notes || "")}</p>
        <div class="email-actions">
          <a class="primary" href="${escape(v.homepage || mailto)}" target="_blank" rel="noopener">Otwórz sklep →</a>
        </div>
      </div>`;
  }

  return `
    <div class="rfq-panel">
      <p class="email-meta">Do: ${escape(recipient)} · Język: ${langLabel} · Region: ${escape(v.region)} · Kategorie: ${escape((v.categories_served || []).join(", "))}</p>
      <div class="email-actions">
        <button type="button" class="copy-subject" data-text="${escape(subject)}">Kopiuj temat</button>
        <button type="button" class="copy-body" data-text="${escape(body)}">Kopiuj treść</button>
        <a class="primary" href="${mailto}" target="_blank" rel="noopener">${v.email ? "Otwórz w poczcie" : "Otwórz formularz"}</a>
      </div>
      <div class="email-content">
        <p class="label">Temat</p>
        <pre class="subj">${escape(subject)}</pre>
        <p class="label">Treść</p>
        <pre class="body">${escape(body)}</pre>
      </div>
    </div>`;
}

function wireRfqPanelEvents(panel) {
  const subjBtn = panel.querySelector(".copy-subject");
  const bodyBtn = panel.querySelector(".copy-body");
  if (subjBtn) subjBtn.addEventListener("click", e => { e.stopPropagation(); copyText(subjBtn.dataset.text, subjBtn); });
  if (bodyBtn) bodyBtn.addEventListener("click", e => { e.stopPropagation(); copyText(bodyBtn.dataset.text, bodyBtn); });
}

function shortVendorName(name) {
  return name
    .replace(/\.pl$/i, "")
    .replace(/\.de$/i, "")
    .replace(/\s+\(.*?\)\s*/g, " ")
    .replace(/\bSp\.?\s*z\s*o\.?o\.?/gi, "")
    .trim();
}

function shortPartName(name) {
  return name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
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
    renderShoppingPlan();
    renderMatrices();
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

// ---------- Refresh button: local backend or GH Actions dispatch ---------- //

const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const LOCAL_BACKEND = "http://127.0.0.1:8001";
const GH_ACTIONS_URL = "https://github.com/oskarseweryn/oskarseweryn.github.io/actions/workflows/refresh-gastro-prices.yml";

document.getElementById("refresh-btn").addEventListener("click", openRefreshModal);

function openRefreshModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "refresh-modal-backdrop";
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) backdrop.remove();
  });

  let bodyHTML;
  if (IS_LOCAL) {
    bodyHTML = `
      <h3>Odśwież ceny — tryb lokalny</h3>
      <p>Tryb lokalny wykryty (${escape(location.hostname)}). Strona spróbuje wywołać scraper Pythonowy na <code>${escape(LOCAL_BACKEND)}</code>.</p>
      <p>Jeśli backend nie jest uruchomiony, wystartuj go w drugim oknie:</p>
      <pre>cd backend &amp;&amp; uvicorn server:app --port 8001</pre>
      <p>Albo uruchom CLI bezpośrednio:</p>
      <pre>.venv/bin/python backend/main.py refresh</pre>
      <div id="refresh-status"></div>
      <div class="refresh-modal-actions">
        <button type="button" class="cancel">Zamknij</button>
        <button type="button" class="primary run-now">▶ Odśwież teraz (POST ${escape(LOCAL_BACKEND)}/refresh)</button>
      </div>`;
  } else {
    bodyHTML = `
      <h3>Odśwież ceny — uruchom GitHub Action</h3>
      <p>Strona statyczna nie scrapuje cen w przeglądarce. Odświeżenie danych odbywa się przez GitHub Actions:
        scraper Pythonowy uruchamia się w workflow, parsuje 3 sklepy (beef.pl, bbq.pl, we-are-bbq.de),
        commituje nowy <code>snapshot.json</code> do repo, GitHub Pages podchwytuje automatycznie (~2&nbsp;min od commit).</p>
      <p>Klik poniżej otwiera stronę workflow. Na GitHub kliknij <strong>"Run workflow"</strong> &rarr; gałąź <code>main</code> &rarr; <strong>Run workflow</strong>.</p>
      <p>Wymaga uprawnień write do repo (tylko właściciel — Oskar).</p>
      <div class="refresh-modal-actions">
        <button type="button" class="cancel">Zamknij</button>
        <a class="primary" href="${escape(GH_ACTIONS_URL)}" target="_blank" rel="noopener">▶ Otwórz GitHub Actions</a>
      </div>`;
  }

  const modal = document.createElement("div");
  modal.className = "refresh-modal";
  modal.innerHTML = bodyHTML;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  modal.querySelector(".cancel").addEventListener("click", () => backdrop.remove());
  const runBtn = modal.querySelector(".run-now");
  if (runBtn) runBtn.addEventListener("click", () => runLocalRefresh(modal, runBtn));
}

async function runLocalRefresh(modal, btn) {
  const status = modal.querySelector("#refresh-status");
  status.className = "refresh-status info";
  status.textContent = "↻ Pobieranie cen — może zająć 10-15s...";
  btn.disabled = true;

  try {
    const res = await fetch(`${LOCAL_BACKEND}/refresh`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    status.className = "refresh-status ok";
    status.textContent = `✓ Gotowe — ${data.priced_count || "?"} cen pobranych. Przeładowuję stronę...`;
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    status.className = "refresh-status error";
    status.innerHTML = `✗ Błąd: ${escape(String(e.message || e))}<br>Sprawdź czy backend działa: <code>uvicorn server:app --port 8001</code>`;
    btn.disabled = false;
  }
}

loadSnapshot()
  .then(data => {
    SNAPSHOT = data;
    initBasketState();
    render();
  })
  .catch(err => {
    const cards = document.getElementById("plan-cards");
    if (cards) {
      cards.innerHTML = `<p class="plan-empty" style="color:#b91c1c">Nie udało się załadować snapshot.json: ${escape(err.message)}</p>`;
    }
  });
