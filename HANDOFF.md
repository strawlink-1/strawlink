# StrawLink — handoff (Yash → Shambhvi), 8 Oct 2026

Read this first, then `/CLAUDE.md`, then `app/CLAUDE.md` / `pipeline/CLAUDE.md`.
Yash's Claude session built **both halves** (pipeline + most of app). This file is the
single source of truth for *what exists, what works, what's blocked, and what's next*.

---

## 0. TL;DR

| Area | State |
|---|---|
| Pipeline (satellite → labels → burns → forecast → planner → backtest → live) | **Done, run on real data** for 200 parcels, 2022–2026 |
| Backend (FastAPI on Lambda, loaders, daily job, messaging, assistant, certs, exposure, emissions) | **Code done, 14 tests pass (moto)**. Works locally. |
| AWS deploy | **NOT deployed.** `sam deploy` repeatedly failed uploading the 57 MB planner zip (S3 `RequestTimeout` on Yash's uplink). Deploy from a stable network. |
| Frontend (React/Vite, 5 screens) | **Works locally**, but Yash wants it **replaced by an impressive animated 3D (three.js) "movie" UI** — see §6, top priority. |
| Data | 200 approximate field parcels on real 2025 paddy pixels, synthetic fleet/plants/phones, OSM villages+schools |
| Contracts | v0.1 **draft** written by Yash's Claude — Shambhvi please review (§8) |

---

## 1. Setup (fresh clone)

```bash
# Python envs (uv; Python 3.11)
cd pipeline && uv venv --python 3.11 && uv pip install -e ".[dev]" && cd ..
cd app && uv venv --python 3.11 && uv pip install --python .venv/bin/python -r backend/requirements.txt \
   pytest "moto[dynamodb,s3,ssm,lambda]" httpx uvicorn -e ../pipeline && cd ..
# Web
cd app/web && npm i && cd ../..
# SAM CLI: the Homebrew build is broken on Python 3.14 (pyexpat). Use:
uv tool install --python 3.11 aws-sam-cli        # → ~/.local/bin/sam
```

Tests: `pipeline/.venv/bin/python -m pytest -q pipeline/tests` (53 pass) ·
`app/.venv/bin/python -m pytest -q app/tests` (14 pass, ~90 s).

**Run the whole thing locally (no AWS needed):**
```bash
app/.venv/bin/python app/tools/dev_server.py --date 2026-10-24 --port 8000   # moto-backed API with real pipeline outputs
npm --prefix app/web run dev -- --port 5173                                   # http://localhost:5173/operator?demo=1
```
`.claude/launch.json` has both (`api-dev`, `web`). Locally Bedrock is off (everything AWS is
mocked) → translation uses the hand-written Punjabi template; the assistant needs the deployed API.

Generated, git-ignored dirs you will need to regenerate: `pipeline/.s3/` (local mirror of the S3
layout: raw imagery cache, derived parquet, models), `app/backend/shared/`, `app/.aws-sam/`.
To rebuild `pipeline/.s3` from scratch: `pipeline/run_all.sh` (≈30 min, downloads Sentinel-2 from
Earth Search; step list also in `pipeline/README.md`).

---

## 2. What was built

### 2.1 Data (`data/`, `config/`)
- `data/osm/villages.geojson`, `schools.geojson` — Overpass export, block bbox + 15 km (`app/tools/load_osm.py`).
- **Block:** bbox `[75.684, 30.295, 75.788, 30.386]` (west of Sangrur), chosen by `pipeline aoi --pick`
  (highest 2025 post-harvest NBR-drop share; report in `outputs/aoi_pick.json`).
- `data/fields/fields.geojson` — **200 parcels, 50 each in Alal, Sultanpur, Mulowal, Ranike**
  (`app/tools/make_fields.py`). NOT hand-drawn: 110 m grid cells kept where ≥ 90 % of pixels look
  like paddy in 2025 Sentinel-2 (peak NDVI > 0.7, then < 0.45). Tagged `synthetic: true`,
  `boundary: grid_cell_approx`. Harvest/burn signals on them are real; boundaries are not.
- `data/fields/villages.geojson` — the 4 villages with ids V01–V04.
- `config/synthetic.yaml` (`app/tools/make_synthetic.py`) — 3 baler sets, 3 Super Seeders,
  3 trucks (rates are **ASSUMPTION — cite**), 3 invented plants, fake phones (+919…), 30 combine bookings.
- `config/params.yaml` — all constants. Added beyond the root spec (each commented):
  planner (`horizon_days`, `penalty_scale: 1e6`, `delay_cost_per_day_frac`, `solver_solution_limit`,
  `cluster_max_day_frac`, truck capacity/trips), ingest/labels/burns thresholds
  (`harvest_lookback_days`, `harvest_confirm_obs`, `burn_post_nbr_max`, `burn_persist_obs`), backtest dates.

### 2.2 Pipeline (`pipeline/`, see its README)
- `s2.py`/`ingest.py`: Earth Search STAC, SCL mask, NDVI/NBR per parcel (10 m inner buffer,
  ≥60 % valid & ≥5 px), per-date cache. `labels.py`, `burns.py` (dNBR + FIRMS when key set),
  `features.py`, `forecast.py` (LightGBM quantiles, seed 42), `volumes.py` (Monte-Carlo village weeks),
  `live.py`, `backtest.py`, `qa.py`, `stubs.py`, `aoi.py`, `weather.py` (Open-Meteo).
- `strawlink_planner` (pure: pydantic, numpy, ortools — **scikit-learn removed**, DBSCAN replaced by
  an equivalent union-find; test proves identical partitions): priority/fair queue, village
  clustering, route chooser, OR-Tools multi-day prize-collecting VRPTW, truck haul + plant capacity,
  greedy fallback, first-come baseline. Deterministic. 200 fields / 12 machines ≈ 10 s.

**Real-data results (200 parcels)** — numbers live in `outputs/` and `pipeline/.s3/derived/`:
- Harvest labelled for 97–99.5 % of parcels each season (2022–2025).
- Burn flags (dNBR only, **no FIRMS yet**): 2022 83 %, 2023 78 %, 2024 23 %, 2025 92.5 % → **over-counted**.
  Post-harvest tillage also drives NBR negative. Do not quote burn numbers until FIRMS is in.
- Forecast (train 2022–24, validate 2025): P50 MAE **4.0 days**, P10–P90 coverage **35 %** (target ~80 %) → intervals too narrow; needs calibration (e.g. conformal widening).
- Backtest 2025 (`outputs/backtest/backtest_result.json`), both policies get the same farmer
  bookings (day after harvest); reach rate StrawLink vs baseline: 0.75× 37.8 % vs 37.8 %,
  1.0× **40.5 % vs 40.0 %**, 1.25× 42.2 % vs 41.6 %. Essentially a tie.
  Why: only 104 of 185 "burned" fields are reachable at all (the rest are dated at/before harvest
  — an image-timing artefact), and burns come ~2 days after harvest, so *knowing about the harvest*
  dominates *planning*. A satellite-only variant (StrawLink without bookings) is in
  `outputs/backtest/backtest_sensitivity_satonly.json` and **loses** (33 % vs 40 %).
  Report this honestly; don't tune the policy to win.
- Live run 2026-10-08: `outputs/live/2026-10-08/` (forecast, village_forecast, planner_input, plan).
  2026 forecasts cluster on 22–25 Oct → **demo plan date = 2026-10-24** (peak load: 18 fields /
  131 t scheduled, 139 waiting on capacity).

### 2.3 Backend (`app/backend/`, `app/template.yaml`)
Packages: `api/` (FastAPI `main.py`, `planning.py`, `supply.py`, `jobs.py`), `loaders/`,
`messaging/`, `assistant/` (Strands + Bedrock), `certificates/` (reportlab PDF + QR),
`exposure/`, `emissions/`, `common/` (settings, DynamoDB/S3 helpers), `planner_fn/`.

All routes from `app/CLAUDE.md` §5 exist, plus: `GET /meta` (plan date, villages, plants,
assumptions list, forecast metrics), `GET /messages?field_id=`, `POST /farmer/message`
(simulated WhatsApp, same handling as Twilio), `GET /backtest/replay?policy&scale`,
`GET /routes?date&policy` (Amazon Location `geo-routes` road lines, straight-line fallback, cached in S3).

Key behaviours:
- `/replan` builds PlannerInput from DynamoDB + config + Open-Meteo rain + injected rain events,
  validates against contracts, invokes the planner Lambda (or local `plan_day`), validates the plan,
  stores both policies (`Plans`: SK `latest#{policy}`), writes route/priority/slot onto Fields,
  messages demo farmers. Planner time limit via `PLANNER_TIME_LIMIT_S` (12 s for API — HTTP API caps at 30 s).
- Confirmations override forecasts (`Fields.confirmed`). Rain events are Events rows with `field_id="RAIN"`.
- Messaging: English template → Bedrock Punjabi with a guard (every number must survive) →
  else hand-written Punjabi (**needs a native-speaker check**, `messaging/core.py`).
  Twilio is used only if SSM `/strawlink/twilio` exists and the phone is a demo number; otherwise "simulated".
- `DEMO_DATE` env pins the planning date for the demo.
- Bedrock model: `in.anthropic.claude-haiku-4-5-20251001-v1:0` (India inference profile) — **verified
  working** in ap-south-1 for this account. Template parameter `BedrockModelId`.

### 2.4 Frontend (`app/web/`) — current version (to be replaced, §6)
React 19 + Vite + MapLibre (no deck.gl). Screens: Operator (map by status, route lines,
StrawLink/baseline toggle, officer exposure view, WhyCard), Factory (weekly P10–P90 per plant,
depot projection + alert), Farmer (phone mock thread, Punjabi/English, assistant), Backtest
(grouped bars, season replay), Verify. Demo console with `?demo=1`. Assumptions drawer.
Palette validated for colour-blindness (light + dark). Fonts: Bricolage Grotesque / IBM Plex / Noto Sans Gurmukhi.
Map basemap = Amazon Location `Hybrid` style when `VITE_MAPS_KEY` is set, else OSM raster.
Gotchas fixed: MapLibre mutates style objects (clone per map); Chrome's `scrollIntoView` returns a
Promise (don't return it from `useEffect`); WebGL needs `preserveDrawingBuffer` for screenshots.

---

## 3. AWS state (account 404119728522, region ap-south-1)

- CLI on Yash's Mac is logged in as the **root user** — switch to an IAM admin user / SSO and enable root MFA.
- **Exists:** `aws-sam-cli-managed-default` stack (SAM artifact bucket) and
  `strawlink-de4e8727-CompanionStack` (an ECR repo holding a half-pushed 1.4 GB planner image from the
  abandoned container approach) → **delete the companion stack** (`aws cloudformation delete-stack
  --stack-name strawlink-de4e8727-CompanionStack --region ap-south-1`, empty the ECR repo first).
- **Does not exist yet:** the `strawlink` stack (bucket, 6 tables, 4 Lambdas, HTTP API, schedule, maps key).
- Yash's `~/.aws/config` was changed: `s3.multipart_chunksize=5MB`, `max_concurrent_requests=1`,
  `multipart_threshold=8MB` (to survive his uplink). Revert if unwanted.

### Deploy runbook (from a machine with a stable connection + Docker running)
```bash
cd app
./tools/sync_shared.sh                         # copies config/contracts/data + strawlink_planner into the Lambda packages
~/.local/bin/sam build --use-container --parallel
~/.local/bin/sam deploy --stack-name strawlink --region ap-south-1 --resolve-s3 \
   --capabilities CAPABILITY_IAM --no-confirm-changeset \
   --parameter-overrides DemoDate=2026-10-24
./tools/publish_data.sh                        # fields → machines → forecast → plan → backtest (S3 events run loaders)
curl -X POST $API_URL/replan -H 'content-type: application/json' -d '{}'
./tools/deploy_web.sh                          # builds web with API URL + maps key, publishes to Amplify Hosting
# then redeploy with --parameter-overrides PublicWebUrl=<amplify url> CorsOrigins=<amplify url> DemoDate=2026-10-24
```
Build gotchas already handled: zip functions must keep `Runtime` per function (not Globals);
`numpy<2.3` and `pillow<12` pinned (AL2 build image can't compile newer); planner is a **zip**
Lambda on python3.12 (ortools needs AL2023 glibc) instead of the spec's container image.

---

## 4. What's left — prioritised

1. **New 3D animated UI (§6)** — Yash's top ask.
2. **Deploy** (runbook above) and smoke-test every endpoint on AWS (Bedrock translation, assistant,
   Amazon Location routes, certificates PDF presign).
3. **FIRMS**: put `FIRMS_MAP_KEY` in `.env`, rerun `burns` → `forecast` → `backtest`. Expect far fewer burns.
4. **Forecast calibration**: widen P10/P90 (conformal on 2025 residuals) until coverage ≈ 0.8; rerun live + backtest.
5. **Twilio sandbox** + SSM params (`/strawlink/twilio` = `{"sid","token","from"}`, `/strawlink/demo_phone_map`
   = `{"F0001":"+91…",…}`), set the Twilio webhook to `$API_URL/webhooks/whatsapp`.
6. **burn_status for certificates**: `api.jobs.daily` writes `outputs/app/cleared.json`; `pipeline/live.py`
   should read it, call `burns.burn_status()` per cleared field, write `outputs/live/{date}/burn_status.json`
   (loader already handles it). Not wired yet.
7. **Emission factors**: `config/params.yaml` `emission_factors` / `assumed_burn_probability` are TODO;
   UI shows "estimate pending source" until cited values are added (shape: `{pm2_5: {g_per_kg, source}}`).
8. Punjabi fallback templates reviewed by a native speaker.
9. Demo video (3 min), deck, rehearsal (Day 4).

---

## 5. Known caveats to state in the demo
- Parcels are approximate grid cells; fleet, plants and phones are synthetic.
- Burn labels are dNBR-only until FIRMS → over-counted; reach-rate denominators inflated.
- Forecast 80 % ranges currently contain only ~35–43 % of harvests.
- Backtest shows a tie at equal information; the value is in earlier information (confirmations,
  forecasts) + rain awareness + fair queue, not routing magic.

---

## 6. 3D "movie" UI — BUILT (route `/live`, default page)

Status (8 Oct evening): implemented in `app/web/src/movie/` with three.js + @react-three/fiber (renderer
bridge only; every model, shader, label and control is hand-written). Everything is driven by the API:
- `model.ts` turns `/fields`, `/plan`, `/routes`, `/machines`, `/plants/supply` into per-machine legs
  (drive / work in serpentine passes / load / unload) on the plan's real arrive/depart times.
- `roadnet.ts`: OpenStreetMap roads (`app/web/public/osm/roads.geojson`, made by
  `app/tools/load_osm.py --roads-only`) + A* routing at tractor speeds; Amazon Location geometry wins when
  `/routes` returns it. `useWorld.ts` polls every 5 s; re-plans/rain/confirmations rebuild the film,
  machines glide to new routes, changed fields pulse cyan, toasts summarise the change.
- Scene: `Fields.tsx` (MeshStandardMaterial + injected crop shader, work front synced to machine progress),
  `Grass.tsx` (instanced wind-swaying paddy/stubble/wheat sprouts/plot crops near the camera, LOD),
  `vehicles.ts` (procedural tractor+baler, Super Seeder, tractor-trolley), `Machines.tsx` (poses, rings,
  dust, bales), `Sites.tsx` (plants with growing bale yards + steam, rain + clouds over wet villages),
  `Environment.tsx` (sun/sky by sim clock, farmland, OSM road ribbons, villages, trees),
  `Labels.tsx` (DOM labels projected per frame with declutter), `CameraRig.tsx` (intro / free / chase / focus),
  `Timeline.tsx` (Gantt of real legs, scrub), `MovieScreen.tsx` (HUD, title card, inspector).
- Dev tips: the in-app browser pane pauses rAF when hidden; verify with headless Chrome
  (puppeteer-core against /Applications/Google Chrome). `?step=1` + `window.__step(n)` steps frames in dev.

Original brief (kept for reference):
## 6b. NEW UI BRIEF — "watch the season like a movie"

Yash: the current UI is too plain. Build an **impressive, animated, 3D** experience with
**three.js** that feels like watching a film of machines and trucks clearing fields, and that
**reacts to live data** (re-plans, rain, confirmations) as they happen.

**Recommended stack:** keep React/Vite; add `three` + `@react-three/fiber` + `@react-three/drei`
(and optionally `@react-three/postprocessing`). For geo-accuracy either (a) MapLibre in 3D pitch
with a three.js **custom layer** (`maplibregl.CustomLayerInterface`, render three meshes in Mercator
space), or (b) a standalone R3F scene: a ground plane textured with an Amazon Location static
satellite image of the block bbox, parcels as extruded polygons. (a) keeps real streets/labels;
(b) gives more cinematic freedom. Pick one and stay with it.

**Scenes / beats (each driven by real API data — never fake motion):**
1. *Fly-in*: camera glides from Punjab overview to the block; parcels rise from the ground,
   coloured by status (`GET /fields?date=`); season clock counts down to the sowing deadline.
2. *The plan plays out*: a day timeline (08:00→18:00) scrubs/plays; each machine is a low-poly
   model (baler, Super Seeder, tractor-trolley) moving along its **road route** (`GET /routes` LineStrings)
   arriving/departing exactly at `plan.assignments[].stops[].arrive/depart`; fields turn from gold to
   cleared as service completes; bales stack in trolleys; trucks drive to plants
   (`deliveries[].plant_id/arrive`) and plant depot meters fill (`GET /plants/supply`).
3. *Live disruption*: on `POST /events/rain` show rain particles over the affected village, fields go
   blue, then the re-plan arrives and trucks visibly reroute (diff old vs new plan, tween positions).
   On WhatsApp confirm/missed call, a pulse rises from that field and it joins the queue.
4. *Why*: click any field → floating 3D card (existing WhyCard data from `GET /fields/{id}`).
5. *Season replay*: `GET /backtest/replay?policy&scale` animates Oct 1→Nov 30, StrawLink vs
   baseline split-screen; burned fields emit a smoke plume drifting with real afternoon wind
   (`GET /exposure` wind_from_deg) — label "if these fields burn", not a pollution reading.
6. *Factory / farmer* stay as 2D panels overlaid (glassmorphism over the 3D scene), Punjabi first.

**Live updates:** poll `/plan` + `/fields` every ~5 s (or after any demo-console action — they
already return the new plan) and animate the delta; later swap to API Gateway WebSocket if time.
**Rules that still apply:** every number traceable to an API value (tooltips), synthetic labels
visible, no enforcement framing, `prefers-reduced-motion` → static fallback, works on a laptop GPU
(instanced meshes, < 300 draw calls), keyboard focus on controls.
Existing reusable pieces: `app/web/src/api.ts` (types + fetch), `state.tsx`, `WhyCard`,
`DemoConsole`, `Tip`; the CSS tokens in `styles.css` (validated palette).

---

## 7. File map (new since the initial CLAUDE.md files)
```
HANDOFF.md                      this file
.claude/launch.json             local api-dev + web servers
app/template.yaml               SAM stack
app/backend/{api,common,loaders,messaging,assistant,certificates,exposure,emissions,planner_fn}/
app/backend/requirements.txt    API/loader/job Lambda deps (planner_fn has its own)
app/tools/{load_osm,make_fields,make_synthetic,dev_server}.py, {sync_shared,publish_data,deploy_web}.sh
app/tests/                      moto API tests + unit tests
app/web/                        React app (to be redesigned)
data/osm/, data/fields/         OSM POIs, parcels, villages
outputs/stubs/                  contract stubs (Day-1)   outputs/live/2026-10-08/   outputs/backtest/   outputs/qa/
pipeline/                       see pipeline/README.md
```

## 8. Decisions needing both owners
- **Contracts v0.1** were drafted by Yash's Claude from root CLAUDE.md §4 (see `contracts/CHANGELOG.md`
  for interpretation choices: parquet contracts as row arrays, ISO datetimes with +05:30, cumulative
  backtest daily counts, null forecast metrics on baseline rows). Review and bump to 1.0 together.
- Spec deviations taken: planner as zip Lambda (not container), no scikit-learn, MapLibre without deck.gl,
  backtest gives both policies the same bookings (satellite-only variant reported separately),
  `penalty_scale` 1e6 instead of 1000 (reason in params.yaml).
