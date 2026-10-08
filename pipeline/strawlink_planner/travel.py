"""Travel-time matrices: road_factor × haversine / speed (default) or OSRM /table."""

from __future__ import annotations

import hashlib
import json
import math
import os
import urllib.request

import numpy as np

from .models import Travel

EARTH_R_KM = 6371.0088
_CACHE: dict[str, np.ndarray] = {}


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(
        (lon2 - lon1) / 2
    ) ** 2
    return 2 * EARTH_R_KM * math.asin(math.sqrt(h))


def haversine_matrix_km(points: list[tuple[float, float]]) -> np.ndarray:
    p = np.radians(np.asarray(points, dtype=float).reshape(-1, 2))
    lon, lat = p[:, 0][:, None], p[:, 1][:, None]
    dlat = lat.T - lat
    dlon = lon.T - lon
    h = np.sin(dlat / 2) ** 2 + np.cos(lat) * np.cos(lat.T) * np.sin(dlon / 2) ** 2
    return 2 * EARTH_R_KM * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


def _osrm_minutes(points: list[tuple[float, float]], url: str) -> np.ndarray:
    coords = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in points)
    with urllib.request.urlopen(f"{url.rstrip('/')}/table/v1/driving/{coords}", timeout=20) as r:
        body = json.load(r)
    return np.asarray(body["durations"], dtype=float) / 60.0


def minutes_matrix(points: list[tuple[float, float]], travel: Travel) -> np.ndarray:
    """Travel minutes between all points. Cached per (node set, travel settings)."""
    key = hashlib.sha1(
        json.dumps([[round(x, 6) for x in p] for p in points]).encode()
        + travel.model_dump_json().encode()
    ).hexdigest()
    if key in _CACHE:
        return _CACHE[key]
    osrm = os.environ.get("OSRM_URL")
    m = None
    if travel.method == "osrm" and osrm:
        try:
            m = _osrm_minutes(points, osrm)
        except Exception:  # noqa: BLE001 — fall back to road factor
            m = None
    if m is None:
        m = haversine_matrix_km(points) * travel.road_factor / travel.speed_kmh * 60.0
    _CACHE[key] = m
    return m
