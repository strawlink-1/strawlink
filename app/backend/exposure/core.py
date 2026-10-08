"""Downwind villages/schools for fields at risk of burning (exposure, not a pollution reading)."""

from __future__ import annotations

import math
from datetime import date
from functools import lru_cache

import requests

from common import settings

LABEL = "Potentially exposed if these fields burn"


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial bearing a→b in degrees from north (lon, lat inputs)."""
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def distance_km(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def is_downwind(field: tuple, poi: tuple, wind_from_deg: float, max_km: float, sector_deg: float) -> bool:
    if distance_km(field, poi) > max_km:
        return False
    wind_to = (wind_from_deg + 180) % 360
    return angle_diff(bearing_deg(field, poi), wind_to) <= sector_deg


@lru_cache(maxsize=32)
def afternoon_wind(lon: float, lat: float, day: str) -> dict:
    """Vector-mean wind 15:00–18:00 IST from Open-Meteo hourly (forecast or archive)."""
    d = date.fromisoformat(day)
    recent = (settings.today() - d).days <= 5
    url = "https://api.open-meteo.com/v1/forecast" if recent else "https://archive-api.open-meteo.com/v1/archive"
    r = requests.get(url, params={"latitude": lat, "longitude": lon, "hourly": "wind_direction_10m,wind_speed_10m",
                                  "timezone": "Asia/Kolkata", "start_date": day, "end_date": day}, timeout=15)
    r.raise_for_status()
    h = r.json()["hourly"]
    u = v = 0.0
    n = 0
    for t, wd, ws in zip(h["time"], h["wind_direction_10m"], h["wind_speed_10m"]):
        if wd is None or ws is None or not (15 <= int(t[11:13]) <= 18):
            continue
        u += ws * math.sin(math.radians(wd))
        v += ws * math.cos(math.radians(wd))
        n += 1
    if not n:
        raise RuntimeError("no wind data")
    return {"wind_from_deg": round((math.degrees(math.atan2(u, v)) + 360) % 360, 1),
            "wind_speed_kmh": round(math.hypot(u, v) / n, 1), "hours": "15:00–18:00 IST", "source": "open-meteo"}


def exposure(risk_fields: list[dict], wind: dict) -> dict:
    p = settings.params()
    max_km, sector = float(p["exposure_max_km"]), float(p["exposure_sector_deg"])
    pois = []
    for kind, rel in (("village", "data/osm/villages.geojson"), ("school", "data/osm/schools.geojson")):
        for f in settings.geojson(rel)["features"]:
            pois.append((kind, f["properties"].get("name") or "(unnamed)", tuple(f["geometry"]["coordinates"]),
                         f["properties"].get("osm_id")))
    hits: dict[str, dict] = {}
    for f in risk_fields:
        for kind, name, xy, oid in pois:
            if is_downwind(tuple(f["centroid"]), xy, wind["wind_from_deg"], max_km, sector):
                h = hits.setdefault(oid, {"kind": kind, "name": name, "location": list(xy), "osm_id": oid,
                                          "from_fields": [], "nearest_km": 1e9})
                h["from_fields"].append(f["field_id"])
                h["nearest_km"] = round(min(h["nearest_km"], distance_km(tuple(f["centroid"]), xy)), 2)
    return {"label": LABEL, "wind": wind, "rule": {"max_km": max_km, "sector_deg": sector},
            "risk_fields": [f["field_id"] for f in risk_fields],
            "exposed": sorted(hits.values(), key=lambda h: (h["kind"], h["nearest_km"])),
            "attribution": "Villages and schools © OpenStreetMap contributors"}
