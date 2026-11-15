// 3D view of the Moon's south pole, coloured by sunlight / Earth visibility.
// Reads ../data/exposure_map.json (from pipeline/exposure_map.py), the detailed south polar map,
// ../data/global_map.json (from pipeline/global_map.py), the rest of the Moon as a smooth ball,
// and ../data/summary.json (from pipeline/compute_visibility.py), the candidate sites.
import * as THREE from 'three';

const BUILD = '2026-11-15h';       // shown at the bottom of the panel, to tell which copy of this file is running
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

// Where the six Apollo crews and three recent robotic landers set down, for comparison with the
// candidate sites. East longitude positive. Apollo, Chandrayaan-3 and IM-2 positions are from
// Lunar Reconnaissance Orbiter images; Chang'e 4 is from NASA's NSSDC list.
const APOLLO = [
  { name: 'Apollo 11', where: 'Sea of Tranquility', when: 'July 1969', lat: 0.674, lon: 23.473 },
  { name: 'Apollo 12', where: 'Ocean of Storms', when: 'November 1969', lat: -3.012, lon: -23.422 },
  { name: 'Apollo 14', where: 'Fra Mauro', when: 'February 1971', lat: -3.645, lon: -17.471, below: true },
  { name: 'Apollo 15', where: 'Hadley Rille', when: 'July 1971', lat: 26.132, lon: 3.634 },
  { name: 'Apollo 16', where: 'Descartes Highlands', when: 'April 1972', lat: -8.973, lon: 15.500, below: true },
  { name: 'Apollo 17', where: 'Taurus-Littrow valley', when: 'December 1972', lat: 20.191, lon: 30.772 },
  { name: "Chang'e 4", where: 'Von Kármán crater, far side', when: 'January 2019', lat: -45.4561, lon: 177.5885 },
  { name: 'Chandrayaan-3', where: 'Shiv Shakti point', when: 'August 2023', lat: -69.3741, lon: 32.32 },
  { name: 'IM-2 Athena', where: 'Mons Mouton', when: 'March 2025', lat: -84.7906, lon: 29.1957 },
];

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
const SOUTH_POLE = new THREE.Vector3(0, -1, 0);
const rad = THREE.MathUtils.degToRad;

// ---------- the view ----------
// One way of moving that works anywhere on the Moon, close up or far out. The view always
// looks at a point on the ground, the "pivot", and is described by four things:
//   frame     how the ground under the pivot is turned. Its local +Y points straight up from the
//             ground there, and its local -Z is "forward" along the ground, away from the camera.
//   distance  from the camera to the pivot, in Moon radii
//   tilt      0 looks straight down at the pivot; larger angles look along the ground
//   radius    how far the pivot is from the Moon's centre (it follows the terrain)
// Dragging turns the frame about the Moon's centre, which slides the ground under you: up close
// that feels like moving a map, far out like spinning a globe.
const TILTED = rad(40), MAX_TILT = rad(82), NEAR = 0.03, FAR = 6;
const WHOLE_MOON = 3.6;                       // distance from which the whole Moon is in view
const HOME_FRAME = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(-0.5, 0, -0.866), SOUTH_POLE, new THREE.Vector3(-0.866, 0, 0.5)));   // over the south pole
const view = { frame: HOME_FRAME.clone(), distance: 0.42, tilt: TILTED, radius: 1 };
const pivot = new THREE.Vector3(0, -1, 0);    // where the view is looking, updated every frame

// Two ways up, same camera position, picture turned half a turn.
// flipped (the default, "upside down"): at the south pole the Moon's north is up, as on a globe,
//   so you look up at the pole from underneath and the terrain hangs down.
// not flipped ("right side up"): the ground is under you, like a map.
let flipped = true;
try { flipped = localStorage.getItem('view-way-up') !== 'ground'; } catch { /* storage unavailable */ }

function flipView() {
  flipped = !flipped;
  try { localStorage.setItem('view-way-up', flipped ? 'north' : 'ground'); } catch { /* storage unavailable */ }
  showFlip();
}
function showFlip() {
  $('view-flip').textContent = flipped ? 'Right-side-up view' : 'Upside-down view';
  $('view-flip').setAttribute('aria-pressed', String(!flipped));
}

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sunLight = new THREE.DirectionalLight(0xfff2dd, 2.2);
sunLight.position.set(3, -0.4, 2);
scene.add(sunLight);

