# pipeline/ — CLAUDE.md (owner: Yash)

Everything computationally heavy lives here: satellite processing, label
derivation, model training, burn records, priority + route chooser, the OR-Tools
planner, and the 2025 backtest. Read `/CLAUDE.md` first; contracts and constants
are defined there. Output files MUST validate against `contracts/`.

## 1. Setup

```
cd pipeline
uv venv && uv pip install -e ".[dev]"
```
Dependencies: pystac-client, odc-stac (or stackstac), rioxarray, xarray, dask,
rasterio, geopandas, shapely, pyproj, numpy, pandas, pyarrow, lightgbm,
scikit-learn, ortools, pydantic>=2, jsonschema, requests, boto3, matplotlib (QA plots).

Env: `STRAWLINK_BUCKET`, `AWS_REGION=ap-south-1`, `FIRMS_MAP_KEY`,
`AWS_REQUEST_PAYER=requester` (only for Landsat/Sentinel-1), optional `OSRM_URL`.

## 2. Package layout

```
pipeline/
  pyproject.toml
  strawlink_pipeline/
    aoi.py          # pick block, bbox, CRS helpers
    stubs.py        # write outputs/stubs/* from contracts/examples (Day 1 FIRST task)
    ingest.py       # STAC search, cloud mask, per-field NDVI/NBR series
    labels.py       # harvest brackets per field-season
    burns.py        # burn records (dNBR + FIRMS), live burn_status
    features.py     # training rows per (field, issue_date)
    forecast.py     # LightGBM quantile models, village volumes
    live.py         # daily live run → outputs/live/{date}/
    backtest.py     # 2025 replay, both policies, 3 fleet scales
    qa.py           # plots for manual label checks
  strawlink_planner/        # separate importable package, also used by app/ Lambda
    models.py       # pydantic models mirroring planner_input / plan contracts
    prepare.py      # dry flag, priority, clustering, route chooser
    travel.py       # road_factor or OSRM travel-time matrices
    solve.py        # OR-Tools VRP + greedy fallback
    baseline.py     # first-come baseline policy
    __init__.py     # exports plan_day(state) and plan_day_baseline(state)
  tests/
```

`strawlink_planner` must be pure Python with no S3/AWS calls inside `plan_day`, so
`app/` can package it into a Lambda container image. Keep its deps to:
pydantic, numpy, ortools, scikit-learn (DBSCAN).

## 3. Task order

### Day 1 (Thu 8)
1. `stubs.py`: write a valid stub of every contract to `outputs/stubs/` (and S3).
   **Deadline 18:00.** This unblocks the app.
2. `aoi.py --pick`: for candidate bboxes around Patiala and Sangrur, compute the
   share of pixels with a post-harvest dNBR jump in 2025 from a few Sentinel-2
   scenes; recommend a ~10×10 km block with clear 2025 burn scars and 3–5 villages.
   Tell Shambhvi the bbox before 11:00 so she draws fields there.
3. `ingest.py` for 2022–2026, Sept 1 → Dec 15:
   - Earth Search STAC (`https://earth-search.aws.element84.com/v1`), collection
     `sentinel-2-l2a`, bbox = block, `eo:cloud_cover < 80`.
   - Mask with SCL: drop classes 0,1,3,8,9,10,11. NDVI = (B08−B04)/(B08+B04);
     NBR = (B08−B12)/(B08+B12) (resample B12 to 10 m).
   - Per field: buffer polygon inward 10 m, mean over valid pixels; keep the
     observation only if valid pixels ≥ 60% and ≥ 5 pixels. Record `cloud_frac`.
   - Optional Landsat 8/9 (`landsat-c2-l2`, requester-pays): apply QA_PIXEL mask and
     C2 L2 scale factors (×0.0000275 − 0.2); tag `sensor`.
   - Cache downloaded windows under `raw/` so re-runs are cheap.
   - Use dask; never load whole scenes, only the block window.

