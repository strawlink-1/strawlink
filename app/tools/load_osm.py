"""One-time Overpass export of villages/hamlets and schools for the block bbox + 15 km.

    python app/tools/load_osm.py --bbox 75.684,30.295,75.788,30.386

Writes data/osm/villages.geojson and data/osm/schools.geojson (© OpenStreetMap contributors).
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OVERPASS = "https://overpass-api.de/api/interpreter"
MIRRORS = [OVERPASS, "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]


def overpass(q: str) -> dict:
    """POST an Overpass query, trying public mirrors in turn (they time out under load)."""
    import time

    last = None
    for attempt in range(2):
        for url in MIRRORS:
            try:
                r = requests.post(url, data={"data": q}, timeout=240, headers={"User-Agent": "strawlink-hackathon/0.1"})
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(3 + attempt * 5)
    raise RuntimeError(f"all Overpass mirrors failed: {last}")


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


def query_ways(selector: str, b: list[float]) -> list[dict]:
    s, w, n, e = b[1], b[0], b[3], b[2]
    q = f"[out:json][timeout:180];way{selector}({s},{w},{n},{e});out geom tags;"
    return overpass(q)["elements"]


def roads(block: list[float], wide: list[float]) -> dict:
    """Main roads over the wide box (to reach plants) + every farm track/minor road near the block."""
    major = query_ways('["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]', wide)
    minor = query_ways('["highway"~"^(unclassified|residential|track|service|living_street|road)$"]', grow(block, 3))
    feats, seen = [], set()
    for el in major + minor:
        if el["id"] in seen or "geometry" not in el:
            continue
        seen.add(el["id"])
        t = el.get("tags", {})
        feats.append({"type": "Feature",
                      "geometry": {"type": "LineString", "coordinates": [[round(p["lon"], 6), round(p["lat"], 6)] for p in el["geometry"]]},
                      "properties": {"osm_id": f"way/{el['id']}", "highway": t.get("highway", ""), "name": t.get("name:en") or t.get("name") or "",
                                     "surface": t.get("surface", "")}})
    feats.sort(key=lambda f: f["properties"]["osm_id"])
    return {"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors", "features": feats}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--km", type=float, default=15)
    ap.add_argument("--roads-km", type=float, default=28, help="radius of the main-road box (must reach the plants)")
    ap.add_argument("--roads-only", action="store_true")
    a = ap.parse_args()
    block = [float(x) for x in a.bbox.split(",")]
    b = grow(block, a.km)
    out = ROOT / "data" / "osm"
    out.mkdir(parents=True, exist_ok=True)
    r = roads(block, grow(block, a.roads_km))
    (out / "roads.geojson").write_text(json.dumps(r, ensure_ascii=False, separators=(",", ":")))
    web = ROOT / "app" / "web" / "public" / "osm"
    web.mkdir(parents=True, exist_ok=True)
    (web / "roads.geojson").write_text(json.dumps(r, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps({"roads": len(r["features"])}))
    if a.roads_only:
        return
    v = to_fc(query('node["place"~"^(village|hamlet|town)$"]', b), "village")
    s = to_fc(query('nwr["amenity"="school"]', b), "school")
    (out / "villages.geojson").write_text(json.dumps(v, ensure_ascii=False, indent=1))
    (out / "schools.geojson").write_text(json.dumps(s, ensure_ascii=False, indent=1))
    print(json.dumps({"villages": len(v["features"]), "schools": len(s["features"]), "bbox": b}))


if __name__ == "__main__":
    main()
