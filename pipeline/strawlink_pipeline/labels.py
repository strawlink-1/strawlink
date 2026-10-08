"""Harvest brackets per field-season from clear NDVI observations.

Peak    = max NDVI between peak_window_mmdd (Aug 15 → Oct 15).
Harvest = first clear obs after the peak whose NDVI is < harvest_ndvi_max and has
          dropped by ≥ harvest_ndvi_drop from the highest clear obs in the previous
          harvest_lookback_days (always including the previous obs), confirmed by the
          next harvest_confirm_obs clear obs staying < harvest_ndvi_max.
Bracket = (previous clear date, this date]  → stored inclusive as
          harvest_lo = previous + 1 day, harvest_hi = this date.

    python -m strawlink_pipeline.labels --seasons 2022-2025
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta

import pandas as pd

from .config import LOCAL_S3, params


def seasons_arg(s: str) -> list[int]:
    if "-" in s:
        a, b = s.split("-")
        return list(range(int(a), int(b) + 1))
    return [int(x) for x in s.split(",")]


def _mmdd(season: int, mmdd: str) -> date:
    m, d = mmdd.split("-")
    return date(season, int(m), int(d))


def clear_obs(df: pd.DataFrame) -> pd.DataFrame:
    """Observations usable for labels: non-null NDVI, sorted by date, one per date."""
    df = df.dropna(subset=["ndvi"]).copy()
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)


def detect_harvest(obs: pd.DataFrame, season: int, p: dict | None = None) -> dict:
    """obs: one field's rows with columns date, ndvi (any season range)."""
    p = p or params()
    obs = clear_obs(obs)
    obs = obs[(obs["date"] >= date(season, 6, 1)) & (obs["date"] <= date(season + 1, 1, 31))]
    out = {"harvested": False, "harvest_lo": None, "harvest_hi": None,
           "peak_date": None, "peak_ndvi": None,
           "last_clear_image": obs["date"].iloc[-1] if len(obs) else None}
    lo, hi = (_mmdd(season, x) for x in p["peak_window_mmdd"])
    win = obs[(obs["date"] >= lo) & (obs["date"] <= hi)]
    if win.empty:
        return out
    ipk = win["ndvi"].idxmax()
    out["peak_date"], out["peak_ndvi"] = obs.loc[ipk, "date"], float(obs.loc[ipk, "ndvi"])
    after = obs.loc[ipk:].reset_index(drop=True)
    drop, ceil = float(p["harvest_ndvi_drop"]), float(p["harvest_ndvi_max"])
    look = timedelta(days=int(p.get("harvest_lookback_days", 0)))
    confirm = int(p.get("harvest_confirm_obs", 0))
    dates, vals = list(after["date"]), list(after["ndvi"])
    for k in range(1, len(after)):
        ref = max([vals[k - 1]] + [vals[j] for j in range(k - 1) if dates[j] >= dates[k] - look])
        if ref - vals[k] < drop or vals[k] >= ceil:
            continue
        nxt = vals[k + 1 : k + 1 + confirm]
        if any(v >= ceil for v in nxt):
            continue  # a one-scene dip (haze, shadow) that recovers is not a harvest
        out.update(harvested=True, harvest_lo=dates[k - 1] + timedelta(days=1), harvest_hi=dates[k])
        break
    return out


def label_all(series: pd.DataFrame, seasons: list[int]) -> pd.DataFrame:
    p = params()
    rows = []
    for fid, g in series.groupby("field_id", sort=True):
        for s in seasons:
            rows.append({"field_id": fid, "season": s, **detect_harvest(g, s, p)})
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2022-2025")
    a = ap.parse_args()
    series = pd.read_parquet(LOCAL_S3 / "derived" / "field_series.parquet")
    labels = label_all(series, seasons_arg(a.seasons))
    out = LOCAL_S3 / "derived" / "labels.parquet"
    labels.to_parquet(out, index=False)
    summary = labels.groupby("season")["harvested"].mean().round(3).to_dict()
    print(json.dumps({"event": "labels", "path": str(out), "harvested_share": summary}))


if __name__ == "__main__":
    main()
