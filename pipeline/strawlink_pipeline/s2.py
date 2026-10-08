"""Sentinel-2 L2A helpers on Earth Search (STAC): search, windowed load, mask, indices."""

from __future__ import annotations

import os

import numpy as np
import xarray as xr

from .config import params

BANDS = ["red", "nir", "swir22", "scl"]
UTM = "EPSG:32643"

os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "6")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")


def search(bbox: tuple[float, float, float, float], start: str, end: str, max_cloud: float | None = None):
    from pystac_client import Client

    p = params()
    cloud = float(max_cloud if max_cloud is not None else p["max_scene_cloud_pct"])
    client = Client.open(p["stac_url"])
    items = client.search(
        collections=[p["s2_collection"]],
        bbox=bbox,
        datetime=f"{start}/{end}",
        query={"eo:cloud_cover": {"lt": cloud}},
    ).item_collection()
    return sorted(items, key=lambda it: (it.datetime, it.id))


def _boa_offset(item) -> float:
    """Processing baseline ≥ 04.00 adds +1000 to DNs unless Earth Search already removed it."""
    props = item.properties
    if props.get("earthsearch:boa_offset_applied") is True:
        return 0.0
    baseline = str(props.get("s2:processing_baseline", "0"))
    try:
        return -1000.0 if float(baseline) >= 4.0 else 0.0
    except ValueError:
        return 0.0


def load(items, bbox, resolution: int = 10, chunks: dict | None = None) -> xr.Dataset:
    """Load only the bbox window (dask-backed), reflectance scaled, grouped by solar day."""
    import odc.stac

    ds = odc.stac.load(
        items,
        bands=BANDS,
        bbox=bbox,
        crs=UTM,
        resolution=resolution,
        groupby="solar_day",
        chunks=chunks if chunks is not None else {"x": 1024, "y": 1024},
        resampling={"swir22": "bilinear", "*": "nearest"},
        fail_on_error=False,  # a failed tile read becomes nodata → masked invalid, not a crash
    )
    # per-time BOA offset (time dimension is grouped by solar day)
    offs = {}
    for it in items:
        offs.setdefault(np.datetime64(it.datetime.date(), "D"), _boa_offset(it))
    off = xr.DataArray(
        [offs.get(np.datetime64(t, "D"), 0.0) for t in ds.time.values], dims="time"
    )
    for b in ("red", "nir", "swir22"):
        ds[b] = ((ds[b].astype("float32") + off).where(ds[b] > 0) / 10000.0).clip(0, 1.5)
    return ds


def indices(ds: xr.Dataset) -> xr.Dataset:
    drop = params()["scl_drop_classes"]
    valid = ~ds["scl"].isin(drop) & ds["red"].notnull() & ds["nir"].notnull() & ds["swir22"].notnull()
    ndvi = (ds["nir"] - ds["red"]) / (ds["nir"] + ds["red"])
    nbr = (ds["nir"] - ds["swir22"]) / (ds["nir"] + ds["swir22"])
    return xr.Dataset({"ndvi": ndvi.where(valid), "nbr": nbr.where(valid), "valid": valid})
