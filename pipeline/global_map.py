"""Map sunlight and Earth visibility over the whole Moon.

Usage:  python global_map.py path\\to\\LDEM_16.LBL [step_deg] [workers]
            with terrain, from a global LOLA elevation grid (get it with: python fetch_lola.py --global)
        python global_map.py
            without terrain: the Moon as a smooth ball. Needs no LOLA files.
        step_deg  distance between mapped points in degrees (default 0.5 with terrain, 2 without)
        workers   how many processor cores to use (default: all but one, at most 8)
Needs:  ../data/malapert_ephemeris.json  (from fetch_ephemeris.py)
Output: ../data/global_map.json     values on a longitude/latitude grid, read by the 3D page in ../web
        ../data/global_heights.bin  (with terrain) ground heights at 8 points per degree, which the
                                    3D page uses to shade hills and craters

This is the wide view that goes around the detailed south polar map made by exposure_map.py.
It uses the same Sun and Earth positions and the same visibility rules. With terrain it also
uses the same skyline calculation, on much coarser data: LDEM_16 has 1.9 km pixels (the polar
map uses 120 m), the skyline is sampled every 4 degrees out to 100 km, and time moves in
3 hour steps. Treat it as a survey. Near the poles, where the Sun skims the horizon and small
hills matter, only the polar map is detailed enough to trust.

For each grid cell it stores
    sun_pct         average share of the Sun's disc above the skyline over the year
    earth_pct       share of the year the Earth's centre is above the skyline
    longest_dark_h  longest unbroken stretch with no part of the Sun showing, hours
    height_m        (with terrain) ground height above the 1737.4 km sphere
"""
import os

# Each worker process below does its own sums on one core. Left alone, numpy's maths library
# would start a full set of threads in every worker (cores x cores in total) and run the
# computer out of memory. This has to be set before numpy is first imported.
for _name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_name, "1")

import json
import multiprocessing
import pathlib
import re
import sys
import time
import traceback

import numpy as np

import horizon_profile
from compute_visibility import sun_fraction
from exposure_map import load_sky, longest_false_run
from fetch_ephemeris import OUT_DIR
from horizon_profile import MAST_M, R

AZ_STEP = 4.0            # skyline resolution with terrain, degrees
MAX_DIST = 100e3         # how far out to look for blocking terrain, metres
HOURS = 3                # time step with terrain: use every 3rd hour of the ephemeris
SHADE_PPD = 8            # points per degree in the heights file used for shading
FLAT_AZ = np.array([0.0, 180.0])      # a horizon at 0 degrees in every direction
FLAT_EL = np.array([0.0, 0.0])


