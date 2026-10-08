"""QA plots for manual label checks: NDVI/NBR series with harvest + burn brackets.

    python -m strawlink_pipeline.qa --season 2025 --n 20
"""

from __future__ import annotations

import argparse
import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from .config import LOCAL_S3, OUTPUTS, params  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--n", type=int, default=20)
    a = ap.parse_args()
    p = params()
    series = pd.read_parquet(LOCAL_S3 / "derived" / "field_series.parquet")
    series["date"] = pd.to_datetime(series["date"])
    series = series[series["date"].dt.year == a.season]
    rec = pd.read_parquet(LOCAL_S3 / "derived" / "burn_record.parquet")
    rec = rec[rec["season"] == a.season].set_index("field_id")
    ids = sorted(series["field_id"].unique())
    rng = np.random.default_rng(int(p["random_seed"]))
    pick = sorted(rng.choice(ids, size=min(a.n, len(ids)), replace=False))
    cols = 4
    rows = int(np.ceil(len(pick) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(4.2 * cols, 2.6 * rows), sharey=True, squeeze=False)
    for ax, fid in zip(axes.ravel(), pick):
        g = series[series["field_id"] == fid]
        ax.plot(g["date"], g["ndvi"], "o-", ms=3, color="#2a7", label="NDVI")
        ax.plot(g["date"], g["nbr"], "o-", ms=3, color="#a52", label="NBR")
        ax.axhline(float(p["harvest_ndvi_max"]), color="#999", lw=0.7, ls=":")
        if fid in rec.index:
            r = rec.loc[fid]
            if r["harvested"]:
                ax.axvspan(pd.Timestamp(r["harvest_lo"]), pd.Timestamp(r["harvest_hi"]), color="#2a7", alpha=0.2)
            if r["burned"]:
                ax.axvspan(pd.Timestamp(r["burn_lo"]), pd.Timestamp(r["burn_hi"]) + pd.Timedelta(days=1),
                           color="#d33", alpha=0.25)
            title = f"{fid} {'H' if r['harvested'] else '-'} {'B:' + ','.join(r['evidence']) if r['burned'] else ''}"
        else:
            title = fid
        ax.set_title(title, fontsize=9)
        ax.tick_params(labelsize=7)
    for ax in axes.ravel()[len(pick):]:
        ax.axis("off")
    axes[0, 0].legend(fontsize=7)
    fig.tight_layout()
    out = OUTPUTS / "qa" / f"labels_{a.season}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=110)
    print(json.dumps({"event": "qa", "path": str(out), "fields": len(pick)}))


if __name__ == "__main__":
    main()
