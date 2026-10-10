# StrawLink — video script (extended version, proposed 10 Oct 2026 night)

About 335 spoken words plus the camera take. At the pace of Shambhvi's first recording this
runs close to 2:50; the limit is 3:00. Lines marked NEW are additions to the version already
filmed (2:17, `docs/video/strawlink-demo.mp4`); everything else is unchanged.

Record one file per paragraph (or one file with a clear pause between paragraphs). Paragraph 5
is the camera take that is already filmed; do not re-record it.

**1. The problem**

Every October, a farmer in Punjab harvests his rice and has three weeks to sow wheat. The straw is in the way. If no machine picks it up in time, he burns it.

**2. The idea**

So we built StrawLink: an app that anticipates the need, before it becomes a fire. It knows which fields will be ready, plans a machine for each one, and tells the farmer exactly when.

**3. How it knows**

From satellite images, it watches two hundred fields near Sangrur turn from green to gold, forecasts each harvest, and plans every machine's day each morning.

**4. Where the straw goes**

Balers and trucks take the straw to plants as fuel. Where plants are full, a Super Seeder sows wheat straight through it. NEW: Each plant sees how much straw is coming, and when its depot will fill.

**5. The farmer** (camera take, already filmed)

The farmer needs no app. Before his harvest, a WhatsApp message in Punjabi tells him his field should be ready. When he cuts, he just says so in a voice note, and the plan changes around him. A machine is on its way. Afterwards he gets a certificate, and no one is ever reported or fined.

**5b. The certificate** NEW

This is that certificate. Anyone can scan its code and check it.

**6. The officer**

The officer can test a decision before spending money. Double the balers: nothing improves. Add trucks and seeders too, and the day clears twice as much. NEW: If it rains on one village, the plan keeps the machines on dry fields. And any field can be clicked, to see when its machine comes, and why.

**6b. The air** NEW

And for fields no machine can reach today, the Air page shows which villages are downwind this afternoon, so everyone knows where the smoke would go.

**7. The test**

Would it have worked? We replayed 2025. Satellite images show 185 of these 200 fields were burned. With StrawLink, 75 would have been cleared before the fire. Most of the rest burned within two days of harvest. That is why StrawLink starts before it.

**8. How it is built**

It is serverless, on eleven AWS services. EventBridge wakes the planner on Lambda every morning. A farmer's voice note goes through Transcribe and Bedrock, and Amplify puts the plan on the officer's map.

**9. Why it matters**

For this one block, that is up to nine and a half tonnes of fine particles kept out of the air. Give it another block's data, and it plans that block. StrawLink: every field picked up in time, so no one has to burn.

## If it runs over three minutes

Lines are dropped in this order: the plants line (4), the field-card line (6), the certificate (5b).
The rain line and the Air paragraph stay.

## Checked against the live app (10 Oct 2026)

- Rain of 15 mm on one village: its 47–50 harvested fields are marked wet and the day's plan
  covers 12 fields in the other villages instead of 18.
- Air page: 18 villages are downwind of the fields with no machine, for the demo day's afternoon
  wind. The number follows the wind forecast, so it is shown on screen and not spoken.
- The no-burn bonus in the fair queue is not visible on any field today, so it is not mentioned.

## Shown on screen, not spoken

- Paragraph 6: "trucks are the limit" (the app's own note) and "about 10 days needed · 22 days left".
- Paragraph 6b: "Potentially exposed if these fields burn. Not a pollution reading."
- Paragraph 7: the two bars from the 2025 page, and the line "75 of 185 = 40.5 % · first-come booking, same machines: 74 · burn detection from imagery, over-counts".
- Paragraph 8: the full diagram, including S3, DynamoDB, API Gateway, Systems Manager, CloudFormation and CloudWatch.
- Paragraph 9: "upper estimate" beside the 9.5 tonnes; "machines and plants shown are examples".

## Earlier versions

The short version as first recorded is commit 68c0aeb; the first long script is commit 53ad29b.
