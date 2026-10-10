# StrawLink — video script (short version, recorded by Shambhvi on 10 Oct 2026)

About 300 words. The finished film, `docs/video/strawlink-demo.mp4`, runs 2:17 (limit 3:00).
Paragraph 5 is her camera take with the phone; the rest is her voice recording, cut to the shots
by `app/tools/film/uservoice.py` (cut points in `voice-cuts.json`). A few words differ in her
reading ("turn into gold from green", "burnt", "wakes up the planner"); the captions follow her.

**1. The problem**

Every October, a farmer in Punjab harvests his rice and has three weeks to sow wheat. The straw is in the way. If no machine picks it up in time, he burns it.

**2. The idea**

So we built StrawLink: an app that anticipates the need, before it becomes a fire. It knows which fields will be ready, plans a machine for each one, and tells the farmer exactly when.

**3. How it knows**

From satellite images, it watches two hundred fields near Sangrur turn from green to gold, forecasts each harvest, and plans every machine's day each morning.

**4. Where the straw goes**

Balers and trucks take the straw to plants as fuel. Where plants are full, a Super Seeder sows wheat straight through it.

**5. The farmer** (on camera, phone in hand)

The farmer needs no app. Before his harvest, a WhatsApp message in Punjabi tells him when his field should be ready. When he cuts, he just says so in a voice note, and a machine is on its way. Nobody is ever reported or fined.

**6. The officer**

The officer can test a decision before spending money. Double the balers: nothing improves. Add trucks and seeders too, and the day clears twice as much.

**7. The test**

Would it have worked? We replayed 2025. Satellite images show 185 of these 200 fields were burned. With StrawLink, 75 would have been cleared before the fire. Most of the rest burned within two days of harvest. That is why StrawLink starts before it.

**8. How it is built**

It is serverless, on eleven AWS services. EventBridge wakes the planner on Lambda every morning. A farmer's voice note goes through Transcribe and Bedrock, and Amplify puts the plan on the officer's map.

**9. Why it matters**

For this one block, that is up to nine and a half tonnes of fine particles kept out of the air. Give it another block's data, and it plans that block. StrawLink: every field picked up in time, so no one has to burn.

## Shown on screen, not spoken

- Paragraph 6: "trucks are the limit" (the app's own note) and "about 10 days needed · 22 days left".
- Paragraph 7: the two bars from the 2025 page, and the line "first-come booking, same machines: 74 · burn detection from imagery, over-counts".
- Paragraph 8: the full diagram, including S3, DynamoDB, API Gateway, Systems Manager, CloudFormation and CloudWatch.
- Paragraph 9: "upper estimate" beside the 9.5 tonnes; "machines and plants shown are examples".

## The longer version

The first approved script (about 450 words) is in git history (commit 53ad29b).
