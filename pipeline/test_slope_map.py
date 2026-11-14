"""Check slope_map.py against made-up terrain where the right answer is known.

Usage:  python test_slope_map.py
No LOLA download needed: it builds a small fake elevation grid in a temp folder.
"""
import pathlib
import tempfile

import numpy as np

from horizon_profile import Dem
from slope_map import site_pixel, site_slope, slope_window

N, OFFSET = 800, 399.5
LABEL = """LINES = {n}
LINE_SAMPLES = {n}
SAMPLE_TYPE = PC_REAL
SAMPLE_BITS = 32
SCALING_FACTOR = 1.0
UNIT = METER
MAP_SCALE = {pix} <METER/PIXEL>
LINE_PROJECTION_OFFSET = {offset}
SAMPLE_PROJECTION_OFFSET = {offset}
"""


def make_dem(folder, height_m, pix=120.0):
    """Write a fake .LBL/.IMG pair holding the given heights (metres) and open it."""
    lbl = pathlib.Path(folder) / "FAKE.LBL"
    lbl.write_text(LABEL.format(n=N, pix=pix, offset=OFFSET))
    height_m.astype("<f4").tofile(lbl.with_suffix(".IMG"))
    return Dem(lbl)


def tilted(tilt_deg, pix=120.0):
    """Heights of a plane that rises tilt_deg along the grid's sample direction."""
    cols = np.arange(N)[None, :] * np.ones((N, 1))
    return np.tan(np.radians(tilt_deg)) * (cols - OFFSET) * pix


def main():
    with tempfile.TemporaryDirectory() as tmp:
        # 1. flat ground has zero slope everywhere
        dem = make_dem(tmp, np.zeros((N, N)))
        stats, _ = site_slope(dem, -89.45, 222.69)
        assert stats["zone_max_deg"] == 0 and stats["zone_safe_pct"] == 100, stats
        del dem

        # 2. a plane tilted by 10 degrees reads as 10 degrees at the pole
        dem = make_dem(tmp, tilted(10))
        stats, _ = site_slope(dem, -90.0, 0.0)
        assert abs(stats["zone_mean_deg"] - 10) < 0.01, stats
        assert abs(stats["zone_max_deg"] - 10) < 0.01, stats
        del dem

        # 3. away from the pole the map is stretched, so the same grid tilt is a
        #    slightly steeper real slope: atan(tan(10 deg) * stretch).
        #    Uses 1 km pixels so the small fake grid reaches 86 S.
        lat, lon = -86.0, 30.0
        dem = make_dem(tmp, tilted(10, pix=1000.0), pix=1000.0)
        stretch = 1 + np.tan(np.radians(90 + lat) / 2) ** 2
        want = np.degrees(np.arctan(np.tan(np.radians(10)) * stretch))
        row, col = site_pixel(dem, lat, lon)
        got = slope_window(dem, row, col, 0)[0, 0]
        assert abs(got - want) < 0.002, (got, want)
        assert want - 10 > 0.01                    # the correction is real, if small
        del dem

        # 4. 5 degree plane is all safe, 15 degree plane is all unsafe
        for tilt, safe in ((5, 100), (15, 0)):
            dem = make_dem(tmp, tilted(tilt))
            stats, _ = site_slope(dem, -89.45, 222.69)
            assert stats["zone_safe_pct"] == safe, (tilt, stats)
            del dem

        # 5. site_pixel lands on the same pixel that Dem.height reads
        h = np.zeros((N, N))
        for lat, lon in ((-89.45, 222.69), (-89.0, 2.93), (-88.8, 135.0)):
            dem = make_dem(tmp, h)
            row, col = site_pixel(dem, lat, lon)
            del dem
            spike = h.copy()
            spike[row, col] = 500.0
            dem = make_dem(tmp, spike)
            assert dem.height(np.array([lat]), np.array([lon]))[0] == 500.0, (lat, lon)
            del dem
    print("all slope checks passed")


if __name__ == "__main__":
    main()
