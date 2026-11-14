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
  visibility or longest night, for every point on a grid.

With the LOLA grids in a folder named `lola` next to the repo folder:

```
python pipeline/server.py
```

Then open http://localhost:8000 for the dashboard and http://localhost:8000/web/
for the 3D map. Without the LOLA grids, `python -m http.server 8000` in the repo
folder serves both pages, but the dashboard cannot analyse new points.

Opening the HTML files directly from disk will not work, because the pages load
their data over HTTP.

The 3D map's colours need `data/exposure_map.json`. To make it, run from `pipeline/`:

```
python exposure_map.py path\to\LDEM_75S_120M.LBL
```

This takes about ten minutes. Add a radius and spacing in km for a different map,
for example `python exposure_map.py path\to\LDEM_75S_120M.LBL 60 1`.

Optional: save an equirectangular Moon image (for example from NASA's CGI Moon
Kit) as `web/assets/moon.jpg` to give the globe a photo surface.

## Pipeline order

1. `fetch_ephemeris.py` Sun and Earth positions for each site, from JPL Horizons
2. `horizon_profile.py` the terrain skyline around each site, from LOLA
3. `compute_visibility.py` sunlight, Earth visibility and panel power at each site
4. `exposure_map.py` sunlight and Earth visibility for every point on a grid around the pole

5. `slope_map.py` how steep the ground is across a 1 km landing zone around each site
6. `score_sites.py` one ranked score per site from sunlight, Earth visibility and slope

`refine_sites.py` suggests better coordinates for the sites (highest ground nearby).
`test_exposure_map.py` and `test_slope_map.py` check the maths and need no LOLA files.

Needs Python with `numpy` and `requests` (and `matplotlib` for the slope pictures).
