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
  if (ss && ss.excluded) return COLORS.excluded;
  if (!ss) return COLORS.todo;
  return COLORS[ss.status] || COLORS.todo;
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
  return ss.status === 'all' || ss.status === 'none';
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
        return !ss.excluded && !isDone(ss);
      case 'done':
        return !ss.excluded && isDone(ss);
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
  const partial = included.filter((s) => streetState(s.name).status === 'partial').length;
  const excluded = all.filter((s) => streetState(s.name).excluded).length;
  const pct = included.length ? Math.round((done / included.length) * 100) : 0;
  els.progressFill.style.width = pct + '%';
  els.progressText.textContent = `${done}/${included.length} afgehandeld · ${partial} deels · ${excluded} NIET doen`;

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
  if (ss.excluded) li.classList.add('excluded');
  else if (ss.status === 'all' || ss.status === 'none') li.classList.add('done');
  else if (ss.status === 'partial') li.classList.add('partial');

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
      if (ss.status === 'partial' && ss.ranges.length === 0) ss.ranges.push({ from: '', to: '' });
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
        saveState();
      });
      to.addEventListener('input', () => {
        r.to = to.value;
        r.toTouched = to.value !== ''; // leeg maken = weer automatisch spiegelen
        saveState();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'range-del';
      del.textContent = '✕';
      del.title = 'Bereik verwijderen';
      del.addEventListener('click', () => {
        ss.ranges.splice(idx, 1);
        if (ss.ranges.length === 0) ss.ranges.push({ from: '', to: '' });
        saveState();
        render();
      });
      row.append(from, sep, to, del);
      wrap.appendChild(row);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'range-add';
    add.textContent = '+ extra bereik';
    add.addEventListener('click', () => {
      ss.ranges.push({ from: '', to: '' });
      saveState();
      render();
    });
    wrap.appendChild(add);
    const hint = document.createElement('div');
    hint.className = 'range-hint';
    hint.textContent = 'Tip: t/m neemt automatisch hetzelfde nummer over (1 nummer). Pas aan voor een reeks.';
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

function rangesText(ss) {
  return ss.ranges
    .filter((r) => r.from !== '' || r.to !== '')
    .map((r) => `${r.from || '?'} t/m ${r.to || '?'}`)
    .join('; ');
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
      ranges: rangesText(ss),
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
  const done = included.filter((r) => r.status === 'all' || r.status === 'none');
  const partial = included.filter((r) => r.status === 'partial');
  const todo = included.filter((r) => r.status === 'todo');
  const excluded = rows.filter((r) => r.status === 'excluded');

  const L = [];
  L.push('Social Hub bezorgshift — Den Haag');
  L.push(`Datum: ${date}`);
  L.push(`Start: ${HUB.name}`);
  L.push(
    `Voortgang: ${done.length}/${included.length} straten afgehandeld` +
      ` (${partial.length} deels, ${todo.length} nog te doen, ${excluded.length} NIET doen)`
  );
  L.push('');

  const block = (title, list, fmt) => {
    if (!list.length) return;
    L.push(title);
    list.forEach((r) => L.push('  ' + fmt(r)));
    L.push('');
  };

  block('✓ ALLES BEZORGD:', done.filter((r) => r.status === 'all'), (r) =>
    `${r.name}${r.numRange ? ` (${r.numRange})` : ''}`
  );
  block('◑ DEELS BEZORGD:', partial, (r) =>
    `${r.name} — bezorgd: ${r.ranges || '(geen bereik ingevuld)'}`
  );
  block('✗ NIKS BEZORGD HIER:', done.filter((r) => r.status === 'none'), (r) =>
    `${r.name}${r.note ? ` — ${r.note}` : ''}`
  );
  block('▢ NOG TE DOEN:', todo, (r) => `${r.name}${r.numRange ? ` (${r.numRange})` : ''}`);
  block('⛔ NIET DOEN (rood):', excluded, (r) => `${r.name}${r.note ? ` — ${r.note}` : ''}`);

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
  const head = ['volgorde', 'straat', 'status', 'bezorgde_bereiken', 'nummerbereik', 'notitie'];
  const lines = [head.join(',')];
  rows.forEach((r) => {
    lines.push(
      [
        r.order < 9000 ? r.order : '',
        esc(r.name),
        statusLabel[r.status] || r.status,
        esc(r.ranges),
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

function wireExport() {
  const modal = document.getElementById('exportModal');
  const textarea = document.getElementById('exportText');
  const open = () => {
    textarea.value = buildReport();
    modal.hidden = false;
  };
  const close = () => (modal.hidden = true);

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
  seedExclusions();
  initMap();
  wireControls();
  wireTabs();
  wireLocate();
  wireExport();
  refineHubLocation();
  loadStreets(false);
}

boot();
