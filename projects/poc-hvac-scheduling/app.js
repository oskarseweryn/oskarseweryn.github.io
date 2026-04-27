/* =====================================================================
   KlimaPro — POC client-side logic (no backend)
   - Address geocoding via Nominatim (OpenStreetMap, public, free)
   - Haversine 100 km geofence from Kraków center
   - Slot generator: pn–pt 8:00–17:00, slot 90 min, demo busy intervals
   - In-page booking confirmation card (no real Google Calendar call)
   ===================================================================== */

const KRAKOW = { lat: 50.0614, lon: 19.9366 };
const GEOFENCE_KM = 100;
const WORK_START = 8;
const WORK_END = 17;
const SLOT_MINUTES = 90;
const PL_WEEKDAYS = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------- date helpers ---------- */
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtTime(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function fmtPlDateTime(d) {
  const wd = PL_WEEKDAYS[d.getDay()];
  return `${wd}, ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} ${fmtTime(d)}`;
}

/* ---------- geocoding ---------- */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocode(address) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", address);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "pl");
  url.searchParams.set("addressdetails", "0");
  const r = await fetch(url, { headers: { "Accept-Language": "pl" } });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const data = await r.json();
  if (!data || !data.length) return null;
  const hit = data[0];
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  const distance = haversineKm(KRAKOW.lat, KRAKOW.lon, lat, lon);
  return {
    lat, lon,
    displayName: hit.display_name || address,
    distanceKm: Math.round(distance * 10) / 10,
    withinRadius: distance <= GEOFENCE_KM,
  };
}

let geocodeTimer = null;
let lastGeocode = null;

function renderGeocode(state) {
  const box = $("#geocode-result");
  if (!state) { box.innerHTML = ""; return; }
  if (state.error) {
    box.innerHTML = `<div class="kp-note err">${state.error}</div>`;
    return;
  }
  if (state.withinRadius) {
    box.innerHTML = `<div class="kp-note ok">
      <strong>✓ Adres w zasięgu</strong> — ${state.distanceKm} km od centrum Krakowa.
      <div style="font-size:12px; opacity:.85; margin-top:2px;">${state.displayName}</div>
    </div>`;
  } else {
    box.innerHTML = `<div class="kp-note warn">
      <strong>✕ Adres poza obszarem działania</strong> — ${state.distanceKm} km od Krakowa (limit 100 km).
      <div style="font-size:12px; opacity:.85; margin-top:2px;">${state.displayName}</div>
    </div>`;
  }
}

$("#address").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  lastGeocode = null;
  clearTimeout(geocodeTimer);
  if (v.length < 5) { renderGeocode(null); return; }
  geocodeTimer = setTimeout(async () => {
    try {
      const result = await geocode(v);
      if (!result) {
        renderGeocode({ error: "Nie znaleziono tego adresu w Polsce." });
        return;
      }
      lastGeocode = result;
      renderGeocode(result);
    } catch (err) {
      renderGeocode({ error: "Nie udało się sprawdzić adresu. Spróbuj ponownie." });
    }
  }, 600);
});

/* ---------- slots ---------- */
// Demo busy intervals: relative to "today + N days" so the page feels alive.
function demoBusyForDay(day) {
  // day is a Date at 00:00 local
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayDelta = Math.round((day - today) / (1000 * 60 * 60 * 24));
  const seeds = {
    1: [[10, 0, 90, "Serwis — Wadowicka"], [13, 0, 90, "Montaż — Salwator"]],
    2: [[9, 0, 90, "Serwis — Bronowice"]],
    3: [[15, 0, 90, "Przegląd okresowy"]],
    4: [[8, 0, 90, "Serwis — Nowa Huta"], [14, 30, 90, "Montaż — Tyniec"]],
  };
  return (seeds[dayDelta] || []).map(([h, m, mins]) => {
    const start = new Date(day); start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + mins * 60 * 1000);
    return [start, end];
  });
}

function listSlots(dateStr) {
  const day = new Date(dateStr + "T00:00:00");
  if (day.getDay() === 0 || day.getDay() === 6) return [];
  const start = new Date(day); start.setHours(WORK_START, 0, 0, 0);
  const end = new Date(day); end.setHours(WORK_END, 0, 0, 0);
  const busy = demoBusyForDay(day);
  const now = new Date();
  const slotMs = SLOT_MINUTES * 60 * 1000;
  const slots = [];
  let cursor = new Date(start);
  while (cursor.getTime() + slotMs <= end.getTime()) {
    const s = new Date(cursor);
    const e = new Date(cursor.getTime() + slotMs);
    if (s > now && !busy.some(([bs, be]) => bs < e && be > s)) {
      slots.push({ start: s, end: e });
    }
    cursor = new Date(cursor.getTime() + slotMs);
  }
  return slots;
}

