"""Outbound templates + Bedrock translation (guarded), inbound parsing, Twilio send/verify.

Without the /strawlink/twilio SSM parameter, messages are logged as simulated
(the Farmer screen still shows the thread).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import uuid
from datetime import date, datetime, timedelta

import boto3
import requests

from common import settings, store

METHOD_EN = {"bale": "baling crew (rake + baler) will collect the straw",
             "seed": "Super Seeder will sow wheat into the straw"}
# Hand-written fallback (used when the translation guard rejects Bedrock output).
# NOTE: should be reviewed by a native Punjabi speaker before the demo.
METHOD_PA = {"bale": "ਪਰਾਲੀ ਚੁੱਕਣ ਲਈ ਬੇਲਰ ਟੀਮ ਆਵੇਗੀ", "seed": "ਸੁਪਰ ਸੀਡਰ ਨਾਲ ਕਣਕ ਦੀ ਬਿਜਾਈ ਹੋਵੇਗੀ"}
TEMPLATE_EN = ("StrawLink: field {field_id} ({village}). On {date}, between {start} and {end}, the {method}. "
               "Operator: {operator}. Reply 1 to confirm, or send your harvest date.")
TEMPLATE_PA = ("ਸਟ੍ਰਾਲਿੰਕ: ਖੇਤ {field_id} ({village})। {date} ਨੂੰ {start} ਤੋਂ {end} ਵਿਚਕਾਰ {method}। "
               "ਆਪਰੇਟਰ: {operator}। ਪੁਸ਼ਟੀ ਲਈ 1 ਭੇਜੋ, ਜਾਂ ਆਪਣੀ ਕਟਾਈ ਦੀ ਤਾਰੀਖ਼ ਭੇਜੋ।")
UNKNOWN_EN = "StrawLink: we could not find a field for this number. Please contact your block coordinator."
UNKNOWN_PA = "ਸਟ੍ਰਾਲਿੰਕ: ਇਸ ਨੰਬਰ ਨਾਲ ਕੋਈ ਖੇਤ ਨਹੀਂ ਮਿਲਿਆ। ਕਿਰਪਾ ਕਰਕੇ ਆਪਣੇ ਬਲਾਕ ਕੋਆਰਡੀਨੇਟਰ ਨਾਲ ਸੰਪਰਕ ਕਰੋ।"
CONFIRM_EN = "StrawLink: thank you. Harvest on {date} recorded for field {field_id}. We will send your slot."
CONFIRM_PA = "ਸਟ੍ਰਾਲਿੰਕ: ਧੰਨਵਾਦ। ਖੇਤ {field_id} ਲਈ {date} ਦੀ ਕਟਾਈ ਦਰਜ ਹੋ ਗਈ ਹੈ। ਅਸੀਂ ਤੁਹਾਡਾ ਸਮਾਂ ਭੇਜਾਂਗੇ।"


def _bedrock(prompt: str, system: str, max_tokens: int = 400) -> str:
    if not settings.BEDROCK_MODEL_ID:
        raise RuntimeError("BEDROCK_MODEL_ID not set")
    r = boto3.client("bedrock-runtime", region_name=settings.REGION).converse(
        modelId=settings.BEDROCK_MODEL_ID, system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": max_tokens, "temperature": 0})
    return r["output"]["message"]["content"][0]["text"].strip()


def numbers_in(text: str) -> list[str]:
    return re.findall(r"\d+", text)


def guard_ok(source: str, translated: str) -> bool:
    """Every number (dates, times, ids) in the source must appear in the translation."""
    out = numbers_in(translated.translate(str.maketrans("੦੧੨੩੪੫੬੭੮੯", "0123456789")))
    pool = list(out)
    for n in numbers_in(source):
        if n in pool:
            pool.remove(n)
        else:
            return False
    return True


def translate_pa(english: str, fallback_pa: str) -> tuple[str, str]:
    """(text, how) — how ∈ bedrock | fallback."""
    try:
        t = _bedrock(english, "Translate the user's message into Punjabi (Gurmukhi script). Translate only; add "
                              "nothing, remove nothing. Keep every number, date, time and field ID exactly as "
                              "written in Western digits. Output only the translation.")
        if guard_ok(english, t):
            return t, "bedrock"
    except Exception:  # noqa: BLE001
        pass
    return fallback_pa, "fallback"


def slot_message(field: dict, slot: dict, operator: str) -> dict:
    d = date.fromisoformat(slot["date"])
    vals = {"field_id": field["field_id"], "village": field.get("village_name", field["village_id"]),
            "date": d.strftime("%d-%m-%Y"), "start": slot["arrive"][11:16], "end": slot["depart"][11:16],
            "operator": operator}
    en = TEMPLATE_EN.format(**vals, method=METHOD_EN[slot["method"]])
    pa, how = translate_pa(en, TEMPLATE_PA.format(**vals, method=METHOD_PA[slot["method"]]))
    return {"en": en, "pa": pa, "translation": how}


# ---------------------------------------------------------------- phones


def demo_phone_map() -> dict[str, str]:
    """field_id → phone (real team numbers from SSM, never committed)."""
    return store.ssm_json(settings.DEMO_PHONE_PARAM) or {}


def phone_for(field_id: str) -> str | None:
    return demo_phone_map().get(field_id) or (settings.synthetic().get("farmer_phones") or {}).get("by_field", {}).get(field_id)


def field_for_phone(phone: str) -> str | None:
    phone = phone.replace("whatsapp:", "").strip()
    for fid, ph in demo_phone_map().items():
        if ph == phone:
            return fid
    for fid, ph in ((settings.synthetic().get("farmer_phones") or {}).get("by_field", {})).items():
        if ph == phone:
            return fid
    return None


def demo_fields() -> list[str]:
    m = demo_phone_map()
    return sorted(m) if m else ["F0001", "F0002", "F0003"]


# ---------------------------------------------------------------- send / log


def log(phone: str, field_id: str | None, direction: str, body: str, **extra) -> dict:
    item = {"phone": phone, "ts": datetime.now(settings.IST).isoformat(timespec="milliseconds"),
            "field_id": field_id, "direction": direction, "body": body, **extra}
    store.put("messages", item)
    return item


def send_whatsapp(phone: str, field_id: str | None, body_pa: str, body_en: str) -> dict:
    creds = store.ssm_json(settings.TWILIO_PARAM)
    real = phone in demo_phone_map().values()
    status = "simulated"
    if creds and real:
        r = requests.post(f"https://api.twilio.com/2010-04-01/Accounts/{creds['sid']}/Messages.json",
                          auth=(creds["sid"], creds["token"]), timeout=15,
                          data={"From": creds["from"], "To": f"whatsapp:{phone}", "Body": body_pa})
        status = "sent" if r.ok else f"error:{r.status_code}"
        if not r.ok:
            # Twilio says why in its own words (a code and a sentence, no secrets); keep it with the message
            try:
                why = r.json()
                return log(phone, field_id, "out", body_pa, body_en=body_en, status=f"{status}:{why.get('code')}",
                           error=str(why.get("message", ""))[:300])
            except ValueError:
                pass
        elif body_en and body_en != body_pa:
            # demo phones also get the English translation as a second message, right after the Punjabi one
            e = requests.post(f"https://api.twilio.com/2010-04-01/Accounts/{creds['sid']}/Messages.json",
                              auth=(creds["sid"], creds["token"]), timeout=15,
                              data={"From": creds["from"], "To": f"whatsapp:{phone}", "Body": body_en})
            return log(phone, field_id, "out", body_pa, body_en=body_en, status=status,
                       english_copy="sent" if e.ok else f"error:{e.status_code}")
    return log(phone, field_id, "out", body_pa, body_en=body_en, status=status)


def notify_scheduled(stops: list[dict]) -> list[dict]:
    """Message demo farmers whose field got a slot in the new plan."""
    ops = {m["machine_id"]: m.get("operator_name", m["machine_id"]) for m in settings.synthetic().get("machines", [])}
    sent = []
    wanted = set(demo_fields())
    for s in stops:
        if s["field_id"] not in wanted:
            continue
        f = store.get("fields", field_id=s["field_id"])
        phone = phone_for(s["field_id"])
        if not f or not phone:
            continue
        m = slot_message(f, s, ops.get(s["machine_id"], s["machine_id"]))
        sent.append(send_whatsapp(phone, s["field_id"], m["pa"], m["en"]))
    return sent


# ---------------------------------------------------------------- voice notes


def transcribe_voice(media_url: str, wait_s: int = 100) -> dict | None:
    """A WhatsApp voice note → {text, language} with Amazon Transcribe (Punjabi, Hindi or English).

    The recording is kept only while it is being transcribed.
    """
    creds = store.ssm_json(settings.TWILIO_PARAM)
    if not creds or not settings.BUCKET:
        return None
    audio = requests.get(media_url, auth=(creds["sid"], creds["token"]), timeout=20)
    audio.raise_for_status()
    name = f"strawlink-voice-{uuid.uuid4().hex}"
    key = f"raw/voice/{name}.ogg"
    s3, tr = store._s3(), boto3.client("transcribe", region_name=settings.REGION)
    s3.put_object(Bucket=settings.BUCKET, Key=key, Body=audio.content, ContentType="audio/ogg")
    try:
        tr.start_transcription_job(TranscriptionJobName=name, Media={"MediaFileUri": f"s3://{settings.BUCKET}/{key}"},
                                   MediaFormat="ogg", IdentifyLanguage=True, LanguageOptions=settings.VOICE_LANGUAGES)
        end = time.time() + wait_s
        while time.time() < end:
            job = tr.get_transcription_job(TranscriptionJobName=name)["TranscriptionJob"]
            if job["TranscriptionJobStatus"] == "COMPLETED":
                out = requests.get(job["Transcript"]["TranscriptFileUri"], timeout=20).json()
                text = " ".join(t["transcript"] for t in out["results"]["transcripts"]).strip()
                return {"text": text, "language": job.get("LanguageCode")} if text else None
            if job["TranscriptionJobStatus"] == "FAILED":
                print(json.dumps({"event": "voice_failed", "reason": job.get("FailureReason")}))
                return None
            time.sleep(1.5)
        return None
    finally:
        s3.delete_object(Bucket=settings.BUCKET, Key=key)
        try:
            tr.delete_transcription_job(TranscriptionJobName=name)
        except Exception:  # noqa: BLE001 — still running; it expires on its own
            pass


VOICE_UNCLEAR_EN = "StrawLink: we could not make out your voice note. Please send it again, or type your message."
VOICE_UNCLEAR_PA = "ਸਟ੍ਰਾਲਿੰਕ: ਤੁਹਾਡਾ ਵੌਇਸ ਨੋਟ ਸਮਝ ਨਹੀਂ ਆਇਆ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਭੇਜੋ, ਜਾਂ ਲਿਖ ਕੇ ਭੇਜੋ।"


# ---------------------------------------------------------------- inbound


def verify_twilio(url: str, form: dict[str, str], signature: str) -> bool:
    creds = store.ssm_json(settings.TWILIO_PARAM)
    if not creds:
        return False
    data = url + "".join(k + form[k] for k in sorted(form))
    mac = hmac.new(creds["token"].encode(), data.encode(), hashlib.sha1).digest()
    return hmac.compare_digest(base64.b64encode(mac).decode(), signature or "")


TODAY_WORDS = ("today", "aaj", "ਅੱਜ", "आज")
YESTERDAY_WORDS = ("yesterday", "kal", "ਕੱਲ੍ਹ", "कल")


def regex_parse(text: str, on: date) -> dict:
    t = text.strip().lower().translate(str.maketrans("੦੧੨੩੪੫੬੭੮੯०१२३४५६७८९", "01234567890123456789"))
    if t in ("1", "yes", "ok", "haan", "ਹਾਂ", "हाँ"):
        return {"intent": "confirm_slot", "date": None}
    m = re.search(r"\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b", t)
    if m:
        y = int(m.group(3)) if m.group(3) else on.year
        y = y + 2000 if y < 100 else y
        try:
            return {"intent": "harvest_date", "date": date(y, int(m.group(2)), int(m.group(1))).isoformat()}
        except ValueError:
            pass
    if any(w in t for w in TODAY_WORDS):
        return {"intent": "harvest_date", "date": on.isoformat()}
    if any(w in t for w in YESTERDAY_WORDS):
        return {"intent": "harvest_date", "date": (on - timedelta(days=1)).isoformat()}
    return {"intent": "question" if "?" in t else "other", "date": None}


def parse_inbound(text: str, on: date) -> dict:
    """Bedrock extracts {intent, date}; regex fallback."""
    try:
        out = _bedrock(
            f"Today is {on.isoformat()}. Message: {text}",
            "A farmer in Punjab sent this WhatsApp message (Punjabi, Hindi or English) about paddy harvest and "
            "straw pickup. Return only JSON: {\"intent\": one of \"confirm_slot\" (agrees to the offered slot), "
            "\"harvest_date\" (says when harvest is/was), \"question\", \"other\"; \"date\": YYYY-MM-DD or null}. "
            "Resolve relative dates against today.", max_tokens=100)
        j = json.loads(out[out.find("{"): out.rfind("}") + 1])
        if j.get("intent") in ("confirm_slot", "harvest_date", "question", "other"):
            if j.get("date"):
                date.fromisoformat(j["date"])
            return {"intent": j["intent"], "date": j.get("date"), "parser": "bedrock"}
    except Exception:  # noqa: BLE001
        pass
    return {**regex_parse(text, on), "parser": "regex"}
