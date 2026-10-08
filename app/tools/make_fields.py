"""Field parcels for the demo block, derived from real 2025 Sentinel-2 paddy pixels.

    python app/tools/make_fields.py --villages Alal,Sultanpur,Mulowal,Ranike --n 200

Stand-in for hand-drawn polygons: the boundaries are APPROXIMATE grid cells
(cell_m × cell_m in UTM 43N), kept only where ≥ min_paddy of pixels look like
paddy (peak NDVI > 0.7 Aug 15–Oct 15, then < 0.45 by Dec 1). Every feature is
tagged synthetic=true and boundary="grid_cell_approx". Villages come from OSM.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from strawlink_pipeline.config import params  # noqa: E402
from strawlink_pipeline.s2 import indices, load, search  # noqa: E402


def main() -> None:
    import geopandas as gpd
    from pyproj import Transformer
    from shapely.geometry import box

    ap = argparse.ArgumentParser()
    ap.add_argument("--villages", required=True)
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--cell-m", type=float, default=110)
    ap.add_argument("--min-paddy", type=float, default=0.9)
    ap.add_argument("--max-km", type=float, default=1.8)
    ap.add_argument("--settlement-m", type=float, default=300)
    a = ap.parse_args()
    p = params()
    rng = np.random.default_rng(int(p["random_seed"]))

    vil = gpd.read_file(ROOT / "data" / "osm" / "villages.geojson")
    names = a.villages.split(",")
    vil = vil[vil["name"].isin(names)].drop_duplicates("name").sort_values("name").reset_index(drop=True)
    assert len(vil) == len(names), f"villages not found in OSM: {set(names) - set(vil['name'])}"
    vil["village_id"] = [f"V{i + 1:02d}" for i in range(len(vil))]
    vutm = vil.to_crs("EPSG:32643")

    pad = a.max_km * 1000 + 200
    x0, y0 = vutm.geometry.x.min() - pad, vutm.geometry.y.min() - pad
    x1, y1 = vutm.geometry.x.max() + pad, vutm.geometry.y.max() + pad
    to_ll = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)
    (lon0, lat0), (lon1, lat1) = to_ll.transform(x0, y0), to_ll.transform(x1, y1)
    bbox = (lon0, lat0, lon1, lat1)

    items = search(bbox, "2025-08-15", "2025-12-01", max_cloud=30)
    ix = indices(load(items, bbox, resolution=10)).compute()
    t = np.array([np.datetime64(v, "D") for v in ix.time.values])
    ndvi = ix["ndvi"].values
    peak_m = (t >= np.datetime64("2025-08-15")) & (t <= np.datetime64("2025-10-15"))
    peak = np.nanmax(ndvi[peak_m], axis=0)
    late = np.nanmin(ndvi[t > np.datetime64("2025-10-15")], axis=0)
    paddy = (peak > 0.7) & (late < float(p["harvest_ndvi_max"]))
    xs, ys = ix.x.values, ix.y.values

    cells = []
    for cx in np.arange(x0, x1 - a.cell_m, a.cell_m):
        mx = (xs >= cx) & (xs < cx + a.cell_m)
        for cy in np.arange(y0, y1 - a.cell_m, a.cell_m):
            my = (ys >= cy) & (ys < cy + a.cell_m)
            sub = paddy[np.ix_(my, mx)]
            if sub.size and sub.mean() >= a.min_paddy:
                cells.append(box(cx, cy, cx + a.cell_m, cy + a.cell_m))
    g = gpd.GeoDataFrame(geometry=cells, crs="EPSG:32643")
    d = np.stack([g.centroid.distance(v) for v in vutm.geometry], axis=1)
    g["vi"] = d.argmin(axis=1)
    g["dist"] = d.min(axis=1)
    g = g[(g["dist"] <= a.max_km * 1000) & (g["dist"] >= a.settlement_m)]

    per = a.n // len(vil)
    keep = []
    for vi in range(len(vil)):
        gi = g[g["vi"] == vi]
        idx = rng.choice(len(gi), size=min(per, len(gi)), replace=False)
        keep.append(gi.iloc[np.sort(idx)])
    f = gpd.GeoDataFrame(np.concatenate([k.values for k in keep]), columns=g.columns, crs="EPSG:32643")
    f = f.set_geometry("geometry").sort_values(["vi", "dist"]).reset_index(drop=True)
    f["field_id"] = [f"F{i + 1:04d}" for i in range(len(f))]
    f["village_id"] = vil["village_id"].values[f["vi"].astype(int)]
    f["village_name"] = vil["name"].values[f["vi"].astype(int)]
    f["area_ha"] = (f.area / 10_000).round(3)
    f["straw_t"] = (f["area_ha"] * float(p["straw_t_per_ha"])).round(3)
    f["sowing_deadline"] = str(p["sowing_deadline_default"])
    f["plant_hint"] = None
    f["synthetic"] = True
    f["boundary"] = "grid_cell_approx"
    out = f[["field_id", "village_id", "village_name", "area_ha", "straw_t", "sowing_deadline",
             "plant_hint", "synthetic", "boundary", "geometry"]].to_crs("EPSG:4326")
    fc = json.loads(out.to_json(drop_id=True))
    for feat in fc["features"]:
        feat["geometry"]["coordinates"] = [[[round(x, 6), round(y, 6)] for x, y in ring]
                                           for ring in feat["geometry"]["coordinates"]]
    fc["synthetic"] = True
    fc["note"] = (f"Approximate {a.cell_m:.0f} m parcels on real 2025 Sentinel-2 paddy pixels near OSM villages "
                  f"({', '.join(names)}); generated {date.today().isoformat()}. Not surveyed boundaries.")
    path = ROOT / "data" / "fields" / "fields.geojson"
    path.write_text(json.dumps(fc, ensure_ascii=False))
    vil_out = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": list(r.geometry.coords[0])},
         "properties": {"village_id": r.village_id, "name": r["name"], "name_pa": r.get("name_pa", "")}}
        for _, r in vil.iterrows()]}
    (ROOT / "data" / "fields" / "villages.geojson").write_text(json.dumps(vil_out, ensure_ascii=False))
    print(json.dumps({"fields": len(out), "paddy_cells": len(g), "per_village": out["village_name"].value_counts().to_dict(),
                      "bbox": [round(x, 5) for x in out.total_bounds]}))


if __name__ == "__main__":
    main()
