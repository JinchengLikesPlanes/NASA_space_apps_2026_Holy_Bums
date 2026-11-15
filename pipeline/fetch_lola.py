"""Download the LOLA elevation grids the pipeline and server.py need.

Usage:  python fetch_lola.py            the 120 m polar grid (111 MB): enough for the polar map and server.py
        python fetch_lola.py --fine     also the 20 m polar grid (1.8 GB): sharper skylines near a site
        python fetch_lola.py --global   only the whole-Moon grid (32 MB), for global_map.py
        python fetch_lola.py --to D:\\some\\folder

Files go in a folder named "lola" next to the repo folder, which is where server.py
looks. They are not kept in the repo itself: GitHub refuses files over 100 MB.
A file that is already fully downloaded is skipped, so it is safe to run again.

Source: the LOLA PDS Data Node at MIT, https://imbrium.mit.edu/BROWSE/LOLA_GDR/POLAR/SOUTH_POLE
"""
import argparse
import pathlib
import sys
import urllib.request

BASE = "https://imbrium.mit.edu/DATA/LOLA_GDR/POLAR/IMG/"
GLOBAL_BASE = "https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/"
COARSE = "LDEM_75S_120M"     # whole south polar region, 120 m per pixel
FINE = "LDEM_80S_20M"        # 80 S to the pole, 20 m per pixel
WHOLE_MOON = "LDEM_16"       # the whole Moon, 16 pixels per degree (1.9 km per pixel)
ROOT = pathlib.Path(__file__).resolve().parent.parent


def download(url, dest):
    """Fetch one file with a progress line. Returns True if it was downloaded, False if skipped."""
    with urllib.request.urlopen(url, timeout=60) as res:
        total = int(res.headers.get("Content-Length") or 0)
        if dest.exists() and total and dest.stat().st_size == total:
            print(f"  {dest.name}: already here, skipped")
            return False
        part = dest.with_name(dest.name + ".part")      # so a broken download is never mistaken for a whole file
        done = 0
        with open(part, "wb") as out:
            while True:
                chunk = res.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r  {dest.name}: {done / 1e6:,.0f} of {total / 1e6:,.0f} MB", end="", flush=True)
        print()
        if total and done != total:
            part.unlink()
            raise IOError(f"{dest.name} stopped at {done} of {total} bytes. Run the command again.")
        part.replace(dest)
        return True


def main():
    ap = argparse.ArgumentParser(description="Download LOLA south polar elevation grids")
    ap.add_argument("--fine", action="store_true", help=f"also download {FINE} (1.8 GB)")
    ap.add_argument("--global", dest="whole", action="store_true", help=f"download only {WHOLE_MOON}, the whole-Moon grid (32 MB)")
    ap.add_argument("--to", default=str(ROOT.parent / "lola"), help="folder to save into")
    ap.add_argument("--base", default=None, help=argparse.SUPPRESS)       # for testing
    args = ap.parse_args()

    folder = pathlib.Path(args.to)
    folder.mkdir(parents=True, exist_ok=True)
    print("saving to", folder)
    names = [WHOLE_MOON] if args.whole else [COARSE] + ([FINE] if args.fine else [])
    base = args.base or (GLOBAL_BASE if args.whole else BASE)
    for name in names:
        for ext in (".LBL", ".IMG"):                   # label first: it is tiny and fails fast if the address is wrong
            try:
                download(base + name + ext, folder / (name + ext))
            except Exception as exc:
                sys.exit(f"\nCould not download {name + ext}: {exc}")
    if args.whole:
        print(f"\nDone. Build the whole-Moon map with:  python global_map.py {folder / (WHOLE_MOON + '.LBL')}")
    else:
        print("\nDone. Start the site with:  python pipeline/server.py")


if __name__ == "__main__":
    main()
