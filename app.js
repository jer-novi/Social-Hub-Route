/* =========================================================================
 * Social Hub Routeplanner — Den Haag
 * Vanilla JS + Leaflet + OpenStreetMap/Overpass (open source, geen API-keys).
 *
 * - Haalt live alle straten binnen het bezorggebied op via de Overpass API.
 * - Toont ze op een echte kaart en in een afvinklijst.
 * - Berekent een logische looproute vanaf The Social Hub (nearest-neighbour).
 * - Status per straat: Alles bezorgd / Deels (met nummerbereiken) / Niks bezorgd.
 * - "NIET doen" (rode) straten apart, met de rode zones als referentielaag.
 * - Alles wordt lokaal opgeslagen (localStorage) — geen server nodig.
 * ========================================================================= */

'use strict';

const STORAGE_KEY = 'shr-state-v2';
const CACHE_KEY = 'shr-osm-cache-v2';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/* ----------------------------- State ----------------------------------- */

const defaultState = () => ({
  v: 2,
  defaultDirection: 'asc',
  filter: 'todo',
  search: '',
  hub: { lat: HUB.lat, lng: HUB.lng },
  // per-street user data, keyed by lowercase street name
  streets: {},
  controlsHidden: false,
  exportNotes: true,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed, streets: parsed.streets || {} };
  } catch (e) {
    console.warn('Kon opgeslagen status niet laden:', e);
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Kon status niet opslaan:', e);
  }
}

const state = loadState();

// Zorg dat een straat een record heeft in state.streets
function streetState(name) {
  const key = name.toLowerCase();
  if (!state.streets[key]) {
    state.streets[key] = {
      name,
      status: 'todo', // todo | all | partial | none
      ranges: [],
      excluded: false,
      note: '',
      dir: null, // null = volg globale richting
      manual: false,
    };
  }
  return state.streets[key];
}

// Onthoud de laatst bewerkte straat (voor de "spring naar laatste"-knop).
function markEdited(name) {
  state.lastEdited = name;
}

// Migratie: zet 'afgerond' voor straten die voorheen automatisch klaar waren.
function migrateDone() {
  if (state._doneMigrated) return;
  for (const key in state.streets) {
    const ss = state.streets[key];
    if (ss.done === undefined) ss.done = ss.status === 'all' || ss.status === 'none';
    if (ss.collapsed === undefined) ss.collapsed = ss.done;
  }
  state._doneMigrated = true;
  saveState();
}

// Markeer de standaard-uitgesloten straten (best guess uit de PDF) bij eerste run.
function seedExclusions() {
  if (state._seeded) return;
  EXCLUDED_DEFAULTS.forEach((d) => {
    const s = streetState(d.name);
    s.excluded = true;
    if (!s.note) s.note = d.note;
    s.maybe = d.status === 'maybe';
  });
  state._seeded = true;
  saveState();
}

/* ------------------------- OSM data (in memory) ------------------------- */

// name -> { name, segments: [[ [lat,lng], ... ]], centroid:{lat,lng}, low, high, distance, order }
let osmStreets = new Map();

/* ----------------------------- Geometry -------------------------------- */

function toRad(v) {
  return (v * Math.PI) / 180;
}
function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/* --------------------------- Overpass query ---------------------------- */

function polyString(polygon) {
  return polygon.map(([lat, lng]) => `${lat} ${lng}`).join(' ');
}

function buildQuery() {
  const p = polyString(AREA_POLYGON);
  const types = DELIVERABLE_HIGHWAYS.join('|');
  return `[out:json][timeout:120];
way["highway"~"^(${types})$"]["name"](poly:"${p}")->.roads;
(
  node["addr:housenumber"]["addr:street"](poly:"${p}");
  way["addr:housenumber"]["addr:street"](poly:"${p}");
);
out tags;
.roads out geom;`;
}

async function fetchOverpass() {
  const query = buildQuery();
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      console.warn('Overpass endpoint faalde:', url, e.message);
    }
  }
  throw lastErr || new Error('Geen Overpass-endpoint bereikbaar');
}

function processOverpass(json) {
  const roads = new Map(); // name -> segments
  const houseNumbers = new Map(); // street -> [numbers]

  for (const el of json.elements) {
    const tags = el.tags || {};
    if (el.type === 'way' && tags.highway && el.geometry) {
      const name = tags.name;
      if (!name) continue;
      const seg = el.geometry.map((g) => [g.lat, g.lon]);
      if (!roads.has(name)) roads.set(name, []);
      roads.get(name).push(seg);
    } else if (tags['addr:housenumber'] && tags['addr:street']) {
      const street = tags['addr:street'];
      const num = parseInt(String(tags['addr:housenumber']).replace(/[^0-9].*$/, ''), 10);
      if (!Number.isNaN(num)) {
        if (!houseNumbers.has(street)) houseNumbers.set(street, []);
        houseNumbers.get(street).push(num);
      }
    }
  }

  const map = new Map();
  for (const [name, segments] of roads) {
    let sumLat = 0,
      sumLng = 0,
      n = 0;
    segments.forEach((seg) =>
      seg.forEach(([la, ln]) => {
        sumLat += la;
        sumLng += ln;
        n++;
      })
    );
    const centroid = { lat: sumLat / n, lng: sumLng / n };
    const nums = houseNumbers.get(name) || [];
    const low = nums.length ? Math.min(...nums) : null;
    const high = nums.length ? Math.max(...nums) : null;
    map.set(name, {
      name,
      segments,
      centroid,
      low,
      high,
      distance: distanceKm(state.hub, centroid),
      order: 0,
    });
  }
  return map;
}

/* ----------------------- Cache (localStorage) -------------------------- */

function cacheStore(map) {
  try {
    const slim = [...map.values()].map((s) => ({
      name: s.name,
      segments: s.segments,
      centroid: s.centroid,
      low: s.low,
      high: s.high,
    }));
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), streets: slim }));
  } catch (e) {
    console.warn('OSM-cache opslaan mislukt (waarschijnlijk te groot):', e.message);
  }
}

function cacheLoad() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const map = new Map();
    data.streets.forEach((s) => {
      map.set(s.name, {
        ...s,
        distance: distanceKm(state.hub, s.centroid),
        order: 0,
      });
    });
    return { map, age: Date.now() - data.t };
  } catch (e) {
    return null;
  }
}

/* --------------------------- Route ordering ---------------------------- */

