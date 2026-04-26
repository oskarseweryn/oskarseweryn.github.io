"use strict";

// Backend used by the "Odśwież" button.
//   - localhost  → local FastAPI on :8001 (works during development / friend demo on Oskar's laptop)
//   - elsewhere  → empty string → button shows offline-mode banner with run instructions
//                  (replace with deployed origin once backend is hosted: Cloudflare Worker, Vercel, etc.)
const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const BACKEND_URL = IS_LOCAL ? "http://localhost:8001" : "";

const FX_TO_PLN = { PLN: 1, EUR: 4.30, USD: 4.00, GBP: 5.10 };

const fmtPLN = (n) => new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", maximumFractionDigits: 0 }).format(n);

let SNAPSHOT = null;
let CURRENT_REGION = "PL";
let QUANTITY = 500;

async function loadSnapshot() {
  const res = await fetch("./snapshot.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot.json: ${res.status}`);
  return res.json();
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function logoUrl(v) {
  const domain = getDomain(v.product_url);
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function fillTemplate(text) {
  if (text == null) return "";
  return String(text).replace(/\{count\}/g, String(QUANTITY));
}

function unitPriceToPLN(retailUnitPLN) {
  return retailUnitPLN; // snapshot already stores in PLN
}

function totalForVendor(v) {
  return Math.round(v.retail_unit_pln * QUANTITY);
}

function render() {
  if (!SNAPSHOT) return;
  document.getElementById("last-updated").textContent = SNAPSHOT.last_updated;
  document.getElementById("pricing-note").textContent = SNAPSHOT.pricing_note;
  document.querySelectorAll("th.total-header").forEach(th => {
    th.textContent = `${QUANTITY} × cena (PLN)`;
  });

  const tbody = document.getElementById("vendor-rows");
  tbody.innerHTML = "";

  const visible = SNAPSHOT.vendors.filter(v =>
    CURRENT_REGION === "PL" ? v.region === "PL" : true
  );

  visible
    .slice()
    .sort((a, b) => a.retail_unit_pln - b.retail_unit_pln)
    .forEach(v => {
      tbody.appendChild(buildVendorRow(v));
      tbody.appendChild(buildEmailRow(v));
    });
}

function buildVendorRow(v) {
  const tr = document.createElement("tr");
  tr.className = "vendor-row";
  tr.dataset.id = v.id;

  const sizesCell = v.sizes_full_coverage
    ? `<span class="size-yes">✓ ${escape(v.sizes_label)}</span>`
    : `<span class="size-no">⚠ ${escape(v.sizes_label)}</span>`;

  const emailCell = v.email
    ? `<a href="mailto:${escape(v.email)}" onclick="event.stopPropagation()">${escape(v.email)}</a>`
    : `<span class="no-email">brak publicznego adresu — <a href="${escape(v.contact_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">formularz</a></span>`;

  tr.innerHTML = `
    <td>
      <div class="vendor-name-cell">
        <img class="vendor-logo" src="${logoUrl(v)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="vendor-text">
          <div class="vendor-name">${escape(v.name)}</div>
          <div class="product-name">${escape(v.product_name)}</div>
        </div>
      </div>
    </td>
    <td>${escape(v.country)}</td>
    <td><a href="${escape(v.product_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">zobacz produkt →</a></td>
    <td class="num price-cell" data-id="${v.id}">
      <div class="price-base">${escape(v.retail_unit_label)}</div>
    </td>
    <td class="num total-cell" data-id="${v.id}">
      <strong>${fmtPLN(totalForVendor(v))}</strong>
    </td>
    <td>${sizesCell}</td>
    <td>${escape(v.weight)}</td>
    <td class="email-cell">${emailCell}</td>
    <td><button class="toggle" type="button">wzór emaila ▾</button></td>
  `;

  tr.addEventListener("click", () => toggleRow(v.id));
  return tr;
}

function buildEmailRow(v) {
  const tr = document.createElement("tr");
  tr.className = "email-row";
  tr.dataset.id = v.id;

  const recipient = v.email || `(brak publicznego adresu — użyj ${v.contact_url})`;
  const subject = fillTemplate(v.email_draft.subject);
  const body = fillTemplate(v.email_draft.body);
  const mailto = v.email
    ? `mailto:${encodeURIComponent(v.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : v.contact_url;
  const mailtoLabel = v.email ? "Otwórz w poczcie" : "Otwórz formularz";
  const langLabel = { pl: "PL", de: "DE", en: "EN" }[v.language] || v.language.toUpperCase();

  tr.innerHTML = `
    <td colspan="9">
      <p class="email-meta">Do: ${escape(recipient)} · Język: ${langLabel} · Uwagi: ${escape(v.notes || "")}</p>
      <div class="email-actions">
        <button type="button" class="copy-subject">Kopiuj temat</button>
        <button type="button" class="copy-body">Kopiuj treść</button>
        <a class="primary" href="${mailto}" target="_blank" rel="noopener">${mailtoLabel}</a>
      </div>
      <div class="email-content">
        <p class="label">Temat</p>
        <pre class="subj"></pre>
        <p class="label">Treść</p>
        <pre class="body"></pre>
      </div>
    </td>
  `;

  tr.querySelector(".subj").textContent = subject;
  tr.querySelector(".body").textContent = body;

  tr.querySelector(".copy-subject").addEventListener("click", e => {
    e.stopPropagation();
    copyText(subject, e.target);
  });
  tr.querySelector(".copy-body").addEventListener("click", e => {
    e.stopPropagation();
    copyText(body, e.target);
  });

  return tr;
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

// ---------- live refresh via backend ---------- //

function setRowState(vendorId, state, payload) {
  const priceCell = document.querySelector(`.price-cell[data-id="${vendorId}"]`);
  const totalCell = document.querySelector(`.total-cell[data-id="${vendorId}"]`);
  if (!priceCell || !totalCell) return;

  // wipe any prior live/loading/error annotations
  priceCell.querySelectorAll(".price-live, .price-loading, .price-error").forEach(el => el.remove());
  totalCell.querySelectorAll(".total-live").forEach(el => el.remove());

  if (state === "loading") {
    const span = document.createElement("span");
    span.className = "price-loading";
    span.textContent = "odświeżanie…";
    priceCell.appendChild(span);
    return;
  }

  if (state === "live") {
    const { price, currency, availability } = payload;
    const fxRate = FX_TO_PLN[currency] || 1;
    const pricePLN = price * fxRate;
    const totalPLN = pricePLN * QUANTITY;

    const base = priceCell.querySelector(".price-base");
    if (base) {
      base.textContent = currency && currency !== "PLN"
        ? `${price} ${currency} (~${Math.round(pricePLN)} PLN)`
        : `${price} ${currency || "PLN"}`;
    }

    const live = document.createElement("span");
    live.className = "price-live";
    const availTxt = ({
      InStock: "✓ dostępne",
      OutOfStock: "✗ brak",
      LimitedAvailability: "● ograniczona",
      PreOrder: "● przedsprzedaż",
    }[availability]) || "● status nieznany";
    const ts = new Date().toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
    live.textContent = `live · ${availTxt} · ${ts}`;
    priceCell.appendChild(live);

    totalCell.innerHTML = `<strong>${fmtPLN(totalPLN)}</strong>`;
    const tlive = document.createElement("div");
    tlive.className = "total-live";
    tlive.textContent = "live";
    totalCell.appendChild(tlive);
    return;
  }

  if (state === "error") {
    const err = document.createElement("span");
    err.className = "price-error";
    err.textContent = `⚠ ${payload?.error || "błąd pobierania"}`;
    priceCell.appendChild(err);
  }
}

async function refreshVendor(vendor) {
  setRowState(vendor.id, "loading");
  try {
    const res = await fetch(`${BACKEND_URL}/refresh/${encodeURIComponent(vendor.id)}`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      setRowState(vendor.id, "live", data);
    } else {
      setRowState(vendor.id, "error", { error: data.error || "brak danych" });
    }
  } catch (err) {
    setRowState(vendor.id, "error", { error: err.message || "błąd sieci" });
  }
}

async function refreshAllVisible() {
  if (!BACKEND_URL) {
    showOfflineBanner();
    return;
  }
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = "↻ Odświeżanie…";

  const visible = SNAPSHOT.vendors.filter(v =>
    CURRENT_REGION === "PL" ? v.region === "PL" : true
  );

  await Promise.allSettled(visible.map(refreshVendor));

  btn.disabled = false;
  btn.textContent = origLabel;
}

function showOfflineBanner() {
  let banner = document.getElementById("offline-banner");
  if (banner) { banner.scrollIntoView({ behavior: "smooth", block: "nearest" }); return; }
  banner = document.createElement("div");
  banner.id = "offline-banner";
  banner.className = "offline-banner";
  banner.innerHTML = `
    <strong>Live refresh działa lokalnie.</strong>
    Strona pokazuje zapisany snapshot z dnia <code>${escape(SNAPSHOT?.last_updated || "—")}</code>.
    Aby pobierać aktualne ceny i dostępność z 12 sklepów na żywo, uruchom backend FastAPI na swoim komputerze:
    <pre>cd backend &amp;&amp; uvicorn main:app --port 8001</pre>
    Backend scrapuje każdego sprzedawcę z osobna (JSON-LD, OpenGraph, microdata, listing fallback) i zwraca aktualną cenę + dostępność per produkt.
    <button type="button" class="dismiss" onclick="document.getElementById('offline-banner').remove()">×</button>
  `;
  document.querySelector("header .controls").appendChild(banner);
}

// ---------- bootstrap ---------- //

document.querySelectorAll('input[name="region"]').forEach(radio => {
  radio.addEventListener("change", e => {
    CURRENT_REGION = e.target.value;
    render();
  });
});

document.getElementById("quantity-input").addEventListener("input", e => {
  const v = parseInt(e.target.value, 10);
  if (!isNaN(v) && v > 0 && v <= 100000) {
    QUANTITY = v;
    render();
  }
});

document.getElementById("refresh-btn").addEventListener("click", refreshAllVisible);

loadSnapshot()
  .then(data => { SNAPSHOT = data; render(); })
  .catch(err => {
    document.getElementById("vendor-rows").innerHTML =
      `<tr><td colspan="9" style="padding:24px;color:#b91c1c">Nie udało się załadować snapshot.json: ${escape(err.message)}</td></tr>`;
  });
