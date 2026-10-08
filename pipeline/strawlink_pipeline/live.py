"""Daily live run → outputs/live/{date}/ (and S3).

    python -m strawlink_pipeline.live --date 2026-10-10 [--ingest]

Writes forecast.json, village_forecast.json, planner_input.json and plan.json.
Machines/plants come from config/synthetic.yaml (falls back to the demo fleet,
labelled synthetic, until that file exists). Confirmations and re-plans are
handled by app/ (/replan); this is the 06:00 baseline run.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

import jsonschema
import pandas as pd
import yaml

from strawlink_planner import plan_day

from .config import CONFIG, DATA, LOCAL_S3, OUTPUTS, params, schema, upload
from .forecast import field_meta, forecast_fields, load_bundle
from .volumes import village_volumes
from .weather import daily_rain, rain_last_days

MACHINE_KEYS = ["machine_id", "type", "base", "rate_t_per_hr", "hours_per_day", "available"]
PLANT_KEYS = ["plant_id", "location", "weekly_capacity_t", "depot_capacity_t", "fill_t"]


def fallback_fleet(fields_gdf) -> tuple[list[dict], list[dict]]:
    """SYNTHETIC fleet placed at the fields' villages until config/synthetic.yaml exists."""
    import math

    from .demo_state import _offset, demo_state

    demo = demo_state(n_fields=1)
    c = fields_gdf.to_crs("EPSG:32643").centroid.to_crs("EPSG:4326")
    g = fields_gdf.assign(lon=c.x, lat=c.y)
    vil = g.groupby("village_id")[["lon", "lat"]].mean().sort_index()
    bases = [[round(r.lon, 6), round(r.lat, 6)] for r in vil.itertuples()]
    n = max(1, math.ceil(len(fields_gdf) / 40))
    proto = {m["type"]: m for m in demo["machines"]}
    machines = []
    for t, pre in (("baler_set", "BA"), ("seeder", "SE"), ("truck", "TR")):
        for k in range(n):
            machines.append({**proto[t], "machine_id": f"{pre}{k + 1:02d}", "base": bases[k % len(bases)]})
    lon, lat = float(c.x.mean()), float(c.y.mean())
    plants = []
    for pl, (dx, dy) in zip(demo["plants"], ((12, 5), (-20, -10))):
        plants.append({**pl, "location": [round(x, 6) for x in _offset(lon, lat, dx, dy)]})
    return machines, plants


def fleet(scale: float = 1.0, fields_gdf=None) -> tuple[list[dict], list[dict], bool]:
    """(machines, plants, from_synthetic_yaml). Scale keeps ≥1 of each machine type."""
    f = CONFIG / "synthetic.yaml"
    if f.exists():
        y = yaml.safe_load(f.read_text()) or {}
        machines = [{k: m[k] for k in MACHINE_KEYS} for m in y.get("machines", [])]
        plants = [{k: p[k] for k in PLANT_KEYS} for p in y.get("plants", [])]
        real = True
    elif fields_gdf is not None:
        machines, plants = fallback_fleet(fields_gdf)
        real = False
    else:
        from .demo_state import demo_state

        s = demo_state()
        machines, plants, real = s["machines"], s["plants"], False
    if scale != 1.0:
        out = []
        for t in ("baler_set", "seeder", "truck"):
            ms = sorted((m for m in machines if m["type"] == t), key=lambda m: m["machine_id"])
            if not ms:
                continue
            out += ms[: max(1, round(len(ms) * scale))]
            # scale > 1: clone machines with new ids at the same bases
            extra = max(0, round(len(ms) * scale) - len(ms))
            out += [{**ms[i % len(ms)], "machine_id": f"{ms[i % len(ms)]['machine_id']}x{i + 1}"} for i in range(extra)]
        machines = out
    return machines, plants, real


