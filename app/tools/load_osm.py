"""One-time Overpass export for the block: villages/hamlets and schools (bbox + 15 km), roads and waterways (bbox + 1 km).

    python app/tools/load_osm.py --bbox 75.684,30.295,75.788,30.386
    python app/tools/load_osm.py --bbox 75.684,30.295,75.788,30.386 --roads-only

Writes data/osm/{villages,schools,roads,water}.geojson (© OpenStreetMap contributors).
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OVERPASS = "https://overpass-api.de/api/interpreter"


def grow(b: list[float], km: float) -> list[float]:
    lat = (b[1] + b[3]) / 2
    dlat, dlon = km / 110.574, km / (111.32 * math.cos(math.radians(lat)))
    return [b[0] - dlon, b[1] - dlat, b[2] + dlon, b[3] + dlat]


def query(selector: str, b: list[float]) -> list[dict]:
    s, w, n, e = b[1], b[0], b[3], b[2]
    q = f"[out:json][timeout:120];({selector}({s},{w},{n},{e}););out center tags;"
    r = requests.post(OVERPASS, data={"data": q}, timeout=180,
                      headers={"User-Agent": "strawlink-hackathon/0.1"})
    r.raise_for_status()
    return r.json()["elements"]


def to_fc(elements: list[dict], kind: str) -> dict:
    feats = []
    for el in elements:
        lon = el.get("lon", el.get("center", {}).get("lon"))
        lat = el.get("lat", el.get("center", {}).get("lat"))
        if lon is None:
            continue
        t = el.get("tags", {})
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": {"osm_id": f"{el['type']}/{el['id']}", "kind": kind,
                                     "name": t.get("name:en") or t.get("name") or "",
                                     "name_pa": t.get("name:pa", ""), "place": t.get("place", "")}})
    feats.sort(key=lambda f: f["properties"]["osm_id"])
    return {"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors", "features": feats}


def ways(selector: str, b: list[float]) -> list[dict]:
    s, w, n, e = b[1], b[0], b[3], b[2]
    q = f"[out:json][timeout:120];({selector}({s},{w},{n},{e}););out tags geom;"
    r = requests.post(OVERPASS, data={"data": q}, timeout=180, headers={"User-Agent": "strawlink-hackathon/0.1"})
    r.raise_for_status()
    return r.json()["elements"]


def lines_fc(elements: list[dict], key: str) -> dict:
    """Ways → LineStrings with one property: kind (the highway / waterway class)."""
    feats = []
    for el in sorted(elements, key=lambda el: el["id"]):
        kind = el.get("tags", {}).get(key)
        geom = [[round(p["lon"], 6), round(p["lat"], 6)] for p in el.get("geometry", [])]
        if kind and len(geom) >= 2:
            feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": geom},
                          "properties": {"kind": kind}})
    return {"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors", "features": feats}


def export_lines(elements: list[dict], out: Path) -> dict:
    roads = lines_fc([el for el in elements if "highway" in el.get("tags", {})], "highway")
    water = lines_fc([el for el in elements if "waterway" in el.get("tags", {})], "waterway")
    (out / "roads.geojson").write_text(json.dumps(roads, separators=(",", ":")), encoding="utf-8")
    (out / "water.geojson").write_text(json.dumps(water, separators=(",", ":")), encoding="utf-8")
    return {"roads": len(roads["features"]), "water": len(water["features"])}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--km", type=float, default=15)
    ap.add_argument("--roads-only", action="store_true")
    ap.add_argument("--raw", type=Path, help="reuse a saved Overpass JSON response for the roads export")
    a = ap.parse_args()
    block = [float(x) for x in a.bbox.split(",")]
    out = ROOT / "data" / "osm"
    out.mkdir(parents=True, exist_ok=True)
    els = json.loads(a.raw.read_text(encoding="utf-8"))["elements"] if a.raw else None
    if els is None:
        b1 = grow(block, 1)
        els = ways('way["highway"]', b1) + ways('way["waterway"]', b1)
    print(json.dumps(export_lines(els, out)))
    if a.roads_only:
        return
    b = grow(block, a.km)
    v = to_fc(query('node["place"~"^(village|hamlet|town)$"]', b), "village")
    s = to_fc(query('nwr["amenity"="school"]', b), "school")
    (out / "villages.geojson").write_text(json.dumps(v, ensure_ascii=False, indent=1))
    (out / "schools.geojson").write_text(json.dumps(s, ensure_ascii=False, indent=1))
    print(json.dumps({"villages": len(v["features"]), "schools": len(s["features"]), "bbox": b}))


if __name__ == "__main__":
    main()
