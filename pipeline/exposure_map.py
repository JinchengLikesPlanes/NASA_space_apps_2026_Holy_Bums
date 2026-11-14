"""Map how much sunlight and Earth contact every spot near the south pole gets.

Usage:  python exposure_map.py path\\to\\LDEM_75S_120M.LBL [radius_km] [spacing_km]
        radius_km   how far from the pole to map (default 150, about 85 S)
        spacing_km  distance between mapped points (default 2)
Needs:  ../data/malapert_ephemeris.json  (from fetch_ephemeris.py)
Output: ../data/exposure_map.json, read by the web app in ../web

For each point on a square grid centred on the pole it stores
    sun_pct         average share of the Sun's disc above the terrain over the year
    earth_pct       share of the year the Earth's centre is above the terrain
    longest_dark_h  longest unbroken stretch with no part of the Sun showing, hours
    height_m        ground height above the 1737.4 km sphere

Method
1. Sky positions. Asking JPL Horizons about thousands of points would take hours,
   so we ask once (the Malapert file) and move the answer. The Sun is so far away
   that its direction is the same from everywhere on the Moon: turn Malapert's
   azimuth/elevation into a direction fixed to the Moon, then turn that direction
   back into azimuth/elevation at any other point. The Earth is close enough that
   its direction shifts by up to 0.3 degrees across the map, so for the Earth we
   rebuild its position (using its average distance) and aim at that.
2. Terrain. Same skyline calculation as horizon_profile.py, with coarser settings
   (one grid only, 2 degree steps, 150 km reach) so thousands of points finish in
   minutes. Expect small differences from the per-site numbers in summary.json,
   which use the fine grid and 0.1 degree steps.
3. Visibility. Same rules as compute_visibility.py: the Sun is a disc that can be
   partly hidden, the Earth is judged by its centre.
"""
import json
import sys
import time

import numpy as np

import horizon_profile
from compute_visibility import sun_fraction
from fetch_ephemeris import OUT_DIR
from horizon_profile import Dem, R, MAST_M

REF_SITE = "malapert"       # the ephemeris file all sky positions are derived from
EARTH_DIST = 384.4e6        # average Earth-Moon distance, metres
AZ_STEP = 2.0               # skyline resolution for the map, degrees
MAX_DIST = 150e3            # how far out to look for blocking terrain, metres


def basis(lat, lon):
    """Unit vectors (up, east, north) at a point, in Moon-fixed x/y/z."""
    p, l = np.radians(lat), np.radians(lon)
    up = np.array([np.cos(p) * np.cos(l), np.cos(p) * np.sin(l), np.sin(p)])
    east = np.array([-np.sin(l), np.cos(l), 0.0])
    north = np.array([-np.sin(p) * np.cos(l), -np.sin(p) * np.sin(l), np.cos(p)])
    return up, east, north


def to_vectors(az, el, lat, lon):
    """Azimuth/elevation seen at (lat, lon) -> unit direction vectors, shape (T, 3)."""
    up, east, north = basis(lat, lon)
    a, e = np.radians(az)[:, None], np.radians(el)[:, None]
    return np.sin(e) * up + np.cos(e) * (np.cos(a) * north + np.sin(a) * east)


def to_az_el(vec, lat, lon):
    """Direction vectors (T, 3) -> azimuth/elevation in degrees seen at (lat, lon)."""
    up, east, north = basis(lat, lon)
    vec = vec / np.linalg.norm(vec, axis=1, keepdims=True)
    el = np.degrees(np.arcsin(np.clip(vec @ up, -1, 1)))
    az = np.degrees(np.arctan2(vec @ east, vec @ north)) % 360
    return az, el


class Sky:
    """Sun and Earth positions through the year, usable from any point on the Moon."""

    def __init__(self, eph, height_m=0.0):
        lat, lon = eph["lat"], eph["lon"]
        self.time_utc = eph["time_utc"]
        self.sun_dir = to_vectors(np.array(eph["sun_az"]), np.array(eph["sun_el"]), lat, lon)
        earth_dir = to_vectors(np.array(eph["earth_az"]), np.array(eph["earth_el"]), lat, lon)
        self.earth_pos = (R + height_m) * basis(lat, lon)[0] + EARTH_DIST * earth_dir

    def sun(self, lat, lon):
        return to_az_el(self.sun_dir, lat, lon)

    def earth(self, lat, lon, height_m=0.0):
        return to_az_el(self.earth_pos - (R + height_m) * basis(lat, lon)[0], lat, lon)


