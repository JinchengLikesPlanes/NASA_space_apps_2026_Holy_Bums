# NASA_space_apps_2026_Holy_Bums

Lunar Landing Site Navigator: find spots near the Moon's south pole with long
sunlight and a clear view of Earth.

## What's here

- `pipeline/` Python scripts that turn NASA data into the numbers the app shows
- `data/` their outputs (JSON)
- `web/` a 3D viewer for the results

## Run the website

There are two pages:

- **Site dashboard** (`index.html`): pick a site and a date, see the skyline,
  the Sun and Earth, power, and a comparison table. Can analyse a typed-in point.
- **3D map** (`web/`): the south polar terrain coloured by sunlight, Earth
  visibility or longest night, for every point on a grid. "Whole Moon" shows the
  rest of the Moon too, from a much coarser whole-Moon elevation grid.

The elevation grids are too large for GitHub, so download them once (111 MB,
saved in a folder named `lola` next to the repo folder):

```
python pipeline/fetch_lola.py
```

Add `--fine` to also get the 20 m grid (1.8 GB) for sharper skylines. Then:

```
python pipeline/server.py
```

Then open http://localhost:8000 for the dashboard and http://localhost:8000/web/
for the 3D map.

Without the LOLA grids, `python -m http.server 8000` in the repo folder serves both
pages. Points on the 3D map still open in the dashboard as a quick estimate worked
out in the browser (`web/estimate.js`); only the detailed analysis of a typed-in
coordinate needs `server.py`.

Opening the HTML files directly from disk will not work, because the pages load
their data over HTTP.

The 3D map's colours need `data/exposure_map.json`, and analysing a clicked map
point in the browser (no server, no LOLA files) needs `data/exposure_horizons.bin`.
Both come from one command, run from `pipeline/`, and are committed to the repo:

```
python exposure_map.py path\to\LDEM_75S_120M.LBL
```

This takes about ten minutes. Add a radius and spacing in km for a different map,
for example `python exposure_map.py path\to\LDEM_75S_120M.LBL 60 1`.

The whole-Moon view needs `data/global_map.json` and `data/global_heights.bin`.
To make them with terrain, download the whole-Moon grid (32 MB) and run, from `pipeline/`:

```
python fetch_lola.py --global
python global_map.py ..\..\lola\LDEM_16.LBL
```

This uses up to 8 processor cores and takes roughly 5 to 15 minutes.
`python global_map.py` with no file makes a smooth-ball version in two minutes.

If a page seems not to change after an update, the browser is running an old copy:
press Ctrl+F5.

Optional: save an equirectangular Moon image (for example from NASA's CGI Moon
Kit) as `web/assets/moon.jpg` to give the globe a photo surface.

## Pipeline order

1. `fetch_ephemeris.py` Sun and Earth positions for each site, from JPL Horizons
2. `horizon_profile.py` the terrain skyline around each site, from LOLA
3. `compute_visibility.py` sunlight, Earth visibility and panel power at each site
4. `exposure_map.py` sunlight and Earth visibility for every point on a grid around the pole
5. `global_map.py` the same for the whole Moon, from the coarse whole-Moon grid `LDEM_16`

6. `slope_map.py` how steep the ground is across a 1 km landing zone around each site
7. `score_sites.py` one ranked score per site from sunlight, Earth visibility and slope

`refine_sites.py` suggests better coordinates for the sites (highest ground nearby).
`test_exposure_map.py` and `test_slope_map.py` check the maths and need no LOLA files.

Needs Python with `numpy` and `requests` (and `matplotlib` for the slope pictures).
