# StrawLink — root CLAUDE.md

> **Handoff in progress (8 Oct 2026):** read `HANDOFF.md` first — current state, AWS deploy
> runbook, results, and the prioritised to-do list (incl. the new 3D UI brief).

Read this file first, then the CLAUDE.md in the folder you are working in
(`pipeline/` for Yash, `app/` for Shambhvi). The PRD is the source of truth for
*what* to build; these files say *how*.

## 1. What we are building

StrawLink is a planning engine that gets every paddy field in one Punjab block
cleared in time for wheat sowing, so farmers have no reason to burn straw.

1. Forecast weekly straw volume per village and a P10–P90 harvest window per field
   from satellite imagery (Sentinel-2, optionally Landsat 8/9).
2. Accept harvest confirmations (WhatsApp from farmer or combine operator; missed
   call simulated) that override the forecast.
3. Choose a clearance route per field: **bale** (rake → baler → truck to a plant)
   or **seed** (Super Seeder, in-situ). Fields neither route can reach in time are
   **at_risk**.
4. Rank fields with a **fair queue**: tonnes × urgency (days left before sowing
   deadline) × (1 + no-burn loyalty bonus) × dry flag. Burn history NEVER raises
   priority.
5. Plan machines daily (OR-Tools), with village batching, rain re-planning and plant
   capacity.
6. Prove it with a day-by-day **2025 backtest** vs a first-come baseline at three
   fleet sizes.
7. Serve: operator map, factory supply view, farmer WhatsApp + Punjabi assistant,
   clearance certificates, downwind exposure layer (villages/schools), emissions
   estimate.

Event: WeMakeDevs × AWS Environmental Hacks, **Air track**, 8–11 Oct 2026.
Judged on: idea & impact, built on AWS, design & usability, execution (working >
polished), 3-minute demo video.

## 2. Team and ownership

| Area | Owner | Folder |
|---|---|---|
| Satellite pipeline, ML, burn records, priority, route chooser, planner, backtest | **Yash** | `pipeline/` |
| AWS infra (SAM), API, DynamoDB, frontend, messaging, Strands assistant, certificates, exposure layer, emissions, synthetic data, demo video | **Shambhvi** | `app/` |
| Data contracts | Both (change only with agreement) | `contracts/` |
| Assumed constants | Both | `config/` |

Rules for Claude Code:
- Only edit files inside the current owner's folder unless the user explicitly asks.
- Never change anything in `contracts/` without the user confirming both owners
  agreed; when changed, bump the version and add a line to `contracts/CHANGELOG.md`.
- The two halves talk ONLY through files matching `contracts/` (in S3) and the
  `strawlink_planner` Python package's public function `plan_day`.

## 3. Repository layout

```
strawlink/
  CLAUDE.md                 # this file
  README.md
  config/
    params.yaml             # assumed constants (see §6)
    synthetic.yaml          # machines, plants, depots, phones, bookings (synthetic)
  contracts/
    CHANGELOG.md
    fields.schema.json
    field_series.schema.json
    forecast.schema.json
    village_forecast.schema.json
    burn_record.schema.json
    planner_input.schema.json
    plan.schema.json
    backtest_result.schema.json
    examples/               # one valid example file per schema (used by tests)
  data/
    fields/fields.geojson   # hand-drawn field polygons (Shambhvi, Day 1)
  pipeline/                 # Yash — see pipeline/CLAUDE.md
  app/                      # Shambhvi — see app/CLAUDE.md
```

## 4. Data contracts (create `contracts/*.schema.json` from these)

All dates are ISO `YYYY-MM-DD` in Asia/Kolkata. Geometry is GeoJSON in EPSG:4326.
Areas and distances are computed in EPSG:32643 (UTM 43N). Every record produced
from synthetic inputs carries `"synthetic": true`.

**fields.geojson** (FeatureCollection) — properties:
`field_id` (str, `F0001`…), `village_id` (str), `village_name` (str),
`area_ha` (float), `straw_t` (float, = area_ha × `straw_t_per_ha`),
`sowing_deadline` (date), `plant_hint` (str|null).

**field_series.parquet** — `field_id, date, sensor (S2|L8|L9|S1), ndvi, nbr,
cloud_frac, n_pixels`.

**forecast.parquet / forecast.json** — `field_id, issued_on, p10, p50, p90 (dates),
source (satellite|confirmed), confidence (0–1)`.

**village_forecast.json** — list of `{village_id, issued_on, week_start,
tonnes_p10, tonnes_p50, tonnes_p90}`.

**burn_record.parquet** — `field_id, season (int), harvested (bool),
harvest_lo, harvest_hi, burned (bool), burn_lo, burn_hi, evidence
(list: dnbr|firms), last_clear_image (date)`.

