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
const controls = new OrbitControls(camera, canvas);
// The camera orbits a point on the surface (the south pole to begin with), so you
// can tilt down towards the horizon and see the relief, not only look straight down.
const SOUTH_POLE = new THREE.Vector3(0, -1, 0);
controls.target.copy(SOUTH_POLE);
controls.enableDamping = true;
controls.zoomToCursor = true;
controls.minDistance = 0.04;
controls.maxDistance = 5;
controls.minPolarAngle = THREE.MathUtils.degToRad(97);    // angles are measured from north,
controls.maxPolarAngle = THREE.MathUtils.degToRad(176);   // so these keep the camera below the pole

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
  go.addEventListener('click', () => { flyTo(lat, lon); showPoint(bestK); });
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
}

function showSites(sites) {
  const list = $('sites');
  list.replaceChildren();
  for (const s of sites) {
    const b = document.createElement('button');
    b.append(Object.assign(document.createElement('span'), { className: 'name', textContent: s.name }),
      Object.assign(document.createElement('span'), {
        className: 'nums',
        textContent: `Sun ${s.sun_pct}%, Earth ${s.earth_pct}%, longest night ${days(s.longest_dark_h)}`,
      }));
    b.addEventListener('click', () => { flyTo(s.lat, s.lon); const k = cellAt(Math.max(s.lat, -89.999), s.lon); if (k >= 0) showPoint(k); });
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

// Move the orbit centre to a spot and come in close, keeping the current viewing angle.
let flight = null;
function flyTo(lat, lon) {
  const k = cellAt(Math.max(lat, -89.999), lon);
  const spot = unit(lat, lon).multiplyScalar(k >= 0 ? cellRadius(k) : 1);
  const offset = camera.position.clone().sub(controls.target);
  offset.setLength(Math.min(offset.length(), 0.12));
  const to = { target: spot, camera: spot.clone().add(offset) };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    controls.target.copy(to.target); camera.position.copy(to.camera); return;
  }
  flight = { fromTarget: controls.target.clone(), fromCamera: camera.position.clone(), to, start: performance.now() };
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
let hover = null, pickQueued = false;

function pick() {
  pickQueued = false;
  if (!cap) return;
  ray.setFromCamera(pointer, camera);
  const hit = ray.intersectObject(cap)[0];
  if (!hit) { hover = null; return; }
  // nearest of the triangle's three corners
  const corners = [hit.face.a, hit.face.b, hit.face.c];
  const p = new THREE.Vector3(), pos = cap.geometry.attributes.position;
  let k = corners[0], bestD = Infinity;
  for (const c of corners) { const d = p.fromBufferAttribute(pos, c).distanceToSquared(hit.point); if (d < bestD) { bestD = d; k = c; } }
  hover = new THREE.Vector3().fromBufferAttribute(pos, k);
  showPoint(k);
}

function onPointer(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  if (!pickQueued) { pickQueued = true; requestAnimationFrame(pick); }
}
canvas.addEventListener('pointermove', onPointer);
canvas.addEventListener('pointerdown', onPointer);

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
  const tilt = THREE.MathUtils.degToRad(140), turn = THREE.MathUtils.degToRad(-60);
  camera.position.copy(SOUTH_POLE).add(new THREE.Vector3(
    Math.sin(tilt) * Math.cos(turn), Math.cos(tilt), Math.sin(tilt) * Math.sin(turn)).multiplyScalar(0.42));
  buildGraticule();

  try {
    map = await getJson('exposure_map.json');
  } catch {
    map = null;
    notice('No exposure map yet, so only the three sites are shown. To make it, run this in the <b>pipeline</b> folder, then reload: <code>python exposure_map.py path\\to\\LDEM_75S_120M.LBL</code>');
    $('layer-section').hidden = true;
    $('point-section').hidden = true;
  }

  buildGlobe(map ? map.radius_km - 2 * map.spacing_km : 0);
  if (map) {
    buildCap();
    showLegend();
    $('source').textContent = `Terrain from NASA's LOLA elevation grid. Sun and Earth positions from JPL Horizons, hourly from ${map.period[0]} to ${map.period[1]} UTC. Map points are ${map.spacing_km} km apart.`;
  }

  try { showSites(await getJson('summary.json')); } catch { /* sites are optional */ }

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