const moon = new THREE.Group();
scene.add(moon);

let map = null;          // exposure_map.json
let cap = null;          // coloured terrain mesh
let globe = null;
let world = null;        // global_map.json: values for the whole Moon, with coarse terrain or as a smooth ball
let worldHeights = null; // global_heights.bin: ground heights used to shade the globe (Int16Array), or null
let globeTex = null;     // the globe's colours, one pixel per cell of `world`
let shadeTex = null;     // the globe's terrain shading
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
  if (world) { paintGlobe(); return; }
  // no whole-Moon data: plain grey, or a photo if an equirectangular Moon image is at web/assets/moon.jpg
  new THREE.TextureLoader().load('./assets/moon.jpg', tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true;
  }, undefined, () => {});
}

const MUTED = new THREE.Color(0x8f8c86);

// The 256 colours of a layer's ramp as sRGB bytes, so painting millions of pixels stays quick.
function rampBytes(L, muted) {
  const out = new Uint8Array(256 * 3), c = {};
  for (let i = 0; i < 256; i++) {
    const col = rampColour(L.ramp, i / 255);
    if (muted) col.lerp(MUTED, 0.5);
    col.getRGB(c, THREE.SRGBColorSpace);
    out[i * 3] = Math.round(c.r * 255); out[i * 3 + 1] = Math.round(c.g * 255); out[i * 3 + 2] = Math.round(c.b * 255);
  }
  return out;
}

// The globe is drawn from two textures multiplied together. Both are longitude/latitude grids,
// which is exactly the layout of a sphere texture.
//   colour: one pixel per map cell, from the whole-Moon values for the current layer. Small, so
//           switching layers is instant. Without terrain (smooth ball) the colours are muted,
//           to keep them apart from the terrain map.
//   shade:  light and dark from the terrain heights, so hills and craters show. Large, and
//           repainted only when the Relief slider changes.
const SHADE_MAX = 1.4;       // brightest shade stored (1 = flat ground)

function paintGlobe() {
  if (!world || !globe) return;
  const L = LAYERS[layer], values = world[L.key], count = world.n_lon * world.n_lat;
  const table = rampBytes(L, !world.terrain);
  const px = globeTex ? globeTex.image.data : new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const c = Math.round(Math.min(Math.max(L.scale(values[i]), 0), 1) * 255) * 3;
    px[i * 4] = table[c]; px[i * 4 + 1] = table[c + 1]; px[i * 4 + 2] = table[c + 2]; px[i * 4 + 3] = 255;
  }
  if (!globeTex) {
    globeTex = globeTexture(px, world.n_lon, world.n_lat);
    globeTex.colorSpace = THREE.SRGBColorSpace;
    globe.material.dispose();
    globe.material = new THREE.MeshBasicMaterial({ map: globeTex });   // unlit, so colours match the legend
    shadeGlobe();
  }
  globeTex.needsUpdate = true;
}

// Light and shade from the terrain: how squarely each patch of ground faces a light in the
// north-west, 45 degrees up. The Relief slider makes the slopes steeper, so the shading deeper.
function shadeGlobe() {
  if (!worldHeights || !globeTex) return;
  const h = worldHeights, W = world.heights.n_lon, H = world.heights.n_lat, moonM = 1737400, z = relief;
  const px = shadeTex ? shadeTex.image.data : new Uint8Array(W * H * 4);
  const dy = moonM * Math.PI / H;                                                         // metres between rows
  for (let j = 0; j < H; j++) {
    const lat = -90 + (j + 0.5) * 180 / H;
    const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);
    const dx = moonM * cosLat * 2 * Math.PI / W;                                          // metres between columns
    // Near the poles the columns crowd together. Measure the east-west slope across enough of
    // them to span about the same ground as one row, or the shading turns into streaks.
    const span = Math.min(Math.max(Math.round(1 / cosLat), 1), W / 8);
    const up = Math.min(j + 1, H - 1) * W, down = Math.max(j - 1, 0) * W, row = j * W;
    for (let i = 0; i < W; i++) {
      const zx = (h[row + (i + span) % W] - h[row + (i + W - span) % W]) / (2 * span * dx) * z;   // slope towards the east
      const zy = (h[up + i] - h[down + i]) / (2 * dy) * z;                                // slope towards the north
      const facing = (0.5 * zx - 0.5 * zy + 0.7071) / (Math.sqrt(zx * zx + zy * zy + 1) * 0.7071);
      const light = 0.3 + 0.7 * Math.min(Math.max(facing, 0), 1.55);                      // 1 on flat ground
      const o = (row + i) * 4;
      px[o] = px[o + 1] = px[o + 2] = Math.min(light / SHADE_MAX, 1) * 255; px[o + 3] = 255;
    }
  }
  if (!shadeTex) {
    shadeTex = globeTexture(px, W, H);
    shadeTex.generateMipmaps = true;                       // smooth when the Moon is small on screen
    shadeTex.minFilter = THREE.LinearMipmapLinearFilter;
    globe.material.lightMap = shadeTex;
    globe.material.lightMapIntensity = Math.PI * SHADE_MAX;   // three.js divides light maps by pi
    globe.material.needsUpdate = true;
  }
  shadeTex.needsUpdate = true;
}

