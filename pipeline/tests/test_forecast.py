from datetime import date, timedelta

import numpy as np
import pandas as pd

from strawlink_pipeline.features import training_rows
from strawlink_pipeline.forecast import metrics, predict_days, train
from strawlink_pipeline.volumes import village_volumes


def _synthetic_world(n_fields=30, seasons=(2022, 2023, 2024, 2025), seed=0):
    rng = np.random.default_rng(seed)
    series, labels = [], []
    for i in range(n_fields):
        fid = f"F{i + 1:04d}"
        for s in seasons:
            h = date(s, 10, 10) + timedelta(days=int(rng.integers(0, 25)))
            d = date(s, 8, 1)
            while d <= date(s, 12, 10):
                senesce = max(0, (d - (h - timedelta(days=25))).days) * 0.008
                v = (0.85 - senesce) if d < h else 0.22
                series.append({"field_id": fid, "date": d.isoformat(), "ndvi": v + rng.normal(0, 0.02)})
                d += timedelta(days=5)
            labels.append({"field_id": fid, "season": s, "harvested": True,
                           "harvest_lo": h - timedelta(days=2), "harvest_hi": h + timedelta(days=2)})
    meta = pd.DataFrame({"field_id": [f"F{i + 1:04d}" for i in range(n_fields)],
                         "village_id": [f"V{i % 3}" for i in range(n_fields)], "area_ha": 1.5})
    return pd.DataFrame(series), pd.DataFrame(labels), meta


def test_quantiles_sorted_and_reasonable():
    s, l, m = _synthetic_world()
    rows = training_rows(s, l, m)
    tr, va = rows[rows.season < 2025], rows[rows.season == 2025]
    b = train(tr, rounds=100)
    q = predict_days(b, va)
    assert np.all(q[:, 0] <= q[:, 1]) and np.all(q[:, 1] <= q[:, 2])
    r = metrics(va, q)
    assert r["p50_mae_days"] < 10
    assert 0 <= r["coverage_p10_p90"] <= 1


def test_training_uses_only_past_issue_dates():
    s, l, m = _synthetic_world(n_fields=3, seasons=(2024,))
    rows = training_rows(s, l, m)
    assert (pd.to_datetime(rows.issued_on) < pd.to_datetime(rows.harvest_lo)).all()
    assert (rows.target > 0).all()


def test_coverage_computed_correctly():
    rows = pd.DataFrame({"target": [5.0, 10.0, 20.0, 1.0]})
    q = np.array([[4, 5, 6], [11, 12, 13], [15, 20, 20], [0, 1, 2]], dtype=float)
    r = metrics(rows, q)
    assert r["coverage_p10_p90"] == 0.75
    assert r["p50_mae_days"] == round((0 + 2 + 0 + 0) / 4, 2)
    assert r["mean_width_days"] == round((2 + 2 + 5 + 2) / 4, 2)


def test_village_volumes_conserve_tonnes():
    fc = [{"field_id": "F1", "p10": "2026-10-10", "p50": "2026-10-15", "p90": "2026-10-25"},
          {"field_id": "F2", "p10": "2026-10-20", "p50": "2026-10-20", "p90": "2026-10-20"}]
    fields = {"F1": {"village_id": "V1", "straw_t": 10.0}, "F2": {"village_id": "V1", "straw_t": 5.0}}
    out = village_volumes(fc, fields, date(2026, 10, 8), 500, 42)
    assert all(r["tonnes_p10"] <= r["tonnes_p50"] <= r["tonnes_p90"] for r in out)
    assert village_volumes(fc, fields, date(2026, 10, 8), 500, 42) == out  # deterministic
    wk = {r["week_start"]: r for r in out}
    assert wk["2026-10-19"]["tonnes_p10"] >= 5.0  # the confirmed field always lands that week
