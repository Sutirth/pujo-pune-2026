# Durga Puja in Pune 2026

A single-page website listing every Bengali Durga Puja pandal in Pune and PCMC, grouped by area, with a Google Maps link for each and a route planner that puts the pandals you pick in the shortest order. It replaces a poster plus one big Google Map with something people can search and tap through on a phone.

- 69 pandals across 9 areas, on a list and an offline SVG map of Pune and PCMC
- Route planner: pick pandals one by one or a whole area, get the shortest order, open it in Google Maps leg by leg
- Map-first on wide screens (the map fills the window, the list sits in a side panel, the route floats on the map), list-first on phones
- Mobile-first, light and dark themes, in a hand-painted signboard style: Bricolage Grotesque for text, JetBrains Mono for labels and buttons, Baloo Da 2 for the Bengali wordmark. All three are free Google Fonts (SIL Open Font License)
- Static site: no backend, no build step, free to host

## Project structure

```
pune-durga-puja/
  README.md
  data/
    pandals.csv        source of truth for pandals (edit this)
    localities.csv     approximate centre of each locality, used until a pandal has exact lat/lng
    meta.json          title, full-map link, contacts, credits
  scripts/
    build_data.py      CSVs + meta  ->  site/data/pandals.json
    build_basemap.py   city outlines  ->  site/data/basemap.json (run once; needs shapely)
    sources/           DataMeet ward boundaries for PMC and PCMC (CC BY 4.0)
  site/                everything that gets published
    index.html
    assets/styles.css
    assets/app.js
    data/pandals.json  generated, committed
    data/basemap.json  generated, committed
  .github/workflows/
    deploy.yml         publishes site/ to GitHub Pages
```

## Run locally

The page loads its data with `fetch`, so open it through a local server, not by double-clicking the file.

```bash
python3 -m http.server 8000 --directory site
# open http://localhost:8000
```

## Update the data

1. Edit `data/pandals.csv`. A new locality also needs a row in `data/localities.csv`, unless the pandal has its own `lat` and `lng`.
2. Run `python3 scripts/build_data.py`. It validates the rows and rewrites `site/data/pandals.json`. It stops with the line number if a locality is missing.
3. Commit both files and push. The deploy workflow fails if the JSON is out of date.

CSV columns:

| Column | Meaning |
| --- | --- |
| `area_id` | Short slug used in the page anchor, for example `southwest` |
| `area_name` | Heading shown on the page. Area order follows first appearance in the file |
| `name` | Committee name |
| `locality` | Neighbourhood, shown under the name |
| `city` | Used only for the Maps search. Defaults to `Pune` |
| `note` | Optional line under the entry, for example `Contact organizer before going` |
| `lat`, `lng` | Optional. When both are set, the Map button opens that exact pin |

## Route planner

- Pick pandals with + on a card or a map pin, or "Add all" on an area heading. The order updates with every pick.
- Up to 13 points (pandals plus your location) the planner checks every possible order (Held-Karp), so the order shown is the shortest. Above that it runs nearest-neighbour from every start, 2-opt and Or-opt, then random double-bridge kicks; the page says "near-shortest" in that case.
- Distances are straight-line distance times 1.3. Times assume 20 km/h by car (festival traffic) and 4.5 km/h on foot. Tune `ROAD_FACTOR` and `SPEED_KMH` at the top of `app.js`.
- Google Maps takes only 3 intermediate stops per link in a phone browser, so routes open as legs of 4 stops, each starting where the last ended (`LEG_POINTS`).
- Each leg finds pandals by name (`name locality city`), same as the Map buttons. Pandals with exact `lat`/`lng` use the coordinates instead.
- Picks are saved on the device. Share route sends a link with `#route=id,id,...` that loads the same picks.

## Map pins and localities

Until exact pins are added, each pandal sits at the approximate centre of its locality from `data/localities.csv`. Pandals in the same locality are drawn on a small ring so they don't overlap. These centres were placed by hand: check them against Google Maps before launch. They are good enough to order a route, not to navigate to.

## Exact map pins

Right now each Map button is a Google Maps search for `name locality city`. Well-known committees resolve cleanly, smaller ones may show a result list. To switch to exact pins:

1. Open the shared Google Map in Google My Maps.
2. Menu (three dots) > Export to KML/KMZ (CSV also works). If the option is missing, ask the map owner to enable downloads or to send the file.
3. Copy each pin's coordinates into the `lat` and `lng` columns of `data/pandals.csv`, matched by committee name.
4. Run `python3 scripts/build_data.py`. Rows with coordinates now open the exact pin and sit at that point on the map and in routes. Rows without them keep the search link and the locality centre.

The poster lists 69 pandals. If the map has 68 pins, one pandal is missing from the map. Find it while matching.

## Deploy (GitHub Pages)

1. Create a GitHub repository and push this folder to the `main` branch.
2. In the repository, go to Settings > Pages and set Source to **GitHub Actions**.
3. Push again, or run the workflow from the Actions tab. The site goes live at `https://<your-username>.github.io/<repo-name>/`.

Custom domain: add it under Settings > Pages and create the DNS record GitHub shows. HTTPS is automatic.

All asset paths are relative, so the site works both on a custom domain and under the `/<repo-name>/` path.

## Roadmap

Ship phase 1 before Puja starts. Build the rest in order of value during the festival.

| Phase | What | Notes |
| --- | --- | --- |
| 1. Done | List, search, area jump chips, Map button per pandal, contacts | This repository |
| 2. Exact pins | `lat` and `lng` for all pandals, then a Near me sort | Needs the KML export above. The map and route planner pick them up with no code change |
| 3. Festival info | Puja dates, aarti and bhog timings, theme and idol details per pandal | Ask each committee; add columns to the CSV |
| 4. Usability | Done: Share button, route planner with picks saved on the device and multi-stop Google Maps legs. Left: favourites separate from the route | |
| 5. Reliability | Installable offline app (service worker and manifest) | Mobile data is poor near crowded pandals |
| 6. Community | Correction form feeding a Google Sheet that exports to the CSV | Keeps committees able to fix their own entry |
| 7. Reach | Bengali and Hindi labels, a short custom domain, privacy-friendly analytics | |

## Data and credits

- The list comes from the 2026 poster and Instagram post by Arun Chakraborty (Raja), an initiative by Bengalis in Pune. Contacts for help: Arun (Raja) 9552162105, Keya 8007318880, Nitin 7276927516 (WhatsApp).
- Committee names and localities were transcribed from the poster image. Check spellings, for example `Bichkshna`, against the organisers.
- This is their compiled data. Get their agreement before launching publicly. The footer already credits them.
- City outlines: Pune and PCMC Municipal Spatial Data by DataMeet India community (CC BY 4.0), https://github.com/datameet/Municipal_Spatial_Data. Credited in the footer.
