"""Pick the study block: ~10×10 km with clear 2025 burn scars and 3–5 villages.

    python -m strawlink_pipeline.aoi --pick

For a 3×3 grid of candidate boxes around Patiala and Sangrur, load 2025 Oct–Nov
Sentinel-2 at coarse resolution and measure the share of cropland pixels with a
post-harvest NBR drop (already-harvested pixel, NDVI < harvest_ndvi_max, whose NBR
then falls by > burn_dnbr_threshold between consecutive clear observations).
Villages are counted from OpenStreetMap (place=village) via Overpass.
"""

from __future__ import annotations

import argparse
import json
import math

import numpy as np
import requests

from .config import OUTPUTS, params
from .s2 import indices, load, search

CITIES = {"patiala": (76.39, 30.34), "sangrur": (75.84, 30.25)}
OVERPASS = "https://overpass-api.de/api/interpreter"


def box(lon: float, lat: float, size_km: float) -> tuple[float, float, float, float]:
    dlat = size_km / 2 / 110.574
    dlon = size_km / 2 / (111.32 * math.cos(math.radians(lat)))
    return (round(lon - dlon, 5), round(lat - dlat, 5), round(lon + dlon, 5), round(lat + dlat, 5))


def shift(lon: float, lat: float, dx_km: float, dy_km: float) -> tuple[float, float]:
    return lon + dx_km / (111.32 * math.cos(math.radians(lat))), lat + dy_km / 110.574


def count_villages(b) -> int | None:
    q = f'[out:json][timeout:60];node["place"~"^(village|hamlet)$"]({b[1]},{b[0]},{b[3]},{b[2]});out ids;'
    try:
        r = requests.post(OVERPASS, data={"data": q}, timeout=90,
                          headers={"User-Agent": "strawlink-hackathon/0.1"})
        r.raise_for_status()
        return len(r.json()["elements"])
    except Exception:  # noqa: BLE001
        return None


def burn_share(region_bbox, cands: dict[str, tuple], res_m: int) -> dict[str, dict]:
    p = params()
    items = search(region_bbox, "2025-09-25", "2025-11-30", max_cloud=30)
    if not items:
        return {}
    ix = indices(load(items, region_bbox, resolution=res_m)).compute()
    ndvi, nbr, valid = ix["ndvi"].values, ix["nbr"].values, ix["valid"].values
    t = len(ix.time)
    # cropland proxy: green paddy (NDVI > 0.6) seen before Oct 20
    early = np.array([np.datetime64(v, "D") < np.datetime64("2025-10-20") for v in ix.time.values])
    crop = np.nanmax(np.where(early[:, None, None], ndvi, np.nan), axis=0) > 0.6 if early.any() else np.zeros(ndvi.shape[1:], bool)

    thr, post_max = float(p["burn_dnbr_threshold"]), float(p["burn_post_nbr_max"])
    burned = np.zeros(ndvi.shape[1:], bool)
    pending = np.full(ndvi.shape[1:], np.nan)  # pre-burn NBR of an unconfirmed drop
    need = np.zeros(ndvi.shape[1:], int)
    last_nbr = np.full(ndvi.shape[1:], np.nan)
    last_ndvi = np.full(ndvi.shape[1:], np.nan)
    for k in range(t):
        v = valid[k]
        # confirm or cancel pending drops on this clear observation
        has = v & ~np.isnan(pending)
        still = has & ((pending - nbr[k]) > thr) & (nbr[k] < post_max)
        need = np.where(still, need - 1, need)
        burned |= still & (need <= 0)
        pending = np.where(has & (~still | (need <= 0)), np.nan, pending)
        # new candidate drops: harvested pixel whose NBR falls sharply to a low value
        drop = v & ((last_nbr - nbr[k]) > thr) & (nbr[k] < post_max)
        new = drop & (last_ndvi < float(p["harvest_ndvi_max"])) & np.isnan(pending) & ~burned
        pending = np.where(new, last_nbr, pending)
        need = np.where(new, int(p["burn_persist_obs"]), need)
        last_nbr = np.where(v, nbr[k], last_nbr)
        last_ndvi = np.where(v, ndvi[k], last_ndvi)

    xs, ys = ix.x.values, ix.y.values
    from pyproj import Transformer

    tr = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
    out = {}
    for name, b in cands.items():
        x0, y0 = tr.transform(b[0], b[1])
        x1, y1 = tr.transform(b[2], b[3])
        cx = (xs >= x0) & (xs <= x1)
        cy = (ys >= y0) & (ys <= y1)
        sub_crop = crop[np.ix_(cy, cx)]
        sub_burn = burned[np.ix_(cy, cx)] & sub_crop
        n = int(sub_crop.sum())
        out[name] = {
            "bbox": list(b),
            "crop_px": n,
            "burn_px": int(sub_burn.sum()),
            "burn_share": round(float(sub_burn.sum() / n), 4) if n else 0.0,
            "scenes": t,
        }
    return out


def pick(size_km: float = 10, res_m: int = 60, villages: bool = True) -> dict:
    results = {}
    for city, (lon, lat) in CITIES.items():
        cands = {}
        for dx in (-10, 0, 10):
            for dy in (-10, 0, 10):
                c = shift(lon, lat, dx, dy)
                cands[f"{city}_{dx:+d}_{dy:+d}"] = box(*c, size_km)
        region = (
            min(b[0] for b in cands.values()), min(b[1] for b in cands.values()),
            max(b[2] for b in cands.values()), max(b[3] for b in cands.values()),
        )
        print(json.dumps({"event": "loading", "city": city, "bbox": region}), flush=True)
        results.update(burn_share(region, cands, res_m))
    ranked = sorted(results.items(), key=lambda kv: -kv[1]["burn_share"])
    if villages:
        for name, r in ranked[:6]:
            r["villages_osm"] = count_villages(r["bbox"])
    best = next(
        (kv for kv in ranked if kv[1].get("villages_osm") and 3 <= kv[1]["villages_osm"] <= 8),
        ranked[0] if ranked else None,
    )
    report = {"candidates": dict(ranked), "recommended": best[0] if best else None,
              "recommended_bbox": best[1]["bbox"] if best else None}
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    (OUTPUTS / "aoi_pick.json").write_text(json.dumps(report, indent=2))
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pick", action="store_true")
    ap.add_argument("--size-km", type=float, default=10)
    ap.add_argument("--res", type=int, default=60)
    ap.add_argument("--no-villages", action="store_true")
    a = ap.parse_args()
    if a.pick:
        r = pick(a.size_km, a.res, not a.no_villages)
        top = list(r["candidates"].items())[:6]
        for name, c in top:
            print(json.dumps({"candidate": name, **c}))
        print(json.dumps({"recommended": r["recommended"], "bbox": r["recommended_bbox"]}))


if __name__ == "__main__":
    main()