### Day 2 (Fri 9)
4. `labels.py` — per field-season:
   - Peak = max NDVI between Aug 15 and Oct 15.
   - Harvest = first clear observation after peak where NDVI drops by ≥ 0.25 from the
     previous clear observation AND falls below 0.45. Bracket = (previous clear date,
     this date]. Thresholds in config; tune by eye with `qa.py` on 20 random fields.
   - No drop found → `harvested=false`.
5. `burns.py`:
   - Burned if, within 20 days after harvest bracket, dNBR (pre − post) > 0.15 on a
     clear observation, OR a FIRMS VIIRS/MODIS point falls inside the field buffered
     by 200 m in that window. Burn bracket from image dates (FIRMS date narrows it).
   - `evidence` lists which signals fired. Write `derived/burn_record.parquet`.
   - `burn_status(field_id, after_date)` for live certificates: returns
     `no_burn_detected` only after ≥ 2 clear observations post-clearance with no dNBR
     jump; else `pending` or `burn_detected`.
6. `features.py` + `forecast.py`:
   - Training rows: for each field-season with a harvest label and each issue date
     d every 3 days from Sept 15 until the bracket start, features use only
     observations ≤ d: last NDVI, max NDVI and its date, slope over last 3 clear obs,
     days since peak, NDVI at fixed offsets, area, village (categorical), day-of-year
     of d, number of clear obs. Target = days from d to bracket midpoint; weight =
     1 / (1 + bracket width).
   - LightGBM, objective `quantile`, alpha 0.1 / 0.5 / 0.9; train 2022–2024,
     validate 2025; then refit on 2022–2025 for live 2026. Sort quantiles to fix
     crossings. Seed 42.
   - Report: P50 MAE (days), [P10,P90] coverage, mean window width.
   - Village volumes: build a piecewise-linear CDF per field from P10/P50/P90,
     Monte-Carlo 1,000 draws, sum `straw_t` per village per week → P10/P50/P90.
   - SageMaker training job is optional (`--sagemaker`); local training is fine.
7. `strawlink_planner` v1 (see §4). Deliver real forecasts + planner to Shambhvi by
   20:00.

### Day 3 (Sat 10)
8. Rain and capacity re-planning, baseline policy, greedy fallback.
9. `backtest.py` (see §5). Deliver results by 18:00.

### Day 4 (Sun 11)
10. Sanity checks, metrics table, methods slide (labels, model, planner, caveats).

## 4. Planner specification

`plan_day(state: PlannerInput) -> Plan` — deterministic, ≤ `time_limit_s`.

**prepare.py**
- `dry`: false if rain in the last `dry_days_after_rain` days ≥ `rain_wet_threshold_mm`.
- `ready_day`: confirmed date if `source=confirmed`, else P50 (live) — a field is
  serviceable from its ready_day; the planner looks ahead `horizon_days` (default 3)
  so machines are positioned before fields are ready.
- `days_left = sowing_deadline − ready_day`.
- `priority = straw_t × exp(−days_left / urgency_tau_days) × (1 + bonus) × dry`
  where `bonus = loyalty_bonus` if `burned_last_season is False`, else 0.
  **Never add anything for burned_last_season=True.** Unit test this.
- Clustering: DBSCAN (haversine, eps = `cluster_radius_m`, min_samples=1) per
  village; a cluster's tonnes and priority are sums; its time window is the
  intersection-aware [max(ready), min(deadline)] — split the cluster if empty.
- Route chooser, in descending priority: assign `bale` if a plant within
  `haul_radius_km` has remaining weekly capacity ≥ tonnes (decrement it); otherwise
  `seed`. `route_reason` is a short human string (shown in the why-card).

**solve.py**
- Two independent VRPs: baler sets on bale-route clusters; seeders on seed-route clusters.
- Vehicles: each machine × each day in the horizon (vehicle-day), start/end at the
  machine's base (day 1) or previous day's last stop (later days), working time
  `hours_per_day`.
- Dimensions: Time (travel + service, service = tonnes / rate_t_per_hr), node time
  windows from ready_day to deadline mapped onto the horizon.
