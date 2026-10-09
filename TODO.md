# StrawLink — to-do list

Last updated Fri 9 Oct 2026. Submission: Sun 11 Oct, video recorded by noon.
`[x]` = done, `[ ]` = still to do. Sources: `HANDOFF.md` (Yash) and the work done since.

## 1. Data and satellite pipeline (Yash) — done, with known weaknesses

- [x] Pick the block (west of Sangrur) from 2025 burn-scar imagery
- [x] 200 field parcels across 4 villages (Alal, Sultanpur, Mulowal, Ranike) — approximate grid cells on real paddy pixels, not hand-drawn
- [x] Synthetic machines, plants, phone numbers and combine bookings (`config/synthetic.yaml`)
- [x] Villages and schools from OpenStreetMap (for the downwind layer)
- [x] Sentinel-2 download and per-field greenness series, 2022–2026
- [x] Harvest dates detected for 97–99.5 % of fields per season
- [x] Burn detection from imagery
- [x] Harvest forecast model (median error 4.0 days on 2025)
- [x] Weekly straw volume per village
- [x] Planner: fair queue, bale-or-seed route choice, daily machine routing, truck hauls, first-come baseline
- [x] 2025 season backtest at three fleet sizes, plus day-by-day replay files
- [x] Live forecast and plan for the demo day (24 Oct 2026)
- [x] Contract schemas v0.1 and stub files
- [x] 53 pipeline tests passing (on Yash's machine)

Still weak — fix if time allows, otherwise say it plainly in the demo:

- [ ] **Add NASA FIRMS fire data** — burns are over-counted without it (2025 shows 92.5 % burned). Needs a free `FIRMS_MAP_KEY`, then rerun burns → forecast → backtest
- [ ] **Widen the forecast range** — the "80 %" range only contains about 35 % of real harvests
- [ ] Rerun live forecast + backtest after the two fixes above
- [ ] Wire `burn_status` into the live run so certificates can say "no burn detected"
- [ ] Review contracts v0.1 together and bump to 1.0

## 2. Backend — code done and tested here, not deployed yet

- [x] All API routes (fields, plan, re-plan, rain, harvest confirmation, missed call, plants, machines, backtest, certificates, verify, exposure, emissions, assistant, WhatsApp webhook, road routes)
- [x] Loaders from S3 into DynamoDB
- [x] Re-plan on rain and on harvest confirmation
- [x] WhatsApp message templates with Punjabi translation and a number-check guard
- [x] Farmer assistant (Strands + Bedrock)
- [x] Clearance certificate PDF with QR code
- [x] Downwind exposure (villages and schools)
- [x] SAM template for the whole stack
- [x] Local dev server that needs no AWS account (works on Windows)
- [x] `POST /simulate` — what-if plan for the Simulator's sliders; stores nothing
- [x] `POST /demo/reset` — undo rain events, confirmations, cleared marks, certificates and messages, then re-plan (button on the Farmers page)
- [x] Emissions estimate with cited factors (Andreae 2019 for PM2.5, black carbon, CO, CO2; IPCC 2006 for the share that burns), shown on the Air page as an upper estimate
- [x] "Mark cleared" on the Farmers page, so the certificate and its verify page can be shown
- [x] Backend tests re-run on this machine: 16 pass
- [x] Planner and contract tests re-run on this machine: 34 pass; 1 needs scikit-learn, which is not installed here
- [ ] The other pipeline tests (forecast, labels, burns) need the pipeline's own packages (lightgbm, rasterio); not run here
- [ ] Native-speaker check of the hand-written Punjabi templates

## 3. AWS deployment — live since 9 Oct 2026

Web app: https://main.d16side0ke5w9y.amplifyapp.com
API: https://u1feqhbpaa.execute-api.ap-south-1.amazonaws.com
Stack `strawlink`, region `ap-south-1`, in Shambhvi's AWS account. No Docker or SAM CLI needed:
`app/tools/deploy_nodocker.sh` fetches Linux packages with pip and lets CloudFormation apply the
SAM template.

- [x] Lambda packages build on this laptop (API 118 MB, planner 201 MB unzipped; limit 250 MB)
- [x] Stack created: S3 bucket, 6 DynamoDB tables, API + planner + loader + daily Lambdas, HTTP API, daily schedule, Location key
- [x] Data published to S3; loaders filled DynamoDB; first re-plan ran on AWS (18 fields, 131 t — same as local)
- [x] Web app on Amplify Hosting, built against the live API
- [x] Checked on AWS: every read endpoint, the simulator's sliders (3/3/3 → 18 fields, 6/6/6 → 36, rain → 0), harvest message with Punjabi reply, farmer assistant with tools, certificate + PDF link + verify, demo reset
- [x] Fixed on the way: certificate PDF links are signed for the regional S3 endpoint; the assistant's reply drops a model's `<thinking>` notes
- [x] Bedrock model: Amazon Nova Pro (`apac.amazon.nova-pro-v1:0`). Claude Haiku 4.5 (the template default) is refused in this account until the Anthropic use-case form is submitted in the Bedrock console
- [ ] Optional: submit that form, then redeploy with the default model if Claude's Punjabi reads better
- [ ] Twilio WhatsApp sandbox + SSM parameters + webhook URL (optional; the Farmers page simulates the thread without it)
- [ ] Old leftovers in the account, safe to delete: `strawlink-de4e8727-CompanionStack` (empty its ECR repo first) and `aws-sam-cli-managed-default`
- [ ] The account is used as the root user; create an IAM admin user and turn on root MFA when there is time
- [ ] After the hackathon, to stop all cost: empty the two `strawlink-…` buckets, delete the `strawlink` stack and the `strawlink-web` Amplify app

To redeploy after a change (the login lasts some hours; `aws login --profile strawlink` renews it):

```bash
AWS_PROFILE=strawlink BEDROCK_MODEL_ID=apac.amazon.nova-pro-v1:0 app/tools/deploy_nodocker.sh all
```

## 4. Web app — rebuilt on 9 Oct around a slider-driven Simulator

A light, simple tool: page tabs on top, inputs on the left, the 3D map in the middle with a
scoreboard above it and a time bar below it (`app/web/README.md`).

- [x] Shell: page tabs, left panel, 3D map, scoreboard strip, time bar; light look; "What is real here?" sheet
- [x] **Simulator** (opens first): five sliders — day, baler sets, Super Seeders, trucks, rain (whole block or one village). Every change goes to the real planner (`POST /simulate`); the map, machine list and scoreboard follow the plan it returns
- [x] Each slider says what that kind of machine achieved in the plan (fields baled, fields sown, truck trips used), and says so when every truck trip is used
- [x] Run the day slowly: tractors and trucks drive real OpenStreetMap roads at the plan's times, a field is cleared in passes, bales go to the plants. Speed slider (1–60 plan-minutes a second, starts at 4) and a scrubber
- [x] The whole fleet is on the map; a machine with no work stays parked and the list says so; click a machine to follow it
- [x] Scoreboard: fields cleared so far / planned, straw dealt with, fields still waiting (and too wet), "enough / not enough machines"
- [x] Field card on click, with "Farmer says: harvested today" feeding straight back into the plan
- [x] **Forecast**, **Plants**, **Farmers**, **Air**, **2025 test** pages, one job each
- [x] Backend: `/simulate` (stores nothing; has a test), `/roads`, wind fallback when the plan day is beyond the forecast, UTF-8 config reading
- [x] The Simulator opens on the saved plan (the one farmers are told about); only a moved slider asks the planner for a what-if. Before this the field card and the farmer's assistant could disagree
- [ ] **You run the Simulator and sign off look, speed and clarity**
- [x] Every page checked on the live site from screenshots (`docs/img`, taken with `app/tools/screenshots.mjs`): simulator at rest, mid-day, following a machine, a bigger fleet, rain, the field card, and the five other pages
- [x] Fixed from that check: the map was missing on every page except the Simulator; labels now shrink on a small window; status rings only show on the Simulator
- [ ] Check it on the laptop and screen size you will record on
- [ ] Punjabi names for the four villages (`name_pa` is empty in `data/fields/villages.geojson`)
- [x] "Start the demo over" on the Farmers page (`POST /demo/reset`)
- [ ] After deploy: confirm Amazon Location road routes replace the local road graph

## 5. Repository housekeeping

- [x] Work committed on the local branch `simulator-ui`
- [ ] **Push it.** GitHub refuses: user `shambhvi2006` has read-only access to `strawlink-1/strawlink`, and the repository is private. Either get write access (and make it public for the judges), or create a new public repository and push there
- [x] `README.md` for the judges
- [x] `app/CLAUDE.md` and `app/web/README.md` describe the new UI
- [ ] Update `HANDOFF.md` to match

## 6. Demo and submission (Sun 11 Oct, video by noon)

- [x] Draft of the 3-minute script with what to click and what to say: `docs/demo-script.md`
- [x] Draft deck, 11 slides with speaker notes: https://claude.ai/artifact/SdBubpT3h94vt8eFJLmjZV (private until shared from its Share menu; downloads as PowerPoint or PDF)
- [x] Draft submission text: `docs/submission.md`
- [x] Narrated demo film, 2:52, 1080p, English voice (Amazon Polly, Kajal) with captions and zooms, rendered frame by frame from the live site: `docs/video/strawlink-demo.mp4` (not in git; rebuild with `app/tools/film/voice.py`, `film.mjs`, `assemble.mjs`). Narration text: `app/tools/film/narration.json`
- [x] Caveats written into the script, the deck and the README: approximate parcels, synthetic fleet and plants, burn over-count, narrow forecast range, the backtest is a tie
- [ ] **You:** read the script and the deck, change the wording to your own
- [ ] **You:** have a Punjabi speaker read the messages the app sends
- [ ] **You:** watch the film with sound once (the voice is synthetic and nobody has listened to it yet); upload it and put the link in the submission
- [ ] Optional: record your own take instead, with `docs/demo-script.md`
- [ ] **You:** put the repository link into the deck's last slide and `docs/submission.md`
- [ ] **You:** fill in the submission form (repo, live link, video)
- [ ] Optional: AWS Builder Center blog post

## Cut order if time runs out

Emissions → exposure layer → assistant (keep the API) → certificates. Never cut the backtest.
