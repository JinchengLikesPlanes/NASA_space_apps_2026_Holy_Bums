// 3D view of the Moon's south pole, coloured by sunlight / Earth visibility.
// Reads ../data/exposure_map.json (from pipeline/exposure_map.py) and
// ../data/summary.json (from pipeline/compute_visibility.py).
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const DATA = '../data/';
const HOURS_CAP = 720;            // "longest night" colours stop at 30 days

// Colour ramps, dark to light. Each is a list of hex stops spread evenly from 0 to 1.
const RAMP_SUN = ['#10163a', '#3b2a6e', '#8a3b7a', '#d2605a', '#f2a541', '#ffe9a8'];
const RAMP_EARTH = ['#10163a', '#1f4e79', '#2e8fa6', '#7ed1c2', '#e8f7e4'];

const LAYERS = {
  sun: {
    key: 'sun_pct', ramp: RAMP_SUN, best: 'max',
    scale: v => v / 100,
    ticks: ['0%', '25%', '50%', '75%', '100%'],
    text: v => `${v.toFixed(1)}% of the year in sunlight`,
    bestLabel: 'Most sunlight on the map',
  },
  earth: {
    key: 'earth_pct', ramp: RAMP_EARTH, best: 'max',
    scale: v => v / 100,
    ticks: ['0%', '25%', '50%', '75%', '100%'],
    text: v => `${v.toFixed(1)}% of the year with Earth in view`,
    bestLabel: 'Most Earth contact on the map',
  },
  dark: {
    key: 'longest_dark_h', ramp: RAMP_SUN, best: 'min',
    scale: v => 1 - Math.min(v / HOURS_CAP, 1),          // short nights are bright
    ticks: ['30+ days', '22', '15', '7', '0'],
    text: v => `longest night ${days(v)}`,
    bestLabel: 'Shortest longest-night on the map',
  },
};