def build_state(on: date, fields_gdf, forecasts: list[dict], burned_last: dict[str, bool | None],
                rain_mm_3d: dict[str, float] | float, machines: list[dict], plants: list[dict],
                status: dict[str, str] | None = None, time_limit_s: float = 45,
                deadlines: dict[str, date] | None = None) -> dict:
    p = params()
    fc = {r["field_id"]: r for r in forecasts}
    t_per_ha = float(p["straw_t_per_ha"])
    utm = fields_gdf.to_crs("EPSG:32643")
    if "area_ha" not in fields_gdf or fields_gdf["area_ha"].isna().any():
        fields_gdf = fields_gdf.assign(area_ha=(utm.area / 10_000).values)
    utm_c = utm.centroid.to_crs("EPSG:4326")
    fields = []
    for (_, f), c in zip(fields_gdf.iterrows(), utm_c):
        fid = f["field_id"]
        if fid not in fc:
            continue
        r = fc[fid]
        straw = f.get("straw_t")
        if straw is None or pd.isna(straw):
            straw = float(f["area_ha"]) * t_per_ha
        st = (status or {}).get(fid) or ("ready" if r["p50"] <= on.isoformat() else "forecast")
        fields.append({
            "field_id": fid, "centroid": [round(c.x, 6), round(c.y, 6)],
            "village_id": str(f["village_id"]), "straw_t": round(float(straw), 3),
            "p10": r["p10"], "p50": r["p50"], "p90": r["p90"], "source": r["source"],
            "sowing_deadline": (deadlines[fid].isoformat() if deadlines and fid in deadlines
                                else str(f.get("sowing_deadline") or p["sowing_deadline_default"])[:10]),
            "status": st, "burned_last_season": burned_last.get(fid),
            "rain_mm_3d": float(rain_mm_3d.get(fid, 0.0) if isinstance(rain_mm_3d, dict) else rain_mm_3d),
        })
    return {"date": on.isoformat(), "synthetic": True, "fields": fields, "machines": machines,
            "plants": plants, "travel": {"method": "road_factor", "road_factor": 1.3, "speed_kmh": 25},
            "params": p, "time_limit_s": time_limit_s}


def burned_last_season(season: int) -> dict[str, bool | None]:
    f = LOCAL_S3 / "derived" / "burn_record.parquet"
    if not f.exists():
        return {}
    b = pd.read_parquet(f)
    b = b[b["season"] == season]
    # unharvested / unknown → None (no bonus, no penalty)
    return {r.field_id: (bool(r.burned) if r.harvested else None) for r in b.itertuples()}


def run(on: date, fields_path: Path, ingest: bool = False) -> Path:
    import geopandas as gpd

    p = params()
    if ingest:
        from .ingest import ingest_season

        new = ingest_season(fields_path, on.year)
        out = LOCAL_S3 / "derived" / "field_series.parquet"
        old = pd.read_parquet(out) if out.exists() else new.iloc[0:0]
        old = old[pd.to_datetime(old["date"]).dt.year != on.year]
        pd.concat([old, new]).sort_values(["field_id", "date"]).to_parquet(out, index=False)
    gdf = gpd.read_file(fields_path).sort_values("field_id").reset_index(drop=True)
    meta = field_meta(fields_path)
    series = pd.read_parquet(LOCAL_S3 / "derived" / "field_series.parquet")
    forecasts = forecast_fields(load_bundle(), series, meta, on)
    for r in forecasts:
        r["synthetic"] = False
    straw = {r.field_id: {"village_id": r.village_id, "straw_t": r.area_ha * float(p["straw_t_per_ha"])}
             for r in meta.itertuples()}
    vf = village_volumes(forecasts, straw, on, int(p["village_mc_draws"]), int(p["random_seed"]))

    lon, lat = gdf.to_crs("EPSG:32643").union_all().centroid.coords[0]
    import pyproj

    lon, lat = pyproj.Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True).transform(lon, lat)
    rain = daily_rain(lon, lat, on - timedelta(days=3), on)
    machines, plants, _ = fleet(1.0, gdf)
    state = build_state(on, gdf, forecasts, burned_last_season(on.year - 1),
                        rain_last_days(rain, on, 3), machines, plants)
    plan = plan_day(state).to_json_dict()

    out = OUTPUTS / "live" / on.isoformat()
    out.mkdir(parents=True, exist_ok=True)
    docs = {"forecast.json": (forecasts, "forecast"), "village_forecast.json": (vf, "village_forecast"),
            "planner_input.json": (state, "planner_input"), "plan.json": (plan, "plan")}
    for name, (doc, sch) in docs.items():
        jsonschema.validate(doc, schema(sch))
        (out / name).write_text(json.dumps(doc, indent=2, ensure_ascii=False))
        upload(out / name, f"outputs/live/{on.isoformat()}/{name}")
    print(json.dumps({"event": "live", "dir": str(out), "fields": len(forecasts),
                      "planned": plan["totals"], "solver": plan["solver"]["status"]}))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--fields", default=str(DATA / "fields" / "fields.geojson"))
    ap.add_argument("--ingest", action="store_true", help="refresh this season's imagery first")
    a = ap.parse_args()
    run(date.fromisoformat(a.date), Path(a.fields), a.ingest)


if __name__ == "__main__":
    main()
