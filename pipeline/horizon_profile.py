"""Compute the terrain horizon around each site from LOLA polar elevation grids.

Usage:  python horizon_profile.py COARSE.LBL [FINE.LBL]
        COARSE - wide grid for distant terrain, e.g. LDEM_75S_120M.LBL
        FINE   - optional detailed grid for terrain close to the site, e.g. LDEM_80S_20M.LBL
        (each matching .IMG file must sit next to its .LBL file)
Output: ../data/<site_id>_horizon.json with
        azimuth_deg  - directions, clockwise from north (0 = north, 90 = east)
        horizon_deg  - elevation angle of the terrain skyline in each direction
        slope_deg    - how steep the ground is at the site itself

Method: from the site, walk outward along each azimuth on the sphere, look up the
terrain height at each step, and keep the largest elevation angle seen. With two
grids, the first NEAR_DIST metres use the fine grid and everything beyond uses the
coarse grid. Where the fine grid has no coverage the coarse grid is used instead.
"""
import json
import pathlib
import re
import sys

import numpy as np

from fetch_ephemeris import SITES, OUT_DIR

R = 1737400.0        # lunar reference radius, metres
MAST_M = 2.0         # height of the solar panel / antenna above the ground
AZ_STEP = 0.1        # degrees between rays (the Sun is 0.53 degrees wide)
MAX_DIST = 300e3     # how far out to look, metres
NEAR_DIST = 15e3     # with two grids: the fine grid is used out to this distance
BIG_FILE = 600e6     # grids larger than this many bytes are read from disk piece by piece


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
        self.name = lbl.stem
        img = next((p for p in (lbl.with_suffix(".IMG"), lbl.with_suffix(".img")) if p.exists()), None)
        if img is None:
            raise FileNotFoundError(f"no .IMG file next to {lbl}")
        shape = (m["lines"], m["samples"])
        if img.stat().st_size > BIG_FILE:
            self.grid = np.memmap(img, dtype=m["dtype"], mode="r", shape=shape)
        else:
            self.grid = np.fromfile(img, dtype=m["dtype"]).reshape(shape)
        self.to_m = m["scale"] * (1000.0 if m["unit_km"] else 1.0)

    def crop(self, lat, lon, radius_m):
        """A small in-memory copy of the grid around one site, or None if not covered."""
        row, col = self.rowcol(lat, lon)
        n = int(radius_m / self.meta["pix"]) + 4
        r, c = int(round(float(row))), int(round(float(col)))
        if not (2 <= r < self.meta["lines"] - 2 and 2 <= c < self.meta["samples"] - 2):
            return None
        r0, r1 = max(r - n, 0), min(r + n, self.meta["lines"])
        c0, c1 = max(c - n, 0), min(c + n, self.meta["samples"])
        small = object.__new__(Dem)
        small.name, small.to_m = self.name, self.to_m
        small.grid = np.array(self.grid[r0:r1, c0:c1])
        small.meta = dict(self.meta, lines=r1 - r0, samples=c1 - c0,
                          l0=self.meta["l0"] - r0, s0=self.meta["s0"] - c0)
        return small

    def covers(self, lat, lon):
        """True if the point lies inside this grid."""
        row, col = self.rowcol(lat, lon)
        return bool(np.isfinite(row) and np.isfinite(col)
                    and 2 <= row < self.meta["lines"] - 2 and 2 <= col < self.meta["samples"] - 2)

    def rowcol(self, lat_deg, lon_deg):
        """Fractional (row, column) of a latitude/longitude in the grid."""
        m = self.meta
        r = 2 * R * np.tan(np.radians(90 + np.asarray(lat_deg, float)) / 2)   # south polar stereographic
        lon = np.radians(lon_deg)
        return m["l0"] - r * np.cos(lon) / m["pix"], m["s0"] + r * np.sin(lon) / m["pix"]

    def latlon(self, row, col):
        m = self.meta
        x, y = (col - m["s0"]) * m["pix"], (m["l0"] - row) * m["pix"]
        lat = -90 + np.degrees(2 * np.arctan(np.hypot(x, y) / (2 * R)))
        return lat, np.degrees(np.arctan2(x, y)) % 360

    def height(self, lat_deg, lon_deg):
        """Terrain height in metres above the 1737.4 km sphere.

        Blends the four surrounding pixels (bilinear interpolation) so the surface is
        smooth between pixel centres. Points outside the grid return a very low value.
        """
        row, col = self.rowcol(lat_deg, lon_deg)
        r0, c0 = np.floor(row).astype(int), np.floor(col).astype(int)
        ok = (r0 >= 0) & (r0 < self.meta["lines"] - 1) & (c0 >= 0) & (c0 < self.meta["samples"] - 1)
        r0, c0 = np.where(ok, r0, 0), np.where(ok, c0, 0)
        fr, fc = row - r0, col - c0
        g = self.grid
        h = (g[r0, c0] * (1 - fr) * (1 - fc) + g[r0, c0 + 1] * (1 - fr) * fc
             + g[r0 + 1, c0] * fr * (1 - fc) + g[r0 + 1, c0 + 1] * fr * fc) * self.to_m
        return np.where(ok, h, -1e9)

    def slope(self, lat, lon):
        """Ground slope at a point in degrees, from the heights of neighbouring pixels."""
        row, col = self.rowcol(lat, lon)
        r, c = int(round(float(row))), int(round(float(col)))
        g, d = self.grid, 2 * self.meta["pix"]
        dzdx = (float(g[r, c + 1]) - float(g[r, c - 1])) * self.to_m / d
        dzdy = (float(g[r - 1, c]) - float(g[r + 1, c])) * self.to_m / d
        return float(np.degrees(np.arctan(np.hypot(dzdx, dzdy))))