class GlobalDem:
    """A LOLA simple-cylindrical elevation grid, such as LDEM_16.

    Rows run from north to south and columns eastwards from the grid's western edge
    (0 degrees for the LOLA global grids). Pixel centres sit half a pixel in from the edges.
    """

    def __init__(self, lbl_path):
        lbl = pathlib.Path(lbl_path)
        text = lbl.read_text(errors="ignore")

        def num(key, default=None):
            m = re.search(rf"^\s*{key}\s*=\s*([-+0-9.eE]+)", text, re.M)
            if m:
                return float(m.group(1))
            if default is None:
                raise KeyError(f"{key} not found in {lbl}")
            return default

        lines, samples = int(num("LINES")), int(num("LINE_SAMPLES"))
        if samples != 2 * lines:
            raise ValueError(f"{lbl.name} is not a whole-Moon cylindrical grid ({samples} x {lines}). "
                             "Use a global grid such as LDEM_16.")
        stype = re.search(r"SAMPLE_TYPE\s*=\s*(\w+)", text).group(1)
        bits = int(num("SAMPLE_BITS"))
        dtype = "<f4" if "REAL" in stype else ("<" if "LSB" in stype or "PC" in stype else ">") + f"i{bits // 8}"
        img = next((p for p in (lbl.with_suffix(".IMG"), lbl.with_suffix(".img")) if p.exists()), None)
        if img is None:
            raise FileNotFoundError(f"no .IMG file next to {lbl}")
        unit_km = bool(re.search(r"^\s*UNIT\s*=\s*\"?KILOMETER", text, re.M))
        self.name = lbl.stem
        self.ppd = samples / 360.0                       # pixels per degree
        self.west = num("WESTERNMOST_LONGITUDE", 0.0)
        self.north = num("MAXIMUM_LATITUDE", 90.0)
        self.to_m = num("SCALING_FACTOR", 1.0) * (1000.0 if unit_km else 1.0)
        # read straight from the file as needed: worker processes then share one copy in memory
        self.grid = np.memmap(img, dtype=dtype, mode="r", shape=(lines, samples))
        self.meta = {"pix": R * np.radians(1.0 / self.ppd), "lines": lines, "samples": samples}

    def height(self, lat_deg, lon_deg):
        """Terrain height in metres above the 1737.4 km sphere, blended from the four nearest pixels."""
        lines, samples = self.grid.shape
        row = np.clip((self.north - np.asarray(lat_deg, float)) * self.ppd - 0.5, 0, lines - 1)
        col = ((np.asarray(lon_deg, float) - self.west) % 360.0) * self.ppd - 0.5
        r0 = np.minimum(np.floor(row).astype(int), lines - 2)
        c0 = np.floor(col).astype(int)
        fr, fc = row - r0, col - c0
        c0, c1 = c0 % samples, (c0 + 1) % samples        # longitude wraps around
        g = self.grid
        return (g[r0, c0] * (1 - fr) * (1 - fc) + g[r0, c1] * (1 - fr) * fc
                + g[r0 + 1, c0] * fr * (1 - fc) + g[r0 + 1, c1] * fr * fc) * self.to_m

    def shading_heights(self):
        """Heights in whole metres at SHADE_PPD points per degree, rows from the south, columns from 180 W."""
        lines, samples = self.grid.shape
        f = max(int(round(self.ppd / SHADE_PPD)), 1)
        g = self.grid[:lines - lines % f, :samples - samples % f].astype(np.float32)
        small = g.reshape(lines // f, f, samples // f, f).mean(axis=(1, 3)) * self.to_m
        small = small[::-1]                                              # south first
        shift = int(round(((-180.0 - self.west) % 360.0) * small.shape[1] / 360.0))
        return np.rint(np.roll(small, -shift, axis=1)).astype("<i2")     # 180 W first


def check_against_polar_map(dem):
    """Stop if the global grid disagrees with the polar map's heights: the file was misread."""
    path = OUT_DIR / "exposure_map.json"
    if not path.exists():
        return
    m = json.loads(path.read_text())
    n, known = m["n"], m["height_m"]
    cells = [k for k in range(0, n * n, 97) if known[k] is not None]
    x = m["x0_km"] + (np.array(cells) % n) * m["spacing_km"]
    y = m["y0_km"] + (np.array(cells) // n) * m["spacing_km"]
    lat = -90 + np.degrees(2 * np.arctan(np.hypot(x, y) / (2 * m["moon_radius_km"])))
    lon = np.degrees(np.arctan2(x, y)) % 360
    ours, theirs = dem.height(lat, lon), np.array([known[k] for k in cells], float)
    match = float(np.corrcoef(ours, theirs)[0, 1])
    print(f"check against the polar map: heights agree with correlation {match:.2f} "
          f"(typical difference {np.median(np.abs(ours - theirs)):.0f} m)")
    if match < 0.8:
        sys.exit(f"{dem.name} does not match the polar map's terrain, so its layout was probably misread. "
                 "Nothing was written. Send this message to whoever maintains global_map.py.")


def smooth_exposure(sky, lat, lon):
    """Exposure numbers for one point on a smooth Moon. lat/lon in degrees."""
    az, el = sky.sun(lat, lon)
    frac = sun_fraction(az, el, FLAT_AZ, FLAT_EL)
    _, earth_el = sky.earth(lat, lon, MAST_M)
    return {"sun_pct": 100 * frac.mean(), "earth_pct": 100 * (earth_el > 0).mean(),
            "longest_dark_h": longest_false_run(frac > 0)}


def terrain_exposure(dem, sky, lat, lon, hours=1):
    """Exposure numbers for one point, with the skyline from a global elevation grid."""
    haz, hel, ground, _ = horizon_profile.horizon(dem, lat, lon)
    az, el = sky.sun(lat, lon)
    frac = sun_fraction(az, el, haz, hel)
    az, el = sky.earth(lat, lon, ground + MAST_M)
    earth = el > np.interp(az, haz, hel, period=360)
    return {"sun_pct": 100 * frac.mean(), "earth_pct": 100 * earth.mean(),
            "longest_dark_h": longest_false_run(frac > 0) * hours, "height_m": ground}


# ---- one row of the map per task, so several processor cores can share the work ----

_w = {}


def _start_worker(lbl, lons):
    """Runs once in each worker process: load the grid and the sky positions."""
    try:
        _w["lons"] = lons
        _w["sky"] = sky = load_sky()
        _w["dem"] = None
        if lbl:
            horizon_profile.AZ_STEP = AZ_STEP          # coarser skyline settings than the per-site run
            horizon_profile.MAX_DIST = MAX_DIST
            _w["dem"] = GlobalDem(lbl)
            sky.sun_dir, sky.earth_pos = sky.sun_dir[::HOURS], sky.earth_pos[::HOURS]
    except BaseException:
        # A worker that dies while starting is quietly replaced, for ever. Keep it alive and
        # report the problem with its first piece of work, so the run stops with a clear message.
        _w["failed"] = traceback.format_exc()


def _row(lat):
    if "failed" in _w:
        raise RuntimeError("a worker process could not start:\n" + _w["failed"])
    if _w["dem"] is None:
        return [smooth_exposure(_w["sky"], lat, float(lon)) for lon in _w["lons"]]
    return [terrain_exposure(_w["dem"], _w["sky"], lat, float(lon), HOURS) for lon in _w["lons"]]


def main():
    args = sys.argv[1:]
    lbl = args.pop(0) if args and not re.fullmatch(r"[0-9.]+", args[0]) else None
    step = float(args[0]) if args else (0.5 if lbl else 2.0)
    workers = int(args[1]) if len(args) > 1 else min(max((os.cpu_count() or 2) - 1, 1), 8)

    lats = np.arange(-90 + step / 2, 90, step)        # cell centres, south to north
    lons = np.arange(-180 + step / 2, 180, step)      # cell centres, west to east
    sky = load_sky()
    dem = None
    if lbl:
        dem = GlobalDem(lbl)
        print(f"{dem.name}: {dem.grid.shape[1]} x {dem.grid.shape[0]} pixels, {dem.meta['pix'] / 1000:.2f} km each")
        check_against_polar_map(dem)
    print(f"{len(lats) * len(lons)} points, {step:g} degrees apart, "
          f"{'with terrain' if lbl else 'smooth Moon'}, on {workers} processor core{'s' if workers > 1 else ''}")

    keys = ("sun_pct", "earth_pct", "longest_dark_h") + (("height_m",) if lbl else ())
    grids = {k: [] for k in keys}
    start = time.time()
    with multiprocessing.Pool(workers, _start_worker, (lbl, lons)) as pool:
        rows = pool.imap(_row, [float(v) for v in lats])
        for done in range(1, len(lats) + 1):
            try:
                row = next(rows)
            except Exception as exc:
                pool.terminate()
                sys.exit(f"\nStopped: {exc}\nNothing was written. If this is a memory error, try fewer cores, "
                         f"for example:  python global_map.py {lbl or ''} {step:g} 4")
            for res in row:
                grids["sun_pct"].append(round(res["sun_pct"], 1))
                grids["earth_pct"].append(round(res["earth_pct"], 1))
                grids["longest_dark_h"].append(int(res["longest_dark_h"]))
                if lbl:
                    grids["height_m"].append(round(res["height_m"]))
            if done % max(len(lats) // 20, 1) == 0 or done == len(lats):
                left = (time.time() - start) / done * (len(lats) - done)
                print(f"  {100 * done // len(lats)}%  about {left / 60:.1f} min left")

    out = {
        "about": "Whole Moon. Cell (i, j) is centred at lon = lon0_deg + i * step_deg (east positive), "
                 "lat = lat0_deg + j * step_deg. Values are stored row by row from the south: "
                 "index = j * n_lon + i. terrain says whether the skyline came from an elevation grid "
                 "(true) or the Moon was treated as a smooth ball (false).",
        "step_deg": step, "n_lon": len(lons), "n_lat": len(lats),
        "lon0_deg": float(lons[0]), "lat0_deg": float(lats[0]),
        "period": [sky.time_utc[0], sky.time_utc[-1]],
        "terrain": bool(lbl),
    }
    if lbl:
        shade = dem.shading_heights()
        (OUT_DIR / "global_heights.bin").write_bytes(shade.tobytes())
        out.update(grid=dem.name, grid_pixel_km=round(dem.meta["pix"] / 1000, 3), az_step_deg=AZ_STEP,
                   reach_km=MAX_DIST / 1000, time_step_h=HOURS, mast_m=MAST_M,
                   heights={"file": "global_heights.bin", "n_lon": int(shade.shape[1]), "n_lat": int(shade.shape[0]),
                            "about": "Ground height in metres as 16-bit little-endian integers, row by row "
                                     "from the south, each row starting at 180 W."})
    out.update(grids)
    (OUT_DIR / "global_map.json").write_text(json.dumps(out))
    print("wrote", OUT_DIR / "global_map.json", ("and " + str(OUT_DIR / "global_heights.bin")) if lbl else "")


if __name__ == "__main__":
    main()
