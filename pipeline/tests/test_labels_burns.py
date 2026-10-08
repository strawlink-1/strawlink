from datetime import date, timedelta

import numpy as np
import pandas as pd

from strawlink_pipeline.burns import burn_status, detect_burn
from strawlink_pipeline.labels import detect_harvest


def series(points: dict[str, float], col="ndvi") -> pd.DataFrame:
    return pd.DataFrame({"date": list(points), col: list(points.values())})


def curve(harvest: date, start=date(2025, 8, 1), end=date(2025, 12, 10), step=5, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    rows, d = {}, start
    while d <= end:
        v = 0.82 if d < harvest else 0.25
        rows[d.isoformat()] = float(np.clip(v + rng.normal(0, noise), -1, 1))
        d += timedelta(days=step)
    return series(rows)


def test_clean_drop():
    r = detect_harvest(curve(date(2025, 10, 22)), 2025)
    assert r["harvested"]
    assert r["harvest_lo"] <= date(2025, 10, 22) <= r["harvest_hi"]
    assert (r["harvest_hi"] - r["harvest_lo"]).days < 5


def test_noisy_drop():
    r = detect_harvest(curve(date(2025, 10, 22), noise=0.04, seed=3), 2025)
    assert r["harvested"]
    assert r["harvest_lo"] <= date(2025, 10, 22) <= r["harvest_hi"]


def test_cloudy_gap_widens_bracket():
    s = curve(date(2025, 10, 22))
    d = pd.to_datetime(s["date"]).dt.date
    s = s[(d < date(2025, 10, 10)) | (d > date(2025, 11, 2))]  # 3-week cloud gap
    r = detect_harvest(s, 2025)
    assert r["harvested"]
    assert r["harvest_lo"] <= date(2025, 10, 22) <= r["harvest_hi"]
    assert (r["harvest_hi"] - r["harvest_lo"]).days >= 20


def test_no_drop():
    s = curve(date(2026, 3, 1))  # never harvested in window
    r = detect_harvest(s, 2025)
    assert not r["harvested"] and r["harvest_lo"] is None


def test_gradual_senescence_not_a_harvest():
    rows = {}
    d = date(2025, 8, 1)
    v = 0.82
    while d <= date(2025, 12, 10):
        rows[d.isoformat()] = v
        if d > date(2025, 9, 20):
            v = max(0.5, v - 0.03)
        d += timedelta(days=5)
    assert not detect_harvest(series(rows), 2025)["harvested"]


# ---------------- burns


def nbr(points):
    return series(points, "nbr")


def test_burn_after_harvest():
    s = nbr({"2025-10-10": 0.5, "2025-10-20": 0.18, "2025-10-25": 0.17, "2025-10-30": -0.05, "2025-11-04": -0.03})
    r = detect_burn(s, date(2025, 10, 11), date(2025, 10, 20))
    assert r["burned"] and r["evidence"] == ["dnbr"]
    assert r["burn_lo"] == date(2025, 10, 26) and r["burn_hi"] == date(2025, 10, 30)


def test_no_burn_stubble():
    s = nbr({"2025-10-10": 0.5, "2025-10-20": 0.18, "2025-10-25": 0.16, "2025-10-30": 0.15, "2025-11-04": 0.2})
    r = detect_burn(s, date(2025, 10, 11), date(2025, 10, 20))
    assert not r["burned"] and r["evidence"] == []


def test_burn_inside_harvest_bracket():
    s = nbr({"2025-10-10": 0.5, "2025-10-20": -0.05, "2025-10-25": -0.04})
    r = detect_burn(s, date(2025, 10, 11), date(2025, 10, 20))
    assert r["burned"] and (r["burn_lo"], r["burn_hi"]) == (date(2025, 10, 11), date(2025, 10, 20))


def test_burn_outside_window_ignored():
    s = nbr({"2025-10-10": 0.5, "2025-10-20": 0.18, "2025-11-30": -0.05})
    assert not detect_burn(s, date(2025, 10, 11), date(2025, 10, 20))["burned"]


def test_firms_only_and_narrowing():
    s = nbr({"2025-10-10": 0.5, "2025-10-20": 0.18, "2025-10-25": 0.17})
    r = detect_burn(s, date(2025, 10, 11), date(2025, 10, 20), [date(2025, 10, 23)])
    assert r["burned"] and r["evidence"] == ["firms"] and r["burn_lo"] == date(2025, 10, 23)
    s2 = nbr({"2025-10-10": 0.5, "2025-10-20": 0.18, "2025-10-25": 0.17, "2025-10-30": -0.05})
    r2 = detect_burn(s2, date(2025, 10, 11), date(2025, 10, 20), [date(2025, 10, 28)])
    assert r2["evidence"] == ["dnbr", "firms"] and r2["burn_lo"] == r2["burn_hi"] == date(2025, 10, 28)


def test_not_harvested_never_burned():
    assert not detect_burn(nbr({"2025-10-10": 0.5}), None, None, [date(2025, 10, 12)])["burned"]


def test_burn_status():
    after = date(2026, 10, 20)
    pending = nbr({"2026-10-18": 0.18, "2026-10-23": 0.17})
    assert burn_status(pending, after)["status"] == "pending"
    clean = nbr({"2026-10-18": 0.18, "2026-10-23": 0.17, "2026-10-28": 0.19})
    assert burn_status(clean, after)["status"] == "no_burn_detected"
    burnt = nbr({"2026-10-18": 0.18, "2026-10-23": -0.05})
    assert burn_status(burnt, after)["status"] == "burn_detected"


def test_gradual_then_harvest_is_detected():
    # real-world pattern (Sangrur 2025): senescence then harvest, no single 0.25 step
    s = series({"2025-09-13": 0.84, "2025-10-13": 0.68, "2025-10-18": 0.60, "2025-10-20": 0.51,
                "2025-10-23": 0.45, "2025-11-02": 0.23, "2025-11-07": 0.21})
    r = detect_harvest(s, 2025)
    assert r["harvested"] and (r["harvest_lo"], r["harvest_hi"]) == (date(2025, 10, 24), date(2025, 11, 2))


def test_one_scene_haze_dip_is_not_harvest():
    s = series({"2025-09-13": 0.84, "2025-09-28": 0.40, "2025-10-03": 0.82, "2025-10-20": 0.80,
                "2025-10-28": 0.25, "2025-11-02": 0.22})
    r = detect_harvest(s, 2025)
    assert r["harvest_hi"] == date(2025, 10, 28)
