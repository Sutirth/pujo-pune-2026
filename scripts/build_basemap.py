#!/usr/bin/env python3
"""Build site/data/basemap.json: simplified Pune (PMC) and Pimpri-Chinchwad (PCMC) outlines.

Run once, or when the source files change. Needs shapely (pip install shapely).

Sources (CC BY 4.0, DataMeet India community, Municipal Spatial Data):
  scripts/sources/pune-admin-wards_2017.geojson
  scripts/sources/pcmc-electoral-wards.geojson
  https://github.com/datameet/Municipal_Spatial_Data
"""
import json
from pathlib import Path

from shapely.geometry import shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "scripts" / "sources"
OUT_PATH = ROOT / "site" / "data" / "basemap.json"

CITIES = (
    ("pmc", "Pune (PMC)", "pune-admin-wards_2017.geojson"),
    ("pcmc", "Pimpri-Chinchwad (PCMC)", "pcmc-electoral-wards.geojson"),
)
TOLERANCE = 0.0015       # degrees, about 160 m
MIN_PART_AREA = 0.0002   # drop slivers and tiny detached parts


def outline(path):
    features = json.loads(path.read_text(encoding="utf-8"))["features"]
    merged = unary_union([shape(f["geometry"]).buffer(0) for f in features])
    # Close hairline gaps between wards, then simplify.
    merged = merged.buffer(0.0005).buffer(-0.0005).simplify(TOLERANCE, preserve_topology=True)
    parts = list(merged.geoms) if merged.geom_type == "MultiPolygon" else [merged]
    rings = []
    for part in parts:
        if part.area < MIN_PART_AREA:
            continue
        rings.append([[round(x, 4), round(y, 4)] for x, y in part.exterior.coords])
    return rings


def main():
    cities = [{"id": cid, "name": name, "rings": outline(SOURCES / fname)} for cid, name, fname in CITIES]
    payload = {
        "attribution": "Pune and PCMC Municipal Spatial Data by DataMeet India community (CC BY 4.0)",
        "source_url": "https://github.com/datameet/Municipal_Spatial_Data",
        "cities": cities,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    points = sum(len(r) for c in cities for r in c["rings"])
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}: {len(cities)} outlines, {points} points")


if __name__ == "__main__":
    main()
