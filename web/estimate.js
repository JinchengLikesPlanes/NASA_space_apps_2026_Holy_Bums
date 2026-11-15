// Work out a full site analysis for any point on the 3D map, in the browser.
//
// Needs no server and no LOLA files: it reads what pipeline/exposure_map.py saved
//   data/exposure_map.json       the map grid
//   data/exposure_horizons.bin   the terrain skyline at every map point
//   data/<ref site>_ephemeris.json   one year of Sun and Earth positions from JPL Horizons
// and repeats the maths of exposure_map.py and compute_visibility.py for one point.
//
// It is a quick estimate: the nearest point on the map's grid, the 120 m terrain grid,
// and a skyline sampled every 2 degrees. pipeline/server.py gives the detailed answer.
//
// Use:  const est = await MapEstimate.load("data/");   // null if the skylines are not there
//       const site = est.site(-88.5, 45);               // null if the point is off the map
//       site.row, site.eph, site.hor, site.vis          // same shapes as the pipeline's files
(function (root) {
  const R = 1737400;            // lunar reference radius, metres
  const MAST_M = 2;             // observer height above the ground
  const SOLAR_CONSTANT = 1361;  // W/m2 of sunlight at the Moon
  const EFFICIENCY = 0.30;      // fraction of sunlight a panel turns into electricity
  const SUN_RADIUS_DEG = 0.2665;
  const STRIPS = 21;            // vertical slices used to measure how much of the Sun's disc is hidden
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

  // Unit vectors (up, east, north) at a point, in Moon-fixed x/y/z.
  function basis(lat, lon) {
    const p = rad(lat), l = rad(lon);
    return {
      up: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
      east: [-Math.sin(l), Math.cos(l), 0],
      north: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    };
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Azimuth/elevation seen at (lat, lon) -> direction vectors, one [x, y, z] per hour.
  function toVectors(az, el, lat, lon) {
    const { up, east, north } = basis(lat, lon);
    return az.map((a, k) => {
      const ar = rad(a), er = rad(el[k]), s = Math.sin(er), c = Math.cos(er);
      return [0, 1, 2].map(i => s * up[i] + c * (Math.cos(ar) * north[i] + Math.sin(ar) * east[i]));
    });
  }

  // Direction vector -> [azimuth, elevation] in degrees seen at a point with the given basis.
  function toAzEl(v, b) {
    const len = Math.hypot(v[0], v[1], v[2]);
    const el = deg(Math.asin(Math.max(-1, Math.min(1, dot(v, b.up) / len))));
    const az = (deg(Math.atan2(dot(v, b.east), dot(v, b.north))) + 360) % 360;
    return [az, el];
  }

  function longestRun(flags) {          // longest unbroken stretch of true values
    let best = 0, run = 0;
    for (const f of flags) { run = f ? run + 1 : 0; if (run > best) best = run; }
    return best;
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

  function build(map, skylines, ref) {
    const H = map.horizons, n = map.n, dirs = H.directions, step = H.az_step_deg;
    // which block of the skyline file belongs to each grid cell (-1 = off the map)
    const slot = new Int32Array(n * n).fill(-1);
    let count = 0;
    for (let k = 0; k < n * n; k++) if (map.sun_pct[k] !== null) slot[k] = count++;
    if (count !== H.points || skylines.length !== count * dirs) throw new Error("skyline file does not match the map");

    // Sun: the same direction from everywhere on the Moon. Earth: rebuild its position.
    const sunDir = toVectors(ref.sun_az, ref.sun_el, ref.lat, ref.lon);
    const refUp = basis(ref.lat, ref.lon).up;
    const earthPos = toVectors(ref.earth_az, ref.earth_el, ref.lat, ref.lon)
      .map(d => [0, 1, 2].map(i => R * refUp[i] + H.earth_dist_m * d[i]));

    // strips across the Sun's disc, as in compute_visibility.sun_fraction
    const xs = [], halves = [];
    for (let i = 1; i <= STRIPS; i++) {
      const x = -SUN_RADIUS_DEG + (2 * SUN_RADIUS_DEG * i) / (STRIPS + 1);
      xs.push(x); halves.push(Math.sqrt(SUN_RADIUS_DEG ** 2 - x * x));
    }
    const halfSum = halves.reduce((s, v) => s + v, 0);

    function cellAt(lat, lon) {
      const r = 2 * map.moon_radius_km * Math.tan(rad(90 + lat) / 2), l = rad(lon);
      const i = Math.round((r * Math.sin(l) - map.x0_km) / map.spacing_km);
      const j = Math.round((r * Math.cos(l) - map.y0_km) / map.spacing_km);
      if (i < 0 || j < 0 || i >= n || j >= n) return -1;
      return slot[j * n + i] < 0 ? -1 : j * n + i;
    }
    function cellLatLon(k) {
      const x = map.x0_km + (k % n) * map.spacing_km, y = map.y0_km + Math.floor(k / n) * map.spacing_km;
      const lat = -90 + deg(2 * Math.atan(Math.hypot(x, y) / (2 * map.moon_radius_km)));
      return [lat, (deg(Math.atan2(x, y)) + 360) % 360];
    }

    function site(lat, lon) {
      const k = cellAt(Math.max(lat, -89.9999), lon);
      if (k < 0) return null;
      let [cLat, cLon] = cellLatLon(k);
      cLat = Math.max(cLat, -89.9999);             // azimuth is undefined exactly at the pole
      const ground = map.height_m[k];
      const sky = skylines.subarray(slot[k] * dirs, (slot[k] + 1) * dirs);
      const terrain = az => {                       // skyline angle in any direction, in degrees
        const f = (((az % 360) + 360) % 360) / step, i0 = Math.floor(f) % dirs, t = f - Math.floor(f);
        return (sky[i0] * (1 - t) + sky[(i0 + 1) % dirs] * t) / 100;
      };

      const b = basis(cLat, cLon), T = sunDir.length;
      const obs = b.up.map(u => (R + ground + MAST_M) * u);
      const eph = { time_utc: ref.time_utc, sun_az: [], sun_el: [], earth_az: [], earth_el: [] };
      const frac = [], earth = [], track = [], flat = [], full = [];
      for (let t = 0; t < T; t++) {
        const [sAz, sEl] = toAzEl(sunDir[t], b);
        const [eAz, eEl] = toAzEl([0, 1, 2].map(i => earthPos[t][i] - obs[i]), b);
        const cosEl = Math.max(Math.cos(rad(sEl)), 0.05);
        let shown = 0;
        for (let s = 0; s < STRIPS; s++) {
          const part = (sEl + halves[s] - terrain(sAz + xs[s] / cosEl)) / (2 * halves[s]);
          shown += Math.max(0, Math.min(1, part)) * halves[s];
        }
        const f = shown / halfSum, power = SOLAR_CONSTANT * EFFICIENCY * f;
        frac.push(f); full.push(power);
        earth.push(eEl > terrain(eAz));
        track.push(power * Math.cos(rad(sEl)));
        flat.push(power * Math.max(Math.sin(rad(sEl)), 0));
        eph.sun_az.push(round(sAz, 3)); eph.sun_el.push(round(sEl, 3));
        eph.earth_az.push(round(eAz, 3)); eph.earth_el.push(round(eEl, 3));
      }
      // fixed vertical panel: try every facing direction and keep the best
      let bestAz = 0, fixed = null, bestMean = -1;
      for (let face = 0; face < 360; face += 5) {
        const p = full.map((w, t) => w * Math.max(Math.cos(rad(eph.sun_el[t])) * Math.cos(rad(eph.sun_az[t] - face)), 0));
        const m = mean(p);
        if (m > bestMean) { bestMean = m; bestAz = face; fixed = p; }
      }

      const south = cLat < 0 ? "S" : "N";
      const row = {
        id: `map_${k}`, name: `Map point ${Math.abs(cLat).toFixed(2)}°${south}, ${cLon.toFixed(1)}°E`,
        lat: round(cLat, 4), lon: round(cLon, 4), estimate: true,
        sun_pct: round(100 * mean(frac), 1),
        earth_pct: round(100 * mean(earth.map(Number)), 1),
        both_pct: round(100 * mean(frac.map((f, t) => f * earth[t])), 1),
        longest_dark_h: longestRun(frac.map(f => !(f > 0))),
        longest_no_comm_h: longestRun(earth.map(e => !e)),
        terrain: "lola", slope_deg: null, ground_height_m: ground,
        max_sun_elevation_deg: round(Math.max(...eph.sun_el), 2),
        avg_power_track_w_m2: round(mean(track), 1), avg_power_fixed_w_m2: round(bestMean, 1),
        fixed_panel_best_az_deg: bestAz, avg_power_flat_w_m2: round(mean(flat), 1),
      };
      const hor = { id: row.id, name: row.name, lat: row.lat, lon: row.lon, terrain: "lola",
        azimuth_deg: Array.from(sky, (_, i) => i * step), horizon_deg: Array.from(sky, v => v / 100) };
      const vis = { id: row.id, time_utc: ref.time_utc, sun_fraction: frac.map(f => round(f, 2)),
        earth_visible: earth.map(Number), power_track_w_m2: track.map(v => round(v, 1)),
        power_fixed_w_m2: fixed.map(v => round(v, 1)), power_flat_w_m2: flat.map(v => round(v, 1)) };
      return { row, eph, hor, vis };
    }
    return { site, cellAt, cellLatLon, spacing_km: map.spacing_km, az_step_deg: step };
  }

  // Fetch the three files from the data folder. Resolves to null if the skylines are not there.
  let loading = null;
  function load(base) {
    loading = loading || (async () => {
      try {
        const map = await (await fetch(base + "exposure_map.json")).json();
        if (!map.horizons) return null;
        const [bin, ref] = await Promise.all([
          fetch(base + map.horizons.file).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
          fetch(base + map.horizons.ref_site + "_ephemeris.json").then(r => r.json()),
        ]);
        return build(map, new Int16Array(bin), ref);
      } catch { return null; }
    })();
    return loading;
  }

  root.MapEstimate = { load, build };
})(typeof window !== "undefined" ? window : globalThis);
