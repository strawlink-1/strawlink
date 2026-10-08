"""Per-field NDVI/NBR series from Sentinel-2 L2A (Earth Search).

    python -m strawlink_pipeline.ingest --season 2025 [--fields data/fields/fields.geojson]

- Only the field bbox window is read (dask, one date at a time), at 10 m in UTM 43N.
- SCL mask drops classes in params.scl_drop_classes; B12 is resampled to 10 m.
- Per field: polygon buffered inward field_inner_buffer_m; mean over valid pixels;
  kept only if valid share ≥ min_valid_frac and valid pixels ≥ min_valid_pixels.
- Each date's masked NDVI/NBR window is cached under raw/s2/ so re-runs are cheap
  (clear raw/s2/ if the mask settings change).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA, LOCAL_S3, params, upload
from .labels import seasons_arg
from .s2 import UTM, indices, load, search


def _zones(gdf_utm, geobox) -> np.ndarray:
    from rasterio.features import rasterize

    shapes = [(geom, i + 1) for i, geom in enumerate(gdf_utm.geometry) if geom is not None and not geom.is_empty]
    return rasterize(shapes, out_shape=geobox.shape, transform=geobox.affine, fill=0, dtype="int32")


def zonal_rows(ndvi: np.ndarray, nbr: np.ndarray, zones: np.ndarray, field_ids: list[str],
               day: date, p: dict) -> list[dict]:
    n = len(field_ids) + 1
    z = zones.ravel()
    total = np.bincount(z, minlength=n)
    valid = ~np.isnan(ndvi.ravel()) & ~np.isnan(nbr.ravel())
    zv = z[valid]
    cnt = np.bincount(zv, minlength=n)
    s_ndvi = np.bincount(zv, weights=ndvi.ravel()[valid], minlength=n)
    s_nbr = np.bincount(zv, weights=nbr.ravel()[valid], minlength=n)
    rows = []
    for i, fid in enumerate(field_ids, start=1):
        if total[i] == 0:
            continue
        frac = cnt[i] / total[i]
        if frac < float(p["min_valid_frac"]) or cnt[i] < int(p["min_valid_pixels"]):
            continue
        rows.append({
            "field_id": fid, "date": day.isoformat(), "sensor": "S2",
            "ndvi": round(float(s_ndvi[i] / cnt[i]), 4), "nbr": round(float(s_nbr[i] / cnt[i]), 4),
            "cloud_frac": round(float(1 - frac), 4), "n_pixels": int(cnt[i]),
        })
    return rows


def ingest_season(fields_path: Path, season: int) -> pd.DataFrame:
    import geopandas as gpd

    p = params()
    gdf = gpd.read_file(fields_path).sort_values("field_id").reset_index(drop=True)
    utm = gdf.to_crs(UTM)
    utm["geometry"] = utm.buffer(-float(p["field_inner_buffer_m"]))
    minx, miny, maxx, maxy = gdf.total_bounds
    pad = 0.002
    bbox = (minx - pad, miny - pad, maxx + pad, maxy + pad)
    start = f"{season}-{p['season_start_mmdd']}"
    end = f"{season}-{p['season_end_mmdd']}"
    items = search(bbox, start, end)
    print(json.dumps({"event": "stac", "season": season, "items": len(items)}), flush=True)
    if not items:
        return pd.DataFrame()

    ds = load(items, bbox, resolution=10)
    zones = _zones(utm, ds.odc.geobox)
    ids = list(gdf["field_id"])
    key = hashlib.sha1(json.dumps([round(x, 5) for x in bbox]).encode()).hexdigest()[:10]
    cache = LOCAL_S3 / "raw" / "s2" / key
    cache.mkdir(parents=True, exist_ok=True)

    rows = []
    for k, t in enumerate(ds.time.values):
        day = pd.Timestamp(t).date()
        f = cache / f"{day.isoformat()}.npz"
        if f.exists():
            z = np.load(f)
            ndvi, nbr = z["ndvi"].astype("float32"), z["nbr"].astype("float32")
        else:
            ix = indices(ds.isel(time=k)).compute()
            ndvi, nbr = ix["ndvi"].values.astype("float32"), ix["nbr"].values.astype("float32")
            np.savez_compressed(f, ndvi=ndvi.astype("float16"), nbr=nbr.astype("float16"))
        r = zonal_rows(ndvi, nbr, zones, ids, day, p)
        rows.extend(r)
        print(json.dumps({"event": "scene", "date": day.isoformat(), "fields_kept": len(r)}), flush=True)
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2025", help="2025 or 2022-2026")
    ap.add_argument("--fields", default=str(DATA / "fields" / "fields.geojson"))
    ap.add_argument("--landsat", action="store_true")
    a = ap.parse_args()
    if a.landsat:
        raise SystemExit("Landsat ingest not implemented yet (optional); run without --landsat")
    fields = Path(a.fields)
    if not fields.exists():
        raise SystemExit(f"{fields} not found — waiting on Shambhvi's field polygons (or pass --fields)")
    out = LOCAL_S3 / "derived" / "field_series.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    seasons = seasons_arg(a.season)
    new = pd.concat([ingest_season(fields, s) for s in seasons], ignore_index=True)
    if out.exists():
        old = pd.read_parquet(out)
        old = old[~pd.to_datetime(old["date"]).dt.year.isin(seasons)]
        new = pd.concat([old, new], ignore_index=True)
    new = new.sort_values(["field_id", "date"]).reset_index(drop=True)
    new.to_parquet(out, index=False)
    upload(out, "derived/field_series.parquet")
    print(json.dumps({"event": "field_series", "path": str(out), "rows": len(new),
                      "fields": int(new["field_id"].nunique()) if len(new) else 0}))


if __name__ == "__main__":
    main()
