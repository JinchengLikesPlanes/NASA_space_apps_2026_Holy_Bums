# NASA_space_apps_2026_Holy_Bums

Lunar Landing Site Navigator, for the NASA Space Apps Challenge 2026: a 3D map of
the whole Moon showing how much sunlight and how much view of Earth every place
gets over a year, with a detailed look at the south pole, where the best landing
sites are.

Live site: https://jinchenglikesplanes.github.io/NASA_space_apps_2026_Holy_Bums/

## What it shows

- **The whole Moon.** Every point on a half-degree grid (259,200 points) has its
  share of the year in sunlight, its share with Earth in view, and its longest
  night. The globe is shaded by real terrain, and clicking anywhere gives that
  point's numbers and a skyline worked out in the browser.
- **The south pole in detail.** Within 150 km of the pole the map uses 120 m
  terrain, with 17,665 points 2 km apart, each with its own skyline.
- **Three candidate sites in full.** Shackleton connecting ridge, Malapert massif
  and the pole itself go through the full pipeline: hourly Sun and Earth
  positions for 2027, the skyline from fine terrain, panel power, ground slope,
  and one score out of 100 (40% sunlight, 30% Earth in view, 30% safe ground).
- **Past landing sites for comparison.** The six Apollo sites and the IM-2
  (Mons Mouton) landing site are marked on the map.

How detailed the answer is depends on where the point is:

| Where | Terrain used | Points |
| --- | --- | --- |
| The three candidate sites | 20 m near the site, 120 m beyond | full hourly analysis |
| Within 150 km of the south pole | 120 m (`LDEM_75S_120M`) | every 2 km |
| The rest of the Moon | 1.9 km (`LDEM_16`) for the map colours; a 3.8 km copy for a clicked point's skyline | every 0.5° |

Away from the pole, treat the numbers as a survey of the neighbourhood, not of
the exact spot: small hills and crater walls are missing from the coarse grid.

## What's here

- `index.html` the start page
- `dashboard.html` the site dashboard
- `web/` the 3D map
- `pipeline/` Python scripts that turn NASA data into the numbers the pages show
- `data/` their outputs, committed so the pages work without running anything

## Run the website

There are three pages:

- **Start page** (`index.html`): a short explanation of the project, with a button
  that launches the 3D map.
- **3D map** (`web/`): the Moon coloured by sunlight, Earth visibility or longest
  night. It opens on the south pole; drag, zoom out or press "Whole Moon" to see
  the rest. Click any point for its numbers, and "Analyse" for its skyline and
  timeline in a pop-up.
- **Site dashboard** (`dashboard.html`): pick a site and a date, see the skyline,
  the Sun and Earth, power, and a comparison table with a score and a recommended
  site. The table also shows each site at the chosen date and time, and adds
  Apollo 11, Apollo 15 and IM-2 as quick estimates for comparison. Can analyse a
  typed-in point anywhere on the Moon.

The pages need no server of their own: all the data they read is in `data/`, so
they work from GitHub Pages (repo Settings, Pages, deploy from the `main`
branch, folder `/ (root)`).

To run them on your own computer, or to rebuild the data, read on.

The elevation grids are too large for GitHub, so download them once (111 MB,
saved in a folder named `lola` next to the repo folder):

```
python pipeline/fetch_lola.py
```

Add `--fine` to also get the 20 m grid (1.8 GB) for sharper skylines. Then:

```
python pipeline/server.py
```

Then open http://localhost:8000 for the start page, which links to the 3D map
(http://localhost:8000/web/) and the dashboard (http://localhost:8000/dashboard.html).

Without the LOLA grids, `python -m http.server 8000` in the repo folder serves all
three pages. Points on the 3D map still open in the dashboard as a quick estimate worked
out in the browser (`web/estimate.js`); only the detailed analysis of a typed-in
coordinate needs `server.py`.

Opening the HTML files directly from disk will not work, because the pages load
their data over HTTP.

## Rebuild the data

The south polar map's colours need `data/exposure_map.json`, and analysing a clicked
polar point in the browser (no server, no LOLA files) needs `data/exposure_horizons.bin`.
Both come from one command, run from `pipeline/`, and are committed to the repo:

```
python exposure_map.py path\to\LDEM_75S_120M.LBL
```

This takes about ten minutes. Add a radius and spacing in km for a different map,
for example `python exposure_map.py path\to\LDEM_75S_120M.LBL 60 1`.

The whole-Moon view needs `data/global_map.json` (the colours) and
`data/global_heights.bin` (the terrain shading and the skylines for clicked points).
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
They are plain scripts, not pytest tests: run them with `python test_exposure_map.py`.

Needs Python with `numpy` and `requests` (and `matplotlib` for the slope pictures).

## Known limits

- The whole-Moon numbers come from terrain with one height every 1.9 km (3.8 km
  for the skyline of a clicked point), so they miss small features. The colours also streak a little within about 10° of the
  poles, where the grid's points crowd together.
- Sun and Earth positions are hourly, for the year 2027 only.
- The score weights are starting values we chose, not a NASA standard, and only
  the three candidate sites have the ground-slope figure the score needs.
- Earth is counted as visible when its centre is above the skyline.
  Its disc is about 2° wide from the Moon, so link times near the horizon are approximate.

## Data sources

Terrain from the Lunar Orbiter Laser Altimeter (LOLA) on NASA's Lunar
Reconnaissance Orbiter. Sun and Earth positions from NASA JPL Horizons.
