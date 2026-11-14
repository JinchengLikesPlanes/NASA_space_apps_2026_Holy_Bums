"""Combine ephemeris + horizon into visibility, solar power and summary metrics.

Usage:  python compute_visibility.py
Needs:  ../data/<site>_ephemeris.json and ../data/<site>_horizon.json
Output: ../data/<site>_visibility.json and ../data/summary.json

Sun:   treated as a disc 0.53 degrees wide. sun_fraction is the share of the disc
       above the terrain (0 = dark, 1 = full Sun, in between = partial sunrise/sunset).
Earth: counted as visible when its centre is above the terrain.
Power: watts per square metre of panel = SOLAR_CONSTANT x EFFICIENCY x cos(angle between
       Sun and panel face) x sun_fraction, for three kinds of panel:
         track - vertical panel that rotates to face the Sun
         fixed - vertical panel facing one compass direction (the best one is found per site)
         flat  - panel lying flat on the ground
"""
import json

import numpy as np

from fetch_ephemeris import SITES, OUT_DIR

SOLAR_CONSTANT = 1361.0   # W/m2 of sunlight at the Moon (no atmosphere to weaken it)
EFFICIENCY = 0.30         # fraction of sunlight a panel turns into electricity
SUN_RADIUS_DEG = 0.2665   # the Sun's apparent radius seen from the Moon
STRIPS = 21               # vertical slices used to measure how much of the disc is hidden


def sun_fraction(az, el, haz, hel):
    """Share of the Sun's disc above the terrain skyline, for every hour."""
    r = SUN_RADIUS_DEG
    x = np.linspace(-r, r, STRIPS + 2)[1:-1]          # slice positions across the disc
    half = np.sqrt(r * r - x * x)                      # half-height of each slice
    cos_el = np.maximum(np.cos(np.radians(el)), 0.05)
    slice_az = (az[:, None] + x[None, :] / cos_el[:, None]) % 360
    terrain = np.interp(slice_az, haz, hel, period=360)
    shown = np.clip((el[:, None] + half - terrain) / (2 * half), 0, 1)
    return (shown * half).sum(axis=1) / half.sum()


def longest_run_hours(mask):
    """Longest unbroken stretch of True values, in hours (one sample per hour)."""
    best = run = 0
    for v in mask:
        run = run + 1 if v else 0
        best = max(best, run)
    return best


def process_site(site_id, name, lat, lon, quiet=False):
    """Compute visibility and power for one site, write its file, and return its summary row."""
    eph = json.loads((OUT_DIR / f"{site_id}_ephemeris.json").read_text())
    hor = json.loads((OUT_DIR / f"{site_id}_horizon.json").read_text())
    haz, hel = np.array(hor["azimuth_deg"]), np.array(hor["horizon_deg"])

    s_az, s_el = np.array(eph["sun_az"]), np.array(eph["sun_el"])
    e_az, e_el = np.array(eph["earth_az"]), np.array(eph["earth_el"])
    frac = sun_fraction(s_az, s_el, haz, hel)
    earth = e_el > np.interp(e_az % 360, haz, hel, period=360)
    sun_any = frac > 0

    # solar power for the three panel types
    full = SOLAR_CONSTANT * EFFICIENCY * frac
    el_r, az_r = np.radians(s_el), np.radians(s_az)
    p_track = full * np.cos(el_r)
    p_flat = full * np.clip(np.sin(el_r), 0, None)
    best_az, p_fixed = 0, None
    for face in range(0, 360, 5):                  # try every facing direction
        p = full * np.clip(np.cos(el_r) * np.cos(az_r - np.radians(face)), 0, None)
        if p_fixed is None or p.mean() > p_fixed.mean():
            best_az, p_fixed = face, p

    # convention check: near the pole, Earth should hover around azimuth = -longitude
    e = np.radians(e_az)
    mean_az = np.degrees(np.arctan2(np.sin(e).mean(), np.cos(e).mean())) % 360

    row = {
        "id": site_id, "name": name, "lat": lat, "lon": lon,
        "sun_pct": round(float(100 * frac.mean()), 1),
        "earth_pct": round(float(100 * earth.mean()), 1),
        "both_pct": round(float(100 * (frac * earth).mean()), 1),
        "longest_dark_h": longest_run_hours(~sun_any),
        "longest_no_comm_h": longest_run_hours(~earth),
        "terrain": hor.get("terrain", "lola"),
        "slope_deg": hor.get("slope_deg"),
        "ground_height_m": hor.get("ground_height_m"),
        "max_sun_elevation_deg": round(float(s_el.max()), 2),
        "avg_power_track_w_m2": round(float(p_track.mean()), 1),
        "avg_power_fixed_w_m2": round(float(p_fixed.mean()), 1),
        "fixed_panel_best_az_deg": best_az,
        "avg_power_flat_w_m2": round(float(p_flat.mean()), 1),
    }
    (OUT_DIR / f"{site_id}_visibility.json").write_text(json.dumps({
        "id": site_id, "time_utc": eph["time_utc"],
        "sun_fraction": np.round(frac, 2).tolist(),
        "earth_visible": earth.astype(int).tolist(),
        "power_track_w_m2": np.round(p_track, 1).tolist(),
        "power_fixed_w_m2": np.round(p_fixed, 1).tolist(),
        "power_flat_w_m2": np.round(p_flat, 1).tolist()}))

    if quiet:
        return row
    print(f"{name}")
    print(f"   sunlight {row['sun_pct']}%   Earth {row['earth_pct']}%   both {row['both_pct']}%"
          f"   longest dark {row['longest_dark_h']} h   longest no-comm {row['longest_no_comm_h']} h")
    print(f"   average power, W per m2 of panel:  tracking {row['avg_power_track_w_m2']}"
          f"   fixed (facing {best_az} deg) {row['avg_power_fixed_w_m2']}"
          f"   flat {row['avg_power_flat_w_m2']}")
    print(f"   check: mean Earth azimuth {mean_az:.0f} deg, expected roughly {(-lon) % 360:.0f}")
    return row


def main():
    summary = [process_site(site_id, name, lat, lon) for site_id, (name, lat, lon) in SITES.items()]
    (OUT_DIR / "summary.json").write_text(json.dumps(summary, indent=1))
    print("wrote", OUT_DIR / "summary.json")


if __name__ == "__main__":
    main()
