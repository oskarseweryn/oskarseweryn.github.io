/* =====================================================================
   KlimaPro — POC client-side logic (no backend)
   - Address geocoding via Nominatim (OpenStreetMap, public, free)
   - Haversine 100 km service radius from Gaj (technician's home base)
   - Inferred commute time (1.5 min/km, 15 min floor) — total slot block
     = commute*2 + on-site work
   - Job size selector (small ≤1h / medium 1-2h / big 2-3h)
   - VIP detection (Żabka & co.) → on-site time × 1.5
   - In-page booking confirmation card (no real Google Calendar call)
   ===================================================================== */

const GAJ = { lat: 49.9626, lon: 19.9333 };
const GEOFENCE_KM = 100;
const WORK_START = 8;
const WORK_END = 17;
const SLOT_STEP_MINUTES = 30;

const COMMUTE_MIN_PER_KM = 1.5;     // ≈ 40 km/h average (urban + S7/A4 mix)
const COMMUTE_FLOOR_MIN = 15;
const DEFAULT_COMMUTE_MIN = 30;     // used when address not yet geocoded

const VIP_KEYWORDS = ["zabka", "żabka"];
const VIP_MULTIPLIER = 1.5;

const JOB_SIZE = {
  small:  { minutes: 60,  label: "Mała (do 1h)",   desc: "Drobny przegląd, wymiana filtra, doładowanie czynnika." },
  medium: { minutes: 120, label: "Średnia (1–2h)", desc: "Standardowy serwis, diagnostyka, czyszczenie zestawu." },
  big:    { minutes: 180, label: "Duża (2–3h)",    desc: "Pełny montaż, większa naprawa, przegląd kilku jednostek." },
};

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

/* ---------- geocoding + commute + VIP ---------- */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function commuteMinutesFor(distanceKm) {
  return Math.max(COMMUTE_FLOOR_MIN, Math.round(distanceKm * COMMUTE_MIN_PER_KM));
}

function detectVip(text) {
  const haystack = (text || "").toLowerCase();
  for (const kw of VIP_KEYWORDS) {
    if (haystack.includes(kw)) {
      return { isVip: true, label: kw.toUpperCase() };
    }
  }
  return { isVip: false, label: null };
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
  const distance = haversineKm(GAJ.lat, GAJ.lon, lat, lon);
  return {
    lat, lon,
    displayName: hit.display_name || address,
    distanceKm: Math.round(distance * 10) / 10,
    withinRadius: distance <= GEOFENCE_KM,
    commuteMinutes: commuteMinutesFor(distance),
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
  const vip = detectVip($("#address").value);
  if (state.withinRadius) {
    box.innerHTML = `<div class="kp-note ok">
      <strong>✓ Adres w zasięgu</strong> — ${state.distanceKm} km od Gaja, dojazd ~${state.commuteMinutes} min w jedną stronę.
      <div style="font-size:12px; opacity:.85; margin-top:2px;">${escapeHtml(state.displayName)}</div>
      ${vip.isVip ? `<div style="margin-top:6px; font-size:12px; color:#8a5a00;"><strong>Klient VIP (${vip.label})</strong> — przewidujemy dłuższy czas pracy na obiekcie.</div>` : ""}
    </div>`;
  } else {
    box.innerHTML = `<div class="kp-note warn">
      <strong>✕ Adres poza obszarem działania</strong> — ${state.distanceKm} km od Gaja (limit ${GEOFENCE_KM} km).
      <div style="font-size:12px; opacity:.85; margin-top:2px;">${escapeHtml(state.displayName)}</div>
    </div>`;
  }
}

$("#address").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  lastGeocode = null;
  clearTimeout(geocodeTimer);
  if (v.length < 5) { renderGeocode(null); refreshSlots(); return; }
  geocodeTimer = setTimeout(async () => {
    try {
      const result = await geocode(v);
      if (!result) {
        renderGeocode({ error: "Nie znaleziono tego adresu w Polsce." });
        refreshSlots();
        return;
      }
      lastGeocode = result;
      renderGeocode(result);
      refreshSlots();
    } catch (err) {
      renderGeocode({ error: "Nie udało się sprawdzić adresu. Spróbuj ponownie." });
      refreshSlots();
    }
  }, 600);
});

