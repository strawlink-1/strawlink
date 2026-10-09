# StrawLink — 3-minute demo video script

A draft to rehearse and change. Left column: what is on screen and what to click. Right column:
what to say (about 420 words; read at a normal pace it runs just under three minutes).

Record from the live site: https://main.d16side0ke5w9y.amplifyapp.com

**Before recording**
- Open the Farmers tab and press **Start the demo over**, so no old messages or cleared fields remain.
- Use a window about 1440 × 810 or larger. Zoom the browser so the left panel shows all five sliders.
- Numbers on screen come from the planner. Read them off the screen rather than from this script;
  with bigger fleets they can differ slightly from run to run.
- Rehearse twice. Keep a second full recording as a backup.
- For a stronger assistant answer: in the Simulator, click a field with a blue ring (a machine
  comes today) before opening the Farmers tab. The tab then opens on that field, and the
  assistant replies with its real time slot instead of "no slot yet".

| Time | On screen | Say |
|---|---|---|
| 0:00 | Simulator tab, day not started. Slowly drag the map a little. | Every October, farmers in Punjab have about three weeks between harvesting rice and sowing wheat. If the straw is still on the field when sowing starts, the cheapest way to clear it is to burn it — and that smoke ends up in the air of every village and city downwind. |
| 0:18 | Still the Simulator. Point at the gold fields, then the machines parked at the villages. | Machines that can clear straw without burning already exist. What is missing is a plan that gets the right machine to the right field on the right day. StrawLink is that plan, for one block of two hundred fields near Sangrur. |
| 0:35 | Press **Run the day**. Push the Speed slider to about 20. Click a truck in the Machines list to follow it, then click it again. | This is today's plan from our planner. Baler sets bale the straw, trucks carry the bales to plants that still have room, and Super Seeders sow wheat straight into the straw where they do not. The machines drive the block's real roads, at the times in the plan. |
| 0:58 | Point at the scoreboard: fields cleared, straw dealt with, still waiting, the verdict. | The scoreboard is the plan's own numbers: fields cleared so far, straw dealt with, fields still waiting, and whether this fleet can finish before the sowing deadline. |
| 1:08 | Drag **Baler sets** from 3 to 6. Wait for "Plan ready". Then drag **Trucks** to 6. | Nothing here is scripted. If I double the baler sets, the planner re-plans — and clears nothing extra, because every truck trip is already used. Add trucks as well, and the same day clears many more fields. That is an answer a block officer can act on. |
| 1:30 | Press **Reset**. Drag **Rain** to about 15 mm. Fields turn blue. Then **Reset** again. | Rain: wet fields cannot be worked, so the planner keeps machines off them and says so. |
| 1:42 | **Farmers** tab. Tap the first quick reply (harvest done today). Wait for the reply. Then tap the question (when will my machine come?). | Farmers need no app. They get a WhatsApp message in Punjabi, and can reply with a harvest date or a question. A confirmation overrides the satellite forecast and triggers a re-plan. The assistant, on Amazon Bedrock, answers only from the current plan. |
| 2:02 | Press **The machine has finished: mark cleared**, then **Open clearance certificate**. Close that tab. | When a field is cleared the farmer gets a certificate with a QR code — evidence to support an incentive claim. StrawLink never reports or penalises anyone, and burning in the past never moves a field up the queue. |
| 2:16 | **Air** tab. Point at the wind compass, the orange fans, the list, then the emissions block. | The Air page shows this afternoon's wind, and which villages and schools are downwind of fields that still have no machine. Below it: what burning today's straw would put into the air — an upper estimate from published emission factors. |
| 2:32 | **2025 test** tab. Drag the date under the map through the season. Point at the bars. | We replayed the whole 2025 season on these fields. Honest result: with the same information, our planner and first-come booking reach about the same share of fields before they burn — forty point five against forty percent. Fields burned within about two days of harvest, so knowing early matters more than routing. That is why the forecast and the farmer's message come first. |
| 2:50 | **What is real here?** button (top right), then back to the Simulator. | The satellite signals, weather, roads and planner are real; the fleet and plants are synthetic and labelled. It runs on AWS: Lambda, DynamoDB, S3, API Gateway, Bedrock and Amplify. StrawLink — every field cleared in time, so no one has to burn. |

## If you need to cut for time

Drop the rain step (1:30) first, then the certificate (2:02). Never cut the 2025 result.

## Things to say only if asked

- Field outlines are 110 m grid cells on real paddy pixels, not surveyed boundaries.
- Burn detection uses imagery only so far and over-counts; NASA FIRMS is supported but not in these numbers.
- The forecast's middle estimate is off by 4.0 days on average; its "80 %" range is still too narrow.
- The satellite pipeline ran on a laptop; its results are loaded into AWS. Real WhatsApp (Twilio) is not connected — the thread is simulated with the same code path.
