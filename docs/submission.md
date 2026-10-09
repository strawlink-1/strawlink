# StrawLink — submission text (draft)

Copy the parts the submission form asks for. Anything in [square brackets] is for you to fill in.

**Project name:** StrawLink

**Track:** Air

**One line:** A planning engine that gets every paddy field cleared before wheat sowing, so no farmer needs to burn straw.

**Links**
- Live demo: https://main.d16side0ke5w9y.amplifyapp.com
- Code: [repository link — make sure it is public]
- Video: [link]

## The problem

Farmers in Punjab have about three weeks between the rice harvest and wheat sowing. A field whose
straw is not cleared in time gets burned, and the smoke reaches villages, schools and cities
downwind. Balers, trucks and Super Seeders that clear straw without burning already exist. What is
missing is coordination: nobody knows which fields will be harvested when, so machines sit idle in
one village while fields wait in the next.

## What it does

StrawLink plans straw clearance for one block of 200 fields west of Sangrur.

- **Forecasts each field's harvest date** from Sentinel-2 satellite images.
- **Listens to farmers:** a WhatsApp message or a missed call overrides the forecast.
- **Chooses how each field is cleared:** baled and trucked to a plant with room, or sown straight
  through with a Super Seeder.
- **Ranks fields with a fair queue:** tonnes × urgency × a bonus for not burning last season × dry.
  Burn history never raises a field's priority, and nothing reports a farmer to anyone.
- **Plans every machine's day** with OR-Tools, and re-plans when it rains or a farmer confirms.
- **Shows it as a simulator:** move a slider — day, baler sets, Super Seeders, trucks, rain — and
  the planner re-plans in about three seconds. Run the day and watch machines drive the block's
  real roads, clear fields and carry bales to plants.
- **Shows who is downwind** of the fields no machine reaches, and what burning that straw would emit.
- **Issues a clearance certificate** with a QR code when a field is cleared.

## How we built it

- **Data:** Sentinel-2 imagery from the Earth Search STAC catalogue (2022–2026), Open-Meteo weather
  and wind, OpenStreetMap roads, villages and schools.
- **Models:** harvest and burn labels from NDVI and NBR time series; LightGBM quantile models for
  the harvest date; an OR-Tools routing model for the daily plan.
- **AWS:** API Gateway (HTTP API) → Lambda (FastAPI) → DynamoDB and S3; a separate planner Lambda;
  S3-triggered loader Lambda; EventBridge Scheduler for the daily re-plan; Amazon Bedrock for
  Punjabi translation and the farmer assistant (Strands Agents); Amplify Hosting for the web app.
  One SAM template, deployed to `ap-south-1`.
- **Web app:** React, TypeScript and three.js. One 3D map of the block shared by six pages.

## What is real and what is not

- **Real:** the satellite signals, weather and wind, roads, villages and schools, and the planner
  that answers every slider.
- **Approximate:** field outlines are 110 m grid cells on real paddy pixels, not surveyed boundaries.
- **Synthetic:** machines, plants, phone numbers and combine bookings. They are labelled in the app,
  and replacing the config files with real ones is all it takes to use real ones.

## Results, stated plainly

- Harvest forecast, tested on 2025: the middle estimate is off by 4.0 days on average. Its "80 %"
  range is still too narrow.
- The 2025 season replayed day by day, same fleet and same information for both policies:
  StrawLink reached 75 of 185 burned fields before they burned; first-come booking reached 74
  (40.5 % against 40.0 %). That is a tie. In 2025 most fields burned within about two days of
  harvest, so hearing about a harvest early matters more than clever routing — which is why the
  forecast, the farmer's WhatsApp and rain re-planning are the core of the product. We did not tune
  the planner to win this test.
- Burn detection uses imagery only so far and over-counts.

## Challenges

- Burn scars and ordinary tillage look alike from space; imagery alone over-counts burning.
- An honest backtest showed that routing alone does not beat first-come booking. We kept the
  result and changed what we emphasise.
- Deploying a 200 MB optimisation package to Lambda from a Windows laptop with no Docker: we fetch
  Linux wheels with pip and let CloudFormation apply the SAM template.

## What is next

- NASA FIRMS fire points to correct the burn labels, then re-run the backtest.
- Wider, calibrated forecast ranges.
- Real WhatsApp through Twilio, and a real machine directory for one block.
- Surveyed field boundaries from a land-records source.

## Team

Yash — satellite pipeline, forecast, planner, backend. Shambhvi — web app, AWS deployment.