def load_sky():
    return Sky(json.loads((OUT_DIR / f"{REF_SITE}_ephemeris.json").read_text()))


def longest_false_run(flags):
    """Length of the longest run of False values in a boolean array."""
    edges = np.flatnonzero(np.diff(np.concatenate(([True], flags, [True])).astype(int)))
    return int((edges[1::2] - edges[::2]).max()) if len(edges) else 0


def point_exposure(dem, sky, lat, lon):
    """Exposure numbers for one point. lat/lon in degrees."""
    lat = max(lat, -89.9999)                      # azimuth is undefined exactly at the pole
    haz, hel, ground, _ = horizon_profile.horizon(dem, lat, lon)
    az, el = sky.sun(lat, lon)
    frac = sun_fraction(az, el, haz, hel)
    az, el = sky.earth(lat, lon, ground + MAST_M)
    earth = el > np.interp(az, haz, hel, period=360)
    return {"height_m": ground, "sun_pct": 100 * frac.mean(), "earth_pct": 100 * earth.mean(),
            "longest_dark_h": longest_false_run(frac > 0)}


def grid_lat_lon(x_m, y_m):
    """South polar stereographic map position (metres) -> lat/lon in degrees."""
    r = np.hypot(x_m, y_m)
    lat = -90 + np.degrees(2 * np.arctan(r / (2 * R)))
    lon = np.degrees(np.arctan2(x_m, y_m)) % 360
    return lat, lon


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    radius_km = float(sys.argv[2]) if len(sys.argv) > 2 else 150.0
    spacing_km = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0

    # coarser skyline settings than the per-site run, so the whole map is quick
    horizon_profile.AZ_STEP = AZ_STEP
    horizon_profile.MAX_DIST = MAX_DIST

    dem = Dem(sys.argv[1])
    sky = load_sky()
    half = int(radius_km // spacing_km)
    axis = np.arange(-half, half + 1) * spacing_km * 1000.0      # metres from the pole
    n = len(axis)
    keys = ("sun_pct", "earth_pct", "longest_dark_h", "height_m")
    grids = {k: [None] * (n * n) for k in keys}
    todo = [(j, i) for j in range(n) for i in range(n)
            if np.hypot(axis[i], axis[j]) <= radius_km * 1000.0]
    print(f"{len(todo)} points, {spacing_km:g} km apart, out to {radius_km:g} km from the pole")
    start = time.time()
    for done, (j, i) in enumerate(todo, 1):
        lat, lon = grid_lat_lon(axis[i], axis[j])
        res = point_exposure(dem, sky, float(lat), float(lon))
        grids["sun_pct"][j * n + i] = round(res["sun_pct"], 1)
        grids["earth_pct"][j * n + i] = round(res["earth_pct"], 1)
        grids["longest_dark_h"][j * n + i] = res["longest_dark_h"]
        grids["height_m"][j * n + i] = round(res["height_m"])
        if done % 500 == 0 or done == len(todo):
            rate = done / (time.time() - start)
            print(f"  {done}/{len(todo)}  about {(len(todo) - done) / rate / 60:.1f} min left")

    out = {
        "about": "Grid on a south polar stereographic map. Point (i, j) sits at "
                 "x = x0_km + i * spacing_km, y = y0_km + j * spacing_km, where "
                 "x = r sin(lon), y = r cos(lon) and r is the map distance from the pole. "
                 "Values are stored row by row: index = j * n + i. null = outside the map.",
        "radius_km": radius_km, "spacing_km": spacing_km, "n": n,
        "x0_km": float(axis[0] / 1000), "y0_km": float(axis[0] / 1000),
        "moon_radius_km": R / 1000, "mast_m": MAST_M,
        "period": [sky.time_utc[0], sky.time_utc[-1]],
        "terrain": True,
        **grids,
    }
    (OUT_DIR / "exposure_map.json").write_text(json.dumps(out))
    print("wrote", OUT_DIR / "exposure_map.json")


if __name__ == "__main__":
    main()
