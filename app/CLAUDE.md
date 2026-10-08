# app/ — CLAUDE.md (owner: Shambhvi)

Everything users touch plus AWS deployment: SAM infrastructure, API, DynamoDB,
frontend, WhatsApp messaging, Bedrock, the Strands Agents assistant, clearance
certificates, exposure layer, emissions estimate, synthetic data and the demo.
Read `/CLAUDE.md` first. Build against `outputs/stubs/` until Yash delivers real
files; never wait on `pipeline/`.

## 1. Stack

- Infra: **AWS SAM** (`app/template.yaml`), region `ap-south-1`.
- Backend: Python 3.11 Lambdas. Main API = FastAPI + Mangum behind API Gateway (HTTP API).
- Data: Amazon DynamoDB (on-demand), Amazon S3 (`STRAWLINK_BUCKET`).
- Planner: Lambda **container image** that installs `pipeline/strawlink_planner`
  (pure package; 1,024–3,008 MB memory, 60 s timeout).
- Events: Amazon EventBridge (daily schedule + custom events).
- AI: Amazon Bedrock (`BEDROCK_MODEL_ID` env — use any text model enabled in the
  account; do not hard-code), **Strands Agents SDK** for the assistant.
- Messaging: Twilio WhatsApp sandbox (inbound webhook + outbound send).
- Maps: MapLibre GL + deck.gl; Amazon Location Service for displayed road routes.
- Frontend: React + TypeScript + Vite, hosted on AWS Amplify Hosting.
- PDFs: reportlab + qrcode.

## 2. Layout

```
app/
  template.yaml
  backend/
    api/            # FastAPI app (routes below)
    loaders/        # S3 → DynamoDB loaders (triggered by S3 events)
    planner_fn/     # Dockerfile + handler calling strawlink_planner.plan_day
    webhook/        # Twilio inbound
    messaging/      # templates, Bedrock translate, Twilio send
    assistant/      # Strands agent + tools
    certificates/   # PDF + QR generator, verify logic
    exposure/       # downwind villages/schools
    emissions/
    common/         # config loader, ddb helpers, schema validation
  web/
    src/screens/    # Operator, Factory, Farmer, Backtest, Verify
    src/components/ # Map, WhyCard, DemoConsole, AssumptionsPanel, Charts
  tools/
    make_synthetic.py
    load_osm.py     # one-time Overpass export of villages + schools for the AOI
  tests/
```

## 3. Day 1 morning tasks (blocking Yash — do first)

1. **Field polygons** (deliver by 12:00): when Yash sends the block bbox, draw
   150–250 field polygons across 3–5 villages in geojson.io or QGIS. Add
   `field_id`, `village_id`, `village_name`. Compute `area_ha` in EPSG:32643,
   `straw_t = area_ha × straw_t_per_ha`, `sowing_deadline` from params.
   Save `data/fields/fields.geojson` and upload to S3.
2. **`tools/make_synthetic.py` → `config/synthetic.yaml`** (by 12:00), every entry
   tagged `synthetic: true`:
   - machines: baler sets, trucks, Super Seeders, based in the block's villages, with
     `rate_t_per_hr`, `hours_per_day` (values marked `# ASSUMPTION — cite`).
   - plants: 2–3 (biomass boiler, pellet plant, CBG) within ~30 km with
     `weekly_capacity_t`, `depot_capacity_t`, `fill_t`.
   - phones: one fake number per field; real team numbers for 3 demo fields come
     from env `DEMO_PHONE_MAP` (never committed).
   - combine bookings: ~15% of fields with a booked date (for F2 demo only).

## 4. DynamoDB tables

| Table | PK | SK | Notes |
|---|---|---|---|
| Fields | field_id | — | static props + latest forecast + status + route + priority parts |
| Plans | date | plan_id | policy, full plan JSON (S3 pointer if > 350 KB) |
| Events | field_id | ts | confirmed / rain / cleared / burned / message |
| Certificates | cert_id | — | GSI on field_id |
| Machines | machine_id | — | includes imported directory rows |
| Messages | phone | ts | inbound/outbound log |

Loaders: S3 put on `outputs/live/*/forecast.json` → update Fields;
`plan.json` → Plans + Fields(status, route, priority); `burn_status.json` → certificates.

## 5. API (FastAPI)

```
GET  /fields?date=                 fields with status, route, priority (GeoJSON)
GET  /fields/{id}                  why-card payload
GET  /villages/forecast?week=      village volumes P10/P50/P90
GET  /plan?date=&policy=           plan (strawlink|baseline)
POST /replan                       invoke planner Lambda with current state → store plan
POST /events/rain                  {village_id|all, mm, date} → Events + replan
POST /events/confirm               {field_id, date, source} → forecast override + replan
POST /simulate/missed-call         {phone} → confirm harvest = today for that field
POST /webhooks/whatsapp            Twilio inbound (validate signature)
GET  /plants/supply?weeks=         weekly tonnes per plant + depot alerts
GET  /backtest                     backtest_result.json (+ per-day plan URLs)
POST /fields/{id}/cleared          mark cleared (demo console) → certificate
GET  /certificates/{id}            PDF URL + status
GET  /verify/{id}                  public verification JSON
GET  /exposure?date=               downwind villages/schools
GET  /emissions?date=              estimate with formula + sources
GET  /machines                     machine list
POST /machines/import              CSV import (owner_name, village, machine_type, phone, available)
POST /assistant/chat               {phone|field_id, message} → assistant reply
```

