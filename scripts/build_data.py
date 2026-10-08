#!/usr/bin/env python3
"""Build site/data/pandals.json from data/pandals.csv, data/localities.csv and data/meta.json.

Edit the CSVs, run this script, commit the result. The site only reads the JSON.

Positions:
  - If a row has lat and lng, that exact pin is used everywhere (map, route, Maps links).
  - Otherwise the pandal sits at its locality's approximate centre from localities.csv.
    That is good enough to order a route, not to navigate, so Maps links and route
    legs still search Google Maps for "name locality city".
"""
import csv
import json
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "pandals.csv"
LOCALITIES_PATH = ROOT / "data" / "localities.csv"
META_PATH = ROOT / "data" / "meta.json"
OUT_PATH = ROOT / "site" / "data" / "pandals.json"

SEARCH = "https://www.google.com/maps/search/?api=1&query="
REQUIRED = ("area_id", "area_name", "name", "locality")


def maps_query(name, locality, city):
    parts = [name]
    for extra in (locality, city):
        if extra and extra.lower() not in (p.lower() for p in parts):
            parts.append(extra)
    return " ".join(parts)


def maps_url(query, lat, lng):
    if lat is not None and lng is not None:
        return SEARCH + urllib.parse.quote_plus(f"{lat},{lng}")
    return SEARCH + urllib.parse.quote_plus(query)


def parse_coord(value, low, high, label, where):
    value = (value or "").strip()
    if not value:
        return None
    try:
        number = float(value)
    except ValueError:
        sys.exit(f"{where}: {label} '{value}' is not a number")
    if not low <= number <= high:
        sys.exit(f"{where}: {label} {number} is out of range")
    return number


def load_localities():
    table = {}
    with LOCALITIES_PATH.open(newline="", encoding="utf-8") as handle:
        for line, row in enumerate(csv.DictReader(handle), start=2):
            where = f"localities.csv line {line}"
            name = (row.get("locality") or "").strip()
            lat = parse_coord(row.get("lat"), -90, 90, "lat", where)
            lng = parse_coord(row.get("lng"), -180, 180, "lng", where)
            if not name or lat is None or lng is None:
                sys.exit(f"{where}: locality, lat and lng are all required")
            table[name.lower()] = (lat, lng)
    return table


def main():
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    localities = load_localities()
    areas, pandals, area_by_id = [], [], {}

    with CSV_PATH.open(newline="", encoding="utf-8") as handle:
        for line, row in enumerate(csv.DictReader(handle), start=2):
            where = f"pandals.csv line {line}"
            for field in REQUIRED:
                if not (row.get(field) or "").strip():
                    sys.exit(f"{where}: '{field}' is empty")

            area_id = row["area_id"].strip()
            if area_id not in area_by_id:
                area_by_id[area_id] = {"id": area_id, "name": row["area_name"].strip(), "count": 0}
                areas.append(area_by_id[area_id])
            area_by_id[area_id]["count"] += 1
            position = area_by_id[area_id]["count"]

            lat = parse_coord(row.get("lat"), -90, 90, "lat", where)
            lng = parse_coord(row.get("lng"), -180, 180, "lng", where)
            if (lat is None) != (lng is None):
                sys.exit(f"{where}: set both lat and lng, or neither")

            name = row["name"].strip()
            locality = row["locality"].strip()
            city = (row.get("city") or "").strip() or "Pune"

            if lat is not None:
                pos, exact = [lat, lng], True
            elif locality.lower() in localities:
                pos, exact = list(localities[locality.lower()]), False
            else:
                sys.exit(f"{where}: no lat/lng and locality '{locality}' is missing from localities.csv")

            query = maps_query(name, locality, city)
            pandals.append({
                "id": f"{area_id}-{position:02d}",
                "area": area_id,
                "name": name,
                "locality": locality,
                "note": (row.get("note") or "").strip() or None,
                "lat": lat,
                "lng": lng,
                "pos": pos,
                "pos_exact": exact,
                "maps_query": query,
                "maps_url": maps_url(query, lat, lng),
            })

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"meta": meta, "areas": areas, "pandals": pandals}
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    pinned = sum(1 for p in pandals if p["pos_exact"])
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}: {len(pandals)} pandals, {len(areas)} areas, "
          f"{pinned} exact pins, {len(pandals) - pinned} at locality centres")


if __name__ == "__main__":
    main()