function globeTexture(px, width, height) {
  const tex = new THREE.DataTexture(px, width, height, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;          // blend between pixels
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;            // longitude wraps around
  // the sphere stops short of the south pole (the hole for the terrain map), so the texture must too
  const shown = globe.geometry.parameters.thetaLength / Math.PI;
  tex.repeat.set(1, shown);
  tex.offset.set(0, 1 - shown);
  return tex;
}

// Index of the whole-Moon cell containing a lat/lon.
function worldCell(lat, lon) {
  const east = ((lon + 180) % 360 + 360) % 360 - 180;       // -180 to 180
  const i = ((Math.round((east - world.lon0_deg) / world.step_deg) % world.n_lon) + world.n_lon) % world.n_lon;
  const j = Math.min(Math.max(Math.round((lat - world.lat0_deg) / world.step_deg), 0), world.n_lat - 1);
  return j * world.n_lon + i;
}

// A faint outline, so the Moon's edge stays visible where its colours are as dark as the sky.
function buildRim() {
  moon.add(new THREE.Mesh(new THREE.SphereGeometry(1.006, 96, 64),
    new THREE.MeshBasicMaterial({ color: 0xece7d8, transparent: true, opacity: 0.35, side: THREE.BackSide })));
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

// A link that opens the dashboard for a point in a pop-up panel over the map.
// name, if given, is what the dashboard calls the point.
function analyseLink(lat, lon, text, title, name = '') {
  const query = `lat=${lat}&lon=${lon}` + (name ? `&name=${encodeURIComponent(name)}` : '');
  const a = Object.assign(document.createElement('a'), { href: `../dashboard.html?${query}`, textContent: text });
  a.addEventListener('click', ev => {             // ctrl/middle click still opens the full page in a new tab
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    openAnalysis(lat, lon, title, name);
  });
  return a;
}

// Fill the point readout: a heading, rows of [label, value], and for a selected point the
// analyse link (or the reason there is none) plus a Release button.
function showReadout(whereText, rows, selected, link, reshow) {
  const where = Object.assign(document.createElement('p'), { className: 'where', textContent: whereText });
  const dl = document.createElement('dl');
  for (const [a, b] of rows) {
    dl.append(Object.assign(document.createElement('dt'), { textContent: a }), Object.assign(document.createElement('dd'), { textContent: b }));
  }
  $('readout').replaceChildren(where, dl);
  $('point-title').textContent = selected ? 'Selected point' : 'Point under the cursor';
  if (!selected) {
    $('readout').append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Click the map to keep a spot selected.' }));
    return;
  }
  const release = Object.assign(document.createElement('button'), { textContent: 'Release' });
  release.addEventListener('click', () => { pinned = null; pinnedSite = null; pinnedGlobe = null; hover = null; reshow(); });
  const actions = Object.assign(document.createElement('p'), { className: 'actions' });
  actions.append(link || Object.assign(document.createElement('span'), { className: 'hint',
    textContent: 'Analysing a new point needs a map made by the latest exposure_map.py, or the site started with pipeline/server.py.' }));
  actions.append(release);
  $('readout').append(actions);
}

// A point on the south polar terrain map. A candidate site is already analysed; any other
// map point is estimated in the browser from the saved skylines.
function showPoint(k) {
  const [lat, lon] = cellLatLon(k);
  const link = pinnedSite ? analyseLink(pinnedSite.lat, pinnedSite.lon, `Analyse ${pinnedSite.name}`, pinnedSite.name)
    : (canAnalyse || map.horizons) ? analyseLink(lat.toFixed(4), lon.toFixed(4), 'Analyse this point', place(lat, lon)) : null;
  showReadout(place(lat, lon), [
    ['Sunlight', `${map.sun_pct[k].toFixed(1)}% of the year`],
    ['Earth in view', `${map.earth_pct[k].toFixed(1)}% of the year`],
    ['Longest night', days(map.longest_dark_h[k])],
    ['Height', `${map.height_m[k].toLocaleString('en')} m`],
  ], pinned !== null, link, () => showPoint(k));
}

// A point anywhere else on the Moon, from the whole-Moon values (coarse terrain, or a smooth ball).
// name is set for a named place, such as an Apollo landing site.
function showGlobePoint(lat, lon, name = '') {
  const c = worldCell(lat, lon), east = (lon + 360) % 360;
  const link = !(map && map.horizons) ? null : name
    ? analyseLink(lat.toFixed(3), east.toFixed(3), `Analyse the ${name}`, name, name)
    : analyseLink(lat.toFixed(2), east.toFixed(2), 'Analyse this point', place(lat, east));
  showReadout(name ? `${name}, ${place(lat, east)}` : place(lat, east), [
    ['Sunlight', `${world.sun_pct[c].toFixed(1)}% of the year`],
    ['Earth in view', `${world.earth_pct[c].toFixed(1)}% of the year`],
    ['Longest night', days(world.longest_dark_h[c])],
    world.terrain ? ['Height', `${world.height_m[c].toLocaleString('en')} m`] : ['Terrain', 'ignored (smooth Moon)'],
  ], pinnedGlobe !== null, link, () => showGlobePoint(lat, lon));      // released, it becomes an ordinary point
}

// Show the dashboard for one coordinate in a panel over the map. The dashboard page is loaded
// once and then asked for each new point, so later points appear without a page load.
function openAnalysis(lat, lon, title, name = '') {
  const dialog = $('analysis'), frame = $('analysis-frame');
  $('analysis-title').textContent = title;
  const query = `lat=${lat}&lon=${lon}` + (name ? `&name=${encodeURIComponent(name)}` : '');
  $('analysis-full').href = `../dashboard.html?${query}`;
  if (!dialog.open) dialog.showModal();
  const inside = frame.contentWindow;
  if (frame.dataset.loaded && inside && typeof inside.openPoint === 'function') {
    inside.openPoint(Number(lat), Number(lon), name);
    inside.scrollTo(0, 0);
  } else {
    frame.addEventListener('load', () => { frame.dataset.loaded = '1'; }, { once: true });
    frame.src = `../dashboard.html?${query}&embed=1`;
  }
}
$('analysis-close').addEventListener('click', () => $('analysis').close());
$('analysis').addEventListener('click', ev => { if (ev.target === $('analysis')) $('analysis').close(); });   // click outside the panel

// Keep one grid cell selected: the readout and ring stay on it until released.
// site is given when the cell was chosen through a candidate site's button.
function pin(k, site = null) {
  pinned = k;
  pinnedSite = site;
  pinnedGlobe = null;
  hover = new THREE.Vector3().fromBufferAttribute(cap.geometry.attributes.position, k);
  showPoint(k);
}

// The same for a point outside the polar map. point is where the cursor ring sits.
function pinGlobe(lat, lon, point, name = '') {
  pinned = null;
  pinnedSite = null;
  pinnedGlobe = { lat, lon };
  hover = point.clone();
  showGlobePoint(lat, lon, name);
}

// The Apollo landing sites: a label on the globe and a row in the panel for each.
function showApollo() {
  const list = $('apollo');
  for (const a of APOLLO) {
    const b = document.createElement('button');
    b.append(Object.assign(document.createElement('span'), { className: 'name', textContent: a.name }),
      Object.assign(document.createElement('span'), { className: 'nums', textContent: `${a.where}, ${a.when}` }));
    if (world) {
      const c = worldCell(a.lat, a.lon);
      b.append(Object.assign(document.createElement('span'), { className: 'nums',
        textContent: `Sun ${world.sun_pct[c]}%, Earth ${world.earth_pct[c]}%, longest night ${days(world.longest_dark_h[c])}` }));
    }
    b.addEventListener('click', () => {
      flyTo(a.lat, a.lon, 0.7);                   // the whole-Moon terrain is coarse, so stay further out
      if (world) pinGlobe(a.lat, a.lon, unit(a.lat, a.lon), `${a.name} landing site`);
    });
    const li = document.createElement('li');
    li.append(b);
    list.append(li);
    const el = Object.assign(document.createElement('div'), { className: 'tag apollo' + (a.below ? ' below' : ''), textContent: a.name });
    $('tags').append(el);
    tags.push({ el, lat: a.lat, lon: a.lon, pos: unit(a.lat, a.lon), apollo: true });
  }
  $('apollo-show').addEventListener('change', ev => { for (const t of tags) if (t.apollo) t.off = !ev.target.checked; });
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

// Far from the Moon the view straightens up, so the whole Moon sits in the middle of the screen.
const tiltNow = () => view.tilt * THREE.MathUtils.clamp((2.4 - view.distance) / 1.4, 0, 1);

// Put the camera where the view says.
function applyView() {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(view.frame);          // straight up from the ground at the pivot
  view.radius += (groundRadius(up) - view.radius) * 0.2;                      // ease over steps in the terrain
  pivot.copy(up).multiplyScalar(view.radius);
  const t = tiltNow();
  camera.position.set(0, view.distance * Math.cos(t), view.distance * Math.sin(t)).applyQuaternion(view.frame).add(pivot);
  camera.up.set(0, Math.sin(t), -Math.cos(t)).applyQuaternion(view.frame);    // "forward along the ground" is up on screen
  if (flipped) camera.up.negate();
  camera.lookAt(pivot);
}

// Slide the ground by a number of screen pixels (what a drag does).
function pan(dx, dy) {
  const perPixel = 2 * view.distance * Math.tan(rad(camera.fov / 2)) / canvas.clientHeight;   // ground covered by one pixel
  const sign = flipped ? -1 : 1;                                   // flipped, the screen is the other way round
  const mx = -dx * perPixel * sign;                                // the pivot moves the opposite way to the drag
  const mz = -dy * perPixel * sign / Math.max(Math.cos(tiltNow()), 0.35);
  const length = Math.hypot(mx, mz);
  if (!length) return;
  // moving the pivot over the ground = turning the frame about an axis lying in the ground
  view.frame.multiply(new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(mz / length, 0, -mx / length), Math.min(length / view.radius, 1.5))).normalize();
}

// Turn the view around the pivot and tilt it (what a right-drag does).
function turnAndTilt(dx, dy) {
  view.frame.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.005)).normalize();
  view.tilt = THREE.MathUtils.clamp(view.tilt - dy * 0.005, 0, MAX_TILT);
}

