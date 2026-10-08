"""Daily precipitation at the block centroid from Open-Meteo (forecast or archive)."""

from __future__ import annotations

import json
from datetime import date, timedelta

import requests

from .config import LOCAL_S3

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
FORECAST = "https://api.open-meteo.com/v1/forecast"


def daily_rain(lon: float, lat: float, start: date, end: date) -> dict[date, float]:
    """mm/day for [start, end], cached under raw/rain/."""
    cache = LOCAL_S3 / "raw" / "rain" / f"{lon:.3f}_{lat:.3f}_{start}_{end}.json"
    if cache.exists():
        body = json.loads(cache.read_text())
    else:
        recent = end >= date.today() - timedelta(days=5)
        url = FORECAST if recent else ARCHIVE
        q = {"latitude": lat, "longitude": lon, "daily": "precipitation_sum",
             "timezone": "Asia/Kolkata", "start_date": start.isoformat(), "end_date": end.isoformat()}
        r = requests.get(url, params=q, timeout=60)
        r.raise_for_status()
        body = r.json()
        if not recent:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(body))
    d = body["daily"]
    return {date.fromisoformat(t): float(v or 0.0) for t, v in zip(d["time"], d["precipitation_sum"])}


def rain_last_days(rain: dict[date, float], on: date, days: int) -> float:
    """Total rain over the `days` days ending on `on` (inclusive)."""
    return round(sum(rain.get(on - timedelta(days=k), 0.0) for k in range(days)), 1)
