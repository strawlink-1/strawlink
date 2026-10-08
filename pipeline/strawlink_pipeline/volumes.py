"""Village weekly straw volumes from per-field P10/P50/P90 harvest windows.

Each field gets a piecewise-linear CDF through (p10, .1), (p50, .5), (p90, .9),
with tails extended by a quarter of the adjacent inner gap. Monte-Carlo draws of
harvest dates are summed into straw tonnes per (village, ISO week) → P10/P50/P90.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np


def _inverse_cdf(u: np.ndarray, p10: float, p50: float, p90: float) -> np.ndarray:
    lo = p10 - (p50 - p10) * 0.25
    hi = p90 + (p90 - p50) * 0.25
    xs = np.array([lo, p10, p50, p90, hi])
    qs = np.array([0.0, 0.1, 0.5, 0.9, 1.0])
    return np.interp(u, qs, xs)


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def village_volumes(
    forecasts: list[dict],
    fields: dict[str, dict],
    issued_on: date,
    draws: int,
    seed: int,
) -> list[dict]:
    """forecasts: rows of forecast contract; fields: field_id → {village_id, straw_t}."""
    rng = np.random.default_rng(seed)
    epoch = date(1970, 1, 1)
    per_draw: dict[tuple[str, date], np.ndarray] = {}
    for row in sorted(forecasts, key=lambda r: r["field_id"]):
        f = fields.get(row["field_id"])
        if f is None:
            continue
        q = [(date.fromisoformat(row[k]) - epoch).days for k in ("p10", "p50", "p90")]
        days = np.floor(_inverse_cdf(rng.random(draws), *q)).astype(int)
        for d_int in np.unique(days):
            wk = week_start(epoch + timedelta(days=int(d_int)))
            key = (f["village_id"], wk)
            arr = per_draw.setdefault(key, np.zeros(draws))
            arr += (days == d_int) * float(f["straw_t"])
    out = []
    for (vid, wk), arr in sorted(per_draw.items()):
        p10, p50, p90 = np.quantile(arr, [0.1, 0.5, 0.9])
        out.append(
            {
                "village_id": vid,
                "issued_on": issued_on.isoformat(),
                "week_start": wk.isoformat(),
                "tonnes_p10": round(float(p10), 2),
                "tonnes_p50": round(float(p50), 2),
                "tonnes_p90": round(float(p90), 2),
            }
        )
    return out