def _steps(lo, hi, pix):
    """Distances to sample between lo and hi: finer close in, coarser far out."""
    a = np.arange(max(lo, pix / 2), min(hi, 2e3), pix / 2)
    b = np.arange(max(lo, 2e3), min(hi, 20e3), pix)
    c = np.arange(max(lo, 20e3), hi, 2 * pix)
    return np.concatenate([a, b, c])


def horizon(dem, lat, lon, mast=MAST_M, fine=None):
    """Skyline around a site. Returns (azimuths, horizon angles, ground height, Dem used at site)."""
    lat = max(lat, -89.9999)                 # azimuth is undefined exactly at the pole
    local = fine.crop(lat, lon, NEAR_DIST) if fine is not None else None
    if local is not None:
        zones = [(local, _steps(0, NEAR_DIST, local.meta["pix"])),
                 (dem, _steps(NEAR_DIST, MAX_DIST, dem.meta["pix"]))]
    else:
        zones = [(dem, _steps(0, MAX_DIST, dem.meta["pix"]))]
    site_dem = local or dem
    h_obs = float(site_dem.height(np.array([lat]), np.array([lon]))[0]) + mast

    az = np.arange(0, 360, AZ_STEP)
    p1, l1 = np.radians(lat), np.radians(lon)
    out = np.full(len(az), -90.0)
    for grid, dist in zones:
        theta = dist[None, :] / R            # angle at the Moon's centre
        for start in range(0, len(az), 200):     # batches keep memory use small
            a = np.radians(az[start:start + 200])[:, None]
            sin_p2 = np.sin(p1) * np.cos(theta) + np.cos(p1) * np.sin(theta) * np.cos(a)
            p2 = np.degrees(np.arcsin(np.clip(sin_p2, -1, 1)))
            l2 = np.degrees(l1 + np.arctan2(np.sin(a) * np.sin(theta) * np.cos(p1),
                                            np.cos(theta) - np.sin(p1) * sin_p2))
            h = grid.height(p2, l2)
            if grid is not dem:              # gaps in the fine grid fall back to the coarse one
                gap = h < -1e8
                if gap.any():
                    h[gap] = dem.height(p2[gap], l2[gap])
            up = (R + h) * np.cos(theta) - (R + h_obs)
            along = (R + h) * np.sin(theta)
            best = np.degrees(np.arctan2(up, along)).max(axis=1)
            out[start:start + 200] = np.maximum(out[start:start + 200], best)
    return az, out, h_obs - mast, site_dem


def build(dem, fine, site_id, name, lat, lon):
    """Everything saved in <site>_horizon.json for one site, as a dictionary.

    A site outside the coarse grid has no terrain data, so it gets a smooth horizon:
    the edge of a perfectly round Moon seen from mast height. It is labelled "smooth".
    """
    out = {"id": site_id, "name": name, "lat": lat, "lon": lon, "mast_m": MAST_M}
    if not dem.covers(max(lat, -89.9999), lon):
        az = np.arange(0, 360, AZ_STEP)
        dip = -float(np.degrees(np.arccos(R / (R + MAST_M))))
        out.update(terrain="smooth", ground_height_m=None, slope_deg=None,
                   azimuth_deg=np.round(az, 2).tolist(), horizon_deg=[round(dip, 3)] * len(az))
        return out
    az, hz, ground, site_dem = horizon(dem, lat, lon, fine=fine)
    slope = site_dem.slope(max(lat, -89.9999), lon)
    out.update(terrain="lola", ground_height_m=round(ground, 1), slope_deg=round(slope, 1),
               slope_baseline_m=2 * site_dem.meta["pix"], near_grid=site_dem.name, far_grid=dem.name,
               azimuth_deg=np.round(az, 2).tolist(), horizon_deg=np.round(hz, 3).tolist())
    return out


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    dem = Dem(sys.argv[1])
    fine = Dem(sys.argv[2]) if len(sys.argv) == 3 else None
    print("coarse grid", dem.name, dem.grid.shape, "pixel", dem.meta["pix"], "m")
    if fine is not None:
        print("fine grid  ", fine.name, fine.grid.shape, "pixel", fine.meta["pix"],
              "m, used within", NEAR_DIST / 1000, "km of each site")
    print("rays every", AZ_STEP, "deg")
    OUT_DIR.mkdir(exist_ok=True)
    for site_id, (name, lat, lon) in SITES.items():
        out = build(dem, fine, site_id, name, lat, lon)
        (OUT_DIR / f"{site_id}_horizon.json").write_text(json.dumps(out))
        hz = out["horizon_deg"]
        if out["terrain"] == "smooth":
            print(f"{site_id}: outside the elevation grid, smooth horizon at {hz[0]:.2f} deg")
        else:
            note = "" if fine is None or out["near_grid"] != dem.name else "  (outside the fine grid: coarse only)"
            print(f"{site_id}: ground {out['ground_height_m']:.0f} m, slope {out['slope_deg']:.1f} deg, "
                  f"horizon {min(hz):.2f} to {max(hz):.2f} deg{note}")


if __name__ == "__main__":
    main()