// Zoom by a factor. With a screen position (the cursor), the ground under it stays under it.
function zoom(factor, x, y) {
  let held = null;
  if (x !== undefined) {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
    held = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), view.radius), new THREE.Vector3());
  }
  view.distance = THREE.MathUtils.clamp(view.distance * factor, NEAR, FAR);
  if (!held) return;
  applyView();
  camera.updateMatrixWorld();
  // see where that bit of ground ended up on screen, and slide it back under the cursor
  const now = held.clone().project(camera), r = canvas.getBoundingClientRect();
  pan(x - r.left - (now.x * 0.5 + 0.5) * r.width, y - r.top - (-now.y * 0.5 + 0.5) * r.height);
}

// Glide to a new view over 0.7 seconds. Any of frame, distance and tilt may be given.
let glideTo = null;
function glide(target) {
  const to = { frame: target.frame || view.frame.clone(), distance: target.distance ?? view.distance, tilt: target.tilt ?? view.tilt };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    view.frame.copy(to.frame); view.distance = to.distance; view.tilt = to.tilt; glideTo = null; return;
  }
  glideTo = { from: { frame: view.frame.clone(), distance: view.distance, tilt: view.tilt }, to, start: performance.now() };
}
function stepGlide(now) {
  const g = glideTo, t = Math.min((now - g.start) / 700, 1), e = t * t * (3 - 2 * t);
  view.frame.slerpQuaternions(g.from.frame, g.to.frame, e);
  view.distance = g.from.distance * Math.pow(g.to.distance / g.from.distance, e);   // even steps of zoom
  view.tilt = THREE.MathUtils.lerp(g.from.tilt, g.to.tilt, e);
  if (t === 1) glideTo = null;
}