const days = h => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h} hours`);
const $ = id => document.getElementById(id);

// ---------- geometry helpers ----------

// Unit vector for a lat/lon. North is +Y, longitude 0 faces +X, east is towards -Z.
function unit(latDeg, lonDeg) {
  const p = THREE.MathUtils.degToRad(latDeg), l = THREE.MathUtils.degToRad(lonDeg);
  return new THREE.Vector3(Math.cos(p) * Math.cos(l), Math.sin(p), -Math.cos(p) * Math.sin(l));
}

// Map grid position (km on the polar stereographic map) to lat/lon in degrees.
function gridLatLon(xKm, yKm, moonKm) {
  const r = Math.hypot(xKm, yKm);
  const lat = -90 + THREE.MathUtils.radToDeg(2 * Math.atan(r / (2 * moonKm)));
  const lon = (THREE.MathUtils.radToDeg(Math.atan2(xKm, yKm)) + 360) % 360;
  return [lat, lon];
}

// lat/lon to map grid position in km (the reverse of gridLatLon).
function latLonGrid(lat, lon, moonKm) {
  const r = 2 * moonKm * Math.tan(THREE.MathUtils.degToRad(90 + lat) / 2);
  const l = THREE.MathUtils.degToRad(lon);
  return [r * Math.sin(l), r * Math.cos(l)];
}

function rampColour(stops, t) {
  t = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(t), stops.length - 2);
  return new THREE.Color(stops[i]).lerp(new THREE.Color(stops[i + 1]), t - i);
}

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

// ---------- scene ----------

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 50);
// The camera orbits a point on the surface (the south pole to begin with), so you
// can tilt down towards the horizon and see the relief, not only look straight down.
const SOUTH_POLE = new THREE.Vector3(0, -1, 0);

// Two ways up. Normally south is "up" for the camera, so the ground is under you like a map.
// Flipped, the Moon's north is up, as on a globe: you look up at the pole from underneath
// and the terrain hangs down. Same camera position, picture turned half a turn.
let flipped = false;
try { flipped = localStorage.getItem('view-flipped') === '1'; } catch { /* storage unavailable */ }

// OrbitControls reads the camera's "up" once, when it is created, so flipping builds a new one.
let controls = null;
function makeControls() {
  const pivot = controls ? controls.target.clone() : SOUTH_POLE.clone();
  if (controls) controls.dispose();
  camera.up.set(0, flipped ? 1 : -1, 0);
  controls = new OrbitControls(camera, canvas);
  controls.target.copy(pivot);
  controls.enableDamping = true;
  controls.zoomToCursor = true;
  controls.minDistance = 0.04;
  controls.maxDistance = 4;
  // tilt runs from almost straight down on the pole to almost level with the ground;
  // the controls measure it from their own "up", so the numbers swap when flipped
  controls.minPolarAngle = THREE.MathUtils.degToRad(flipped ? 97 : 4);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(flipped ? 176 : 83);
  // Works like a map: drag moves the ground, right-drag (or Ctrl/Shift + drag) turns and tilts,
  // the wheel zooms towards the cursor. One finger moves, two fingers zoom and turn.
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  // Unflipped, a drag slides along the ground. Flipped, that would run backwards (the controls
  // would take north as "up"), so the drag follows the screen and keepPivotOnGround puts the
  // pivot back on the surface.
  controls.screenSpacePanning = flipped;
  controls.keyPanSpeed = 30;
  controls.listenToKeyEvents(canvas);      // arrow keys move the view when the map has focus
}
makeControls();

function flipView() {
  flipped = !flipped;
  try { localStorage.setItem('view-flipped', flipped ? '1' : '0'); } catch { /* storage unavailable */ }
  flight = null;
  makeControls();
  showFlip();
}
function showFlip() {
  $('view-flip').textContent = flipped ? 'Ground-down view' : 'Upside-down view';
  $('view-flip').setAttribute('aria-pressed', String(flipped));
}

// In the helpers below a view is described from the Moon's north (+Y), so 180 degrees is straight down on the pole.
const STRAIGHT_DOWN = THREE.MathUtils.degToRad(176), TILTED = THREE.MathUtils.degToRad(140);
const HOME = { turn: THREE.MathUtils.degToRad(-60), distance: 0.42 };

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sunLight = new THREE.DirectionalLight(0xfff2dd, 2.2);
sunLight.position.set(3, -0.4, 2);
scene.add(sunLight);

const moon = new THREE.Group();
scene.add(moon);

let map = null;          // exposure_map.json
let cap = null;          // coloured terrain mesh
let globe = null;
let layer = 'sun';
let relief = 5;
const tags = [];         // site labels: { el, lat, lon }

function buildGlobe(cutKm) {
  if (globe) { moon.remove(globe); globe.geometry.dispose(); }
  // leave a hole at the south pole where the coloured terrain sits
  const moonKm = map ? map.moon_radius_km : 1737.4;
  const hole = cutKm > 0 ? 2 * Math.atan(cutKm / (2 * moonKm)) : 0;
  const geo = new THREE.SphereGeometry(0.9985, 128, 96, 0, Math.PI * 2, 0, Math.PI - hole);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8f8c86, roughness: 1 });
  globe = new THREE.Mesh(geo, mat);
  moon.add(globe);
  // optional photo texture: drop an equirectangular Moon image at web/assets/moon.jpg
  new THREE.TextureLoader().load('./assets/moon.jpg', tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true;
  }, undefined, () => {});
}

function buildGraticule() {
  const pts = [];
  const ring = (fn, n = 180) => { for (let k = 0; k < n; k++) pts.push(fn(k / n), fn((k + 1) / n)); };
  for (let lat = -60; lat <= 60; lat += 30) ring(t => unit(lat, t * 360));
  for (let lon = 0; lon < 360; lon += 30) ring(t => unit(-88 + t * 176, lon), 90);
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xece7d8, transparent: true, opacity: 0.16 }));
  moon.add(lines);
}

// Radius (in Moon radii) of the terrain surface at grid cell index k.
function cellRadius(k) {
  const i = k % map.n, j = Math.floor(k / map.n);
  const x = map.x0_km + i * map.spacing_km, y = map.y0_km + j * map.spacing_km;
  const edge = 1 - smooth(0.9, 1, Math.hypot(x, y) / map.radius_km);   // ease to the globe at the rim
  return 1 + relief * edge * (map.height_m[k] / 1000) / map.moon_radius_km;
}

function buildCap() {
  const n = map.n, count = n * n;
  const pos = new Float32Array(count * 3);
  const index = [];
  const has = k => map.sun_pct[k] !== null;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    if (i < n - 1 && j < n - 1) {
      const a = k, b = k + 1, c = k + n, d = k + n + 1;
      if (has(a) && has(b) && has(c)) index.push(a, b, c);
      if (has(b) && has(d) && has(c)) index.push(b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setIndex(index);
  cap = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  moon.add(cap);
  shapeCap();
}

// Place the vertices (depends on relief), then colour them (depends on layer).
function shapeCap() {
  const n = map.n, pos = cap.geometry.attributes.position;
  for (let k = 0; k < n * n; k++) {
    const i = k % n, j = Math.floor(k / n);
    const [lat, lon] = gridLatLon(map.x0_km + i * map.spacing_km, map.y0_km + j * map.spacing_km, map.moon_radius_km);
    const v = unit(lat, lon).multiplyScalar(map.height_m[k] === null ? 1 : cellRadius(k));
    pos.setXYZ(k, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  cap.geometry.computeVertexNormals();
  cap.geometry.computeBoundingSphere();
  paintCap();
  placeTags();
  if (pinned !== null) hover = new THREE.Vector3().fromBufferAttribute(pos, pinned);
}

function paintCap() {
  const L = LAYERS[layer], values = map[L.key];
  const col = cap.geometry.attributes.color, nor = cap.geometry.attributes.normal, pos = cap.geometry.attributes.position;
  const light = new THREE.Vector3(0.8, -0.55, 0.3).normalize();      // fixed light, only to show relief
  const nrm = new THREE.Vector3(), p = new THREE.Vector3();
  for (let k = 0; k < values.length; k++) {
    if (values[k] === null) continue;
    nrm.fromBufferAttribute(nor, k); p.fromBufferAttribute(pos, k);
    if (nrm.dot(p) < 0) nrm.negate();                                 // make it point away from the Moon
    const shade = 0.7 + 0.3 * Math.max(0, nrm.dot(light)) / 0.85;
    const c = rampColour(L.ramp, L.scale(values[k])).multiplyScalar(Math.min(shade, 1.05));
    col.setXYZ(k, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

// ---------- side panel ----------

function showLegend() {
  const L = LAYERS[layer];
  $('ramp').style.background = `linear-gradient(90deg, ${L.ramp.join(', ')})`;
  $('ticks').replaceChildren(...L.ticks.map(t => Object.assign(document.createElement('span'), { textContent: t })));
  if (!map) return;
  const values = map[L.key];
  let bestK = -1;
  for (let k = 0; k < values.length; k++) {
    if (values[k] === null) continue;
    if (bestK < 0 || (L.best === 'max' ? values[k] > values[bestK] : values[k] < values[bestK])) bestK = k;
  }
  const [lat, lon] = cellLatLon(bestK);
  const p = document.createElement('p');
  p.textContent = `${L.bestLabel}: ${L.text(values[bestK])}, at ${place(lat, lon)}.`;
  const go = Object.assign(document.createElement('button'), { textContent: 'Show this spot' });
  go.addEventListener('click', () => { flyTo(lat, lon); pin(bestK); });
  $('best').replaceChildren(p, go);
}

const place = (lat, lon) => `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}, ${lon.toFixed(1)}° E`;

function cellLatLon(k) {
  const i = k % map.n, j = Math.floor(k / map.n);
  return gridLatLon(map.x0_km + i * map.spacing_km, map.y0_km + j * map.spacing_km, map.moon_radius_km);
}

// Nearest grid cell to a lat/lon, or -1 if it is off the map.
function cellAt(lat, lon) {
  if (!map) return -1;
  const [x, y] = latLonGrid(lat, lon, map.moon_radius_km);
  const i = Math.round((x - map.x0_km) / map.spacing_km), j = Math.round((y - map.y0_km) / map.spacing_km);
  if (i < 0 || j < 0 || i >= map.n || j >= map.n) return -1;
  const k = j * map.n + i;
  return map.sun_pct[k] === null ? -1 : k;
}

function showPoint(k) {
  const [lat, lon] = cellLatLon(k);
  const where = Object.assign(document.createElement('p'), { className: 'where', textContent: place(lat, lon) });
  const dl = document.createElement('dl');
  const row = (a, b) => dl.append(Object.assign(document.createElement('dt'), { textContent: a }),
    Object.assign(document.createElement('dd'), { textContent: b }));
  row('Sunlight', `${map.sun_pct[k].toFixed(1)}% of the year`);
  row('Earth in view', `${map.earth_pct[k].toFixed(1)}% of the year`);
  row('Longest night', days(map.longest_dark_h[k]));
  row('Height', `${map.height_m[k].toLocaleString('en')} m`);
  $('readout').replaceChildren(where, dl);
  $('point-title').textContent = pinned === null ? 'Point under the cursor' : 'Selected point';
  if (pinned === null) {
    $('readout').append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Click the map to keep a spot selected.' }));
    return;
  }
  // The link opens the dashboard for this point in a pop-up panel over the map. A candidate site
  // is already analysed; any other map point is estimated in the browser from the saved skylines.
  const analyse = (aLat, aLon, text, title) => {
    const a = Object.assign(document.createElement('a'), { href: `../?lat=${aLat}&lon=${aLon}`, textContent: text });
    a.addEventListener('click', ev => {             // ctrl/middle click still opens the full page in a new tab
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      ev.preventDefault();
      openAnalysis(aLat, aLon, title);
    });
    return a;
  };
  const release = Object.assign(document.createElement('button'), { textContent: 'Release' });
  release.addEventListener('click', () => { pinned = null; pinnedSite = null; hover = null; showPoint(k); });
  const actions = Object.assign(document.createElement('p'), { className: 'actions' });
  if (pinnedSite) {
    actions.append(analyse(pinnedSite.lat, pinnedSite.lon, `Analyse ${pinnedSite.name}`, pinnedSite.name));
  } else if (canAnalyse || map.horizons) {       // map.horizons: the dashboard can estimate it in the browser
    actions.append(analyse(lat.toFixed(4), lon.toFixed(4), 'Analyse this point', place(lat, lon)));
  } else {
    actions.append(Object.assign(document.createElement('span'), { className: 'hint',
      textContent: 'Analysing a new point needs a map made by the latest exposure_map.py, or the site started with pipeline/server.py.' }));
  }
  actions.append(release);
  $('readout').append(actions);
}

// Show the dashboard for one coordinate in a panel over the map. The dashboard page is loaded
// once and then asked for each new point, so later points appear without a page load.
function openAnalysis(lat, lon, title) {
  const dialog = $('analysis'), frame = $('analysis-frame');
  $('analysis-title').textContent = title;
  $('analysis-full').href = `../?lat=${lat}&lon=${lon}`;
  if (!dialog.open) dialog.showModal();
  const inside = frame.contentWindow;
  if (frame.dataset.loaded && inside && typeof inside.openPoint === 'function') {
    inside.openPoint(Number(lat), Number(lon));
    inside.scrollTo(0, 0);
  } else {
    frame.addEventListener('load', () => { frame.dataset.loaded = '1'; }, { once: true });
    frame.src = `../?lat=${lat}&lon=${lon}&embed=1`;
  }
}
$('analysis-close').addEventListener('click', () => $('analysis').close());
$('analysis').addEventListener('click', ev => { if (ev.target === $('analysis')) $('analysis').close(); });   // click outside the panel

// Keep one grid cell selected: the readout and ring stay on it until released.
// site is given when the cell was chosen through a candidate site's button.
function pin(k, site = null) {
  pinned = k;
  pinnedSite = site;
  hover = new THREE.Vector3().fromBufferAttribute(cap.geometry.attributes.position, k);
  showPoint(k);
}

// sites: rows of summary.json. zones: slope_summary.json rows or null. scores: scores.json or null.
function showSites(sites, zones, scores) {
  const list = $('sites');
  list.replaceChildren();
  const zone = Object.fromEntries((zones || []).map(z => [z.id, z]));
  const score = Object.fromEntries(((scores && scores.sites) || []).map(r => [r.id, r.score]));
  if (scores) {
    sites = [...sites].sort((a, b) => (score[b.id] ?? -1) - (score[a.id] ?? -1));
    const w = scores.weights;
    $('sites-note').textContent = `Ranked by score out of 100. Weights are a starting guess: power ${w.power}, radio link ${w.comms}, flat ground ${w.safety}.`;
    $('sites-note').hidden = false;
  }
  for (const s of sites) {
    const b = document.createElement('button');
    const line = text => Object.assign(document.createElement('span'), { className: 'nums', textContent: text });
    b.append(Object.assign(document.createElement('span'), { className: 'name',
      textContent: score[s.id] != null ? `${s.name}: ${score[s.id]}` : s.name }));
    b.append(line(`Sun ${s.sun_pct}%, Earth ${s.earth_pct}%, longest night ${days(s.longest_dark_h)}`));
    const ground = [];
    if (s.slope_deg != null) ground.push(`Slope at the site ${s.slope_deg}°`);
    if (zone[s.id]) ground.push(`${zone[s.id].zone_safe_pct}% of the ${zone[s.id].zone_radius_m / 1000} km landing zone under ${zone[s.id].slope_limit_deg}°`);
    if (ground.length) b.append(line(ground.join(', ')));
    b.addEventListener('click', () => { flyTo(s.lat, s.lon); const k = cellAt(Math.max(s.lat, -89.999), s.lon); if (k >= 0) pin(k, s); });
    const li = document.createElement('li');
    li.append(b);
    list.append(li);
    const el = Object.assign(document.createElement('div'), { className: 'tag', textContent: s.name.replace(/\s*\(.*\)/, '') });
    $('tags').append(el);
    tags.push({ el, lat: s.lat, lon: s.lon, pos: unit(s.lat, s.lon) });
  }
  placeTags();
}

function placeTags() {
  for (const t of tags) {
    const k = cellAt(Math.max(t.lat, -89.999), t.lon);
    t.pos = unit(t.lat, t.lon).multiplyScalar(k >= 0 ? cellRadius(k) : 1);
  }
}

function notice(html) { const n = $('notice'); n.innerHTML = html; n.hidden = false; }

// ---------- camera ----------

// Height of the ground (in Moon radii) under a direction from the Moon's centre.
function groundRadius(dir) {
  if (!map) return 1;
  const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(dir.y / dir.length(), -1, 1)));
  const lon = THREE.MathUtils.radToDeg(Math.atan2(-dir.z, dir.x));
  const k = cellAt(Math.max(lat, -89.999), (lon + 360) % 360);
  return k >= 0 ? cellRadius(k) : 1;
}

// The view always turns around a point on the ground (the "pivot"). After moving the view,
// put the pivot back on the surface and keep it over the mapped area, so you cannot drift
// off into space or under the terrain. The camera is shifted by the same amount.
let pivotRadius = 1;
function keepPivotOnGround() {
  const t = controls.target, dir = t.clone().normalize();
  const limit = map ? 1.25 * map.radius_km / map.moon_radius_km : 0.12;     // radians from the pole
  const away = dir.angleTo(SOUTH_POLE);
  if (away > limit) dir.copy(SOUTH_POLE.clone().lerp(dir, limit / away)).normalize();   // pull back to the edge
  pivotRadius += (groundRadius(dir) - pivotRadius) * 0.2;                   // ease over height steps
  const shift = dir.multiplyScalar(pivotRadius).sub(t);
  t.add(shift);
  camera.position.add(shift);
}

// Glide to a new view: where the pivot is and where the camera sits.
let flight = null;
function glide(target, cameraPos) {
  controls.enableDamping = false;           // one update without damping drops any leftover drag motion,
  controls.update();                        // so it cannot nudge the view after the glide ends
  controls.enableDamping = true;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    controls.target.copy(target); camera.position.copy(cameraPos); return;
  }
  flight = { fromTarget: controls.target.clone(), fromCamera: camera.position.clone(), to: { target, camera: cameraPos }, start: performance.now() };
}

// Offset of the camera from the pivot for a tilt (angle from north), a turn and a distance.
function viewOffset(tilt, turn, distance) {
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(distance, tilt, turn));
}
function currentView() {
  return new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
}

// Move the pivot to a spot and come in close, keeping the current viewing angle.
function flyTo(lat, lon) {
  const k = cellAt(Math.max(lat, -89.999), lon);
  const spot = unit(lat, lon).multiplyScalar(k >= 0 ? cellRadius(k) : 1);
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(Math.min(offset.length(), 0.12));
  glide(spot, spot.clone().add(offset));
}

function resetView() {
  const pole = SOUTH_POLE.clone().multiplyScalar(groundRadius(SOUTH_POLE));
  glide(pole, pole.clone().add(viewOffset(TILTED, HOME.turn, HOME.distance)));
}
function zoomBy(factor) {
  const v = currentView();
  v.radius = THREE.MathUtils.clamp(v.radius * factor, controls.minDistance, controls.maxDistance);
  glide(controls.target.clone(), controls.target.clone().add(new THREE.Vector3().setFromSpherical(v)));
}
function toggleTilt() {                     // switch between looking straight down and a tilted view
  const v = currentView();
  v.phi = v.phi > THREE.MathUtils.degToRad(165) ? TILTED : STRAIGHT_DOWN;
  glide(controls.target.clone(), controls.target.clone().add(new THREE.Vector3().setFromSpherical(v)));
}

function stepFlight(now) {
  if (!flight) return;
  const t = Math.min((now - flight.start) / 700, 1), e = t * t * (3 - 2 * t);
  controls.target.lerpVectors(flight.fromTarget, flight.to.target, e);
  camera.position.lerpVectors(flight.fromCamera, flight.to.camera, e);
  if (t === 1) flight = null;
}

// ---------- picking ----------

const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let canAnalyse = false;      // true when pipeline/server.py is serving the page
let pinnedSite = null;
let hover = null, pickQueued = false, pinned = null, pickToPin = false, downAt = null;

function pick() {
  pickQueued = false;
  const wantPin = pickToPin;
  pickToPin = false;
  if (!cap || (pinned !== null && !wantPin)) return;
  ray.setFromCamera(pointer, camera);
  const hit = ray.intersectObject(cap)[0];
  if (!hit) { if (pinned === null) hover = null; return; }
  // nearest of the triangle's three corners
  const corners = [hit.face.a, hit.face.b, hit.face.c];
  const p = new THREE.Vector3(), pos = cap.geometry.attributes.position;
  let k = corners[0], bestD = Infinity;
  for (const c of corners) { const d = p.fromBufferAttribute(pos, c).distanceToSquared(hit.point); if (d < bestD) { bestD = d; k = c; } }
  if (wantPin) { pin(k); return; }
  hover = new THREE.Vector3().fromBufferAttribute(pos, k);
  showPoint(k);
}

function onPointer(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  if (!pickQueued) { pickQueued = true; requestAnimationFrame(pick); }
}
canvas.addEventListener('pointermove', onPointer);
canvas.addEventListener('pointerdown', ev => { downAt = [ev.clientX, ev.clientY]; });
canvas.addEventListener('pointerup', ev => {
  // a click selects the spot; a drag (rotating the view) does not
  if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) < 5) { pickToPin = true; onPointer(ev); }
  downAt = null;
});

// ---------- frame loop ----------

const screen = new THREE.Vector3();
function toScreen(world, el) {
  // hide anything on the far side of the Moon
  const visible = world.dot(camera.position) > world.lengthSq() * 0.995;
  screen.copy(world).project(camera);
  if (!visible || screen.z > 1) { el.hidden = true; return; }
  el.hidden = false;
  el.style.left = `${(screen.x * 0.5 + 0.5) * canvas.clientWidth}px`;
  el.style.top = `${(-screen.y * 0.5 + 0.5) * canvas.clientHeight}px`;
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    // keep the view centre clear of the side panel on wide screens: render the
    // left part of a frame that is one panel-width wider than the window
    const panel = window.innerWidth > 720 ? 336 : 0;
    camera.aspect = (w + panel) / h;
    camera.setViewOffset(w + panel, h, 0, 0, w, h);
    camera.updateProjectionMatrix();
  }
}

function frame(now) {
  resize();
  stepFlight(now);
  controls.update();
  if (!flight) keepPivotOnGround();
  const down = currentView().phi > THREE.MathUtils.degToRad(165);
  if ($('view-tilt').dataset.down !== String(down)) {
    $('view-tilt').dataset.down = String(down);
    $('view-tilt').textContent = down ? 'Tilt the view' : 'Look straight down';
  }
  renderer.render(scene, camera);
  for (const t of tags) toScreen(t.pos, t.el);
  if (hover) toScreen(hover, $('cursor')); else $('cursor').hidden = true;
  requestAnimationFrame(frame);
}

// ---------- start ----------

async function getJson(name) {
  const res = await fetch(DATA + name);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

async function start() {
  // start below the pole, tilted 40 degrees off straight-down, far enough to see the whole map
  camera.position.copy(SOUTH_POLE).add(viewOffset(TILTED, HOME.turn, HOME.distance));
  $('view-reset').addEventListener('click', resetView);
  $('view-in').addEventListener('click', () => zoomBy(0.6));
  $('view-out').addEventListener('click', () => zoomBy(1 / 0.6));
  $('view-tilt').addEventListener('click', toggleTilt);
  $('view-flip').addEventListener('click', flipView);
  showFlip();
  canvas.addEventListener('keydown', ev => {      // with the map focused: + and - zoom, 0 or Home resets
    if (ev.key === '+' || ev.key === '=') zoomBy(0.6);
    else if (ev.key === '-' || ev.key === '_') zoomBy(1 / 0.6);
    else if (ev.key === '0' || ev.key === 'Home') resetView();
  });
  buildGraticule();

  try {
    map = await getJson('exposure_map.json');
  } catch {
    map = null;
    notice('No exposure map yet, so only the three sites are shown. To make it, run this in the <b>pipeline</b> folder, then reload: <code>python exposure_map.py path\\to\\LDEM_75S_120M.LBL</code>');
    $('layer-section').hidden = true;
    $('point-section').hidden = true;
  }

  // server.py answers /api/site with JSON even when no point is given; a plain file server does not
  fetch('../api/site').then(r => { canAnalyse = (r.headers.get('content-type') || '').includes('json'); }).catch(() => {});

  buildGlobe(map ? map.radius_km - 2 * map.spacing_km : 0);
  if (map) {
    buildCap();
    showLegend();
    $('source').textContent = `Terrain from NASA's LOLA elevation grid. Sun and Earth positions from JPL Horizons, hourly from ${map.period[0]} to ${map.period[1]} UTC. Map points are ${map.spacing_km} km apart.`;
  }

  try {
    const optional = name => getJson(name).catch(() => null);       // made by slope_map.py and score_sites.py
    const [sites, zones, scores] = await Promise.all([getJson('summary.json'), optional('slope_summary.json'), optional('scores.json')]);
    showSites(sites, zones, scores);
  } catch { /* sites are optional */ }

  for (const input of document.querySelectorAll('input[name=layer]')) {
    input.addEventListener('change', () => { layer = input.value; paintCap(); showLegend(); });
  }
  $('relief').addEventListener('input', ev => {
    relief = Number(ev.target.value);
    $('relief-value').textContent = `${relief}×`;
    if (cap) shapeCap();
  });

  requestAnimationFrame(frame);
}

start();
