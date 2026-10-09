# StrawLink web app

A simulator for one block. Set the day, the fleet and the rain with sliders; the real planner
re-plans; run the day and watch machines clear the fields on a 3D map. React + TypeScript + Vite,
three.js through `@react-three/fiber`. Every number on screen comes from the StrawLink API;
nothing is scripted.

## Run

```bash
npm install
npm run dev -- --port 5173        # http://localhost:5173
```

The app talks to the API at `VITE_API_URL` (default `http://localhost:8000`). To run that API
locally with no AWS account, from the repo root:

```bash
app/.venv/Scripts/python.exe app/tools/dev_server.py --date 2026-10-24 --port 8000   # Windows
app/.venv/bin/python app/tools/dev_server.py --date 2026-10-24 --port 8000           # macOS / Linux
```

`npm run build` type-checks and builds to `dist/`.

## How it is put together

```
src/
  sim/        the simulation: pure data → positions and looks, no drawing
    world.tsx   the slider inputs, the planner's answer to them, fields, roads, fleet, the day clock
    dayplan.ts  a plan → where each machine is at each minute
    roads.ts    the block's road graph and shortest paths (for drawing routes)
    stage.ts    what the map should show right now; each page publishes its own mode
    geo.ts      projection, parcels, helpers
  scene/      the one shared 3D map
    Stage3D.tsx camera, light, composition
    ground.ts   paints the board: land, real roads and waterways
    Fields.tsx  every field (instanced), the strip a machine clears, bales
    Vehicles.tsx tractors and trucks, their routes and name tags
    Scenery.tsx board, houses, trees, plants, village labels
    Effects.tsx rain, smoke, pulses, truck-trip arcs, wind and downwind fans
    Label.tsx   text pinned to a point on the map, drawn as ordinary HTML
  views/      one file per page tab; each fills the left panel and the strips round the map
  ui/         Shell (frame), kit (sliders, tiles, legend), Transport (time bar), FieldCard
  screens/Verify.tsx   public page behind a certificate's QR code
```

The frame never changes: page tabs across the top, a panel on the left, the map in the middle with
one strip above it and one below it. A page is a component that renders into those slots
(`<InPanel>`, `<InAbove>`, `<InBelow>`) and calls `useStageMode(...)` to say how fields are
coloured, whether machines are shown and where the camera looks. The map never knows which page
is on screen.

## Pages

| Page | Job | API |
|---|---|---|
| Simulator | Sliders → planner → run the day and watch | `POST /simulate`, `/fields`, `/machines`, `/roads` |
| Forecast | Scrub the season: fields turn from standing paddy to straw | `/fields`, `/villages/forecast` |
| Plants | Bale or seed per field, the plants and their depots, truck trips | `/plants/supply` |
| Farmers | WhatsApp thread in Punjabi, the slot, the certificate | `/messages`, `/farmer/message`, `/fields/{id}` |
| Air | Afternoon wind, places downwind of fields with no machine | `/exposure`, `/emissions` |
| 2025 test | The 2025 season replayed, StrawLink against first-come booking | `/backtest`, `/backtest/replay` |

### How the Simulator answers a slider

1. A slider changes `inputs` in `sim/world.tsx` (day, baler sets, Super Seeders, trucks, rain, fields a farmer confirmed).
2. 450 ms after the last change the inputs are posted to `/simulate`. The API builds the planner's
   input from the stored fields and forecasts, applies the fleet and rain, runs `plan_day`, and
   returns the plan plus each field's status. Nothing is stored.
3. `dayplan.ts` turns the plan into a track per machine; the drive between two planned times is
   drawn along the road graph.
4. The map, the machine list, the scoreboard and the colour key all read that plan and the day
   clock. The time of day is kept when a new plan arrives, so a slider moved mid-run shows the
   same moment under the new plan.

## Putting real data in

The scene is drawn from five inputs, all served by the API:

1. fields — `data/fields/fields.geojson` (outline, village, straw tonnes)
2. plan — `plan.json` from the planner (who visits which field, when; truck deliveries)
3. machines and plants — `config/synthetic.yaml`
4. roads and waterways — `data/osm/roads.geojson`, `water.geojson` (`app/tools/load_osm.py`)
5. forecasts, backtest, exposure — pipeline outputs

Replace any of those files with real ones in the same format and every view uses them. Roads,
villages and imagery are already real; field outlines are approximate; machines and plants are
synthetic. The "What is real here?" button in the top bar lists every assumption.

## Things worth knowing

- Machine positions are the plan's arrival and departure times with the drive drawn in between
  along the road graph. They are planned times, not GPS.
- Deployed, `/routes` returns Amazon Location road lines and those are used instead of the local graph.
- Plants are 15–25 km from the block. They are drawn on islands at the board's edge, at the true
  bearing, and their labels give the real distance.
- `prefers-reduced-motion` turns off camera glides and smoothing.
- The satellite photo (switch on the map) is Esri World Imagery; roads are © OpenStreetMap contributors.
- A baled field needs a truck trip, and a truck makes `truck_trips_per_day` trips (an assumption in
  `config/params.yaml`). More baler sets without more trucks clear nothing extra; the Simulator says so.
- The planner is given 3 seconds per what-if, so a slider answers in about 4 seconds.