// The frame for looking at a lat/lon: the current frame swung the short way round to that spot.
function frameAt(lat, lon) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(view.frame);
  return new THREE.Quaternion().setFromUnitVectors(up, unit(lat, lon)).multiply(view.frame);
}

function flyTo(lat, lon, distance = 0.12) {   // bring a spot to the middle and come in close
  glide({ frame: frameAt(lat, lon), distance, tilt: view.tilt || TILTED });
}
function resetView() {                        // back to the south polar map
  glide({ frame: HOME_FRAME.clone(), distance: 0.42, tilt: TILTED });
}
// Pull back until the whole Moon is in view: the near side, seen from a little south of its
// centre, with north at the top of the screen.
function wholeMoon() {
  const up = unit(-20, 15), north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  const back = north.multiplyScalar(flipped ? 1 : -1);        // flipped, "forward along the ground" points down the screen
  const frame = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, back), up, back));
  glide({ frame, distance: WHOLE_MOON });
}
function zoomBy(factor) {
  glide({ distance: THREE.MathUtils.clamp(view.distance * factor, NEAR, FAR) });
}
function toggleTilt() {                       // switch between looking straight down and a tilted view
  glide({ tilt: view.tilt < rad(8) ? TILTED : 0 });
}

// Mouse, touch and keyboard. A drag slides the ground. A right-drag, or a drag with Ctrl or
// Shift held, turns and tilts. The wheel zooms towards the cursor. Two fingers pinch to zoom
// and twist to turn.
const fingers = new Map();                    // pointers currently down: id -> { x, y, turning }
let pinch = null;
function fingerPair() {
  const [a, b] = [...fingers.values()];
  return { gap: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
canvas.addEventListener('pointerdown', ev => {
  canvas.setPointerCapture(ev.pointerId);
  fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, turning: ev.button === 2 || ev.ctrlKey || ev.shiftKey || ev.metaKey });
  pinch = fingers.size === 2 ? fingerPair() : null;
  glideTo = null;                             // taking hold of the view stops any glide
});
canvas.addEventListener('pointermove', ev => {
  const f = fingers.get(ev.pointerId);
  if (!f) return;
  const dx = ev.clientX - f.x, dy = ev.clientY - f.y;
  f.x = ev.clientX; f.y = ev.clientY;
  if (fingers.size === 1) {
    if (f.turning) turnAndTilt(dx, dy); else pan(dx, dy);
  } else if (fingers.size === 2 && pinch) {
    const now = fingerPair();
    zoom(pinch.gap / Math.max(now.gap, 1), now.x, now.y);
    view.frame.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (now.angle - pinch.angle) * (flipped ? -1 : 1))).normalize();
    pinch = now;
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, ev => { fingers.delete(ev.pointerId); pinch = null; });
}
canvas.addEventListener('contextmenu', ev => ev.preventDefault());          // right-drag turns the view instead
canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  glideTo = null;
  zoom(Math.exp(THREE.MathUtils.clamp(ev.deltaY, -300, 300) * 0.0015), ev.clientX, ev.clientY);
}, { passive: false });
canvas.addEventListener('keydown', ev => {    // with the map focused: arrows move, + and - zoom, 0 or Home resets
  const step = 60, moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[ev.key]) { pan(...moves[ev.key]); ev.preventDefault(); }
  else if (ev.key === '+' || ev.key === '=') zoomBy(0.6);
  else if (ev.key === '-' || ev.key === '_') zoomBy(1 / 0.6);
  else if (ev.key === '0' || ev.key === 'Home') resetView();
});

