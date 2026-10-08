"""Burn records per field-season (dNBR + FIRMS) and live burn_status for certificates.

Burned if, within burn_window_days after the harvest bracket, a clear observation
shows an NBR drop (pre − post) > burn_dnbr_threshold to a value < burn_post_nbr_max,
OR a FIRMS point falls inside the field buffered by firms_buffer_m in that window.
Burn data is used only for the loyalty bonus, backtest, certificates and training.

    python -m strawlink_pipeline.burns --seasons 2022-2025
"""

from __future__ import annotations

import argparse
import io
import json
import os
from datetime import date, timedelta

import pandas as pd

from .config import DATA, LOCAL_S3, params
from .labels import seasons_arg

FIRMS_SOURCES = ["VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "MODIS_SP"]


def _is_burn_drop(pre: float, post: float, p: dict) -> bool:
    return (pre - post) > float(p["burn_dnbr_threshold"]) and post < float(p["burn_post_nbr_max"])


def detect_burn(
    obs: pd.DataFrame,
    harvest_lo: date | None,
    harvest_hi: date | None,
    firms_dates: list[date] | None = None,
    p: dict | None = None,
) -> dict:
    """obs: one field's rows (date, nbr). Returns burned, burn_lo, burn_hi, evidence."""
    p = p or params()
    out = {"burned": False, "burn_lo": None, "burn_hi": None, "evidence": []}
    if harvest_hi is None:
        return out
    obs = obs.dropna(subset=["nbr"]).copy()
    obs["date"] = pd.to_datetime(obs["date"]).dt.date
    obs = obs.sort_values("date").drop_duplicates("date", keep="last").reset_index(drop=True)
    w_end = harvest_hi + timedelta(days=int(p["burn_window_days"]))

    bracket = None
    before = obs[obs["date"] < harvest_lo] if harvest_lo else obs.iloc[0:0]
    seq = obs[(obs["date"] >= harvest_hi) & (obs["date"] <= w_end)].reset_index(drop=True)
    if len(seq):
        # burned already inside the harvest bracket: the harvest obs itself looks charred
        if len(before) and _is_burn_drop(before["nbr"].iloc[-1], seq["nbr"].iloc[0], p):
            bracket = (harvest_lo, harvest_hi)
        for k in range(1, len(seq)):
            if bracket:
                break
            if _is_burn_drop(seq["nbr"].iloc[k - 1], seq["nbr"].iloc[k], p):
                bracket = (seq["date"].iloc[k - 1] + timedelta(days=1), seq["date"].iloc[k])
    if bracket:
        out.update(burned=True, burn_lo=bracket[0], burn_hi=bracket[1], evidence=["dnbr"])

    fd = sorted(d for d in (firms_dates or []) if (harvest_lo or harvest_hi) <= d <= w_end)
    if fd:
        out["burned"] = True
        out["evidence"] = sorted(set(out["evidence"]) | {"firms"})
        inside = [d for d in fd if bracket and bracket[0] <= d <= bracket[1]]
        d0 = inside[0] if inside else fd[0]
        out["burn_lo"] = out["burn_hi"] = d0  # FIRMS date narrows the bracket
    return out


def burn_status(obs: pd.DataFrame, after_date: date, p: dict | None = None) -> dict:
    """Certificate check after clearance: no_burn_detected | pending | burn_detected."""
    p = p or params()
    obs = obs.dropna(subset=["nbr"]).copy()
    obs["date"] = pd.to_datetime(obs["date"]).dt.date
    obs = obs.sort_values("date")
    pre = obs[obs["date"] <= after_date]
    post = obs[obs["date"] > after_date]
    ref = pre["nbr"].iloc[-1] if len(pre) else None
    dates = [d.isoformat() for d in post["date"]]
    for _, r in post.iterrows():
        if ref is not None and _is_burn_drop(ref, r["nbr"], p):
            return {"status": "burn_detected", "image_dates": dates}
        ref = r["nbr"]
    if len(post) >= int(p["no_burn_min_clear_obs"]):
        return {"status": "no_burn_detected", "image_dates": dates}
    return {"status": "pending", "image_dates": dates}


# ---------------------------------------------------------------- FIRMS


def fetch_firms(bbox, start: date, end: date, key: str | None = None) -> pd.DataFrame:
    """FIRMS area API, 10-day chunks, cached under raw/firms/. Needs FIRMS_MAP_KEY."""
    import requests

    key = key or os.environ.get("FIRMS_MAP_KEY")
    if not key:
        raise RuntimeError("FIRMS_MAP_KEY not set")
    cache = LOCAL_S3 / "raw" / "firms"
    cache.mkdir(parents=True, exist_ok=True)
    area = ",".join(f"{x:.4f}" for x in bbox)
    frames = []
    for src in FIRMS_SOURCES:
        d = start
        while d <= end:
            n = min(10, (end - d).days + 1)
            f = cache / f"{src}_{area.replace(',', '_')}_{d.isoformat()}_{n}.csv"
            if not f.exists():
                url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{src}/{area}/{n}/{d.isoformat()}"
                r = requests.get(url, timeout=60)
                r.raise_for_status()
                f.write_text(r.text)
            txt = f.read_text()
            if txt.strip() and not txt.lower().startswith("invalid"):
                df = pd.read_csv(io.StringIO(txt))
                if len(df):
                    df["source"] = src
                    frames.append(df[["latitude", "longitude", "acq_date", "source"]])
            d += timedelta(days=n)
    if not frames:
        return pd.DataFrame(columns=["latitude", "longitude", "acq_date", "source"])
    return pd.concat(frames, ignore_index=True)


def firms_by_field(fields_gdf, firms: pd.DataFrame, buffer_m: float) -> dict[str, list[date]]:
    import geopandas as gpd

    if firms.empty:
        return {}
    pts = gpd.GeoDataFrame(
        firms, geometry=gpd.points_from_xy(firms.longitude, firms.latitude), crs="EPSG:4326"
    ).to_crs("EPSG:32643")
    buf = fields_gdf.to_crs("EPSG:32643")[["field_id", "geometry"]].copy()
    buf["geometry"] = buf.buffer(buffer_m)
    j = gpd.sjoin(pts, buf, predicate="within")
    out: dict[str, list[date]] = {}
    for fid, g in j.groupby("field_id"):
        out[fid] = sorted({date.fromisoformat(str(x)) for x in g["acq_date"]})
    return out


# ---------------------------------------------------------------- CLI


def build_records(series: pd.DataFrame, labels: pd.DataFrame, firms: dict[str, list[date]]) -> pd.DataFrame:
    p = params()
    rows = []
    by_field = {fid: g for fid, g in series.groupby("field_id")}
    for _, lab in labels.sort_values(["field_id", "season"]).iterrows():
        g = by_field.get(lab["field_id"], series.iloc[0:0])
        hlo = lab["harvest_lo"] if lab["harvested"] else None
        hhi = lab["harvest_hi"] if lab["harvested"] else None
        b = detect_burn(g, hlo, hhi, firms.get(lab["field_id"]), p)
        rows.append({
            "field_id": lab["field_id"], "season": int(lab["season"]),
            "harvested": bool(lab["harvested"]),
            "harvest_lo": hlo, "harvest_hi": hhi, **b,
            "last_clear_image": lab["last_clear_image"],
        })
    return pd.DataFrame(rows)


def main() -> None:
    import geopandas as gpd

    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2022-2025")
    ap.add_argument("--no-firms", action="store_true")
    a = ap.parse_args()
    p = params()
    seasons = seasons_arg(a.seasons)
    series = pd.read_parquet(LOCAL_S3 / "derived" / "field_series.parquet")
    labels = pd.read_parquet(LOCAL_S3 / "derived" / "labels.parquet")
    labels = labels[labels["season"].isin(seasons)]
    firms_dates: dict[str, list[date]] = {}
    if not a.no_firms and os.environ.get("FIRMS_MAP_KEY"):
        fields = gpd.read_file(DATA / "fields" / "fields.geojson")
        bbox = tuple(fields.total_bounds)
        for s in seasons:
            fr = fetch_firms(bbox, date(s, 9, 15), date(s, 12, 15))
            for fid, ds in firms_by_field(fields, fr, float(p["firms_buffer_m"])).items():
                firms_dates.setdefault(fid, []).extend(ds)
    else:
        print(json.dumps({"event": "firms_skipped", "reason": "no FIRMS_MAP_KEY or --no-firms"}))
    rec = build_records(series, labels, firms_dates)
    out = LOCAL_S3 / "derived" / "burn_record.parquet"
    rec.to_parquet(out, index=False)
    print(json.dumps({"event": "burn_record", "path": str(out),
                      "burned_share": rec.groupby("season")["burned"].mean().round(3).to_dict()}))


if __name__ == "__main__":
    main()
