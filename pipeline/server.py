"""Run the website locally with support for custom coordinates.

Usage:  python server.py [COARSE.LBL] [FINE.LBL] [--port 8000]
        With no grid paths it looks for LDEM_75S_120M.LBL and LDEM_80S_20M.LBL in a
        folder named "lola" next to the repo folder.
Then open http://localhost:8000

It serves the site like "python -m http.server", plus one extra address the page calls:
    /api/site?lat=-88.2&lon=45&name=My+site
which runs the whole pipeline for that point (Horizons download, terrain skyline,
visibility and power), saves the files in data/ and adds the site to summary.json.
Custom sites are removed from the table the next time compute_visibility.py is run.
"""
import argparse
import functools
import http.server
import json
import pathlib
import re
import threading
import time
import urllib.parse

import compute_visibility
import fetch_ephemeris as fe
import horizon_profile as hp

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK = threading.Lock()          # one calculation at a time
GRIDS = {}


def site_id_for(lat, lon):
    return f"custom_{abs(lat):.4f}{'S' if lat < 0 else 'N'}_{lon:.4f}E".replace(".", "p")


def add_site(lat, lon, name):
    """Run the pipeline for one point and return its summary row."""
    site_id = site_id_for(lat, lon)
    out = fe.OUT_DIR
    out.mkdir(exist_ok=True)
    t0 = time.time()

    eph = {"id": site_id, "name": name, "lat": lat, "lon": lon, "step": fe.STEP}
    for body, body_id in fe.BODIES.items():
        rows = fe.fetch(body_id, lat, lon)
        eph.setdefault("time_utc", [r[0] for r in rows])
        eph[f"{body}_az"] = [round(r[1], 3) for r in rows]
        eph[f"{body}_el"] = [round(r[2], 3) for r in rows]
    (out / f"{site_id}_ephemeris.json").write_text(json.dumps(eph))

    hor = hp.build(GRIDS["coarse"], GRIDS.get("fine"), site_id, name, lat, lon)
    (out / f"{site_id}_horizon.json").write_text(json.dumps(hor))

    row = compute_visibility.process_site(site_id, name, lat, lon, quiet=True)
    row["custom"] = True
    summary_path = out / "summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else []
    summary = [r for r in summary if r["id"] != site_id] + [row]
    summary_path.write_text(json.dumps(summary, indent=1))
    print(f"added {name} ({lat}, {lon}) in {time.time() - t0:.0f} s, terrain: {row['terrain']}")
    return row


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/api/site":
            return super().do_GET()
        q = urllib.parse.parse_qs(url.query)
        try:
            lat, lon = float(q["lat"][0]), float(q["lon"][0]) % 360
            if not -90 <= lat <= 90:
                raise ValueError
        except (KeyError, ValueError):
            return self.reply(400, {"error": "Give a latitude from -90 to 90 and a longitude in degrees east."})
        name = re.sub(r"[^\w .,()\-]", "", q.get("name", [""])[0]).strip()[:60]
        name = name or f"Custom {abs(lat):.2f}°{'S' if lat < 0 else 'N'}, {lon:.2f}°E"
        try:
            with LOCK:
                row = add_site(round(lat, 4), round(lon, 4), name)
        except Exception as exc:                      # report the reason to the page
            return self.reply(502, {"error": f"{type(exc).__name__}: {str(exc)[:300]}"})
        self.reply(200, row)

    def reply(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):                            # always serve fresh data files
        if self.path.startswith("/data/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            super().log_message(fmt, *args)


def main():
    lola = ROOT.parent / "lola"
    ap = argparse.ArgumentParser(description="Lunar Landing Site Navigator local server")
    ap.add_argument("coarse", nargs="?", default=str(lola / "LDEM_75S_120M.LBL"))
    ap.add_argument("fine", nargs="?", default=str(lola / "LDEM_80S_20M.LBL"))
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    GRIDS["coarse"] = hp.Dem(args.coarse)
    print("coarse grid", GRIDS["coarse"].name)
    if pathlib.Path(args.fine).exists():
        GRIDS["fine"] = hp.Dem(args.fine)
        print("fine grid  ", GRIDS["fine"].name)
    else:
        print("no fine grid found: using the coarse grid only")

    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"\nOpen http://localhost:{args.port}   (press Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
