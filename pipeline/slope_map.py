"""Measure how steep the ground is around each site, from the LOLA polar elevation grid.

Usage:  python slope_map.py path\\to\\LDEM_75S_120M.LBL
        (the matching .IMG file must sit next to the .LBL file)
Output: ../data/slope_summary.json  - slope numbers for every site in SITES
        ../data/<site_id>_slope.png - picture of the slope around the site
                                      (only if matplotlib is installed)

Method: slope is how fast the height changes as you move across the ground.
For every pixel, take the height difference between its left/right neighbours and
its up/down neighbours, divide by the ground distance between them, and convert
the combined steepness to an angle:  slope = atan(rise / run).

The neighbours are two pixels apart, so with the 120 m grid this is the slope over
a 240 m baseline. Craters and boulders smaller than that are smoothed away, so
treat these numbers as "the regional slope", not "is this exact spot flat".
"""
import json
import sys

import numpy as np

from fetch_ephemeris import SITES, OUT_DIR
from horizon_profile import Dem, R

ZONE_RADIUS_M = 1000.0    # landing zone: a circle of this radius around the site
SLOPE_LIMIT_DEG = 10.0    # steeper than this counts as unsafe for a lander
MAP_HALF_M = 10e3         # half-width of the slope picture saved for each site


def site_pixel(dem, lat, lon):
    """(row, col) of the grid pixel containing a site. Same maths as Dem.height."""
    m = dem.meta
    r = 2 * R * np.tan(np.radians(90 + lat) / 2)      # south polar stereographic
    lon = np.radians(lon)
    row = int(np.rint(m["l0"] - r * np.cos(lon) / m["pix"]))
    col = int(np.rint(m["s0"] + r * np.sin(lon) / m["pix"]))
    return row, col


def slope_window(dem, row, col, half_px):
    """Slope in degrees for the square of pixels within half_px of (row, col)."""
    m = dem.meta
    # one spare pixel on every side so each pixel we keep has both neighbours
    r0, r1 = row - half_px - 1, row + half_px + 2
    c0, c1 = col - half_px - 1, col + half_px + 2
    if r0 < 0 or c0 < 0 or r1 > m["lines"] or c1 > m["samples"]:
        raise ValueError("site is too close to the edge of the elevation grid")
    h = np.asarray(dem.grid[r0:r1, c0:c1], dtype=float) * dem.to_m
    rise_y, rise_x = np.gradient(h)                    # metres of height per pixel

    # The map projection stretches the ground slightly away from the pole, so a
    # pixel covers a little less than MAP_SCALE metres of real ground there.
    rows = np.arange(r0, r1)[:, None]
    cols = np.arange(c0, c1)[None, :]
    r_map = np.hypot(rows - m["l0"], cols - m["s0"]) * m["pix"]
    stretch = 1 + (r_map / (2 * R)) ** 2               # exactly 1 at the pole
    run = m["pix"] / stretch                           # ground metres per pixel

    slope = np.degrees(np.arctan(np.hypot(rise_x, rise_y) / run))
    return slope[1:-1, 1:-1]


def site_slope(dem, lat, lon):
    """Slope statistics for the landing zone, plus the slope picture window."""
    pix = dem.meta["pix"]
    row, col = site_pixel(dem, lat, lon)
    half = int(np.ceil(MAP_HALF_M / pix))
    window = slope_window(dem, row, col, half)

    offs = np.arange(-half, half + 1) * pix            # metres from the site
    dist = np.hypot(offs[:, None], offs[None, :])
    zone = window[dist <= ZONE_RADIUS_M]
    stats = {
        "slope_at_site_deg": round(float(window[half, half]), 2),
        "zone_mean_deg": round(float(zone.mean()), 2),
        "zone_median_deg": round(float(np.median(zone)), 2),
        "zone_p95_deg": round(float(np.percentile(zone, 95)), 2),
        "zone_max_deg": round(float(zone.max()), 2),
        "zone_safe_pct": round(float(100 * (zone < SLOPE_LIMIT_DEG).mean()), 1),
    }
    return stats, window


def save_picture(path, window, name, pix):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    half_km = (window.shape[0] // 2) * pix / 1000
    fig, ax = plt.subplots(figsize=(6, 5))
    im = ax.imshow(window, cmap="inferno", vmin=0, vmax=30,
                   extent=[-half_km, half_km, -half_km, half_km])
    ax.add_patch(plt.Circle((0, 0), ZONE_RADIUS_M / 1000, fill=False, color="cyan", lw=1.5))
    ax.plot(0, 0, "c+", ms=10)
    ax.set_title(f"{name}: slope (cyan = {ZONE_RADIUS_M / 1000:g} km landing zone)")
    ax.set_xlabel("km")
    ax.set_ylabel("km")
    fig.colorbar(im, label="slope (degrees)")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return True


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    dem = Dem(sys.argv[1])
    pix = dem.meta["pix"]
    print("grid", dem.grid.shape, "pixel", pix, "m")
    OUT_DIR.mkdir(exist_ok=True)
    summary = []
    for site_id, (name, lat, lon) in SITES.items():
        stats, window = site_slope(dem, lat, lon)
        row = {"id": site_id, "name": name, "lat": lat, "lon": lon,
               "baseline_m": 2 * pix, "zone_radius_m": ZONE_RADIUS_M,
               "slope_limit_deg": SLOPE_LIMIT_DEG, **stats}
        summary.append(row)
        drew = save_picture(OUT_DIR / f"{site_id}_slope.png", window, name, pix)
        print(f"{site_id}: at site {stats['slope_at_site_deg']} deg, zone mean "
              f"{stats['zone_mean_deg']} deg, {stats['zone_safe_pct']}% under "
              f"{SLOPE_LIMIT_DEG:g} deg" + ("" if drew else "  (no picture: matplotlib missing)"))
    (OUT_DIR / "slope_summary.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
