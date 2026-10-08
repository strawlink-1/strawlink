"""2025 day-by-day replay: StrawLink vs first-come baseline at three fleet sizes.

    python -m strawlink_pipeline.backtest --season 2025 --scales 0.75,1.0,1.25 --workers 6

- Ground truth: actual harvest = harvest-bracket midpoint; burn date = burn_lo.
- Each day d, StrawLink sees only forecasts made from imagery ≤ d (validation model
  trained without the season); baseline sees a field only the day after its actual
  harvest. Rain = Open-Meteo archive at the block centroid.
- Execute day-1 stops only; a stop succeeds iff the field is actually harvested by d
  and dry. Burning is exogenous: a field burns at burn_lo unless already cleared;
  a burned field is "reached" if cleared strictly before burn_lo.
- confirm_rate (sensitivity, default 0): share of fields confirmed 2 days before
  harvest. Reported separately, never mixed into the headline.
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from strawlink_planner import plan_day, plan_day_baseline

from .config import DATA, LOCAL_S3, OUTPUTS, params, schema, upload
from .forecast import field_meta, forecast_fields, load_bundle
from .live import build_state, fleet
from .volumes import village_volumes, week_start


@dataclass
class Truth:
    harvest: dict[str, date]       # actual harvest (bracket midpoint)
    burn: dict[str, date]          # burn_lo for burned fields
    straw: dict[str, float]
    deadline: dict[str, date]


def _mmdd(season: int, s: str) -> date:
    m, d = s.split("-")
    return date(season, int(m), int(d))


def load_truth(season: int, meta: pd.DataFrame, gdf) -> Truth:
    p = params()
    rec = pd.read_parquet(LOCAL_S3 / "derived" / "burn_record.parquet")
    rec = rec[rec["season"] == season]
    harvest, burn = {}, {}
    for r in rec.itertuples():
        if r.harvested:
            lo, hi = pd.Timestamp(r.harvest_lo).date(), pd.Timestamp(r.harvest_hi).date()
            harvest[r.field_id] = lo + timedelta(days=(hi - lo).days // 2)
        if r.burned and r.burn_lo is not None:
            burn[r.field_id] = pd.Timestamp(r.burn_lo).date()
    default = date.fromisoformat(str(p["sowing_deadline_default"])).replace(year=season)
    straw = {r.field_id: float(r.area_ha) * float(p["straw_t_per_ha"]) for r in meta.itertuples()}
    deadline = {}
    for _, f in gdf.iterrows():
        d = f.get("sowing_deadline")
        deadline[f["field_id"]] = date.fromisoformat(str(d)[:10]).replace(year=season) if d else default
    return Truth(harvest, burn, straw, deadline)


def precompute_forecasts(season: int, days: list[date], meta, series) -> dict[date, list[dict]]:
    bundle = load_bundle(_val_version(season))
    return {d: forecast_fields(bundle, series, meta, d) for d in days}


def _val_version(season: int) -> str:
    root = LOCAL_S3 / "models" / "harvest_lgbm"
    vs = sorted(p.name for p in root.iterdir() if p.name.endswith(f"-val{season}"))
    if not vs:
        raise SystemExit(f"no validation model for {season}: run forecast --train --validate {season}")
    return vs[-1]


def _confirmed(fc: list[dict], truth: Truth, d: date, chosen: set[str], lead_days: int) -> list[dict]:
    out = []
    for r in fc:
        h = truth.harvest.get(r["field_id"])
        if r["field_id"] in chosen and h and d >= h - timedelta(days=lead_days):
            r = {**r, "p10": h.isoformat(), "p50": h.isoformat(), "p90": h.isoformat(),
                 "source": "confirmed", "confidence": 1.0}
        out.append(r)
    return out


def simulate(job: dict) -> dict:
    p = params()
    policy, scale = job["policy"], job["scale"]
    truth: Truth = job["truth"]
    gdf, days, fcs, rain = job["gdf"], job["days"], job["forecasts"], job["rain"]
    confirm_rate = job.get("confirm_rate", 0.0)
    bookings_parity = job.get("bookings_parity", True)
    machines, plants, _ = fleet(scale, gdf)
    plant_fill = {pl["plant_id"]: float(pl["fill_t"]) for pl in plants}
    rng = np.random.default_rng(int(p["random_seed"]))
    ids = sorted(truth.straw)
    chosen = {f for f in ids if rng.random() < confirm_rate}
    burned_last = job["burned_last"]
    thr = float(p["rain_wet_threshold_mm"])
    variant = policy + (f"_confirm{confirm_rate}" if confirm_rate else "") + ("" if bookings_parity else "_satonly")
    plan_dir = OUTPUTS / "backtest" / "plans" / variant / str(scale)
    plan_dir.mkdir(parents=True, exist_ok=True)

    cleared: dict[str, date] = {}
    burned: dict[str, date] = {}
    daily = []
    for d in days:
        for fid, b in truth.burn.items():  # burns happen at the start of burn_lo
            if fid not in cleared and fid not in burned and b <= d:
                burned[fid] = b
        rain3 = sum(rain.get(d - timedelta(days=k), 0.0) for k in range(3))
        wet_today = rain3 >= thr
        # Both policies receive the same farmer bookings: a field is booked the day after its actual
        # harvest. StrawLink additionally sees satellite forecasts for fields not yet booked.
        fc = []
        for r in fcs[d]:
            h = truth.harvest.get(r["field_id"])
            if h and h < d and (policy == "baseline" or bookings_parity):
                r = {**r, "p10": h.isoformat(), "p50": h.isoformat(), "p90": h.isoformat(), "source": "confirmed"}
            fc.append(r)
        if policy == "strawlink" and chosen:
            fc = _confirmed(fc, truth, d, chosen, 2)
        fc = [r for r in fc if r["field_id"] not in burned]
        status = {f: "cleared" for f in cleared}
        pls = [{**pl, "fill_t": round(min(pl["depot_capacity_t"], plant_fill[pl["plant_id"]]), 3)} for pl in plants]
        state = build_state(d, gdf[~gdf["field_id"].isin(burned)], fc, burned_last, rain3, machines, pls,
                            status, time_limit_s=float(p["backtest_time_limit_s"]), deadlines=truth.deadline)
        plan = (plan_day if policy == "strawlink" else plan_day_baseline)(state).to_json_dict()
        (plan_dir / f"{d.isoformat()}.json").write_text(json.dumps(plan))

        ok_fields = set()
        for a in plan["assignments"]:
            if a["type"] == "truck":
                continue
            for s in a["stops"]:
                h = truth.harvest.get(s["field_id"])
                if h is not None and h <= d and not wet_today and s["field_id"] not in cleared:
                    cleared[s["field_id"]] = d
                    ok_fields.add(s["field_id"])
        for a in plan["assignments"]:
            for dl, st in zip(a["deliveries"], a["stops"]):
                if st["field_id"] in ok_fields:
                    plant_fill[dl["plant_id"]] += dl["tonnes"]
        for pl in plants:  # plants consume a seventh of weekly capacity per day
            plant_fill[pl["plant_id"]] = max(0.0, plant_fill[pl["plant_id"]] - pl["weekly_capacity_t"] / 7)
        daily.append({"date": d.isoformat(), "cleared_fields": len(cleared),
                      "cleared_t": round(sum(truth.straw[f] for f in cleared), 2),
                      "at_risk": int(plan["totals"]["fields_at_risk"])})

    replay_dir = OUTPUTS / "backtest" / "replay" / variant
    replay_dir.mkdir(parents=True, exist_ok=True)
    replay = {"policy": policy, "fleet_scale": scale, "dates": [d.isoformat() for d in days],
              "cleared": {f: c.isoformat() for f, c in sorted(cleared.items())},
              "burned": {f: b.isoformat() for f, b in sorted(burned.items())},
              "harvest": {f: h.isoformat() for f, h in sorted(truth.harvest.items())}, "synthetic_fleet": True}
    (replay_dir / f"{scale}.json").write_text(json.dumps(replay))
    upload(replay_dir / f"{scale}.json", f"outputs/backtest/replay/{replay_dir.name}/{scale}.json")

    burned_truth = sorted(truth.burn)
    reached = [f for f in burned_truth if f in cleared and cleared[f] < truth.burn[f]]
    in_time = sum(truth.straw[f] for f, c in cleared.items()
                  if c <= truth.deadline[f] and (f not in truth.burn or c < truth.burn[f]))
    return {
        "fleet_scale": scale, "policy": policy,
        "reach_rate": round(len(reached) / len(burned_truth), 4) if burned_truth else 0.0,
        "burned_fields_total": len(burned_truth), "burned_fields_reached": len(reached),
        "tonnes_cleared_in_time": round(in_time, 2),
        "window_coverage": job.get("window_coverage") if policy == "strawlink" else None,
        "village_volume_mape": job.get("village_mape") if policy == "strawlink" else None,
        "daily": daily, **({"confirm_rate": confirm_rate} if confirm_rate else {}),
        **({} if bookings_parity else {"variant": "satellite_only"}),
    }


def window_coverage(fcs: dict[date, list[dict]], truth: Truth) -> float | None:
    """Share of pre-harvest satellite forecasts whose [P10, P90] contains the actual harvest."""
    hit = n = 0
    for d, rows in fcs.items():
        for r in rows:
            h = truth.harvest.get(r["field_id"])
            if h is None or h <= d:
                continue
            n += 1
            hit += r["p10"] <= h.isoformat() <= r["p90"]
    return round(hit / n, 4) if n else None


def village_mape(fcs: dict[date, list[dict]], truth: Truth, meta: pd.DataFrame) -> float | None:
    """Weekly village P50 issued 7 days before the week vs actual harvested tonnes."""
    p = params()
    straw = {r.field_id: {"village_id": r.village_id, "straw_t": truth.straw[r.field_id]} for r in meta.itertuples()}
    actual: dict[tuple[str, date], float] = {}
    for f, h in truth.harvest.items():
        if f in straw:
            k = (straw[f]["village_id"], week_start(h))
            actual[k] = actual.get(k, 0.0) + straw[f]["straw_t"]
    errs = []
    for d, rows in fcs.items():
        if d.weekday() != 0:
            continue
        target = d + timedelta(days=7)
        vv = village_volumes(rows, straw, d, int(p["village_mc_draws"]), int(p["random_seed"]))
        pred = {r["village_id"]: r["tonnes_p50"] for r in vv if r["week_start"] == target.isoformat()}
        for (vid, wk), t in actual.items():
            if wk == target and t > 0:
                errs.append(abs(pred.get(vid, 0.0) - t) / t)
    return round(float(np.mean(errs)), 4) if errs else None


def main() -> None:
    import geopandas as gpd
    import jsonschema

    from .weather import daily_rain

    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--scales", default="0.75,1.0,1.25")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--fields", default=str(DATA / "fields" / "fields.geojson"))
    ap.add_argument("--every", type=int, default=1, help="simulate every n-th day (speed)")
    ap.add_argument("--confirm-rate", type=float, default=0.0, help="sensitivity run, reported separately")
    ap.add_argument("--satellite-only", action="store_true",
                    help="StrawLink without farmer bookings (information handicap vs baseline); reported separately")
    a = ap.parse_args()
    p = params()
    season = a.season
    fields_path = Path(a.fields)
    gdf = gpd.read_file(fields_path).sort_values("field_id").reset_index(drop=True)
    meta = field_meta(fields_path)
    series = pd.read_parquet(LOCAL_S3 / "derived" / "field_series.parquet")
    truth = load_truth(season, meta, gdf)
    start, end = _mmdd(season, p["backtest_start_mmdd"]), _mmdd(season, p["backtest_end_mmdd"])
    days = [start + timedelta(days=k) for k in range(0, (end - start).days + 1, a.every)]
    print(json.dumps({"event": "forecasting", "days": len(days)}), flush=True)
    fcs = precompute_forecasts(season, days, meta, series)
    c = gdf.to_crs("EPSG:32643").union_all().centroid
    import pyproj

    lon, lat = pyproj.Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True).transform(c.x, c.y)
    rain = daily_rain(lon, lat, start - timedelta(days=3), end)
    rec = pd.read_parquet(LOCAL_S3 / "derived" / "burn_record.parquet")
    prev = rec[rec["season"] == season - 1]
    burned_last = {r.field_id: (bool(r.burned) if r.harvested else None) for r in prev.itertuples()}
    cov, mape = window_coverage(fcs, truth), village_mape(fcs, truth, meta)

    scales = [float(x) for x in a.scales.split(",")]
    jobs = [{"policy": pol, "scale": s, "season": season, "truth": truth, "gdf": gdf, "days": days,
             "forecasts": fcs, "rain": rain, "burned_last": burned_last, "confirm_rate": a.confirm_rate,
             "window_coverage": cov, "village_mape": mape,
             "bookings_parity": not a.satellite_only}
            for s in scales for pol in ("strawlink", "baseline")]
    with ProcessPoolExecutor(max_workers=max(1, min(a.workers, len(jobs)))) as ex:
        results = list(ex.map(simulate, jobs))

    name = ("backtest_result.json" if not (a.confirm_rate or a.satellite_only)
            else f"backtest_sensitivity_{'satonly' if a.satellite_only else f'confirm{a.confirm_rate}'}.json")
    out = OUTPUTS / "backtest" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    if not (a.confirm_rate or a.satellite_only):
        jsonschema.validate(results, schema("backtest_result"))
    out.write_text(json.dumps(results, indent=2))
    upload(out, f"outputs/backtest/{name}")
    for r in results:
        print(json.dumps({k: r[k] for k in ("policy", "fleet_scale", "reach_rate", "burned_fields_reached",
                                            "burned_fields_total", "tonnes_cleared_in_time")}))
    print(json.dumps({"event": "backtest", "path": str(out), "window_coverage": cov, "village_mape": mape,
                      "fields": len(truth.straw), "harvested": len(truth.harvest), "burned": len(truth.burn),
                      "rain_days": sum(1 for v in rain.values() if v >= 1)}))


if __name__ == "__main__":
    main()
