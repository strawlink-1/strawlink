"""Write a valid, clearly synthetic stub of every contract so app/ never waits.

    python -m strawlink_pipeline.stubs              # → outputs/stubs/ (+ S3 if STRAWLINK_BUCKET)
    python -m strawlink_pipeline.stubs --examples   # → contracts/examples/ (small)

The plan stubs are real planner output on a synthetic state. Every record carries
synthetic=true; backtest numbers are placeholders, not results.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import date, timedelta
from pathlib import Path

import jsonschema
import numpy as np
import pandas as pd

from strawlink_planner import plan_day, plan_day_baseline

from .config import CONTRACTS, OUTPUTS, params, schema, upload
from .demo_state import demo_state
from .volumes import village_volumes

PARQUET = {"field_series", "forecast", "burn_record"}


def _square(lon: float, lat: float, area_ha: float) -> list:
    half_m = math.sqrt(area_ha * 10_000) / 2
    dlat = half_m / 110_574
    dlon = half_m / (111_320 * math.cos(math.radians(lat)))
    ring = [
        [lon - dlon, lat - dlat], [lon + dlon, lat - dlat], [lon + dlon, lat + dlat],
        [lon - dlon, lat + dlat], [lon - dlon, lat - dlat],
    ]
    return [[[round(x, 6), round(y, 6)] for x, y in ring]]


def build(n_fields: int, on: date) -> dict[str, object]:
    p = params()
    state = demo_state(on=on, n_fields=n_fields, n_villages=min(4, max(2, n_fields // 5)))
    rng = np.random.default_rng(int(p["random_seed"]))
    t_per_ha = float(p["straw_t_per_ha"])

    fields_geo = {
        "type": "FeatureCollection",
        "synthetic": True,
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": _square(*f["centroid"], f["straw_t"] / t_per_ha)},
                "properties": {
                    "field_id": f["field_id"],
                    "village_id": f["village_id"],
                    "village_name": f"Village {f['village_id'][1:]} (synthetic)",
                    "area_ha": round(f["straw_t"] / t_per_ha, 2),
                    "straw_t": f["straw_t"],
                    "sowing_deadline": f["sowing_deadline"],
                    "plant_hint": None,
                    "synthetic": True,
                },
            }
            for f in state["fields"]
        ],
    }

    forecast = [
        {
            "field_id": f["field_id"], "issued_on": on.isoformat(), "p10": f["p10"], "p50": f["p50"],
            "p90": f["p90"], "source": f["source"],
            "confidence": 1.0 if f["source"] == "confirmed" else round(float(rng.uniform(0.5, 0.85)), 2),
            "synthetic": True,
        }
        for f in state["fields"]
    ]
    vf = village_volumes(
        forecast, {f["field_id"]: f for f in state["fields"]}, on,
        int(p["village_mc_draws"]), int(p["random_seed"]),
    )
    for r in vf:
        r["synthetic"] = True

    # synthetic NDVI/NBR curves: green-up plateau, sharp drop at harvest (p50)
    series = []
    for f in state["fields"][: min(len(state["fields"]), 20)]:
        harvest = date.fromisoformat(f["p50"])
        for k in range(0, 60, 5):
            d = date(on.year, 9, 1) + timedelta(days=k)
            if d > on:
                break
            ndvi = 0.8 if d < harvest else 0.25
            series.append({
                "field_id": f["field_id"], "date": d.isoformat(), "sensor": "S2",
                "ndvi": round(ndvi + float(rng.normal(0, 0.02)), 3),
                "nbr": round(ndvi - 0.2 + float(rng.normal(0, 0.02)), 3),
                "cloud_frac": round(float(rng.uniform(0, 0.3)), 2),
                "n_pixels": int(rng.integers(20, 300)), "synthetic": True,
            })

    burns = []
    for f in state["fields"]:
        burned = f["burned_last_season"] is True
        harvested = f["burned_last_season"] is not None
        lo = date(on.year - 1, 10, 18)
        burns.append({
            "field_id": f["field_id"], "season": on.year - 1, "harvested": harvested,
            "harvest_lo": lo.isoformat() if harvested else None,
            "harvest_hi": (lo + timedelta(days=5)).isoformat() if harvested else None,
            "burned": burned,
            "burn_lo": (lo + timedelta(days=7)).isoformat() if burned else None,
            "burn_hi": (lo + timedelta(days=10)).isoformat() if burned else None,
            "evidence": ["dnbr"] if burned else [],
            "last_clear_image": (lo + timedelta(days=20)).isoformat(),
            "synthetic": True,
        })

    plan = plan_day(state).to_json_dict()
    base = plan_day_baseline(state).to_json_dict()

    days = [(date(2025, 10, 1) + timedelta(days=i)).isoformat() for i in range(0, 61, 10)]
    backtest = []
    for scale in (0.75, 1.0, 1.25):
        for policy in ("strawlink", "baseline"):
            backtest.append({
                "fleet_scale": scale, "policy": policy, "reach_rate": 0.0,
                "burned_fields_total": 0, "burned_fields_reached": 0,
                "tonnes_cleared_in_time": 0.0, "window_coverage": None,
                "village_volume_mape": None, "synthetic": True,
                "daily": [{"date": d, "cleared_fields": 0, "cleared_t": 0.0, "at_risk": 0} for d in days],
            })

    return {
        "fields": fields_geo,
        "field_series": series,
        "forecast": forecast,
        "village_forecast": vf,
        "burn_record": burns,
        "planner_input": state,
        "plan": plan,
        "plan_baseline": base,
        "backtest_result": backtest,
    }


FILENAMES = {
    "fields": "fields.geojson",
    "field_series": "field_series.json",
    "forecast": "forecast.json",
    "village_forecast": "village_forecast.json",
    "burn_record": "burn_record.json",
    "planner_input": "planner_input.json",
    "plan": "plan.json",
    "plan_baseline": "plan_baseline.json",
    "backtest_result": "backtest_result.json",
}


def schema_for(name: str) -> str:
    return "plan" if name == "plan_baseline" else name


def write(out: Path, docs: dict[str, object], parquet: bool) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, doc in docs.items():
        jsonschema.validate(doc, schema(schema_for(name)))
        path = out / FILENAMES[name]
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        written.append(path)
        if parquet and name in PARQUET:
            pq = out / f"{name}.parquet"
            pd.DataFrame(doc).to_parquet(pq, index=False)
            written.append(pq)
    return written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--examples", action="store_true", help="write small examples to contracts/examples")
    ap.add_argument("--date", default="2026-10-20")
    ap.add_argument("--fields", type=int, default=60)
    a = ap.parse_args()
    on = date.fromisoformat(a.date)
    if a.examples:
        files = write(CONTRACTS / "examples", build(6, on), parquet=False)
    else:
        files = write(OUTPUTS / "stubs", build(a.fields, on), parquet=True)
        for f in files:
            if upload(f, f"outputs/stubs/{f.name}"):
                print(json.dumps({"event": "uploaded", "key": f"outputs/stubs/{f.name}"}))
    for f in files:
        print(json.dumps({"event": "wrote", "path": str(f)}))


if __name__ == "__main__":
    main()