// ---------- picking ----------

const ray = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let canAnalyse = false;      // true when pipeline/server.py is serving the page
let pinnedSite = null;
let pinnedGlobe = null;       // { lat, lon } of a selected point outside the polar map
let hover = null, pickQueued = false, pinned = null, pickToPin = false, downAt = null;

function pick() {
  pickQueued = false;
  const wantPin = pickToPin;
  pickToPin = false;
  const selected = pinned !== null || pinnedGlobe !== null;
  if (selected && !wantPin) return;
  ray.setFromCamera(pointer, camera);
  const hit = ray.intersectObjects([cap, world ? globe : null].filter(Boolean))[0];
  if (!hit) { if (!selected) hover = null; return; }

  if (hit.object === globe) {               // outside the polar map: smooth-Moon values
    const d = hit.point.clone().normalize();
    const lat = THREE.MathUtils.radToDeg(Math.asin(d.y)), lon = THREE.MathUtils.radToDeg(Math.atan2(-d.z, d.x));
    if (wantPin) { pinGlobe(lat, lon, hit.point); return; }
    hover = hit.point.clone();
    showGlobePoint(lat, lon);
    return;
  }
  // on the polar map: nearest of the triangle's three corners
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
  if (glideTo) stepGlide(now);
  applyView();
  // the buttons say what they will do next
  const far = view.distance > 1.8, down = view.tilt < rad(8);
  if ($('view-mode').dataset.far !== String(far)) {
    $('view-mode').dataset.far = String(far);
    $('view-mode').textContent = far ? 'South pole map' : 'Whole Moon';
  }
  if ($('view-tilt').dataset.down !== String(down)) {
    $('view-tilt').dataset.down = String(down);
    $('view-tilt').textContent = down ? 'Tilt the view' : 'Look straight down';
  }
  renderer.render(scene, camera);
  for (const t of tags) { if (t.off) t.el.hidden = true; else toScreen(t.pos, t.el); }
  if (hover) toScreen(hover, $('cursor')); else $('cursor').hidden = true;
  requestAnimationFrame(frame);
}