**planner_input.json** — the full state handed to `plan_day`:
```
{ "date": "2026-10-20",
  "fields": [{ "field_id", "centroid": [lon,lat], "village_id", "straw_t",
               "p10","p50","p90","source","sowing_deadline",
               "status": "forecast|ready|scheduled|cleared|at_risk",
               "burned_last_season": bool|null, "rain_mm_3d": float }],
  "machines": [{ "machine_id","type":"baler_set|truck|seeder","base":[lon,lat],
                 "rate_t_per_hr","hours_per_day","available": bool }],
  "plants":   [{ "plant_id","location":[lon,lat],"weekly_capacity_t",
                 "depot_capacity_t","fill_t" }],
  "travel": { "method": "osrm|road_factor", "road_factor": 1.3, "speed_kmh": 25 },
  "params": { ...copied from config/params.yaml... },
  "time_limit_s": 45 }
```

**plan.json**:
```
{ "plan_id","date","policy": "strawlink|baseline","synthetic": true,
  "fields": [{ "field_id","priority","priority_parts":{"tonnes","urgency","bonus","dry"},
               "route":"bale|seed|at_risk","route_reason","cluster_id",
               "days_left","dry": bool }],
  "assignments": [{ "machine_id","type",
                    "stops":[{"field_id","arrive","depart","tonnes","method"}],
                    "deliveries":[{"plant_id","tonnes","arrive"}] }],
  "unassigned": [{ "field_id","reason":"capacity|deadline|wet|no_machine" }],
  "totals": { "tonnes_planned","fields_planned","fields_at_risk" },
  "solver": { "status","runtime_s","objective" } }
```

**backtest_result.json** — list of
`{fleet_scale (0.75|1.0|1.25), policy, reach_rate, burned_fields_total,
burned_fields_reached, tonnes_cleared_in_time, window_coverage,
village_volume_mape, daily: [{date, cleared_fields, cleared_t, at_risk}]}`.

## 5. S3 layout (bucket name from env `STRAWLINK_BUCKET`)

```
raw/        imagery chip caches, FIRMS CSV, OSM extracts
derived/    field_series.parquet, burn_record.parquet, labels.parquet
models/     harvest_lgbm/{version}/model.txt + metadata.json
outputs/live/{date}/forecast.json, village_forecast.json, plan.json, burn_status.json
outputs/backtest/backtest_result.json, outputs/backtest/plans/{policy}/{scale}/{date}.json
outputs/stubs/   stub versions of every contract (Day 1)
```

## 6. Assumed constants (`config/params.yaml`) — show these as "assumptions" in the UI

```
straw_t_per_ha: 6.0          # ~19 Mt straw / 31.72 lakh ha paddy (Punjab, 2025 figures)
sowing_deadline_default: "2026-11-15"   # ASSUMPTION — confirm from a Punjab agri source
urgency_tau_days: 5
loyalty_bonus: 0.2
rain_wet_threshold_mm: 5
dry_days_after_rain: 2       # ASSUMPTION
haul_radius_km: 30           # ASSUMPTION for bale route
cluster_radius_m: 800
exposure_sector_deg: 30
exposure_max_km: 10
emission_factors: TODO-cite  # per tonne of rice straw burned; must cite a source
assumed_burn_probability: TODO   # discount for emissions-avoided estimate
```
Never hard-code these in code; read from config.

## 7. Conventions

- Python 3.11, `uv` for envs, `ruff` + `pytest`. TypeScript + React for the web app.
- Deterministic: fixed random seeds; same inputs → same plan.
- Logging: structured JSON logs; no secrets in logs.
- Secrets (FIRMS key, Twilio, team phone numbers) in AWS SSM Parameter Store or a
  local `.env` that is git-ignored. Never commit them.

## 8. Non-negotiable rules

1. **Never invent real-world numbers.** Anything not from a real source is in
   `config/` and labelled ASSUMPTION or `synthetic: true`.
2. **No enforcement features.** Burn data is used only for the loyalty bonus,
   backtest, certificates and model training. Never build "report this farmer".
3. **Burn history never increases priority.**
4. **Every number in the UI traces to a stored file or DynamoDB record.**
5. **Stubs first.** By Day 1 18:00, `outputs/stubs/` contains a valid example of
   every contract so `app/` never waits on `pipeline/`.
6. Validate every produced file against its schema in tests (`contracts/examples`).

## 9. Schedule and cut order

| Day | Integration check |
|---|---|
| Thu 8 | App renders stub forecasts and plan |
| Fri 9 | Real forecast + plan for one date in the app |
| Sat 10 | Rain event and WhatsApp confirmation both trigger re-plan live; backtest done |
| Sun 11 | Full demo rehearsed twice; video recorded by noon |

Cut order if late: emissions (F13) → exposure layer (F12) → assistant (F11, keep the
API) → certificates (F10). **Never cut the backtest (F6).**