// Greedy nearest-neighbour vanaf de hub, over de niet-uitgesloten straten.
function computeRoute() {
  const included = [...osmStreets.values()].filter((s) => {
    const ss = state.streets[s.name.toLowerCase()];
    return !(ss && ss.excluded);
  });
  const remaining = new Set(included);
  let current = state.hub;
  let order = 1;
  while (remaining.size) {
    let best = null;
    let bestD = Infinity;
    for (const s of remaining) {
      const d = distanceKm(current, s.centroid);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    best.order = order++;
    current = best.centroid;
    remaining.delete(best);
  }
  // uitgesloten straten achteraan
  [...osmStreets.values()]
    .filter((s) => !included.includes(s))
    .forEach((s) => (s.order = 9999));
}

/* ------------------------------- Map ----------------------------------- */

let map, hubMarker;
const streetLayers = new Map(); // name -> L.Polyline
let selectedName = null;

const COLORS = {
  todo: '#2563eb',
  all: '#16a34a',
  none: '#16a34a',
  partial: '#f59e0b',
  excluded: '#dc2626',
};

function statusColor(name) {
  const ss = state.streets[name.toLowerCase()];
  if (!ss) return COLORS.todo;
  if (ss.excluded) return COLORS.excluded;
  if (ss.done) return COLORS.all; // afgerond = groen
  if (ss.status && ss.status !== 'todo') return COLORS.partial; // mee bezig = oranje
  return COLORS.todo;
}

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([state.hub.lat, state.hub.lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  // Bezorggebied
  L.polygon(AREA_POLYGON, {
    color: '#2563eb',
    weight: 2,
    fillColor: '#3b82f6',
    fillOpacity: 0.06,
    interactive: false,
  }).addTo(map);

  // Rode referentiezones (indicatief)
  RED_REFERENCE_ZONES.forEach((z) => {
    L.polygon(z.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '6 5',
      fillColor: '#dc2626',
      fillOpacity: 0.1,
      interactive: false,
    })
      .addTo(map)
      .bindTooltip('NIET doen (indicatief): ' + z.label, { sticky: true });
  });

  hubMarker = L.marker([state.hub.lat, state.hub.lng], {
    title: HUB.name,
  })
    .addTo(map)
    .bindPopup('<strong>' + HUB.name + '</strong><br>Startpunt van de shift');
}

function refineHubLocation() {
  // Best-effort: verfijn de hub-locatie via Nominatim (alleen eerste keer).
  if (state._hubRefined) return;
  fetch(
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
      encodeURIComponent('The Social Hub, Hoefkade 9, Den Haag')
  )
    .then((r) => (r.ok ? r.json() : []))
    .then((arr) => {
      if (arr && arr[0]) {
        state.hub = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
        state._hubRefined = true;
        hubMarker.setLatLng([state.hub.lat, state.hub.lng]);
        saveState();
      }
    })
    .catch(() => {});
}

function drawStreets() {
  streetLayers.forEach((l) => map.removeLayer(l));
  streetLayers.clear();

  for (const s of osmStreets.values()) {
    const color = statusColor(s.name);
    const group = L.featureGroup();
    s.segments.forEach((seg) => {
      L.polyline(seg, { color, weight: 5, opacity: 0.85 }).addTo(group);
    });
    group.on('click', () => selectStreet(s.name, true));
    group.addTo(map);
    // bind tooltip on each polyline via group
    group.eachLayer((layer) => layer.bindTooltip(s.name, { sticky: true }));
    streetLayers.set(s.name, group);
  }
  highlightSelected();
}

function restyleStreet(name) {
  const group = streetLayers.get(name);
  if (!group) return;
  const color = statusColor(name);
  group.eachLayer((layer) => layer.setStyle({ color }));
}

function highlightSelected() {
  streetLayers.forEach((group, name) => {
    const sel = name === selectedName;
    group.eachLayer((layer) =>
      layer.setStyle({ weight: sel ? 9 : 5, opacity: sel ? 1 : 0.85 })
    );
  });
}

function selectStreet(name, fromMap) {
  selectedName = name;
  highlightSelected();
  const s = osmStreets.get(name);
  if (s && fromMap) {
    // scroll list item into view
    const el = document.querySelector(`[data-street="${cssEscape(name)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    }
  }
  if (s && !fromMap) {
    const bounds = L.latLngBounds(s.segments.flat());
    map.fitBounds(bounds, { maxZoom: 17, padding: [40, 40] });
  }
}

function cssEscape(str) {
  return str.replace(/["\\]/g, '\\$&');
}

/* ------------------------------ Rendering ------------------------------- */

const els = {
  list: document.getElementById('streetList'),
  status: document.getElementById('status'),
  filter: document.getElementById('filterSelect'),
  direction: document.getElementById('directionSelect'),
  search: document.getElementById('searchInput'),
  addInput: document.getElementById('addInput'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
};

function effectiveDir(ss) {
  return ss.dir || state.defaultDirection;
}

function rangeText(s, ss) {
  if (s.low == null || s.high == null) return 'nummers onbekend';
  const dir = effectiveDir(ss);
  return dir === 'asc' ? `${s.low} ➜ ${s.high}` : `${s.high} ➜ ${s.low}`;
}

function isDone(ss) {
  return !!ss.done; // afgerond-vinkje bepaalt voltooiing
}
function isBusy(ss) {
  return !ss.excluded && !ss.done && ss.status && ss.status !== 'todo';
}

function visibleStreets() {
  const q = (state.search || '').trim().toLowerCase();
  let arr = [...osmStreets.values()];

  // manual streets without geometry
  for (const key in state.streets) {
    const ss = state.streets[key];
    if (ss.manual && !osmStreets.has(ss.name)) {
      arr.push({ name: ss.name, segments: [], centroid: null, low: null, high: null, distance: Infinity, order: 9998, manualOnly: true });
    }
  }

  arr = arr.filter((s) => {
    const ss = streetState(s.name);
    if (q && !s.name.toLowerCase().includes(q)) return false;
    switch (state.filter) {
      case 'todo':
        return !ss.excluded && !ss.done && (!ss.status || ss.status === 'todo');
      case 'busy':
        return isBusy(ss);
      case 'done':
        return !ss.excluded && ss.done;
      case 'excluded':
        return ss.excluded;
      default:
        return true; // all
    }
  });

  arr.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  return arr;
}

function render() {
  if (!osmStreets.size && !Object.keys(state.streets).length) return;

  // progress
  const all = [...osmStreets.values()];
  const included = all.filter((s) => !streetState(s.name).excluded);
  const done = included.filter((s) => isDone(streetState(s.name))).length;
  const busy = included.filter((s) => isBusy(streetState(s.name))).length;
  const excluded = all.filter((s) => streetState(s.name).excluded).length;
  const pct = included.length ? Math.round((done / included.length) * 100) : 0;
  els.progressFill.style.width = pct + '%';
  els.progressText.textContent = `${done}/${included.length} afgerond · ${busy} mee bezig · ${excluded} NIET doen`;

  // list
  els.list.innerHTML = '';
  const streets = visibleStreets();
  if (!streets.length) {
    els.list.innerHTML = '<li class="empty">Geen straten in deze weergave.</li>';
    return;
  }
  for (const s of streets) {
    els.list.appendChild(renderItem(s));
  }
}

function renderItem(s) {
  const ss = streetState(s.name);
  const li = document.createElement('li');
  li.className = 'street-item';
  li.dataset.street = s.name;
  const started = !ss.excluded && ss.status && ss.status !== 'todo';
  if (ss.excluded) li.classList.add('excluded');
  else if (ss.done) li.classList.add('done');
  else if (started) li.classList.add('partial');

  // Afgeronde straat: ingeklapt compact tonen (geen per ongeluk wijzigen).
  if (ss.done && ss.collapsed !== false && !ss.excluded) {
    li.classList.add('collapsed-done');
    const row = document.createElement('div');
    row.className = 'item-head';
    const badge = document.createElement('span');
    badge.className = 'order';
    badge.textContent = '✓';
    const tw = document.createElement('div');
    tw.className = 'title-wrap';
    const nm = document.createElement('button');
    nm.className = 'street-name';
    nm.type = 'button';
    nm.textContent = s.name;
    nm.addEventListener('click', () => selectStreet(s.name, false));
    const sub = document.createElement('span');
    sub.className = 'meta';
    sub.textContent = 'Afgerond' + (rangesSummary(ss) ? ` · ${rangesSummary(ss)}` : '');
    tw.append(nm, sub);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'open-btn';
    openBtn.textContent = '✎ open';
    openBtn.title = 'Uitklappen om te wijzigen';
    openBtn.addEventListener('click', () => {
      ss.collapsed = false;
      saveState();
      render();
    });
    row.append(badge, tw, openBtn);
    li.appendChild(row);
    return li;
  }

  // header row
  const head = document.createElement('div');
  head.className = 'item-head';

  const order = document.createElement('span');
  order.className = 'order';
  order.textContent = s.order && s.order < 9000 ? s.order : '–';

  const title = document.createElement('button');
  title.className = 'street-name';
  title.type = 'button';
  title.textContent = s.name;
  title.title = 'Toon op kaart';
  title.addEventListener('click', () => selectStreet(s.name, false));

  const meta = document.createElement('span');
  meta.className = 'meta';
  const dist = s.distance && s.distance !== Infinity ? ` · ${Math.round(s.distance * 1000)}m` : '';
  meta.textContent = `${rangeText(s, ss)}${dist}`;

  head.appendChild(order);
  const titleWrap = document.createElement('div');
  titleWrap.className = 'title-wrap';
  titleWrap.appendChild(title);
  titleWrap.appendChild(meta);
  head.appendChild(titleWrap);

  // exclude toggle
  const exclBtn = document.createElement('button');
  exclBtn.type = 'button';
  exclBtn.className = 'excl-btn' + (ss.excluded ? ' active' : '');
  exclBtn.textContent = ss.excluded ? '⛔ NIET doen' : 'Markeer NIET';
  exclBtn.title = 'Zet deze straat op de "NIET doen"-lijst';
  exclBtn.addEventListener('click', () => {
    ss.excluded = !ss.excluded;
    saveState();
    computeRoute();
    restyleStreet(s.name);
    render();
  });
  head.appendChild(exclBtn);

  li.appendChild(head);

  if (ss.excluded) {
    if (ss.note || ss.maybe) {
      const note = document.createElement('div');
      note.className = 'excl-note';
      note.textContent = (ss.maybe ? '❓ ' : '') + (ss.note || 'Op de "NIET doen"-lijst.');
      li.appendChild(note);
    }
    return li;
  }

  // status segmented control
  const ctrl = document.createElement('div');
  ctrl.className = 'status-ctrl';
  [
    ['all', '✓ Alles'],
    ['partial', '◑ Deels'],
    ['none', '✗ Niks'],
  ].forEach(([val, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg' + (ss.status === val ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      ss.status = ss.status === val ? 'todo' : val;
      if (ss.status === 'partial' && ss.ranges.length === 0) ss.ranges.push({ from: '', to: '', parity: 'all' });
      markEdited(s.name);
      saveState();
      restyleStreet(s.name);
      render();
    });
    ctrl.appendChild(b);
  });
  li.appendChild(ctrl);

  // partial ranges
  if (ss.status === 'partial') {
    const wrap = document.createElement('div');
    wrap.className = 'ranges';
    ss.ranges.forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = 'range-row';
      // Onthoud of het t/m-vakje handmatig is aangepast; zo niet, dan spiegelt
      // het automatisch het "van"-nummer (vaak bezorg je maar bij 1 nummer).
      if (r.toTouched === undefined) r.toTouched = r.to !== '' && r.to !== r.from;
      const from = document.createElement('input');
      from.type = 'number';
      from.placeholder = 'van';
      from.value = r.from;
      from.inputMode = 'numeric';
      const sep = document.createElement('span');
      sep.textContent = 't/m';
      const to = document.createElement('input');
      to.type = 'number';
      to.placeholder = 't/m';
      to.value = r.to;
      to.inputMode = 'numeric';
      from.addEventListener('input', () => {
        r.from = from.value;
        if (!r.toTouched) {
          r.to = from.value; // spiegel automatisch → reeks van 1 nummer
          to.value = from.value;
        }
        markEdited(s.name);
        saveState();
      });
      to.addEventListener('input', () => {
        r.to = to.value;
        r.toTouched = to.value !== ''; // leeg maken = weer automatisch spiegelen
        markEdited(s.name);
        saveState();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'range-del';
      del.textContent = '✕';
      del.title = 'Bereik verwijderen';
      del.addEventListener('click', () => {
        ss.ranges.splice(idx, 1);
        if (ss.ranges.length === 0) ss.ranges.push({ from: '', to: '', parity: 'all' });
        saveState();
        render();
      });
      row.append(from, sep, to, del);

      // even/oneven/alles keuze per bereik
      if (r.parity === undefined) r.parity = 'all';
      const parity = document.createElement('div');
      parity.className = 'parity';
      [
        ['all', 'Alles'],
        ['even', 'Even'],
        ['odd', 'Oneven'],
      ].forEach(([val, label]) => {
        const pb = document.createElement('button');
        pb.type = 'button';
        pb.className = 'par' + (r.parity === val ? ' active' : '');
        pb.textContent = label;
        pb.addEventListener('click', () => {
          r.parity = val;
          saveState();
          render();
        });
        parity.appendChild(pb);
      });

      const count = expandRange(r).length;
      const countEl = document.createElement('span');
      countEl.className = 'range-count';
      countEl.textContent = count ? `${count} nr${count > 1 ? "'s" : ''}` : '';

      const item = document.createElement('div');
      item.className = 'range-item';
      item.append(row, parity, countEl);
      wrap.appendChild(item);
    });
    if (!Array.isArray(ss.adds)) ss.adds = [];
    const addRow = document.createElement('div');
    addRow.className = 'range-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'range-add';
    add.textContent = '+ extra bereik';
    add.addEventListener('click', () => {
      ss.ranges.push({ from: '', to: '', parity: 'all' });
      saveState();
      render();
    });
    const addPlus = document.createElement('button');
    addPlus.type = 'button';
    addPlus.className = 'range-add add-plus';
    addPlus.textContent = '+ toevoeging (a/b)';
    addPlus.title = 'Letteradres toevoegen, bv. 145a t/m b';
    addPlus.addEventListener('click', () => {
      const last = ss.ranges[ss.ranges.length - 1] || {};
      ss.adds.push({ base: last.from || '', lf: '', lt: '' });
      saveState();
      render();
    });
    if (!Array.isArray(ss.bells)) ss.bells = [];
    const bellPlus = document.createElement('button');
    bellPlus.type = 'button';
    bellPlus.className = 'range-add bell-plus';
    bellPlus.textContent = '+ bel (2×)';
    bellPlus.title = 'Meerdere brievenbussen op 1 nummer, bv. 17 = 2 brieven';
    bellPlus.addEventListener('click', () => {
      const last = ss.ranges[ss.ranges.length - 1] || {};
      ss.bells.push({ nr: last.from || '', count: '2' });
      markEdited(s.name);
      saveState();
      render();
    });
    addRow.append(add, addPlus, bellPlus);
    wrap.appendChild(addRow);

    // meervoudige bellen (× aantal brieven op 1 nummer)
    if (ss.bells.length) {
      const bw = document.createElement('div');
      bw.className = 'adds';
      ss.bells.forEach((b, bi) => {
        const brow = document.createElement('div');
        brow.className = 'add-row bell-row';
        const nr = document.createElement('input');
        nr.type = 'number';
        nr.className = 'base';
        nr.placeholder = 'nr';
        nr.value = b.nr;
        nr.inputMode = 'numeric';
        const x = document.createElement('span');
        x.textContent = '×';
        const cnt = document.createElement('input');
        cnt.type = 'number';
        cnt.className = 'letter';
        cnt.min = '2';
        cnt.placeholder = '2';
        cnt.value = b.count;
        cnt.inputMode = 'numeric';
        const prev = document.createElement('span');
        prev.className = 'add-preview';
        const draw = () => {
          prev.textContent = b.nr ? `${b.nr} → ${parseInt(b.count, 10) || 2} brieven` : '';
        };
        nr.addEventListener('input', () => { b.nr = nr.value; markEdited(s.name); saveState(); draw(); });
        cnt.addEventListener('input', () => { b.count = cnt.value; markEdited(s.name); saveState(); draw(); });
        const bdel = document.createElement('button');
        bdel.type = 'button';
        bdel.className = 'range-del';
        bdel.textContent = '✕';
        bdel.title = 'Bel verwijderen';
        bdel.addEventListener('click', () => { ss.bells.splice(bi, 1); saveState(); render(); });
        draw();
        brow.append(nr, x, cnt, bdel, prev);
        bw.appendChild(brow);
      });
      wrap.appendChild(bw);
    }

    // letteradres-toevoegingen (bv. 145a t/m b), basisnummer stapbaar door het bereik
    if (ss.adds.length) {
      const stepVals = deliveredNumbers(ss);
      const addsWrap = document.createElement('div');
      addsWrap.className = 'adds';
      ss.adds.forEach((a, ai) => {
        const arow = document.createElement('div');
        arow.className = 'add-row';

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'step';
        down.textContent = '▼';
        down.title = 'Vorig nummer';
        const baseIn = document.createElement('input');
        baseIn.type = 'number';
        baseIn.className = 'base';
        baseIn.placeholder = 'nr';
        baseIn.value = a.base;
        baseIn.inputMode = 'numeric';
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'step';
        up.textContent = '▲';
        up.title = 'Volgend nummer';

        const lf = document.createElement('input');
        lf.type = 'text';
        lf.className = 'letter';
        lf.placeholder = 'a';
        lf.maxLength = 2;
        lf.value = a.lf || '';
        const dash = document.createElement('span');
        dash.textContent = 't/m';
        const lt = document.createElement('input');
        lt.type = 'text';
        lt.className = 'letter';
        lt.placeholder = 'b';
        lt.maxLength = 2;
        lt.value = a.lt || '';
        const prev = document.createElement('span');
        prev.className = 'add-preview';
        const drawPrev = () => (prev.textContent = expandAdd(a).join(', '));

        const stepTo = (dir) => {
          if (!stepVals.length) return;
          const cur = parseInt(a.base, 10);
          let next;
          if (Number.isNaN(cur)) next = stepVals[0];
          else if (dir > 0) next = stepVals.find((v) => v > cur);
          else next = [...stepVals].reverse().find((v) => v < cur);
          if (next !== undefined) {
            a.base = String(next);
            baseIn.value = a.base;
            saveState();
            drawPrev();
          }
        };
        up.addEventListener('click', () => stepTo(1));
        down.addEventListener('click', () => stepTo(-1));
        baseIn.addEventListener('input', () => {
          a.base = baseIn.value;
          markEdited(s.name);
          saveState();
          drawPrev();
        });
        lf.addEventListener('input', () => {
          a.lf = lf.value.toLowerCase();
          markEdited(s.name);
          saveState();
          drawPrev();
        });
        lt.addEventListener('input', () => {
          a.lt = lt.value.toLowerCase();
          markEdited(s.name);
          saveState();
          drawPrev();
        });

        const adel = document.createElement('button');
        adel.type = 'button';
        adel.className = 'range-del';
        adel.textContent = '✕';
        adel.title = 'Toevoeging verwijderen';
        adel.addEventListener('click', () => {
          ss.adds.splice(ai, 1);
          saveState();
          render();
        });

        drawPrev();
        arow.append(down, baseIn, up, lf, dash, lt, adel, prev);
        addsWrap.appendChild(arow);
      });
      wrap.appendChild(addsWrap);
    }

    const hint = document.createElement('div');
    hint.className = 'range-hint';
    hint.textContent =
      'Tip: t/m spiegelt automatisch. Even/Oneven telt alleen die kant. "+ toevoeging" = letteradres (bv. 145a t/m b); met ▲▼ stap je het nummer door het bereik.';
    wrap.appendChild(hint);
    li.appendChild(wrap);
  }

  // note + remove (manual)
  const foot = document.createElement('div');
  foot.className = 'item-foot';
  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'note-input';
  noteInput.placeholder = 'notitie…';
  noteInput.value = ss.note || '';
  noteInput.addEventListener('input', () => {
    ss.note = noteInput.value;
    markEdited(s.name);
    saveState();
  });
  foot.appendChild(noteInput);
  if (ss.manual) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove-btn';
    rm.textContent = 'Verwijder';
    rm.addEventListener('click', () => {
      delete state.streets[s.name.toLowerCase()];
      saveState();
      render();
    });
    foot.appendChild(rm);
  }
  li.appendChild(foot);

  // "Straat afgerond" — aan = groen + inklappen (extra check, standaard uit)
  const doneLabel = document.createElement('label');
  doneLabel.className = 'done-check';
  const doneChk = document.createElement('input');
  doneChk.type = 'checkbox';
  doneChk.checked = !!ss.done;
  doneChk.addEventListener('change', () => {
    ss.done = doneChk.checked;
    ss.collapsed = doneChk.checked; // afronden = inklappen
    markEdited(s.name);
    saveState();
    restyleStreet(s.name);
    render();
  });
  doneLabel.append(doneChk, document.createTextNode(' Straat afgerond'));
  li.appendChild(doneLabel);
  if (ss.done) {
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'open-btn';
    collapseBtn.textContent = '▲ inklappen';
    collapseBtn.addEventListener('click', () => {
      ss.collapsed = true;
      saveState();
      render();
    });
    doneLabel.appendChild(collapseBtn);
  }

  return li;
}

/* ------------------------------ Controls ------------------------------- */

function wireControls() {
  els.filter.value = state.filter;
  els.direction.value = state.defaultDirection;

  els.filter.addEventListener('change', () => {
    state.filter = els.filter.value;
    saveState();
    render();
  });
  els.direction.addEventListener('change', () => {
    state.defaultDirection = els.direction.value;
    saveState();
    render();
  });
  els.search.addEventListener('input', () => {
    state.search = els.search.value;
    render();
  });

  document.getElementById('addBtn').addEventListener('click', addManual);
  els.addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addManual();
  });

  const lastBtn = document.getElementById('lastEditBtn');
  if (lastBtn) lastBtn.addEventListener('click', scrollToLastEdited);

  document.getElementById('recomputeBtn').addEventListener('click', () => {
    computeRoute();
    drawStreets();
    render();
  });
  document.getElementById('refetchBtn').addEventListener('click', () => loadStreets(true));
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Alle voortgang en NIET-doen-markeringen wissen?')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });

  const banner = document.getElementById('estimateBanner');
  document.getElementById('bannerClose').addEventListener('click', () => (banner.style.display = 'none'));
}

// Spring naar de straat waar je het laatst aan het invullen was.
function scrollToLastEdited() {
  const name = state.lastEdited;
  if (!name) {
    toast('Nog geen straat bewerkt deze sessie.');
    return;
  }
  const ss = state.streets[name.toLowerCase()];
  if (ss && ss.done) ss.collapsed = false; // uitklappen zodat je verder kunt
  const focus = () => {
    const el = document.querySelector(`[data-street="${cssEscape(name)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
      return true;
    }
    return false;
  };
  saveState();
  render();
  if (!focus()) {
    // staat in deze filter niet zichtbaar → toon alles en probeer opnieuw
    state.filter = 'all';
    els.filter.value = 'all';
    saveState();
    render();
    focus();
  }
}

function addManual() {
  const name = els.addInput.value.trim();
  if (!name) return;
  const ss = streetState(name);
  ss.manual = true;
  ss.name = name;
  els.addInput.value = '';
  saveState();
  render();
  const el = document.querySelector(`[data-street="${cssEscape(name)}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ------------------------------ Tabs ----------------------------------- */

function wireTabs() {
  const layout = document.getElementById('layout');
  const tabs = document.querySelectorAll('#tabs .tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const showMap = tab.dataset.tab === 'map';
      layout.classList.toggle('show-map', showMap);
      if (showMap && map) {
        // Leaflet moet hertekenen nadat de container zichtbaar wordt
        setTimeout(() => map.invalidateSize(), 50);
      }
    });
  });
}

/* ---------------- Inklappen bovenbalk bij scrollen --------------------- */

// Expliciete verberg-knop: houdt het bovenblok weg tot je 'm weer aanzet.
function applyControlsHidden() {
  const side = document.querySelector('.side');
  side.classList.toggle('controls-hidden', !!state.controlsHidden);
  const btn = document.getElementById('optsToggle');
  btn.textContent = state.controlsHidden ? '▸ Opties tonen' : '▾ Opties verbergen';
  btn.classList.toggle('is-hidden', !!state.controlsHidden);
  btn.setAttribute('aria-expanded', String(!state.controlsHidden));
}

function wireOptsToggle() {
  document.getElementById('optsToggle').addEventListener('click', () => {
    state.controlsHidden = !state.controlsHidden;
    saveState();
    applyControlsHidden();
  });
  applyControlsHidden();
}

// Scrollen-omlaag bootst de verberg-knop na: het bovenblok gaat weg en
// blijft weg. Terugkomen kan ALLEEN via het knopje bovenin (nooit via scroll).
function wireCollapse() {
  const list = els.list;
  const mq = window.matchMedia('(max-width: 820px)');
  let last = 0;
  list.addEventListener(
    'scroll',
    () => {
      const cur = list.scrollTop;
      if (mq.matches && cur > last + 6 && cur > 20 && !state.controlsHidden) {
        state.controlsHidden = true; // zelfde effect als op 'verbergen' drukken
        saveState();
        applyControlsHidden();
      }
      last = cur;
    },
    { passive: true }
  );
}

/* ------------------------------ GPS ------------------------------------ */

let posMarker = null;
let accCircle = null;
let watchId = null;
let firstFix = true;

function stopLocate() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  firstFix = true;
  document.getElementById('locateBtn').classList.remove('active');
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const ll = [latitude, longitude];
  if (!posMarker) {
    posMarker = L.circleMarker(ll, {
      radius: 8,
      color: '#fff',
      weight: 3,
      fillColor: '#2563eb',
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip('Jouw locatie');
    accCircle = L.circle(ll, {
      radius: accuracy,
      color: '#2563eb',
      weight: 1,
      fillColor: '#2563eb',
      fillOpacity: 0.1,
    }).addTo(map);
  } else {
    posMarker.setLatLng(ll);
    accCircle.setLatLng(ll).setRadius(accuracy);
  }
  // laat de Google Maps-knop naar je exacte locatie wijzen als GPS wél werkt
  const g = document.getElementById('gmapsBtn');
  if (g) g.href = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  if (firstFix) {
    map.setView(ll, 17);
    firstFix = false;
  }
}

function startWatch() {
  watchId = navigator.geolocation.watchPosition(onPosition, onWatchError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 27000,
  });
}

// Fouten tijdens het live volgen (na de eerste fix): niet meteen stoppen.
function onWatchError(err) {
  if (err.code === 1) {
    stopLocate();
    showGpsHelp();
  } else {
    toast('GPS-signaal even kwijt…');
  }
}

function showGpsHelp() {
  showHelpModal(
    'Locatie staat uit of is geblokkeerd',
    `<p>Chrome krijgt geen toestemming voor je locatie. Loop deze 3 checks na (Android):</p>
     <ol>
       <li><b>Site-toestemming</b>: tik op het <b>🔒 / ⓘ</b> links in de adresbalk →
         <b>Machtigingen</b> → <b>Locatie</b> → <b>Toestaan</b>.
         (of ⋮ menu → <i>Instellingen → Site-instellingen → Locatie</i>)</li>
       <li><b>Telefoon-locatie aan</b>: veeg van bovenaf omlaag en zet <b>Locatie/GPS</b> aan.</li>
       <li><b>Chrome mag locatie</b>: Android <i>Instellingen → Apps → Chrome →
         Machtigingen → Locatie → Toestaan</i>.</li>
     </ol>
     <p>Tik daarna opnieuw op de <b>📍</b>-knop.</p>`
  );
}

async function toggleLocate() {
  const btn = document.getElementById('locateBtn');
  if (watchId !== null) {
    stopLocate();
    return;
  }
  if (!('geolocation' in navigator)) {
    toast('Deze browser ondersteunt geen GPS-locatie.');
    return;
  }

  // Vooraf checken: als de toestemming al geweigerd is, komt er geen popup.
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'denied') {
        showGpsHelp();
        return;
      }
    } catch (e) {
      /* permissions API niet beschikbaar — gewoon doorgaan */
    }
  }

  btn.classList.add('active');
  firstFix = true;
  // op mobiel: schakel naar de kaart-tab zodat je positie zichtbaar is
  const mapTab = document.querySelector('#tabs .tab[data-tab="map"]');
  if (mapTab && getComputedStyle(document.getElementById('tabs')).display !== 'none') {
    mapTab.click();
  }
  toast('Locatie bepalen…');

  // getCurrentPosition triggert de toestemmings-popup betrouwbaarder dan watchPosition.
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      onPosition(pos);
      startWatch();
    },
    (err) => {
      if (err.code === 1) {
        stopLocate();
        showGpsHelp();
      } else if (err.code === 2) {
        stopLocate();
        toast('Geen locatie beschikbaar. Staat de GPS van je telefoon aan?');
      } else {
        // timeout: probeer het nog eens met minder nauwkeurigheid en blijf volgen
        toast('Locatie duurt lang — ik probeer het grover…');
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            onPosition(pos);
            startWatch();
          },
          () => {
            stopLocate();
            toast('Kon je locatie niet bepalen. Probeer buiten of opnieuw.');
          },
          { enableHighAccuracy: false, maximumAge: 60000, timeout: 27000 }
        );
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 }
  );
}

function wireLocate() {
  document.getElementById('locateBtn').addEventListener('click', toggleLocate);
}

/* --------------------------- UI helpers -------------------------------- */

function showHelpModal(title, html) {
  let ov = document.getElementById('helpModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'helpModal';
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal"><div class="modal-head"><h2></h2>' +
      '<button class="modal-close" aria-label="Sluiten">✕</button></div>' +
      '<div class="modal-body"></div></div>';
    document.body.appendChild(ov);
    ov.querySelector('.modal-close').addEventListener('click', () => (ov.hidden = true));
    ov.addEventListener('click', (e) => {
      if (e.target === ov) ov.hidden = true;
    });
  }
  ov.querySelector('h2').textContent = title;
  ov.querySelector('.modal-body').innerHTML = html;
  ov.hidden = false;
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

/* ------------------------------ Export --------------------------------- */

// Bepaal de onder-/bovengrens van een bereik (volgorde-onafhankelijk).
function rangeBounds(r) {
  let a = parseInt(r.from, 10);
  let b = parseInt(r.to, 10);
  if (Number.isNaN(a) && Number.isNaN(b)) return null;
  if (Number.isNaN(b)) b = a;
  if (Number.isNaN(a)) a = b;
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

// Vouw een bereik uit naar de daadwerkelijk bezorgde nummers (even/oneven/alles).
function expandRange(r) {
  const bnds = rangeBounds(r);
  if (!bnds) return [];
  const [a, b] = bnds;
  const out = [];
  for (let n = a; n <= b; n++) {
    if (r.parity === 'even' && n % 2 !== 0) continue;
    if (r.parity === 'odd' && n % 2 === 0) continue;
    out.push(n);
  }
  return out;
}

function parityLabel(p) {
  return p === 'even' ? ' (even)' : p === 'odd' ? ' (oneven)' : '';
}

// Korte omschrijving van één bereik, bv. "52 t/m 64 (even)" of "9".
function rangeLabel(r) {
  const bnds = rangeBounds(r);
  if (!bnds) return '';
  const [a, b] = bnds;
  return a === b ? `${a}` : `${a} t/m ${b}${parityLabel(r.parity)}`;
}

function filledRanges(ss) {
  return ss.ranges.filter((r) => r.from !== '' || r.to !== '');
}

// Samenvatting met uitgevouwen nummers, voor de export.
function rangesSummary(ss) {
  const parts = filledRanges(ss).map((r) => {
    const nums = expandRange(r);
    const lbl = rangeLabel(r);
    // toon de exacte nummers wanneer even/oneven is gekozen (geen misverstand)
    if (r.parity && r.parity !== 'all' && nums.length > 1) {
      return `${lbl} → ${nums.join(', ')}`;
    }
    return lbl;
  });
  (ss.adds || []).forEach((a) => {
    const nums = expandAdd(a);
    if (!nums.length) return;
    parts.push(nums.length > 1 ? `${addLabel(a)} → ${nums.join(', ')}` : addLabel(a));
  });
  const bl = bellsLabel(ss);
  if (bl) parts.push(`bellen: ${bl}`);
  return parts.join('; ');
}

// Platte lijst van alle bezorgde huisnummers (gesorteerd, uniek).
function deliveredNumbers(ss) {
  const set = new Set();
  filledRanges(ss).forEach((r) => expandRange(r).forEach((n) => set.add(n)));
  return [...set].sort((x, y) => x - y);
}

/* --- letteradres-toevoegingen, bv. 145a t/m b → 145a, 145b --- */
function expandAdd(a) {
  const base = (a.base || '').trim();
  const lf = (a.lf || '').trim().toLowerCase();
  const lt = (a.lt || '').trim().toLowerCase();
  if (!base || !lf) return [];
  const c1 = lf.charCodeAt(0);
  let c2 = lt ? lt.charCodeAt(0) : c1;
  if (c2 < c1) c2 = c1;
  if (c1 < 97 || c1 > 122 || c2 > 122) return [base + lf]; // fallback
  const out = [];
  for (let c = c1; c <= c2; c++) out.push(base + String.fromCharCode(c));
  return out;
}

function addLabel(a) {
  const base = (a.base || '').trim();
  const lf = (a.lf || '').trim().toLowerCase();
  const lt = (a.lt || '').trim().toLowerCase();
  if (!base || !lf) return '';
  return lt && lt !== lf ? `${base}${lf}–${lt}` : `${base}${lf}`;
}

function deliveredExtras(ss) {
  const out = [];
  (ss.adds || []).forEach((a) => expandAdd(a).forEach((s) => out.push(s)));
  return out;
}

// Alle bezorgde adressen als tekst: hele nummers + letteradressen.
function deliveredAllText(ss) {
  return [...deliveredNumbers(ss).map(String), ...deliveredExtras(ss)].join(', ');
}

/* --- meervoudige bellen: bv. 17 met 2 brievenbussen → 2 brieven --- */
function filledBells(ss) {
  return (ss.bells || []).filter((b) => String(b.nr).trim() !== '');
}
function bellsLabel(ss) {
  return filledBells(ss)
    .map((b) => `${b.nr} (${parseInt(b.count, 10) || 2}×)`)
    .join(', ');
}
function bellExtraLetters(ss) {
  return filledBells(ss).reduce((t, b) => t + Math.max(0, (parseInt(b.count, 10) || 1) - 1), 0);
}
// Aantal brieven voor een straat: nummers + letteradressen + extra door bellen.
function letterCount(ss) {
  return deliveredNumbers(ss).length + deliveredExtras(ss).length + bellExtraLetters(ss);
}

function gatherForExport() {
  const rows = [];
  // OSM streets + manual-only streets
  const names = new Set([...osmStreets.keys()]);
  for (const key in state.streets) {
    if (state.streets[key].manual) names.add(state.streets[key].name);
  }
  for (const name of names) {
    const s = osmStreets.get(name);
    const ss = streetState(name);
    rows.push({
      order: s ? s.order : 9998,
      name,
      status: ss.excluded ? 'excluded' : ss.status,
      done: !!ss.done,
      ranges: rangesSummary(ss),
      numbers: deliveredAllText(ss),
      bells: bellsLabel(ss),
      letters: letterCount(ss),
      numRange: s && s.low != null ? `${s.low}-${s.high}` : '',
      note: ss.note || '',
      manual: !!ss.manual,
    });
  }
  rows.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  return rows;
}

function buildReport() {
  const rows = gatherForExport();
  const date = new Date().toLocaleString('nl-NL');
  const included = rows.filter((r) => r.status !== 'excluded');
  const afgerond = included.filter((r) => r.done);
  const busy = included.filter((r) => !r.done && r.status && r.status !== 'todo');
  const todo = included.filter((r) => !r.done && (!r.status || r.status === 'todo'));
  const excluded = rows.filter((r) => r.status === 'excluded');

  const L = [];
  L.push('Social Hub bezorgshift — Den Haag');
  L.push(`Datum: ${date}`);
  L.push(`Start: ${HUB.name}`);
  L.push(
    `Voortgang: ${afgerond.length}/${included.length} afgerond` +
      ` (${busy.length} mee bezig, ${todo.length} nog te doen, ${excluded.length} NIET doen)`
  );
  const totLetters = [...osmStreets.keys(), ...Object.keys(state.streets)]
    .filter((n, i, a) => a.indexOf(n) === i)
    .reduce((t, n) => {
      const ss = state.streets[n.toLowerCase()];
      return t + (ss && !ss.excluded ? letterCount(ss) : 0);
    }, 0);
  L.push(`Brieven bezorgd (geteld uit invoer): ${totLetters}`);
  L.push('');

  // notitie meenemen volgens het vinkje in de export
  const noteOf = (r) => (state.exportNotes && r.note ? `  📝 ${r.note}` : '');

  const block = (title, list, fmt) => {
    if (!list.length) return;
    L.push(title);
    list.forEach((r) => L.push('  ' + fmt(r) + noteOf(r)));
    L.push('');
  };

  block('✓ AFGEROND:', afgerond, (r) =>
    `${r.name}${r.ranges ? ` — ${r.ranges}` : r.numRange ? ` (${r.numRange})` : ''}`
  );
  block('◑ MEE BEZIG (niet afgerond):', busy, (r) =>
    `${r.name}${r.ranges ? ` — bezorgd: ${r.ranges}` : ''}`
  );
  block('▢ NOG TE DOEN:', todo, (r) => `${r.name}${r.numRange ? ` (${r.numRange})` : ''}`);
  block('⛔ NIET DOEN (rood):', excluded, (r) => `${r.name}`);

  return L.join('\n');
}

function buildCsv() {
  const rows = gatherForExport();
  const statusLabel = {
    all: 'alles bezorgd',
    partial: 'deels',
    none: 'niks bezorgd',
    todo: 'nog te doen',
    excluded: 'NIET doen',
  };
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const head = [
    'volgorde',
    'straat',
    'status',
    'afgerond',
    'bezorgde_bereiken',
    'bezorgde_nummers',
    'meervoudige_bellen',
    'aantal_brieven',
    'nummerbereik',
    'notitie',
  ];
  const lines = [head.join(',')];
  rows.forEach((r) => {
    lines.push(
      [
        r.order < 9000 ? r.order : '',
        esc(r.name),
        statusLabel[r.status] || r.status,
        r.done ? 'ja' : '',
        esc(r.ranges),
        esc(r.numbers),
        esc(r.bells),
        r.letters || '',
        esc(r.numRange),
        esc(r.note),
      ].join(',')
    );
  });
  return lines.join('\n');
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

/* ---- PDF: schematische kaart van de straten (kleur = status) + legenda ---- */

function htmlEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildSchematicSVG() {
  const streets = [...osmStreets.values()];
  if (!streets.length) return '<p>(geen kaartdata geladen)</p>';
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  const see = (la, ln) => {
    minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
    minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln);
  };
  AREA_POLYGON.forEach(([la, ln]) => see(la, ln));
  streets.forEach((s) => s.segments.forEach((seg) => seg.forEach(([la, ln]) => see(la, ln))));
  see(state.hub.lat, state.hub.lng);
  const midLat = (minLat + maxLat) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  const W = 900, pad = 16;
  const dx = (maxLng - minLng) * cos || 1;
  const dy = maxLat - minLat || 1;
  const H = Math.max(320, Math.min(1200, Math.round(W * (dy / dx))));
  const X = (ln) => (pad + ((ln - minLng) / (maxLng - minLng)) * (W - 2 * pad)).toFixed(1);
  const Y = (la) => (pad + ((maxLat - la) / (maxLat - minLat)) * (H - 2 * pad)).toFixed(1);
  const poly = (pts) => pts.map(([la, ln]) => `${X(ln)},${Y(la)}`).join(' ');
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:900px;border:1px solid #ccc;background:#fff">`];
  p.push(`<polygon points="${poly(AREA_POLYGON)}" fill="#3b82f6" fill-opacity="0.06" stroke="#2563eb" stroke-width="1.5"/>`);
  RED_REFERENCE_ZONES.forEach((z) =>
    p.push(`<polygon points="${poly(z.polygon)}" fill="#dc2626" fill-opacity="0.08" stroke="#dc2626" stroke-dasharray="5 4" stroke-width="1"/>`)
  );
  streets.forEach((s) => {
    const col = statusColor(s.name);
    s.segments.forEach((seg) =>
      p.push(`<polyline points="${poly(seg)}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round"/>`)
    );
  });
  p.push(`<circle cx="${X(state.hub.lng)}" cy="${Y(state.hub.lat)}" r="6" fill="#1d4ed8" stroke="#fff" stroke-width="2"/>`);
  p.push('</svg>');
  return p.join('');
}

function buildOverviewHTML() {
  const rows = gatherForExport();
  const included = rows.filter((r) => r.status !== 'excluded');
  const afgerond = included.filter((r) => r.done);
  const busy = included.filter((r) => !r.done && r.status && r.status !== 'todo');
  const todo = included.filter((r) => !r.done && (!r.status || r.status === 'todo'));
  const excl = rows.filter((r) => r.status === 'excluded');
  const note = (r) => (state.exportNotes && r.note ? ` <span class="nt">📝 ${htmlEsc(r.note)}</span>` : '');
  const grp = (title, list, fmt) =>
    list.length ? `<h3>${title}</h3><ul>${list.map((r) => `<li>${fmt(r)}${note(r)}</li>`).join('')}</ul>` : '';
  return (
    grp('✓ Afgerond', afgerond, (r) => `<b>${htmlEsc(r.name)}</b>${r.ranges ? ` — ${htmlEsc(r.ranges)}` : r.numRange ? ` (${r.numRange})` : ''}`) +
    grp('◑ Mee bezig (niet afgerond)', busy, (r) => `<b>${htmlEsc(r.name)}</b>${r.ranges ? ` — ${htmlEsc(r.ranges)}` : ''}`) +
    grp('⛔ NIET doen (rood)', excl, (r) => `<b>${htmlEsc(r.name)}</b>`) +
    `<p class="muted">Nog te doen: ${todo.length} straten.</p>`
  );
}

function exportPdf() {
  const w = window.open('', '_blank');
  if (!w) {
    toast('Pop-up geblokkeerd — sta pop-ups toe voor de PDF.');
    return;
  }
  const rows = gatherForExport();
  const included = rows.filter((r) => r.status !== 'excluded');
  const done = included.filter((r) => r.status === 'all' || r.status === 'none').length;
  const date = new Date().toLocaleString('nl-NL');
  const legend = `<div class="legend">
    <span><i style="background:#1d4ed8;border-radius:50%"></i> Social Hub</span>
    <span><i style="background:#2563eb"></i> Te doen</span>
    <span><i style="background:#16a34a"></i> Afgerond</span>
    <span><i style="background:#f59e0b"></i> Deels</span>
    <span><i style="background:#dc2626"></i> NIET doen</span>
  </div>`;
  w.document.write(`<!doctype html><html lang="nl"><head><meta charset="utf-8">
    <title>Social Hub shift ${htmlEsc(date)}</title>
    <style>
      body{font-family:system-ui,Arial,sans-serif;color:#1f2733;margin:18px;}
      h1{font-size:18px;margin:0 0 2px;} h3{margin:14px 0 4px;font-size:14px;}
      .sub{color:#5b6675;font-size:12px;margin-bottom:8px;}
      .legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin:8px 0;}
      .legend i{display:inline-block;width:12px;height:12px;vertical-align:middle;margin-right:4px;}
      ul{margin:2px 0 8px;padding-left:18px;font-size:12.5px;} li{margin:2px 0;}
      .nt{color:#7a5b00;} .muted{color:#5b6675;font-size:12px;}
      @media print{.noprint{display:none;}}
    </style></head><body>
    <h1>Social Hub bezorgshift — Den Haag</h1>
    <div class="sub">${htmlEsc(date)} · ${htmlEsc(HUB.name)} · <b>${done}/${included.length}</b> straten afgehandeld</div>
    ${legend}
    ${buildSchematicSVG()}
    ${buildOverviewHTML()}
    <button class="noprint" onclick="window.print()" style="margin-top:12px;padding:8px 14px;">🖨 Opslaan als PDF</button>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}

function wireExport() {
  const modal = document.getElementById('exportModal');
  const textarea = document.getElementById('exportText');
  const notesChk = document.getElementById('exportNotes');
  notesChk.checked = state.exportNotes !== false;
  const open = () => {
    textarea.value = buildReport();
    modal.hidden = false;
  };
  const close = () => (modal.hidden = true);

  notesChk.addEventListener('change', () => {
    state.exportNotes = notesChk.checked;
    saveState();
    textarea.value = buildReport();
  });
  document.getElementById('pdfBtn').addEventListener('click', exportPdf);

  document.getElementById('exportBtn').addEventListener('click', open);
  document.getElementById('exportClose').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  document.getElementById('copyBtn').addEventListener('click', async () => {
    const btn = document.getElementById('copyBtn');
    try {
      await navigator.clipboard.writeText(textarea.value);
      btn.textContent = '✓ Gekopieerd';
    } catch (e) {
      textarea.select();
      document.execCommand('copy');
      btn.textContent = '✓ Gekopieerd';
    }
    setTimeout(() => (btn.textContent = '📋 Kopieer'), 1500);
  });
  document.getElementById('downloadTxtBtn').addEventListener('click', () =>
    download(`social-hub-shift-${dateStamp()}.txt`, buildReport(), 'text/plain;charset=utf-8')
  );
  document.getElementById('downloadCsvBtn').addEventListener('click', () =>
    download(`social-hub-shift-${dateStamp()}.csv`, buildCsv(), 'text/csv;charset=utf-8')
  );
  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('backupBtn').addEventListener('click', () =>
    download(`social-hub-backup-${dateStamp()}.json`, JSON.stringify(state), 'application/json')
  );
  const importFile = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const f = importFile.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyImport(JSON.parse(reader.result));
      } catch (e) {
        toast('Kon bestand niet lezen (geen geldige JSON).');
      }
      importFile.value = '';
    };
    reader.readAsText(f);
  });
}

// Importeer een backup (vervangt alles) of een merge-bestand (voegt toe).
function applyImport(obj) {
  if (obj && obj.merge && obj.streets) {
    let n = 0;
    for (const key in obj.streets) {
      const src = obj.streets[key];
      const ss = streetState(src.name || key);
      ss.name = ss.name || src.name || key;
      if (Array.isArray(src.adds) && src.adds.length) ss.adds = (ss.adds || []).concat(src.adds);
      if (Array.isArray(src.bells) && src.bells.length) ss.bells = (ss.bells || []).concat(src.bells);
      if (src.note && !ss.note) ss.note = src.note;
      if (src.status && (!ss.status || ss.status === 'todo')) ss.status = src.status;
      if (Array.isArray(src.ranges) && (!ss.ranges || !ss.ranges.length)) ss.ranges = src.ranges;
      n++;
    }
    saveState();
    render();
    toast(`Toevoegingen samengevoegd voor ${n} straten.`);
    return;
  }
  if (obj && obj.streets) {
    if (!confirm('Hele opgeslagen voortgang vervangen door dit backup-bestand?')) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    location.reload();
    return;
  }
  toast('Onbekend bestandsformaat.');
}

/* ------------------------------- Boot ---------------------------------- */

async function loadStreets(force) {
  els.status.textContent = 'Straten laden vanaf OpenStreetMap…';
  els.status.className = 'status loading';

  if (!force) {
    const cached = cacheLoad();
    if (cached) {
      osmStreets = cached.map;
      computeRoute();
      drawStreets();
      render();
      const days = Math.floor(cached.age / 86400000);
      els.status.textContent = `${osmStreets.size} straten geladen (uit cache${days ? `, ${days}d oud` : ''}).`;
      els.status.className = 'status ok';
    }
  }

  try {
    const json = await fetchOverpass();
    osmStreets = processOverpass(json);
    cacheStore(osmStreets);
    computeRoute();
    drawStreets();
    render();
    els.status.textContent = `${osmStreets.size} straten geladen vanaf OpenStreetMap.`;
    els.status.className = 'status ok';
  } catch (e) {
    console.error(e);
    if (!osmStreets.size) {
      els.status.innerHTML =
        'Kon straten niet laden van Overpass. <button id="retryBtn" class="btn">Opnieuw</button>';
      els.status.className = 'status error';
      const rb = document.getElementById('retryBtn');
      if (rb) rb.addEventListener('click', () => loadStreets(true));
    } else {
      els.status.textContent += ' (live verversen mislukt — cache wordt getoond)';
    }
    render();
  }
}

function boot() {
  migrateDone();
  seedExclusions();
  initMap();
  wireControls();
  wireTabs();
  wireOptsToggle();
  wireCollapse();
  wireLocate();
  wireExport();
  refineHubLocation();
  loadStreets(false);
}

boot();
