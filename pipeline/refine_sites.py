"""Find the highest ground near each site, to replace approximate coordinates.

Usage:  python refine_sites.py GRID.LBL [search_radius_m]
        GRID - use the finest grid you have, e.g. LDEM_80S_20M.LBL
        (default search radius: 1500 m)

Prints a ready-to-paste SITES block. Nothing is changed automatically: review the
moves, paste the lines you want into fetch_ephemeris.py, then rerun all three scripts.
Sites whose id contains "pole", "floor" or "crater" are left where they are.
"""
import sys

import numpy as np

from fetch_ephemeris import SITES
from horizon_profile import Dem, R

KEEP = ("pole", "floor", "crater")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    dem = Dem(sys.argv[1])
    radius = float(sys.argv[2]) if len(sys.argv) > 2 else 1500.0
    n = int(np.ceil(radius / dem.meta["pix"]))
    print(f"searching within {radius:.0f} m of each site\n")
    lines = []
    for site_id, (name, lat, lon) in SITES.items():
        new_lat, new_lon = lat, lon
        if not any(k in site_id for k in KEEP):
            row, col = dem.rowcol(max(lat, -89.9999), lon)
            r, c = int(round(float(row))), int(round(float(col)))
            if not (n + 2 <= r < dem.meta["lines"] - n - 2 and n + 2 <= c < dem.meta["samples"] - n - 2):
                print(f"{site_id}: outside this grid, kept as is")
                lines.append(f'    "{site_id}": ("{name}", {lat}, {lon}),')
                continue
            rr, cc = np.mgrid[r - n:r + n + 1, c - n:c + n + 1]
            inside = np.hypot(rr - r, cc - c) * dem.meta["pix"] <= radius
            h = np.where(inside, dem.grid[rr, cc], -32768)
            i = np.unravel_index(h.argmax(), h.shape)
            moved = float(np.hypot(rr[i] - r, cc[i] - c) * dem.meta["pix"])
            gain = (float(h[i]) - float(dem.grid[r, c])) * dem.to_m
            if gain <= 0:
                print(f"{site_id}: already the highest point nearby, kept as is")
            else:
                la, lo = dem.latlon(float(rr[i]), float(cc[i]))
                new_lat, new_lon = round(float(la), 4), round(float(lo), 4)
                print(f"{site_id}: move {moved:.0f} m to gain {gain:.0f} m of height, "
                      f"slope there {dem.slope(new_lat, new_lon):.1f} deg")
        else:
            print(f"{site_id}: kept as is")
        lines.append(f'    "{site_id}": ("{name}", {new_lat}, {new_lon}),')
    print("\nSITES = {\n" + "\n".join(lines) + "\n}")


if __name__ == "__main__":
    main()
