"""Feature rows per (field, issue_date) using only observations ≤ issue_date.

Training: for each harvested field-season, issue dates every forecast_issue_every_days
from forecast_first_issue_mmdd until the bracket start. Target = days from the issue
date to the bracket midpoint; weight = 1 / (1 + bracket width in days).
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from .config import params

FEATURES = [
    "last_ndvi", "days_since_last", "max_ndvi", "max_ndvi_doy", "days_since_peak",
    "slope3", "ndvi_m7", "ndvi_m14", "ndvi_m21", "area_ha", "village", "doy", "n_clear",
    "drop_from_max",
]
CATEGORICAL = ["village"]


def _season_obs(obs: pd.DataFrame, season: int) -> tuple[np.ndarray, np.ndarray]:
    o = obs.dropna(subset=["ndvi"])
    d = pd.to_datetime(o["date"]).dt.date
    m = (d >= date(season, 6, 1)) & (d <= date(season + 1, 1, 31))
    o = o[m.values]
    days = np.array([(x - date(season, 1, 1)).days for x in pd.to_datetime(o["date"]).dt.date])
    order = np.argsort(days, kind="stable")
    return days[order], o["ndvi"].to_numpy(dtype=float)[order]


def _at_or_before(days, vals, t):
    i = np.searchsorted(days, t, side="right") - 1
    return float(vals[i]) if i >= 0 else np.nan


def features_at(days: np.ndarray, vals: np.ndarray, season: int, issue: date,
                area_ha: float, village: str) -> dict:
    t = (issue - date(season, 1, 1)).days
    k = np.searchsorted(days, t, side="right")
    d, v = days[:k], vals[:k]
    row = {"area_ha": area_ha, "village": village, "doy": issue.timetuple().tm_yday, "n_clear": int(k)}
    if k == 0:
        return row | {f: np.nan for f in FEATURES if f not in row}
    ip = int(np.argmax(v))
    slope = np.polyfit(d[-3:], v[-3:], 1)[0] if k >= 3 and d[-1] > d[-3] else np.nan
    return row | {
        "last_ndvi": float(v[-1]),
        "days_since_last": int(t - d[-1]),
        "max_ndvi": float(v[ip]),
        "max_ndvi_doy": int(d[ip]) + 1,
        "days_since_peak": int(t - d[ip]),
        "slope3": float(slope),
        "ndvi_m7": _at_or_before(d, v, t - 7),
        "ndvi_m14": _at_or_before(d, v, t - 14),
        "ndvi_m21": _at_or_before(d, v, t - 21),
        "drop_from_max": float(v[ip] - v[-1]),
    }


def issue_dates(season: int, until: date, p: dict | None = None) -> list[date]:
    p = p or params()
    m, dd = (int(x) for x in p["forecast_first_issue_mmdd"].split("-"))
    d, step, out = date(season, m, dd), int(p["forecast_issue_every_days"]), []
    while d < until:
        out.append(d)
        d += timedelta(days=step)
    return out


def training_rows(series: pd.DataFrame, labels: pd.DataFrame, meta: pd.DataFrame) -> pd.DataFrame:
    """meta: field_id → area_ha, village_id."""
    p = params()
    meta = meta.set_index("field_id")
    by_field = {fid: g for fid, g in series.groupby("field_id")}
    rows = []
    for _, lab in labels[labels["harvested"]].sort_values(["field_id", "season"]).iterrows():
        fid, season = lab["field_id"], int(lab["season"])
        if fid not in by_field or fid not in meta.index:
            continue
        lo, hi = pd.Timestamp(lab["harvest_lo"]).date(), pd.Timestamp(lab["harvest_hi"]).date()
        width = (hi - lo).days
        days, vals = _season_obs(by_field[fid], season)
        for d in issue_dates(season, lo, p):
            f = features_at(days, vals, season, d, float(meta.loc[fid, "area_ha"]), str(meta.loc[fid, "village_id"]))
            rows.append({"field_id": fid, "season": season, "issued_on": d,
                         "target": (lo - d).days + width / 2.0,
                         "weight": 1.0 / (1.0 + width), "harvest_lo": lo, "harvest_hi": hi, **f})
    return pd.DataFrame(rows)