function renderSlots(dateStr) {
  const box = $("#slots");
  let slots;
  try { slots = listSlots(dateStr); }
  catch { box.innerHTML = `<div class="kp-note err">Nieprawidłowa data.</div>`; return; }
  if (!slots.length) {
    box.innerHTML = `<div class="kp-note warn">Brak dostępnych terminów w tym dniu (weekend lub wszystkie sloty zajęte). Wybierz inną datę.</div>`;
    $("#slot_start_iso").value = "";
    return;
  }
  const html = slots.map(s =>
    `<button type="button" class="slot-btn" data-slot-iso="${s.start.toISOString()}">${fmtTime(s.start)}–${fmtTime(s.end)}</button>`
  ).join("");
  box.innerHTML = `<div class="slots">${html}</div><div class="helper" style="margin-top:8px;">Kliknij godzinę, aby ją wybrać.</div>`;
  $("#slot_start_iso").value = "";
}

/* default date = tomorrow */
(function initDate() {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const today = new Date();
  $("#date").min = isoDate(today);
  $("#date").value = isoDate(tomorrow);
  renderSlots($("#date").value);
})();

$("#date").addEventListener("change", (e) => renderSlots(e.target.value));

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-slot-iso]");
  if (!btn) return;
  e.preventDefault();
  $("#slot_start_iso").value = btn.dataset.slotIso;
  $$("[data-slot-iso]").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
});

/* ---------- form submission ---------- */
const form = $("#booking-form");

function showError(msg) {
  $("#result").innerHTML = `<div class="kp-error-box">
    <div class="head">Nie udało się złożyć rezerwacji</div>
    <p style="margin:0;">${msg}</p>
  </div>`;
  $("#result").scrollIntoView({ behavior: "smooth", block: "center" });
}

function showConfirmation(data) {
  const start = new Date(data.slot_start_iso);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);
  const typeLabel = data.request_type === "montaz" ? "Montaż" : "Serwis";
  const eventId = `demo-${Math.floor(start.getTime() / 1000)}`;
  $("#result").innerHTML = `<div class="kp-confirm">
    <div class="head">
      <div class="badge">✓</div>
      <div>
        <div class="eye">Potwierdzenie</div>
        <h3>Termin zarezerwowany</h3>
        <p style="margin:0;">Wizyta została dodana do kalendarza technika (mock — w produkcji wpada do prawdziwego Google Calendar).</p>
      </div>
    </div>
    <dl>
      <div><dt>Termin</dt><dd>${fmtPlDateTime(start)} – ${fmtTime(end)}</dd></div>
      <div><dt>Typ zlecenia</dt><dd>${typeLabel}</dd></div>
      <div><dt>Klient</dt><dd>${escapeHtml(data.customer_name)}</dd></div>
      <div><dt>Telefon</dt><dd>${escapeHtml(data.phone)}</dd></div>
      <div class="span2"><dt>Adres</dt><dd>${escapeHtml(data.addressDisplay)}</dd></div>
      <div><dt>Odległość od Krakowa</dt><dd>${data.distanceKm} km</dd></div>
      <div><dt>ID wydarzenia (mock)</dt><dd class="mono">${eventId}</dd></div>
      <div class="span2"><dt>Opis</dt><dd class="muted">${escapeHtml(data.description)}</dd></div>
    </dl>
    <p style="font-size:12px; color:#1b6b3b; margin-top:14px;">
      To statyczne demo — żadne wydarzenie nie zostało faktycznie utworzone. Pełna integracja z Google Calendar w repo.
    </p>
  </div>`;
  $("#result").scrollIntoView({ behavior: "smooth", block: "center" });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const data = {
    customer_name: (fd.get("customer_name") || "").toString().trim(),
    phone: (fd.get("phone") || "").toString().trim(),
    address: (fd.get("address") || "").toString().trim(),
    request_type: fd.get("request_type"),
    description: (fd.get("description") || "").toString().trim(),
    slot_start_iso: (fd.get("slot_start_iso") || "").toString(),
  };

  if (data.customer_name.length < 3) return showError("Podaj imię i nazwisko (min. 3 znaki).");
  if (!/^(\+?48)?[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}$/.test(data.phone)) return showError("Nieprawidłowy format telefonu.");
  if (data.address.length < 5) return showError("Podaj pełny adres (min. 5 znaków).");
  if (!data.request_type) return showError("Wybierz typ zlecenia: Montaż lub Serwis.");
  if (data.description.length < 10) return showError("Opis musi mieć co najmniej 10 znaków.");
  if (!data.slot_start_iso) return showError("Wybierz termin (godzinę).");

  let geo = lastGeocode;
  if (!geo) {
    try { geo = await geocode(data.address); }
    catch { return showError("Nie udało się sprawdzić adresu. Spróbuj ponownie."); }
  }
  if (!geo) return showError("Nie znaleziono adresu. Doprecyzuj wpis.");
  if (!geo.withinRadius) return showError(`Adres jest poza zasięgiem: ${geo.distanceKm} km od Krakowa (limit ${GEOFENCE_KM} km).`);

  data.addressDisplay = geo.displayName;
  data.distanceKm = geo.distanceKm;
  showConfirmation(data);
});
