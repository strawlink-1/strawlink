"""Synthetic PlannerInput for stubs, tests and timing — every value is synthetic.

Placeholder until Shambhvi's data/fields/fields.geojson and config/synthetic.yaml
exist. Field layout, machines and plants here are invented and labelled synthetic.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np

from .config import params as load_params

# Placeholder block centre near Patiala (SYNTHETIC — replaced once aoi --pick runs).
CENTRE = (76.40, 30.33)


def _offset(lon: float, lat: float, dx_km: float, dy_km: float) -> tuple[float, float]:
    return (
        lon + dx_km / (111.32 * math.cos(math.radians(lat))),
        lat + dy_km / 110.574,
    )


def demo_state(
    on: date = date(2026, 10, 20),
    n_fields: int = 60,
    n_villages: int = 4,
    n_balers: int = 4,
    n_seeders: int = 3,
    n_trucks: int = 4,
    seed: int = 42,
    time_limit_s: float = 10,
) -> dict:
    rng = np.random.default_rng(seed)
    p = load_params()
    t_per_ha = float(p["straw_t_per_ha"])
    deadline = date.fromisoformat(str(p["sowing_deadline_default"]))
    villages = [
        (f"V{i + 1:02d}", _offset(*CENTRE, *(rng.uniform(-4, 4, 2)))) for i in range(n_villages)
    ]
    fields = []
    for i in range(n_fields):
        vid, vc = villages[i % n_villages]
        lon, lat = _offset(*vc, *(rng.normal(0, 0.6, 2)))
        area = float(np.round(rng.uniform(0.8, 3.5), 2))
        p50 = on + timedelta(days=int(rng.integers(-3, 9)))
        confirmed = rng.random() < 0.15
        p10 = p50 if confirmed else p50 - timedelta(days=int(rng.integers(1, 4)))
        p90 = p50 if confirmed else p50 + timedelta(days=int(rng.integers(1, 5)))
        fields.append(
            {
                "field_id": f"F{i + 1:04d}",
                "centroid": [round(lon, 6), round(lat, 6)],
                "village_id": vid,
                "straw_t": round(area * t_per_ha, 2),
                "p10": p10.isoformat(),
                "p50": p50.isoformat(),
                "p90": p90.isoformat(),
                "source": "confirmed" if confirmed else "satellite",
                "sowing_deadline": deadline.isoformat(),
                "status": "ready" if p50 <= on else "forecast",
                "burned_last_season": [True, False, None][int(rng.integers(0, 3))],
                "rain_mm_3d": float(round(rng.choice([0.0, 0.0, 0.0, 2.0, 12.0]), 1)),
            }
        )

    def machine(kind: str, k: int, rate: float, hours: float) -> dict:
        _, vc = villages[k % n_villages]
        return {
            "machine_id": f"{kind[:2].upper()}{k + 1:02d}",
            "type": kind,
            "base": [round(x, 6) for x in vc],
            "rate_t_per_hr": rate,
            "hours_per_day": hours,
            "available": True,
        }

    machines = (
        [machine("baler_set", k, 4.0, 10) for k in range(n_balers)]
        + [machine("seeder", k, 3.0, 10) for k in range(n_seeders)]
        + [machine("truck", k, 10.0, 10) for k in range(n_trucks)]
    )
    plants = [
        {"plant_id": "P01", "location": [round(x, 6) for x in _offset(*CENTRE, 12, 5)],
         "weekly_capacity_t": 300, "depot_capacity_t": 400, "fill_t": 250},
        {"plant_id": "P02", "location": [round(x, 6) for x in _offset(*CENTRE, -20, -10)],
         "weekly_capacity_t": 150, "depot_capacity_t": 200, "fill_t": 180},
    ]
    return {
        "date": on.isoformat(),
        "synthetic": True,
        "fields": fields,
        "machines": machines,
        "plants": plants,
        "travel": {"method": "road_factor", "road_factor": 1.3, "speed_kmh": 25},
        "params": p,
        "time_limit_s": time_limit_s,
    }
