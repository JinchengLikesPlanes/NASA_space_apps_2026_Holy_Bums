"""Rank the sites by combining power, communications and landing safety.

Usage:  python score_sites.py
Needs:  ../data/summary.json        (from compute_visibility.py)
        ../data/slope_summary.json  (from slope_map.py)
Output: ../data/scores.json, best site first

Each factor is a percentage from 0 to 100:
    power   - share of the year the Sun is visible
    comms   - share of the year the Earth is visible
    safety  - share of the landing zone that is flatter than the slope limit
The score is their weighted average, so it is also 0 to 100.

WEIGHTS are a starting guess, not a NASA standard. Change them to match the
mission you are pitching (a solar-powered lander cares most about power, a relay
station cares most about comms) and say which you chose in the demo.
"""
import json

from fetch_ephemeris import OUT_DIR

WEIGHTS = {"power": 0.4, "comms": 0.3, "safety": 0.3}


def score(factors, weights=WEIGHTS):
    return sum(weights[k] * factors[k] for k in weights) / sum(weights.values())


def main():
    vis = {r["id"]: r for r in json.loads((OUT_DIR / "summary.json").read_text())}
    slope = {r["id"]: r for r in json.loads((OUT_DIR / "slope_summary.json").read_text())}
    rows = []
    for site_id, v in vis.items():
        if site_id not in slope:
            print(f"skipping {site_id}: no slope data, run slope_map.py first")
            continue
        factors = {"power": v["sun_pct"], "comms": v["earth_pct"],
                   "safety": slope[site_id]["zone_safe_pct"]}
        rows.append({"id": site_id, "name": v["name"], **factors,
                     "score": round(score(factors), 1)})
    rows.sort(key=lambda r: r["score"], reverse=True)
    (OUT_DIR / "scores.json").write_text(json.dumps({"weights": WEIGHTS, "sites": rows}, indent=1))
    for i, r in enumerate(rows, 1):
        print(f"{i}. {r['name']}: {r['score']}  (power {r['power']}, "
              f"comms {r['comms']}, safety {r['safety']})")


if __name__ == "__main__":
    main()
