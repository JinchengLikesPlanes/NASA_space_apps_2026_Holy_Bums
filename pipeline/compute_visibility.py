"""Combine ephemeris + horizon into visibility flags and summary metrics.

Usage:  python compute_visibility.py
Needs:  ../data/<site>_ephemeris.json and ../data/<site>_horizon.json
Output: ../data/<site>_visibility.json and ../data/summary.json

The Sun counts as visible when its centre is above the terrain (the real Sun is a
0.53 degree disc, so this is "at least half the Sun").
"""
import json

import numpy as np

from fetch_ephemeris import SITES, OUT_DIR


def longest_run_hours(flags_false_is_dark):
    best = run = 0
    for v in flags_false_is_dark:
        run = 0 if v else run + 1
        best = max(best, run)
    return best


def main():
    summary = []
    for site_id, (name, lat, lon) in SITES.items():
        eph = json.loads((OUT_DIR / f"{site_id}_ephemeris.json").read_text())
        hor = json.loads((OUT_DIR / f"{site_id}_horizon.json").read_text())
        haz, hel = np.array(hor["azimuth_deg"]), np.array(hor["horizon_deg"])
        vis = {}
        for body in ("sun", "earth"):
            az, el = np.array(eph[f"{body}_az"]), np.array(eph[f"{body}_el"])
            terrain = np.interp(az % 360, haz, hel, period=360)
            vis[body] = el > terrain
        both = vis["sun"] & vis["earth"]

        # convention check: near the pole, Earth should hover around azimuth = -longitude
        e = np.radians(eph["earth_az"])
        mean_az = np.degrees(np.arctan2(np.sin(e).mean(), np.cos(e).mean())) % 360
        row = {
            "id": site_id, "name": name, "lat": lat, "lon": lon,
            "sun_pct": round(float(100 * vis["sun"].mean()), 1),
            "earth_pct": round(float(100 * vis["earth"].mean()), 1),
            "both_pct": round(float(100 * both.mean()), 1),
            "longest_dark_h": longest_run_hours(vis["sun"]),
            "longest_no_comm_h": longest_run_hours(vis["earth"]),
        }
        summary.append(row)
        (OUT_DIR / f"{site_id}_visibility.json").write_text(json.dumps({
            "id": site_id, "time_utc": eph["time_utc"],
            "sun_visible": vis["sun"].astype(int).tolist(),
            "earth_visible": vis["earth"].astype(int).tolist()}))
        print(row)
        print(f"   check: mean Earth azimuth {mean_az:.0f} deg, expected roughly {(-lon) % 360:.0f}")
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()