// ---------- start ----------

// 'no-cache' makes the browser check for a newer copy every time, so regenerated data shows up on reload
async function getFile(name) {
  const res = await fetch(DATA + name, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res;
}
const getJson = async name => (await getFile(name)).json();

async function start() {
  $('view-reset').addEventListener('click', resetView);
  $('view-in').addEventListener('click', () => zoomBy(0.6));
  $('view-out').addEventListener('click', () => zoomBy(1 / 0.6));
  $('view-tilt').addEventListener('click', toggleTilt);
  $('view-flip').addEventListener('click', flipView);
  $('view-mode').addEventListener('click', () => (view.distance > 1.8 ? resetView() : wholeMoon()));
  showFlip();
  $('build').textContent = `Page version ${BUILD}.`;
  buildGraticule();
  buildRim();

  try {
    map = await getJson('exposure_map.json');
  } catch {
    map = null;
    notice('No exposure map yet, so only the three sites are shown. To make it, run this in the <b>pipeline</b> folder, then reload: <code>python exposure_map.py path\\to\\LDEM_75S_120M.LBL</code>');
    $('layer-section').hidden = true;
    $('point-section').hidden = true;
  }

  // server.py answers /api/site with JSON even when no point is given; a plain file server does not
  fetch('../api/site', { cache: 'no-store' }).then(r => { canAnalyse = (r.headers.get('content-type') || '').includes('json'); }).catch(() => {});

  world = await getJson('global_map.json').catch(() => null);        // optional: made by global_map.py
  if (world && world.heights) {
    try {
      const bin = new Int16Array(await (await getFile(world.heights.file)).arrayBuffer());
      if (bin.length === world.heights.n_lon * world.heights.n_lat) worldHeights = bin;
    } catch { /* no shading without the heights */ }
  }
  if (world) {
    $('world-note').textContent = world.terrain
      ? `Outside the south polar map the terrain is much coarser: a ${world.grid_pixel_km} km elevation grid, with points ${world.step_deg}° apart.`
      : 'Outside the south polar map, in muted colours, the Moon is treated as a smooth ball: hills and crater walls are ignored.';
    $('world-note').hidden = false;
  }
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
  showApollo();

  for (const input of document.querySelectorAll('input[name=layer]')) {
    input.addEventListener('change', () => { layer = input.value; if (cap) paintCap(); paintGlobe(); showLegend(); });
  }
  $('relief').addEventListener('input', ev => {
    relief = Number(ev.target.value);
    $('relief-value').textContent = `${relief}×`;
    if (cap) shapeCap();
  });
  $('relief').addEventListener('change', shadeGlobe);     // on release: reshading the globe takes a moment

  requestAnimationFrame(frame);
}

start();
