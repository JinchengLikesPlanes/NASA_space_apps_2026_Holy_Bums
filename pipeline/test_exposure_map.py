"""Check exposure_map.py's sky-position shortcut against the real JPL data.

Usage:  python test_exposure_map.py
No LOLA download needed. exposure_map.py works out Sun and Earth positions for
any point from the Malapert ephemeris alone. Here we ask it for the other sites
and compare with what JPL Horizons actually returned for them.
"""
import json

import numpy as np

from exposure_map import grid_lat_lon, load_sky, longest_false_run
from fetch_ephemeris import SITES, OUT_DIR
from horizon_profile import R


def main():
    sky = load_sky()
    wrap = lambda d: (d + 180) % 360 - 180
    for site_id in SITES:
        eph = json.loads((OUT_DIR / f"{site_id}_ephemeris.json").read_text())
        lat, lon = max(eph["lat"], -89.9999), eph["lon"]
        worst = 0.0
        for body, (az, el) in (("sun", sky.sun(lat, lon)), ("earth", sky.earth(lat, lon))):
            worst = max(worst, np.abs(el - np.array(eph[f"{body}_el"])).max(),
                        np.abs(wrap(az - np.array(eph[f"{body}_az"]))).max())
        print(f"{site_id}: largest difference from JPL {worst:.4f} deg")
        assert worst < 0.01, site_id

    # helpers
    assert longest_false_run(np.array([True, False, False, True, False])) == 2
    assert longest_false_run(np.array([True, True])) == 0
    assert longest_false_run(np.array([False, False, False])) == 3
    lat, lon = grid_lat_lon(0.0, 2 * R * np.tan(np.radians(1.0) / 2))   # 1 degree from the pole, towards lon 0
    assert abs(lat + 89) < 1e-9 and abs(lon) < 1e-9
    lat, lon = grid_lat_lon(1000.0, 0.0)                                 # +x is longitude 90 east
    assert abs(lon - 90) < 1e-9
    # smooth-Moon values used for the whole-Moon map: known answers away from the poles
    from global_map import smooth_exposure
    near, far = smooth_exposure(sky, 0.0, 0.0), smooth_exposure(sky, 0.0, 180.0)
    assert near["earth_pct"] == 100 and far["earth_pct"] == 0          # Earth never sets / never rises
    assert 45 < near["sun_pct"] < 55 and 45 < far["sun_pct"] < 55         # day and night are about equal
    assert 340 < near["longest_dark_h"] < 370                           # a night is about 14.8 Earth days
    print("all exposure checks passed")


if __name__ == "__main__":
    main()
