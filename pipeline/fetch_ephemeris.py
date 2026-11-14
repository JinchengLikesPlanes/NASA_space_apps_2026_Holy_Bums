"""Fetch hourly Sun and Earth azimuth/elevation for lunar surface sites from JPL Horizons.

Usage:  python fetch_ephemeris.py
Output: ../data/<site_id>_ephemeris.json for every site in SITES.

Angles ignore terrain: elevation is measured from the ideal (smooth-sphere) horizon.
Compare it with the terrain horizon profile to decide whether the Sun/Earth is visible.
"""
import json
import pathlib
import time

import requests

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
OUT_DIR = pathlib.Path(__file__).resolve().parent.parent / "data"

# id: (name, latitude deg, east longitude deg). APPROXIMATE - verify before the demo.
SITES = {
    "shackleton_ridge": ("Shackleton connecting ridge", -89.45, 222.69),
    "malapert": ("Malapert massif", -85.99, 2.93),
    "south_pole": ("South pole (reference)", -90.0, 0.0),
}
START, STOP, STEP = "2027-01-01", "2028-01-01", "1h"
BODIES = {"sun": "10", "earth": "399"}


def parse_rows(text):
    """Return [(utc_string, az_deg, el_deg)] from a Horizons CSV observer table."""
    if "$$SOE" not in text:
        raise RuntimeError("Horizons returned no table:\n" + text[-1500:])
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        nums = []
        for p in parts[1:]:
            try:
                nums.append(float(p))
            except ValueError:
                pass
        if len(nums) >= 2:
            rows.append((parts[0], nums[0], nums[1]))
    return rows


def fetch(body_id, lat, lon, alt_km=0.0):
    params = {
        "format": "text",
        "COMMAND": f"'{body_id}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",          # a point on the Moon (body 301)
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon},{lat},{alt_km}'",  # east longitude, latitude, altitude km
        "START_TIME": f"'{START}'",
        "STOP_TIME": f"'{STOP}'",
        "STEP_SIZE": f"'{STEP}'",
        "QUANTITIES": "'4'",              # apparent azimuth and elevation
        "CSV_FORMAT": "'YES'",
    }
    r = requests.get(API, params=params, timeout=120)
    r.raise_for_status()
    return parse_rows(r.text)


def main():
    OUT_DIR.mkdir(exist_ok=True)
    for site_id, (name, lat, lon) in SITES.items():
        out = {"id": site_id, "name": name, "lat": lat, "lon": lon, "step": STEP}
        for body, body_id in BODIES.items():
            rows = fetch(body_id, lat, lon)
            out.setdefault("time_utc", [r[0] for r in rows])
            out[f"{body}_az"] = [round(r[1], 3) for r in rows]
            out[f"{body}_el"] = [round(r[2], 3) for r in rows]
            print(f"{site_id}: {body} {len(rows)} rows, "
                  f"elevation {min(r[2] for r in rows):.2f} to {max(r[2] for r in rows):.2f} deg")
            time.sleep(1)  # be polite to the API
        path = OUT_DIR / f"{site_id}_ephemeris.json"
        path.write_text(json.dumps(out))
        print("wrote", path)


if __name__ == "__main__":
    main()