/* ---------- slots ---------- */
// Demo busy intervals: relative to "today + N days" so the page feels alive.
function demoBusyForDay(day) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayDelta = Math.round((day - today) / (1000 * 60 * 60 * 24));
  const seeds = {
    1: [[10, 0, 90, "Serwis — Wadowicka"], [13, 0, 120, "Montaż — Salwator"]],
    2: [[9, 0, 60, "Serwis — Bronowice"]],
    3: [[15, 0, 90, "Przegląd okresowy"]],
    4: [[8, 0, 90, "Serwis — Nowa Huta"], [14, 30, 90, "Montaż — Tyniec"]],
  };
  return (seeds[dayDelta] || []).map(([h, m, mins]) => {
    const start = new Date(day); start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + mins * 60 * 1000);
    return [start, end];
  });
}

function listSlots(dateStr, opts) {
  const { workMinutes, commuteMinutes } = opts;
  const day = new Date(dateStr + "T00:00:00");
  if (day.getDay() === 0 || day.getDay() === 6) return [];
  const workOpen = new Date(day); workOpen.setHours(WORK_START, 0, 0, 0);
  const workClose = new Date(day); workClose.setHours(WORK_END, 0, 0, 0);
  const busy = demoBusyForDay(day);
  const now = new Date();
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const blockMs = (commuteMinutes + workMinutes + commuteMinutes) * 60 * 1000;
  const latestDepart = new Date(workClose.getTime() - blockMs);

  const slots = [];
  let cursor = new Date(workOpen);
  while (cursor.getTime() <= latestDepart.getTime()) {
    const departStart = new Date(cursor);
    const departEnd = new Date(cursor.getTime() + blockMs);
    const maintenanceStart = new Date(departStart.getTime() + commuteMinutes * 60 * 1000);
    const maintenanceEnd = new Date(maintenanceStart.getTime() + workMinutes * 60 * 1000);
    if (departStart > now && !busy.some(([bs, be]) => bs < departEnd && be > departStart)) {
      slots.push({ start: maintenanceStart, end: maintenanceEnd, departStart, departEnd });
    }
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return slots;
}

function refreshSlots() {
  const dateStr = $("#date").value;
  const sizeKey = ($$("input[name=job_size]:checked")[0] || {}).value;
  const box = $("#slots");
  $("#slot_start_iso").value = "";

  if (!sizeKey) {
    box.innerHTML = `<div class="kp-note warn">Wybierz rozmiar pracy, żeby dopasować długość wizyty.</div>`;
    return;
  }
  const size = JOB_SIZE[sizeKey];
  if (!size) {
    box.innerHTML = `<div class="kp-note err">Nieprawidłowy rozmiar pracy.</div>`;
    return;
  }

  // Detect VIP from current address text — works even if Nominatim missed the place.
  const vip = detectVip($("#address").value);
  const workMinutes = vip.isVip ? Math.round(size.minutes * VIP_MULTIPLIER) : size.minutes;
  const commuteMinutes = (lastGeocode && lastGeocode.withinRadius)
    ? lastGeocode.commuteMinutes
    : DEFAULT_COMMUTE_MIN;

  let slots;
  try { slots = listSlots(dateStr, { workMinutes, commuteMinutes }); }
  catch (e) { box.innerHTML = `<div class="kp-note err">Nieprawidłowa data.</div>`; return; }

  if (!slots.length) {
    box.innerHTML = `<div class="kp-note warn">Brak dostępnych terminów w tym dniu (weekend, zajęte sloty lub blok nie mieści się w godzinach pracy). Wybierz inną datę albo mniejszy rozmiar pracy.</div>`;
    return;
  }

  const distanceTag = (lastGeocode && lastGeocode.withinRadius)
    ? ` (${lastGeocode.distanceKm} km)`
    : ` (szac.)`;
  const vipTag = vip.isVip
    ? `<span class="vip-tag">VIP ${vip.label} ×${VIP_MULTIPLIER.toFixed(1)}</span>`
    : "";
  const meta = `<div class="slot-meta">
    <span><strong>${size.label}</strong> · ${workMinutes} min na miejscu</span>
    <span>· dojazd 2× ${commuteMinutes} min${distanceTag}</span>
    ${vipTag}
  </div>`;

  const html = slots.map(s => `
    <button type="button" class="slot-btn"
            data-slot-iso="${s.start.toISOString()}"
            data-depart-iso="${s.departStart.toISOString()}"
            data-return-iso="${s.departEnd.toISOString()}">
      <span class="slot-main">${fmtTime(s.start)}–${fmtTime(s.end)}</span>
      <span class="slot-sub">wyjazd z Gaja ${fmtTime(s.departStart)} · powrót ok. ${fmtTime(s.departEnd)}</span>
    </button>`).join("");

  box.innerHTML = meta + `<div class="slots">${html}</div>` +
    `<div class="helper" style="margin-top:8px;">Godzina główna = start pracy u klienta. Pod nią widać czas wyjazdu z Gaja i orientacyjnego powrotu.</div>`;
}

/* default date = tomorrow */
(function initDate() {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const today = new Date();
  $("#date").min = isoDate(today);
  $("#date").value = isoDate(tomorrow);
  refreshSlots();
})();

$("#date").addEventListener("change", refreshSlots);
$$("input[name=job_size]").forEach(el => el.addEventListener("change", refreshSlots));

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
  const maintenanceStart = new Date(data.slot_start_iso);
  const maintenanceEnd = new Date(maintenanceStart.getTime() + data.workMinutes * 60 * 1000);
  const departStart = new Date(maintenanceStart.getTime() - data.commuteMinutes * 60 * 1000);
  const departEnd = new Date(maintenanceEnd.getTime() + data.commuteMinutes * 60 * 1000);
  const typeLabel = data.request_type === "montaz" ? "Montaż" : "Serwis";
  const sizeLabel = JOB_SIZE[data.job_size].label;
  const eventId = `demo-${Math.floor(departStart.getTime() / 1000)}`;
  const vipBadge = data.isVip ? ` · <span style="color:#8a5a00;">VIP ${escapeHtml(data.vipLabel)}</span>` : "";

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
      <div><dt>Praca u klienta</dt><dd>${fmtPlDateTime(maintenanceStart)} – ${fmtTime(maintenanceEnd)}</dd></div>
      <div><dt>Wyjazd z Gaja</dt><dd>${fmtTime(departStart)} · powrót ok. ${fmtTime(departEnd)}</dd></div>
      <div><dt>Typ zlecenia</dt><dd>${typeLabel}${vipBadge}</dd></div>
      <div><dt>Rozmiar pracy</dt><dd>${sizeLabel} · ${data.workMinutes} min na miejscu</dd></div>
      <div><dt>Klient</dt><dd>${escapeHtml(data.customer_name)}</dd></div>
      <div><dt>Telefon</dt><dd>${escapeHtml(data.phone)}</dd></div>
      <div><dt>Dojazd z Gaja</dt><dd>${data.distanceKm} km · ~${data.commuteMinutes} min w jedną stronę</dd></div>
      <div><dt>ID wydarzenia (mock)</dt><dd class="mono">${eventId}</dd></div>
      <div class="span2"><dt>Adres</dt><dd>${escapeHtml(data.addressDisplay)}</dd></div>
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
    job_size: fd.get("job_size"),
    description: (fd.get("description") || "").toString().trim(),
    slot_start_iso: (fd.get("slot_start_iso") || "").toString(),
  };

  if (data.customer_name.length < 3) return showError("Podaj imię i nazwisko (min. 3 znaki).");
  if (!/^(\+?48)?[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}$/.test(data.phone)) return showError("Nieprawidłowy format telefonu.");
  if (data.address.length < 5) return showError("Podaj pełny adres (min. 5 znaków).");
  if (!data.request_type) return showError("Wybierz typ zlecenia: Montaż lub Serwis.");
  if (!data.job_size || !JOB_SIZE[data.job_size]) return showError("Wybierz rozmiar pracy: mała / średnia / duża.");
  if (data.description.length < 10) return showError("Opis musi mieć co najmniej 10 znaków.");
  if (!data.slot_start_iso) return showError("Wybierz termin (godzinę).");

  let geo = lastGeocode;
  if (!geo) {
    try { geo = await geocode(data.address); }
    catch (e) { return showError("Nie udało się sprawdzić adresu. Spróbuj ponownie."); }
  }
  if (!geo) return showError("Nie znaleziono adresu. Doprecyzuj wpis.");
  if (!geo.withinRadius) return showError(`Adres jest poza zasięgiem: ${geo.distanceKm} km od Gaja (limit ${GEOFENCE_KM} km).`);

  const vip = detectVip(data.address);
  const baseMinutes = JOB_SIZE[data.job_size].minutes;

  data.addressDisplay = geo.displayName;
  data.distanceKm = geo.distanceKm;
  data.commuteMinutes = geo.commuteMinutes;
  data.isVip = vip.isVip;
  data.vipLabel = vip.label;
  data.workMinutes = vip.isVip ? Math.round(baseMinutes * VIP_MULTIPLIER) : baseMinutes;
  showConfirmation(data);
});
