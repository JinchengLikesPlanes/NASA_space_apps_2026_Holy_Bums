"""Map sunlight and Earth visibility over the whole Moon, treating it as a smooth ball.

Usage:  python global_map.py [step_deg]      step_deg: grid spacing in degrees (default 2)
Needs:  ../data/malapert_ephemeris.json  (from fetch_ephemeris.py). No LOLA files.
Output: ../data/global_map.json, read by the 3D page in ../web

This is the wide view that goes around the detailed south polar map made by
exposure_map.py. It uses the same Sun and Earth positions and the same visibility
rules, but with a flat horizon everywhere: hills and crater walls are ignored.
That is a fair picture for most of the Moon, where the Sun climbs high and terrain
changes the yearly totals only a little. It is not a fair picture near the poles,
where the Sun stays within a couple of degrees of the horizon and terrain decides
everything, which is why the south pole has its own terrain-based map.

For each grid cell it stores
    sun_pct         average share of the Sun's disc above the horizon over the year
    earth_pct       share of the year the Earth's centre is above the horizon
    longest_dark_h  longest unbroken stretch with no part of the Sun showing, hours
"""
import json
import sys
import time

import numpy as np

from compute_visibility import sun_fraction
from exposure_map import load_sky, longest_false_run
from fetch_ephemeris import OUT_DIR
from horizon_profile import MAST_M

FLAT_AZ = np.array([0.0, 180.0])      # a horizon at 0 degrees in every direction
FLAT_EL = np.array([0.0, 0.0])


def smooth_exposure(sky, lat, lon):
    """Exposure numbers for one point on a smooth Moon. lat/lon in degrees."""
    az, el = sky.sun(lat, lon)
    frac = sun_fraction(az, el, FLAT_AZ, FLAT_EL)
    _, earth_el = sky.earth(lat, lon, MAST_M)
    return {"sun_pct": 100 * frac.mean(), "earth_pct": 100 * (earth_el > 0).mean(),
            "longest_dark_h": longest_false_run(frac > 0)}


def main():
    step = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
    sky = load_sky()
    lats = np.arange(-90 + step / 2, 90, step)        # cell centres, south to north
    lons = np.arange(-180 + step / 2, 180, step)      # cell centres, west to east
    keys = ("sun_pct", "earth_pct", "longest_dark_h")
    grids = {k: [] for k in keys}
    print(f"{len(lats) * len(lons)} cells, {step:g} degrees apart")
    start = time.time()
    for lat in lats:
        for lon in lons:
            res = smooth_exposure(sky, float(lat), float(lon))
            grids["sun_pct"].append(round(res["sun_pct"], 1))
            grids["earth_pct"].append(round(res["earth_pct"], 1))
            grids["longest_dark_h"].append(res["longest_dark_h"])
    print(f"done in {time.time() - start:.0f} s")

    out = {
        "about": "Whole Moon as a smooth ball (terrain ignored). Cell (i, j) is centred at "
                 "lon = lon0_deg + i * step_deg (east positive), lat = lat0_deg + j * step_deg. "
                 "Values are stored row by row from the south: index = j * n_lon + i.",
        "step_deg": step, "n_lon": len(lons), "n_lat": len(lats),
        "lon0_deg": float(lons[0]), "lat0_deg": float(lats[0]),
        "period": [sky.time_utc[0], sky.time_utc[-1]],
        "terrain": False,
        **grids,
    }
    (OUT_DIR / "global_map.json").write_text(json.dumps(out))
    print("wrote", OUT_DIR / "global_map.json")


if __name__ == "__main__":
    main()
