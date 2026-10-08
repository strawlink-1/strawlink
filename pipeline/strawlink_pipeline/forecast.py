"""LightGBM quantile models for harvest date (P10/P50/P90) + village volumes.

    python -m strawlink_pipeline.forecast --train --validate 2025

Train on 2022–2024, validate on 2025 (P50 MAE, [P10,P90] coverage, mean width),
then refit on 2022–2025 for live 2026. Quantile crossings are fixed by sorting.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from .config import DATA, LOCAL_S3, params, upload
from .features import CATEGORICAL, FEATURES, _season_obs, features_at, training_rows
from .labels import detect_harvest

MODEL_DIR = LOCAL_S3 / "models" / "harvest_lgbm"
QNAMES = ("p10", "p50", "p90")


def _lgb_params(alpha: float, seed: int) -> dict:
    return {
        "objective": "quantile", "alpha": alpha, "learning_rate": 0.05, "num_leaves": 15,
        "min_data_in_leaf": 10, "feature_fraction": 0.9, "bagging_fraction": 0.9,
        "bagging_freq": 1, "seed": seed, "deterministic": True, "num_threads": 1,
        "force_col_wise": True, "verbose": -1,
    }


def _xy(rows: pd.DataFrame, villages: list[str]) -> pd.DataFrame:
    X = rows[FEATURES].copy()
    X["village"] = pd.Categorical(X["village"].astype(str), categories=villages)
    return X


def train(rows: pd.DataFrame, rounds: int = 300) -> dict:
    p = params()
    villages = sorted(rows["village"].astype(str).unique())
    X = _xy(rows, villages)
    models = {}
    for name, a in zip(QNAMES, p["forecast_quantiles"]):
        ds = lgb.Dataset(X, rows["target"], weight=rows["weight"], categorical_feature=CATEGORICAL)
        models[name] = lgb.train(_lgb_params(float(a), int(p["random_seed"])), ds, num_boost_round=rounds)
    return {"models": models, "villages": villages}


def predict_days(bundle: dict, rows: pd.DataFrame) -> np.ndarray:
    X = _xy(rows, bundle["villages"])
    q = np.column_stack([bundle["models"][n].predict(X) for n in QNAMES])
    return np.sort(q, axis=1)  # fix quantile crossings


def metrics(rows: pd.DataFrame, q: np.ndarray) -> dict:
    """Coverage = share where the true bracket midpoint falls inside [P10, P90]."""
    t = rows["target"].to_numpy()
    return {
        "n": len(t),
        "p50_mae_days": round(float(np.mean(np.abs(q[:, 1] - t))), 2),
        "coverage_p10_p90": round(float(np.mean((t >= q[:, 0]) & (t <= q[:, 2]))), 3),
        "mean_width_days": round(float(np.mean(q[:, 2] - q[:, 0])), 2),
    }


def save(bundle: dict, version: str, meta: dict) -> Path:
    out = MODEL_DIR / version
    out.mkdir(parents=True, exist_ok=True)
    for n, m in bundle["models"].items():
        m.save_model(str(out / f"model_{n}.txt"))
    (out / "metadata.json").write_text(json.dumps({**meta, "villages": bundle["villages"],
                                                   "features": FEATURES}, indent=2, default=str))
    for f in out.iterdir():
        upload(f, f"models/harvest_lgbm/{version}/{f.name}")
    return out


def load_bundle(version: str | None = None) -> dict:
    if version is None:  # latest live model (validation models carry a -val suffix)
        version = sorted(p.name for p in MODEL_DIR.iterdir() if "-val" not in p.name)[-1]
    root = MODEL_DIR / version
    meta = json.loads((root / "metadata.json").read_text())
    return {"models": {n: lgb.Booster(model_file=str(root / f"model_{n}.txt")) for n in QNAMES},
            "villages": meta["villages"], "meta": meta}


def field_meta(fields_path: Path) -> pd.DataFrame:
    import geopandas as gpd

    g = gpd.read_file(fields_path)
    if "area_ha" not in g or g["area_ha"].isna().any():
        g["area_ha"] = g.to_crs("EPSG:32643").area / 10_000
    if "village_id" not in g:
        g["village_id"] = "V00"
    return pd.DataFrame(g[["field_id", "village_id", "area_ha"]])


def forecast_fields(bundle: dict, series: pd.DataFrame, meta: pd.DataFrame, issued_on: date) -> list[dict]:
    """Forecast rows (contract) for every field as of issued_on, using obs ≤ issued_on only."""
    p = params()
    season = issued_on.year
    s = series[pd.to_datetime(series["date"]).dt.date <= issued_on]
    by_field = {fid: g for fid, g in s.groupby("field_id")}
    width_ref = float(p.get("confidence_width_days", 21))
    rows, feats = [], []
    for _, m in meta.sort_values("field_id").iterrows():
        fid = m["field_id"]
        g = by_field.get(fid, s.iloc[0:0])
        h = detect_harvest(g, season, p) if len(g) else {"harvested": False}
        if h["harvested"]:
            # already harvested per imagery: the bracket is the window
            lo, hi = h["harvest_lo"], h["harvest_hi"]
            rows.append({"field_id": fid, "issued_on": issued_on.isoformat(), "p10": lo.isoformat(),
                         "p50": (lo + (hi - lo) / 2).isoformat(), "p90": hi.isoformat(),
                         "source": "satellite",
                         "confidence": round(max(0.0, 1 - (hi - lo).days / width_ref), 3)})
            continue
        days, vals = _season_obs(g, season)
        feats.append({"field_id": fid, **features_at(days, vals, season, issued_on,
                                                    float(m["area_ha"]), str(m["village_id"]))})
    if feats:
        F = pd.DataFrame(feats)
        q = predict_days(bundle, F)
        for fid, (a, b, c) in zip(F["field_id"], q):
            ds = [issued_on + timedelta(days=int(round(max(0.0, x)))) for x in (a, b, c)]
            rows.append({"field_id": fid, "issued_on": issued_on.isoformat(),
                         "p10": ds[0].isoformat(), "p50": ds[1].isoformat(), "p90": ds[2].isoformat(),
                         "source": "satellite",
                         "confidence": round(max(0.0, 1 - (c - a) / width_ref), 3)})
    return sorted(rows, key=lambda r: r["field_id"])


def main() -> None:
    from .labels import seasons_arg

    ap = argparse.ArgumentParser()
    ap.add_argument("--train", action="store_true")
    ap.add_argument("--train-seasons", default="2022-2024")
    ap.add_argument("--validate", type=int, default=2025)
    ap.add_argument("--fields", default=str(DATA / "fields" / "fields.geojson"))
    ap.add_argument("--version", default=None)
    a = ap.parse_args()
    series = pd.read_parquet(LOCAL_S3 / "derived" / "field_series.parquet")
    labels = pd.read_parquet(LOCAL_S3 / "derived" / "labels.parquet")
    meta = field_meta(Path(a.fields))
    rows = training_rows(series, labels, meta)
    tr_seasons = seasons_arg(a.train_seasons)
    tr = rows[rows["season"].isin(tr_seasons)]
    va = rows[rows["season"] == a.validate]
    report = {"train_rows": len(tr), "validate_rows": len(va)}
    version = a.version or f"v{date.today().strftime('%Y%m%d')}"
    if a.train and len(tr):
        b = train(tr)
        if len(va):
            report["validation"] = metrics(va, predict_days(b, va))
        # the as-of model the backtest replays with (never saw the validation season)
        save(b, f"{version}-val{a.validate}", {"trained_on": tr_seasons, **report})
    if a.train:
        full = rows[rows["season"].isin(tr_seasons + [a.validate])]
        b = train(full)
        out = save(b, version, {"trained_on": sorted(full["season"].unique().tolist()), **report})
        report["model_dir"] = str(out)
    out = LOCAL_S3 / "derived" / "forecast_report.json"
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps({"event": "forecast_report", **report}))


if __name__ == "__main__":
    main()
