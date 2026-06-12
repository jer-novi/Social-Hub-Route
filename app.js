const socialHub = {
  name: 'The Social Hub Den Haag',
  lat: 52.0799,
  lng: 4.3246,
};

const streets = [
  { name: 'Hoefkade', lat: 52.0788, lng: 4.3254, low: 2, high: 260 },
  { name: 'Stationsweg', lat: 52.077, lng: 4.3222, low: 1, high: 183 },
  { name: 'Wagenstraat', lat: 52.0734, lng: 4.3138, low: 3, high: 198 },
  { name: 'Spui', lat: 52.0786, lng: 4.3128, low: 10, high: 240 },
  { name: 'Prinsegracht', lat: 52.0746, lng: 4.3074, low: 5, high: 320 },
  { name: 'Paviljoensgracht', lat: 52.0756, lng: 4.3058, low: 1, high: 210 },
  { name: 'Vaillantlaan', lat: 52.0679, lng: 4.3077, low: 1, high: 520 },
  { name: 'Rijswijkseweg', lat: 52.0726, lng: 4.3303, low: 2, high: 760 },
];

const state = {
  completed: new Set(),
  radiusKm: 1.5,
  direction: 'asc',
};

const radiusInput = document.getElementById('radiusInput');
const directionSelect = document.getElementById('directionSelect');
const streetList = document.getElementById('streetList');
const summary = document.getElementById('summary');
const map = document.getElementById('map');

const bounds = streets.reduce(
  (acc, street) => ({
    minLat: Math.min(acc.minLat, street.lat, socialHub.lat),
    maxLat: Math.max(acc.maxLat, street.lat, socialHub.lat),
    minLng: Math.min(acc.minLng, street.lng, socialHub.lng),
    maxLng: Math.max(acc.maxLng, street.lng, socialHub.lng),
  }),
  {
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
    minLng: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
  }
);

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(a, b) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const haversine =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return earthRadiusKm * (2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)));
}

function formatDirection(low, high) {
  return state.direction === 'asc' ? `${low} ➜ ${high}` : `${high} ➜ ${low}`;
}

function inRadius(street) {
  return distanceKm(socialHub, street) <= state.radiusKm;
}

function setDone(streetName, isDone) {
  if (isDone) {
    state.completed.add(streetName);
  } else {
    state.completed.delete(streetName);
  }
}

function mapPosition(street) {
  const latRange = bounds.maxLat - bounds.minLat || 1;
  const lngRange = bounds.maxLng - bounds.minLng || 1;

  const x = ((street.lng - bounds.minLng) / lngRange) * 100;
  const y = ((bounds.maxLat - street.lat) / latRange) * 100;

  return { x, y };
}

function renderMap(visibleStreets) {
  map.innerHTML = '';

  const hub = document.createElement('button');
  hub.className = 'map-point hub';
  hub.type = 'button';
  const hubPos = mapPosition(socialHub);
  hub.style.left = `${hubPos.x}%`;
  hub.style.top = `${hubPos.y}%`;
  hub.title = socialHub.name;
  hub.textContent = 'H';
  map.appendChild(hub);

  const radiusLabel = document.createElement('div');
  radiusLabel.className = 'map-legend';
  radiusLabel.textContent = `Radius: ${state.radiusKm.toFixed(1)} km rond The Social Hub`;
  map.appendChild(radiusLabel);

  visibleStreets.forEach((street) => {
    const done = state.completed.has(street.name);
    const point = document.createElement('button');
    point.className = `map-point street ${done ? 'done' : ''}`;
    point.type = 'button';
    point.title = `${street.name} (${street.low} t/m ${street.high})`;

    const position = mapPosition(street);
    point.style.left = `${position.x}%`;
    point.style.top = `${position.y}%`;

    point.addEventListener('click', () => {
      setDone(street.name, !state.completed.has(street.name));
      render();
    });

    map.appendChild(point);
  });
}

function render() {
  const visibleStreets = streets
    .filter(inRadius)
    .map((street) => ({
      ...street,
      distance: distanceKm(socialHub, street),
    }))
    .sort((a, b) => a.distance - b.distance);

  summary.textContent = `${visibleStreets.length} straten binnen ${state.radiusKm.toFixed(
    1
  )} km van The Social Hub.`;

  streetList.innerHTML = '';

  visibleStreets.forEach((street) => {
    const done = state.completed.has(street.name);

    const li = document.createElement('li');
    if (done) {
      li.classList.add('street-done');
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = done;
    checkbox.id = `street-${street.name}`;
    checkbox.addEventListener('change', () => {
      setDone(street.name, checkbox.checked);
      render();
    });

    const label = document.createElement('label');
    label.setAttribute('for', checkbox.id);
    label.textContent = `${street.name} (${Math.round(street.distance * 1000)}m)`;

    const rangeMeta = document.createElement('span');
    rangeMeta.className = 'meta';
    rangeMeta.textContent = `Nummerbereik: ${street.low} t/m ${street.high}`;

    const directionMeta = document.createElement('span');
    directionMeta.className = 'meta';
    directionMeta.textContent = `Looprichting: ${formatDirection(
      street.low,
      street.high
    )}`;

    li.appendChild(checkbox);
    li.appendChild(label);
    li.appendChild(rangeMeta);
    li.appendChild(directionMeta);
    streetList.appendChild(li);
  });

  renderMap(visibleStreets);
}

radiusInput.addEventListener('input', () => {
  const value = Number.parseFloat(radiusInput.value);
  if (!Number.isNaN(value) && value > 0) {
    state.radiusKm = value;
    render();
  }
});

directionSelect.addEventListener('change', () => {
  state.direction = directionSelect.value;
  render();
});

render();