- Prize collection: `AddDisjunction([node], penalty = round(priority × 1000))`.
- Search: PATH_CHEAPEST_ARC first solution, GUIDED_LOCAL_SEARCH, time limit.
- Trucks: after solving, allocate each day's baled tonnes to plants greedily (nearest
  with capacity); if truck capacity per day is exceeded, drop lowest-priority stops
  from that day and mark `capacity`.
- Output only day-1 routes as `assignments`; days 2..H go into `preview` (optional
  field, add to contract only with agreement) or are omitted.
- Unassigned reasons: `wet`, `deadline`, `capacity`, `no_machine`.
- Any solver failure → greedy: nearest-feasible highest-priority insertion.
- Performance target: 200 fields, 12 machines, horizon 3 → < 45 s on 2 vCPU.

**travel.py**: `road_factor × haversine / speed_kmh` by default; OSRM `/table`
if `OSRM_URL` set. Cache matrices per (node set) hash.

**baseline.py** — `plan_day_baseline(state)`:
- A field enters the queue only the day AFTER it is actually harvested (booking after
  harvest). Queue order = entry date, then field_id.
- Bale route only, nearest free baler set, no rain awareness: a wet field scheduled
  by the baseline fails service that day and returns to the queue.
- Plant full → field waits.

## 5. Backtest specification (`backtest.py`)

- Season 2025, simulate each day from Oct 1 to Nov 30.
- Ground truth per field: harvest bracket (actual harvest = bracket midpoint) and
  burn bracket from `burn_record`.
- On day d: build `PlannerInput` from forecasts issued with data ≤ d only
  (re-run the 2025 validation model with an as-of filter), rain from Open-Meteo
  archive (daily precipitation at block centroid), current plant fills.
- StrawLink policy: `plan_day`; baseline: `plan_day_baseline`. Execute only day-1
  stops; a stop succeeds only if the field is actually harvested by that day and dry.
- Burning is exogenous: a field burns at `burn_lo` unless already cleared. A burned
  field counts as **reached** if cleared strictly before `burn_lo`.
- Fleet scales 0.75, 1.0, 1.25 of `synthetic.yaml` machine counts.
- Optional sensitivity: `confirm_rate` (share of fields with a confirmation 2 days
  before harvest), default 0.0 — report separately, never mix into the headline.
- Use `time_limit_s=10` per solve in backtest and run the 6 (policy × scale)
  combinations in parallel processes. Budget ≈ 60 days × 6 runs. If too slow, run
  on a SageMaker Processing job (`ml.c5.4xlarge`) or reduce to every-other day.
- Write `outputs/backtest/backtest_result.json` and per-day plans for replay.

## 6. Tests (pytest)

- Label detection on synthetic NDVI curves (clean drop, noisy, cloudy gap, no drop).
- Burn detection on synthetic dNBR series.
- Quantiles sorted; coverage computed correctly.
- Planner: deterministic for a fixed input; never assigns `dry=false` fields;
  burned_last_season=True never yields higher priority than None or False;
  respects plant capacity; returns within time limit.
- Every output validates against `contracts/*.schema.json`.

## 7. CLI

```
python -m strawlink_pipeline.stubs
python -m strawlink_pipeline.aoi --pick
python -m strawlink_pipeline.ingest --season 2025 [--landsat]
python -m strawlink_pipeline.labels --seasons 2022-2025
python -m strawlink_pipeline.burns --seasons 2022-2025
python -m strawlink_pipeline.forecast --train --validate 2025
python -m strawlink_pipeline.live --date 2026-10-10
python -m strawlink_pipeline.backtest --season 2025 --scales 0.75,1.0,1.25 --workers 6
```

## 8. Don'ts

- Don't hard-code thresholds or constants; put them in `config/params.yaml`.
- Don't use any 2025 imagery after day d when forecasting for day d in the backtest.
- Don't claim precision the labels can't support; always report window coverage.
- Don't change `contracts/` alone.
