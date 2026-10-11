# We tested our idea against a whole burning season. It tied. That result built StrawLink.

*A serverless planner on AWS that gets paddy straw picked up before a farmer has a reason to burn it. Built for WeMakeDevs × AWS Environmental Hacks 2026, Air track.*

**Live demo:** https://main.d16side0ke5w9y.amplifyapp.com · **Code:** https://github.com/strawlink-1/strawlink · **3-minute video:** https://youtu.be/IEd7r5U8gP8

![The simulator: six balers, six trucks and six seeders clear 36 fields in a day instead of 18](https://raw.githubusercontent.com/strawlink-1/strawlink/main/docs/img/blog/simulator-what-if.jpg)

## Three weeks

Every October a farmer in Punjab harvests rice and has about three weeks to sow wheat. The field is covered in straw, and the straw is in the way. Machines that can deal with it exist: balers that pack it, trucks that carry the bales to plants that burn it as fuel, Super Seeders that sow wheat straight through it. But they are few, and nobody can tell a farmer when one will reach his field. Straw that is not picked up in time gets burned, and the smoke becomes the air of every village and city downwind.

So the problem we picked is not "detect fires". It is a scheduling problem with a deadline: **get the right machine to the right field before the farmer runs out of time.**

## What StrawLink does

For one block of 200 fields near Sangrur, StrawLink:

1. **Knows** which fields will be ready. A model reads Sentinel-2 satellite images and forecasts each field's harvest date.
2. **Plans** a machine for each one. Every morning an optimiser assigns balers, trucks and seeders, respecting plant capacity, rain and the sowing deadline.
3. **Tells** the farmer exactly when, on WhatsApp, in Punjabi. He needs no app. If he harvests early he says so, in a voice note if he likes, and the plan changes around him.

An officer gets a simulator on top of the same planner: move a slider for balers, trucks, seeders or rain, and the real planner answers in a few seconds.

## The test that changed the product

Before polishing anything we replayed the whole 2025 season on this block, day by day, with the same machines and the same information for two policies: our planner, and plain first-come booking.

![The 2025 replay: 75 of the 185 burned fields reached, against 74 for first-come booking](https://raw.githubusercontent.com/strawlink-1/strawlink/main/docs/img/blog/test-2025.jpg)

Satellite images show 185 of the 200 fields were burned that year. Our planner would have reached 75 of them before the fire. First-come booking would have reached 74.

That is a tie, and we report it as one. We did not tune the planner until it won.

The useful part was *why* it tied: most fields burned within about two days of harvest. No routing is clever enough if you only learn about a field after it is cut. The value is in knowing **before**. So we moved the product's weight from routing to early information:

- StrawLink writes to the farmer first, before the harvest, with the window its forecast gives for his field.
- A reply, typed or spoken, overrides the satellite and triggers a new plan.
- Rain re-plans the day.

That is the product in the video. The tie is on screen in the app, with the caveat that burn detection from imagery alone over-counts.

## The architecture

![Eleven AWS services: forecasts into S3 and DynamoDB, EventBridge waking the planner on Lambda, WhatsApp through API Gateway to Transcribe and Bedrock, and the web app on Amplify](https://raw.githubusercontent.com/strawlink-1/strawlink/main/docs/img/blog/aws-architecture.jpg)

Everything is one AWS SAM template in `ap-south-1` (Mumbai). No servers.

| Service | What it does here |
|---|---|
| **Amazon S3** | Forecast files from the satellite pipeline, certificate PDFs |
| **AWS Lambda** (5 functions) | The API (FastAPI), the planner (Google OR-Tools), a loader triggered by S3, the daily job, a WhatsApp worker |
| **Amazon DynamoDB** (6 tables) | Fields, plans, events, messages, machines, certificates |
| **Amazon EventBridge Scheduler** | Wakes the planner at 06:00 India time, every day |
| **Amazon API Gateway** (HTTP API) | The web app's API and the WhatsApp webhook |
| **Amazon Transcribe** | Turns a farmer's voice note into text, in Punjabi, Hindi or English |
| **Amazon Bedrock** (Amazon Nova Pro) | Reads what a message means, translates replies into Punjabi, and powers a farmer assistant built with **Strands Agents** |
| **AWS Amplify Hosting** | The React and three.js web app |
| **AWS Systems Manager** | Twilio credentials and phone numbers, encrypted, never in the repository |
| **AWS CloudFormation / SAM**, **Amazon CloudWatch** | The stack and its logs |

Amazon Location Service also computes the road route for each machine's stops.

## Four things that were harder than they looked

### 1. A 200 MB optimiser on Lambda, from a Windows laptop with no Docker

OR-Tools is a big native package, and I could not run Docker. The way through was to let pip fetch Linux ARM wheels directly and let CloudFormation do the rest:

```bash
pip install -r requirements.txt --target build/planner \
  --platform manylinux2014_aarch64 --python-version 3.12 \
  --implementation cp --only-binary=:all:

aws cloudformation package --template-file template.yaml --s3-bucket "$BUCKET" --output-template-file packaged.yaml
aws cloudformation deploy  --template-file packaged.yaml --stack-name strawlink \n  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND
```

The planner package is 201 MB unzipped. Lambda's limit is 250 MB. It fits, on Graviton (arm64), in a 3 GB function that solves the morning plan in about 23 seconds and a what-if in about 5.

### 2. WhatsApp gives you 15 seconds. Listening and re-planning take longer.

Twilio waits at most 15 seconds for a webhook to answer. Transcribing a voice note, asking Bedrock what it means and re-planning 200 fields does not fit. So the webhook only checks the signature and hands the message to a second Lambda, asynchronously:

```python
boto3.client("lambda").invoke(
    FunctionName=INBOUND_FUNCTION, InvocationType="Event",
    Payload=json.dumps({"from": sender, "body": text, "voice": media_url}).encode())
return Response("<Response/>", media_type="application/xml")
```

The worker takes its time, then answers through Twilio's API: first "heard, harvest recorded", then the new machine slot once the plan is redone.

![A real voice note, the app's reply, and the new machine slot, on my own phone](https://raw.githubusercontent.com/strawlink-1/strawlink/main/docs/img/blog/farmer-whatsapp.jpg)

### 3. A farmer does not pick a language first

A voice note might be Punjabi, Hindi or English, and people mix them. Amazon Transcribe can choose among a short list:

```python
transcribe.start_transcription_job(
    TranscriptionJobName=name, Media={"MediaFileUri": s3_uri}, MediaFormat="ogg",
    IdentifyLanguage=True, LanguageOptions=["pa-IN", "hi-IN", "en-IN"])
```

Across my test notes it picked English, Hindi and Punjabi. For my mixed Hindi-Punjabi sentences it switched between the two, which did not matter, because the next step reads the meaning and not the script. It also once heard my "aaj" (today) as "aa", which the app then treated as a question instead of a harvest date. The fix was not more code but a clearer instruction to the model: the text may be a transcript with small mistakes, and a farmer who says he is harvesting and names no day means today. The reply always starts with what was heard, so a wrong transcript is visible to the farmer instead of silently becoming a wrong plan. The recording is deleted as soon as it is transcribed.

### 4. An LLM must not change a time

Slot messages are written from a fixed template and translated into Punjabi by Bedrock. A translation that turns 08:01 into 08:10 sends a farmer to an empty field. So every translation passes a guard before it is sent: each number in the English source, dates, times and field IDs, must appear in the Punjabi output, or the app falls back to a hand-written Punjabi template.

```python
def guard_ok(source: str, translated: str) -> bool:
    pool = numbers_in(translated)          # Gurmukhi digits are normalised first
    for n in numbers_in(source):
        if n in pool: pool.remove(n)
        else: return False
    return True
```

Two smaller notes for anyone building the same thing. New Twilio trial accounts can only send Twilio's own WhatsApp templates (error 21654), so custom text needs the classic sandbox or an upgraded account. And Anthropic models on Bedrock need a one-time use-case form per AWS account; with a deadline close, Amazon Nova Pro through the `apac.amazon.nova-pro-v1:0` inference profile worked immediately.

## Rain, the air, and a certificate

![Rain on one village: the plan keeps the machines on dry fields](https://raw.githubusercontent.com/strawlink-1/strawlink/main/docs/img/blog/rain.jpg)

Three more things the prototype does:

- **Rain.** Fifteen millimetres on one village marks its fields too wet to work, and the day's plan moves to the dry ones.
- **The air.** For fields no machine can reach today, the Air page takes the afternoon wind and lists the villages and schools downwind. It is exposure if those fields burn, not a pollution reading, and it is never used to report anyone.
- **A certificate.** A cleared field gets a PDF with a QR code that opens a public check page. Nothing in StrawLink fines or reports a farmer, and burning last year never moves anyone up the queue.

![The clearance certificate and the public page its QR code opens](https://raw.githubusercontent.com/strawlink-1/strawlink/main/docs/img/blog/certificate.jpg)

For this one block, clearing the straw in time keeps up to 9.5 tonnes of fine particles (PM2.5) out of the air this season. That is an upper estimate: it assumes every field would otherwise burn, and uses published emission factors (Andreae 2019; IPCC 2006).

## What is real, and what is not

- **Real:** the satellite signals, the weather and wind, the roads and villages, the planner behind every slider, the WhatsApp messages and voice notes.
- **Approximate:** field outlines are 110 m squares on real paddy pixels, not surveyed boundaries.
- **Synthetic:** the machines, plants and phone numbers, labelled as such in the app. It adapts to any data: give it another block's fields, machines and plants in the same file formats and it plans that block.
- **Not on AWS yet:** the satellite pipeline runs offline and uploads its results to S3.

The day before submission the live stack handled about 750 Lambda invocations with zero errors.

## How we worked

My teammate Yash built the satellite pipeline, the forecast model and the planner's core. I took the project from there: the AWS stack and deployment, the API, the web app, the WhatsApp and voice-note channel, the certificates, and the demo. I wrote most of the code with an AI coding assistant, which made me the person deciding what to build, testing it on a real phone, and throwing things away. I threw away a whole first interface, a scripted animation, because a demo that cannot be touched proves nothing; the simulator that replaced it calls the real planner on every slider.

## What I would do next

- Add NASA FIRMS fire points to correct the burn labels, then run the 2025 replay again.
- Run the satellite pipeline on AWS on a schedule.
- Move WhatsApp off the sandbox, and try one real block with a real machine directory.

The idea is small enough to say in one line: **straw that is picked up in time is never burned.** The rest is logistics, and logistics is something the cloud is good at.

*StrawLink was built by Shambhvi and Yash. Try it: https://main.d16side0ke5w9y.amplifyapp.com*
