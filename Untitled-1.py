"""Compute the terrain horizon around each site from a LOLA polar elevation grid.

Usage:  python horizon_profile.py path\\to\\LDEM_75S_120M.LBL
        (the matching .IMG file must sit next to the .LBL file)
Output: ../data/<site_id>_horizon.json with
        azimuth_deg  - directions, clockwise from north (0 = north, 90 = east)
        horizon_deg  - elevation angle of the terrain skyline in each direction

Method: from the site, walk outward along each azimuth on the sphere, look up the
terrain height at each step, and keep the largest elevation angle seen.
"""
import json
import pathlib
import re
import sys

import numpy as np

from fetch_ephemeris import SITES, OUT_DIR

R = 1737400.0        # lunar reference radius, metres
MAST_M = 2.0         # height of the solar panel / antenna above the ground
AZ_STEP = 0.5        # degrees between rays
MAX_DIST = 300e3     # how far out to look, metres


def read_label(lbl_path):
    text = pathlib.Path(lbl_path).read_text(errors="ignore")

    def num(key, default=None):
        m = re.search(rf"^\s*{key}\s*=\s*([-+0-9.eE]+)", text, re.M)
        if m:
            return float(m.group(1))
        if default is None:
            raise KeyError(f"{key} not found in {lbl_path}")
        return default

    stype = re.search(r"SAMPLE_TYPE\s*=\s*(\w+)", text).group(1)
    bits = int(num("SAMPLE_BITS"))
    if "REAL" in stype:
        dtype = "<f4"
    else:
        dtype = ("<" if "LSB" in stype or "PC" in stype else ">") + f"i{bits // 8}"
    return {
        "lines": int(num("LINES")),
        "samples": int(num("LINE_SAMPLES")),
        "scale": num("SCALING_FACTOR", 1.0),      # metres per data unit
        "offset_is_radius": True,
        "pix": num("MAP_SCALE"),                   # metres per pixel
        "l0": num("LINE_PROJECTION_OFFSET"),
        "s0": num("SAMPLE_PROJECTION_OFFSET"),
        "dtype": dtype,
        "unit_km": bool(re.search(r"^\s*UNIT\s*=\s*\"?KILOMETER", text, re.M)),
    }


class Dem:
    def __init__(self, lbl_path):
        self.meta = m = read_label(lbl_path)
        lbl = pathlib.Path(lbl_path)
        img = next((p for p in (lbl.with_suffix(".IMG"), lbl.with_suffix(".img")) if p.exists()), None)
        if img is None:
            raise FileNotFoundError(f"no .IMG file next to {lbl}")
        self.grid = np.memmap(img, dtype=m["dtype"], mode="r", shape=(m["lines"], m["samples"]))
        self.to_m = m["scale"] * (1000.0 if m["unit_km"] else 1.0)

    def height(self, lat_deg, lon_deg):
        """Terrain height in metres above the 1737.4 km sphere (nearest pixel)."""
        m = self.meta
        r = 2 * R * np.tan(np.radians(90 + lat_deg) / 2)   # south polar stereographic
        lon = np.radians(lon_deg)
        col = np.rint(m["s0"] + r * np.sin(lon) / m["pix"]).astype(int)
        row = np.rint(m["l0"] - r * np.cos(lon) / m["pix"]).astype(int)
        ok = (row >= 0) & (row < m["lines"]) & (col >= 0) & (col < m["samples"])
        h = np.full(np.shape(row), -1e9)
        h[ok] = self.grid[row[ok], col[ok]] * self.to_m
        return h


def horizon(dem, lat, lon, mast=MAST_M):
    lat = max(lat, -89.9999)                 # azimuth is undefined exactly at the pole
    pix = dem.meta["pix"]
    near = np.arange(pix, 20e3, pix)
    far = np.arange(20e3, MAX_DIST, 2 * pix)
    dist = np.concatenate([near, far])
    az = np.arange(0, 360, AZ_STEP)

    theta = dist[None, :] / R                # angle at the Moon's centre
    a = np.radians(az)[:, None]
    p1, l1 = np.radians(lat), np.radians(lon)
    sin_p2 = np.sin(p1) * np.cos(theta) + np.cos(p1) * np.sin(theta) * np.cos(a)
    p2 = np.arcsin(np.clip(sin_p2, -1, 1))
    l2 = l1 + np.arctan2(np.sin(a) * np.sin(theta) * np.cos(p1),
                         np.cos(theta) - np.sin(p1) * sin_p2)

    h_obs = float(dem.height(np.array([lat]), np.array([lon]))[0]) + mast
    h = dem.height(np.degrees(p2), np.degrees(l2))
    up = (R + h) * np.cos(theta) - (R + h_obs)
    along = (R + h) * np.sin(theta)
    elev = np.degrees(np.arctan2(up, along))
    return az, elev.max(axis=1), h_obs - mast


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dem = Dem(sys.argv[1])
    print("grid", dem.grid.shape, "pixel", dem.meta["pix"], "m")
    OUT_DIR.mkdir(exist_ok=True)
    for site_id, (name, lat, lon) in SITES.items():
        az, hz, ground = horizon(dem, lat, lon)
        out = {"id": site_id, "name": name, "lat": lat, "lon": lon,
               "ground_height_m": round(ground, 1), "mast_m": MAST_M,
               "azimuth_deg": az.tolist(), "horizon_deg": np.round(hz, 3).tolist()}
        (OUT_DIR / f"{site_id}_horizon.json").write_text(json.dumps(out))
        print(f"{site_id}: ground {ground:.0f} m, horizon {hz.min():.2f} to {hz.max():.2f} deg")


if __name__ == "__main__":
    main()