`/replan` builds `PlannerInput` from DynamoDB + `config/params.yaml` +
`config/synthetic.yaml` + Open-Meteo rain, validates it against
`contracts/planner_input.schema.json`, invokes the planner Lambda, validates the
returned plan, stores it. EventBridge runs it daily at 06:00 IST and on
`confirm`, `rain`, and capacity-change events.

## 6. Screens (keep each to one clear job; large type; every number has a tooltip)

1. **Operator** (`/operator`): map of fields coloured by status (forecast, ready,
   scheduled, cleared, at risk, too wet); route lines per machine; date slider;
   toggle StrawLink vs baseline; village volume sidebar; click field → **WhyCard**
   (harvest window + source, route + reason, priority parts, wetness, assigned
   machine + ETA). Officer filter: at-risk only + exposure layer.
2. **Factory** (`/factory`): per plant, weekly expected tonnes with P10–P90 band,
   depot fill bars, alert banner when projected full within 2 days.
3. **Farmer** (`/farmer`): phone mock showing the WhatsApp thread (pickup or seeding
   slot, confirmation reply) and the assistant chat; Punjabi by default, English toggle.
4. **Backtest** (`/backtest`): reach rate, StrawLink vs baseline, at 3 fleet sizes
   (grouped bars); replay button that animates the map day by day; caveats text.
5. **Verify** (`/verify/:certId`): certificate details and no-burn check with image dates.
- **DemoConsole** (only with `?demo=1`): inject rain, confirm harvest, simulate
  missed call, mark field cleared, run re-plan.
- **AssumptionsPanel**: lists every ASSUMPTION/synthetic input from config.

## 7. Messaging and Bedrock

- Outbound: fill a fixed template (field, village, method, date, time window,
  operator name) → Bedrock translates to Punjabi (Gurmukhi) with the instruction
  "translate only, add nothing". Verify every date/number in the source appears in
  the output; if not, use the stored hand-written Punjabi template.
- Inbound (`/webhooks/whatsapp`): Bedrock extracts `{intent, date}` as JSON from
  Punjabi/Hindi/English free text; regex fallback for dates. Unknown phone → polite reply.
- Log every message in Messages.

## 8. Strands assistant

- Python, `strands-agents` package with a Bedrock model; check the current SDK
  docs for exact imports before writing code.
- Tools (each calls the API, no direct DB access): `get_field_status`,
  `get_pickup_slot`, `explain_route`, `list_free_machines(village)`,
  `get_certificate`.
- System prompt: reply in the user's language (Punjabi default); answer only from
  tool results; never promise a time that is not in the current plan; never discuss
  penalties or report anyone.
- Expose via `POST /assistant/chat`; reuse it for WhatsApp messages that are questions.

## 9. Certificates (F10)

- On `cleared`: create Certificate `status=pending_check`, generate PDF with field,
  village, date, method, machine, QR → `/verify/{cert_id}`.
- When pipeline `burn_status` = `no_burn_detected`, update status and regenerate PDF
  with "No burn scar detected in imagery of <dates>".
- Footer text: "Evidence to support an incentive claim. Not an official approval."

## 10. Exposure layer (F12)

- `tools/load_osm.py`: one-time Overpass export of `place=village|hamlet` and
  `amenity=school` within block bbox + 15 km → `data/osm/`.
- Wind: Open-Meteo hourly wind direction/speed at block centroid; use the 15:00–18:00
  mean (most burning now happens late afternoon).
- Risk fields = route `at_risk` or top-decile priority not scheduled today.
- A POI is downwind if distance ≤ `exposure_max_km` and the angle between the
  field→POI bearing and the wind-to direction (wind_from + 180°) ≤ `exposure_sector_deg`.
- Label in UI: "Potentially exposed if these fields burn" — not a pollution reading.

## 11. Emissions (F13)

`tonnes_cleared × emission_factor × assumed_burn_probability`. Until
`emission_factors` is cited in `config/params.yaml`, show "estimate pending source".
Show the formula and sources on hover.

## 12. Deploy

```
cd app && sam build && sam deploy --guided     # first time
cd app/web && npm i && npm run build           # Amplify Hosting connects to the repo
```
Secrets in SSM Parameter Store: Twilio SID/token/sandbox number, DEMO_PHONE_MAP.
CORS restricted to the Amplify domain.

## 13. Tests

- Validate stubs and all API responses against `contracts/`.
- API tests with moto (DynamoDB, S3).
- Messaging: translation guard rejects outputs missing dates/numbers.
- Exposure: bearing/sector math on hand-made points.

## 14. Demo and delivery (Day 4)

- Freeze data at 10:00; record the 3-minute video using the script in the PRD;
  keep a screen recording as backup for live failures.
- Deck: problem, how it works diagram, backtest result, AWS architecture, roadmap.
- Optional AWS Builder Center blog post (top 5 win prizes).

## 15. Don'ts

- Don't show stub or synthetic values without the synthetic label.
- Don't build any feature that reports or penalises farmers.
- Don't call `strawlink_planner` internals; only `plan_day` / `plan_day_baseline`.
- Don't change `contracts/` alone.
