"""Plant supply: weekly expected tonnes (P10/P50/P90) and depot fill projection."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from common import settings

from .planning import effective_forecast, haversine_km, plants


def _draw_days(fc: dict, n: int, rng) -> np.ndarray:
    epoch = date(1970, 1, 1)
    q = [(date.fromisoformat(fc[k]) - epoch).days for k in ("p10", "p50", "p90")]
    lo, hi = q[0] - (q[1] - q[0]) * 0.25, q[2] + (q[2] - q[1]) * 0.25
    return np.floor(np.interp(rng.random(n), [0, 0.1, 0.5, 0.9, 1], [lo, q[0], q[1], q[2], hi])).astype(int)


def supply(fields: list[dict], on: date, weeks: int) -> dict:
    p = settings.params()
    draws = int(p["village_mc_draws"])
    rng = np.random.default_rng(int(p["random_seed"]))
    radius = float(p["haul_radius_km"])
    pls = plants()
    meta = {pl["plant_id"]: pl for pl in settings.synthetic().get("plants", [])}
    epoch = date(1970, 1, 1)
    start = on - timedelta(days=on.weekday())
    week_starts = [start + timedelta(days=7 * k) for k in range(weeks)]
    out = []
    per_plant: dict[str, list[dict]] = {pl["plant_id"]: [] for pl in pls}
    for f in sorted(fields, key=lambda f: f["field_id"]):
        if f.get("cleared_on") or f.get("route") != "bale":
            continue
        reach = sorted((haversine_km(f["centroid"], pl["location"]), pl["plant_id"]) for pl in pls)
        reach = [r for r in reach if r[0] <= radius]
        if reach:
            per_plant[reach[0][1]].append(f)
    for pl in pls:
        pid = pl["plant_id"]
        weekly = np.zeros((draws, weeks))
        daily = np.zeros((draws, 7))
        on_i = (on - epoch).days
        for f in per_plant[pid]:
            fc = effective_forecast(f)
            if not fc:
                continue
            d = _draw_days(fc, draws, rng) + 1  # baled the day after harvest
            d = np.maximum(d, on_i)  # already-harvested straw arrives from today
            for k, ws in enumerate(week_starts):
                w0 = (ws - epoch).days
                weekly[:, k] += ((d >= w0) & (d < w0 + 7)) * float(f["straw_t"])
            for k in range(7):
                daily[:, k] += (d == on_i + k) * float(f["straw_t"])
        q = np.quantile(weekly, [0.1, 0.5, 0.9], axis=0)
        inflow = daily.mean(axis=0)
        fill, path = float(pl["fill_t"]), []
        for k in range(7):
            fill = max(0.0, fill + inflow[k] - pl["weekly_capacity_t"] / 7)
            path.append({"date": (on + timedelta(days=k)).isoformat(), "fill_t": round(fill, 1)})
        full_day = next((x["date"] for x in path if x["fill_t"] >= pl["depot_capacity_t"]), None)
        alert = full_day is not None and (date.fromisoformat(full_day) - on).days <= 2
        out.append({
            "plant_id": pid, "name": meta.get(pid, {}).get("name", pid), "location": pl["location"],
            "weekly_capacity_t": pl["weekly_capacity_t"], "depot_capacity_t": pl["depot_capacity_t"],
            "fill_t": pl["fill_t"], "fields_routed": len(per_plant[pid]),
            "weeks": [{"week_start": ws.isoformat(), "tonnes_p10": round(float(q[0, k]), 1),
                       "tonnes_p50": round(float(q[1, k]), 1), "tonnes_p90": round(float(q[2, k]), 1)}
                      for k, ws in enumerate(week_starts)],
            "depot_projection": path, "projected_full_on": full_day, "alert": alert,
            "synthetic": True,
        })
    return {"date": on.isoformat(), "plants": out,
            "method": "Bale-route fields go to the nearest plant within the haul radius; harvest dates drawn "
                      f"{draws}× from each field's P10/P50/P90 window; straw arrives the day after harvest."}
