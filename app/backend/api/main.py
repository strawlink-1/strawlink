"""StrawLink API (FastAPI on Lambda via Mangum)."""

from __future__ import annotations

import csv
import io
import json
import os
import time
from datetime import date

import boto3
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from mangum import Mangum

from certificates import core as certs
from common import settings, store
from emissions import core as emissions
from exposure import core as exposure_core
from messaging import core as msg

from . import planning
from .supply import supply

app = FastAPI(title="StrawLink API", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])


# ---------------------------------------------------------------- helpers


def plan_date(d: str | None = None) -> date:
    if d:
        return date.fromisoformat(d)
    return date.fromisoformat(os.environ["DEMO_DATE"]) if os.environ.get("DEMO_DATE") else settings.today()


_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    v = fn()
    _cache[key] = (time.time(), v)
    return v


def live_dates() -> list[str]:
    def f():
        keys = store.s3_list("outputs/live/")
        return sorted({k.split("/")[2] for k in keys if k.count("/") >= 3})
    return cached("live_dates", 60, f)


def fields_all() -> list[dict]:
    return store.scan("fields")


def field_or_404(fid: str) -> dict:
    f = store.get("fields", field_id=fid)
    if not f:
        raise HTTPException(404, f"field {fid} not found")
    return f


def harvest_window(f: dict) -> dict | None:
    fc = planning.effective_forecast(f)
    return fc and {k: fc.get(k) for k in ("p10", "p50", "p90", "source", "confidence", "issued_on", "confirmed_by")}


def machine_rows() -> list[dict]:
    rows = store.scan("machines") or settings.synthetic().get("machines", [])
    return sorted(rows, key=lambda m: m["machine_id"])


def operator_names() -> dict[str, str]:
    return {m["machine_id"]: m.get("operator_name") or m.get("owner_name") or m["machine_id"] for m in machine_rows()}


def notify_and_replan(on: date, trigger: str) -> dict:
    r = planning.replan(on, trigger)
    r["messages"] = len(msg.notify_scheduled(r.get("scheduled", [])))
    return r


# ---------------------------------------------------------------- meta


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/meta")
def meta():
    fc = settings.geojson("data/fields/fields.geojson")
    villages = settings.geojson("data/fields/villages.geojson")
    report = cached("forecast_report", 300, lambda: store.s3_get_json("derived/forecast_report.json"))
    return {"plan_date": plan_date().isoformat(), "today": settings.today().isoformat(),
            "live_dates": live_dates(), "villages": villages["features"],
            "plants": settings.synthetic().get("plants", []), "assumptions": settings.assumptions(),
            "params": {k: v for k, v in settings.params().items() if not isinstance(v, (dict, list))},
            "fields_note": fc.get("note"), "demo_fields": msg.demo_fields(), "forecast_report": report,
            "bedrock_model": settings.BEDROCK_MODEL_ID or None}


@app.get("/roads")
def roads():
    """OSM roads and waterways of the block (display + path drawing). Empty if not exported yet."""
    return {"roads": settings.geojson("data/osm/roads.geojson"), "water": settings.geojson("data/osm/water.geojson"),
            "attribution": "Roads and waterways © OpenStreetMap contributors"}


# ---------------------------------------------------------------- fields


@app.get("/fields")
def get_fields(date: str | None = None):
    on = plan_date(date)
    rain, _ = cached(f"rain:{on}", 300, lambda: planning.rain_by_village(on))
    feats = []
    for f in sorted(fields_all(), key=lambda f: f["field_id"]):
        props = {
            "field_id": f["field_id"], "village_id": f["village_id"], "village_name": f.get("village_name"),
            "area_ha": f.get("area_ha"), "straw_t": f.get("straw_t"),
            "status": planning.field_status(f, on, rain.get(f["village_id"])),
            "route": f.get("route"), "priority": f.get("priority"), "harvest_window": harvest_window(f),
            "slot": f.get("slot"), "cleared_on": f.get("cleared_on"), "synthetic": f.get("synthetic", True),
        }
        feats.append({"type": "Feature", "geometry": json.loads(f["geometry"]), "properties": props})
    return {"type": "FeatureCollection", "date": on.isoformat(), "features": feats}


@app.get("/fields/{fid}")
def get_field(fid: str, date: str | None = None):
    f = field_or_404(fid)
    on = plan_date(date)
    rain, _ = cached(f"rain:{on}", 300, lambda: planning.rain_by_village(on))
    slot = f.get("slot")
    if slot:
        slot = {**slot, "operator": operator_names().get(slot["machine_id"], slot["machine_id"])}
    events = store.query("events", "field_id", fid, desc=True)[:10]
    certs_for = store.query("certificates", "field_id", fid, index="by_field")
    return {
        "field_id": fid, "village_id": f["village_id"], "village_name": f.get("village_name"),
        "area_ha": f.get("area_ha"), "straw_t": f.get("straw_t"), "sowing_deadline": f.get("sowing_deadline"),
        "status": planning.field_status(f, on, rain.get(f["village_id"])), "harvest_window": harvest_window(f),
        "satellite_forecast": f.get("forecast"), "confirmed": f.get("confirmed"),
        "route": f.get("route"), "route_reason": f.get("route_reason"), "priority": f.get("priority"),
        "priority_parts": f.get("priority_parts"), "days_left": f.get("days_left"), "dry": f.get("dry"),
        "rain_mm_3d": rain.get(f["village_id"]), "rain_wet_threshold_mm": settings.params()["rain_wet_threshold_mm"],
        "slot": slot, "unassigned_reason": f.get("unassigned_reason"), "cluster_id": f.get("cluster_id"),
        "plan_id": f.get("plan_id"), "plan_date": f.get("plan_date"), "cleared_on": f.get("cleared_on"),
        "burned_last_season": f.get("burned_last_season"),
        "certificate_id": certs_for[-1]["cert_id"] if certs_for else None,
        "events": events, "synthetic": f.get("synthetic", True), "boundary": f.get("boundary"),
    }


@app.post("/fields/{fid}/cleared")
def mark_cleared(fid: str, body: dict = Body(default={})):
    f = field_or_404(fid)
    on = (body.get("date") or plan_date().isoformat())
    slot = f.get("slot") or {}
    store.update("fields", {"field_id": fid}, {"cleared_on": on, "status": "cleared"})
    store.put("events", {"field_id": fid, "ts": settings.now_iso(), "type": "cleared", "date": on,
                         "machine_id": slot.get("machine_id"), "method": slot.get("method")})
    cert = certs.issue(f, on, slot.get("method") or f.get("route"), slot.get("machine_id"))
    return {"field_id": fid, "cleared_on": on, "certificate": certs.public_view(cert)}


# ---------------------------------------------------------------- forecasts + plans


@app.get("/villages/forecast")
def villages_forecast(week: str | None = None, issued: str | None = None):
    ds = live_dates()
    if not ds:
        raise HTTPException(404, "no live forecast yet")
    d = issued if issued in ds else ds[-1]
    rows = cached(f"vf:{d}", 300, lambda: store.s3_get_json(f"outputs/live/{d}/village_forecast.json")) or []
    if week:
        rows = [r for r in rows if r["week_start"] == week]
    return {"issued_on": d, "rows": rows}


@app.get("/plan")
def get_plan(date: str | None = None, policy: str = "strawlink"):
    on = plan_date(date)
    p = planning.load_plan(on, policy)
    if not p:
        raise HTTPException(404, f"no {policy} plan for {on}; POST /replan first")
    return p


@app.post("/replan")
def post_replan(body: dict = Body(default={})):
    on = plan_date(body.get("date"))
    return notify_and_replan(on, body.get("trigger", "manual"))


@app.post("/simulate")
def simulate(body: dict = Body(default={})):
    """What-if plan for one day: fleet size, rain and date come from the request; nothing is stored."""
    on = plan_date(body.get("date"))
    base = {t: sum(m["type"] == t for m in planning.machines()) for t in ("baler_set", "seeder", "truck")}
    fleet = {t: max(0, min(8, int(body.get(t, base[t])))) for t in base}
    try:
        return planning.scenario(on, fleet, rain_mm=max(0.0, min(100.0, float(body.get("rain_mm", 0)))),
                                 rain_village=str(body.get("rain_village", "all")),
                                 confirmed=tuple(str(x) for x in body.get("confirmed", [])[:200]),
                                 time_limit_s=max(1.0, min(12.0, float(body.get("time_limit_s", 3)))))
    except Exception as e:  # noqa: BLE001 — a scenario the planner rejects is the caller's to fix
        raise HTTPException(422, f"could not plan this scenario: {e}") from e


@app.post("/demo/reset")
def demo_reset(body: dict = Body(default={})):
    """Undo what was done during a demo — rain events, harvest confirmations, cleared marks,
    certificates and the message log — then re-plan. Forecasts, fields and the fleet are untouched."""
    on = plan_date(body.get("date"))
    touched = 0
    for f in fields_all():
        gone = [k for k in ("confirmed", "cleared_on", "status") if k in f]
        if gone:
            store.remove("fields", {"field_id": f["field_id"]}, gone)
            touched += "confirmed" in gone or "cleared_on" in gone
    removed = {"events": store.clear("events", ("field_id", "ts")),
               "certificates": store.clear("certificates", ("cert_id",)),
               "messages": store.clear("messages", ("phone", "ts"))}
    _cache.clear()
    return {"fields_reset": touched, "removed": removed, "replan": notify_and_replan(on, "reset")}


@app.post("/events/rain")
def rain_event(body: dict = Body(...)):
    on = plan_date(body.get("date"))
    ev = {"field_id": "RAIN", "ts": settings.now_iso(), "type": "rain", "date": on.isoformat(),
          "village_id": body.get("village_id", "all"), "mm": float(body["mm"])}
    store.put("events", ev)
    _cache.pop(f"rain:{on}", None)
    return {"event": ev, "replan": notify_and_replan(on, "rain")}


def confirm(fid: str, harvest: str, source: str, on: date) -> dict:
    f = field_or_404(fid)
    store.update("fields", {"field_id": fid}, {"confirmed": {"date": harvest, "source": source, "on": settings.now_iso()}})
    store.put("events", {"field_id": fid, "ts": settings.now_iso(), "type": "confirmed", "date": harvest,
                         "source": source})
    return {"field_id": fid, "village_name": f.get("village_name"), "harvest": harvest,
            "replan": notify_and_replan(on, f"confirm:{fid}")}


@app.post("/events/confirm")
def confirm_event(body: dict = Body(...)):
    on = plan_date(body.get("plan_date"))
    return confirm(body["field_id"], body.get("date") or on.isoformat(), body.get("source", "operator"), on)


@app.post("/simulate/missed-call")
def missed_call(body: dict = Body(...)):
    on = plan_date(body.get("plan_date"))
    fid = body.get("field_id") or msg.field_for_phone(body["phone"])
    if not fid:
        raise HTTPException(404, "phone not linked to a field")
    phone = body.get("phone") or msg.phone_for(fid) or "unknown"
    msg.log(phone, fid, "in", "[missed call]", channel="missed_call")
    return confirm(fid, on.isoformat(), "missed_call", on)


# ---------------------------------------------------------------- messaging


def handle_inbound(phone: str, text: str, on: date, channel: str, deliver: bool = False, heard: bool = False) -> dict:
    """Read a farmer's message and answer it.

    deliver: send the answer to the phone ourselves (the webhook has already returned).
    heard:   the text came from a voice note, so the answer starts with what was understood.
    """
    phone = phone.replace("whatsapp:", "").strip()
    fid = msg.field_for_phone(phone)
    msg.log(phone, fid, "in", text, channel=channel, **({"voice_note": True} if heard else {}))

    def answer(pa: str, en: str | None) -> str:
        if heard:
            pa, en = f'ਸੁਣਿਆ: "{text}"\n{pa}', (f'Heard: "{text}"\n{en}' if en else None)
        if deliver:
            msg.send_whatsapp(phone, fid, pa, en or "")
        else:
            msg.log(phone, fid, "out", pa, body_en=en, status="simulated" if channel != "whatsapp" else "reply")
        return pa

    if not fid:
        return {"reply": answer(msg.UNKNOWN_PA, msg.UNKNOWN_EN), "intent": "unknown_phone"}
    parsed = msg.parse_inbound(text, on)
    if parsed["intent"] == "harvest_date" and parsed["date"]:
        d = date.fromisoformat(parsed["date"]).strftime("%d-%m-%Y")
        reply_en = msg.CONFIRM_EN.format(date=d, field_id=fid)
        reply, _ = msg.translate_pa(reply_en, msg.CONFIRM_PA.format(date=d, field_id=fid))
        reply = answer(reply, reply_en)  # the thank-you first; the new slot follows once the plan is redone
        r = confirm(fid, parsed["date"], channel, on)
        return {"reply": reply, "reply_en": reply_en, "intent": parsed["intent"], "parser": parsed.get("parser"),
                "field_id": fid, "replan": r["replan"]}
    elif parsed["intent"] == "confirm_slot":
        store.put("events", {"field_id": fid, "ts": settings.now_iso(), "type": "slot_confirmed", "source": channel})
        reply_en = "StrawLink: thank you, your slot is confirmed."
        reply, _ = msg.translate_pa(reply_en, "ਸਟ੍ਰਾਲਿੰਕ: ਧੰਨਵਾਦ, ਤੁਹਾਡਾ ਸਮਾਂ ਪੱਕਾ ਹੋ ਗਿਆ ਹੈ।")
        out = {}
    else:
        from assistant.agent import chat

        a = chat(text, fid)
        reply, out = a["reply"], {"tools_used": a["tools_used"]}
        reply_en = msg.to_english(reply) if deliver else None
    reply = answer(reply, reply_en)
    return {"reply": reply, "reply_en": reply_en, "intent": parsed["intent"], "parser": parsed.get("parser"),
            "field_id": fid, **out}


@app.post("/fields/{fid}/ask")
def ask_farmer(fid: str):
    """Before the harvest: send the farmer the forecast window for his field and ask him to say when he cuts."""
    f = field_or_404(fid)
    phone = msg.phone_for(fid)
    m = msg.ask_message(f)
    if not phone or not m:
        raise HTTPException(404, "no phone or no satellite forecast for this field")
    sent = msg.send_whatsapp(phone, fid, m["pa"], m["en"])
    return {"field_id": fid, "status": sent["status"], "en": m["en"], "pa": m["pa"], "translation": m["translation"]}


@app.post("/webhooks/whatsapp")
async def whatsapp(request: Request):
    form = {k: str(v) for k, v in (await request.form()).items()}
    url = str(request.url).replace("http://", "https://")
    if not msg.verify_twilio(url, form, request.headers.get("X-Twilio-Signature", "")):
        raise HTTPException(403, "invalid signature")
    voice = form.get("MediaUrl0") if form.get("MediaContentType0", "").startswith("audio") else None
    if settings.INBOUND_FUNCTION:
        # Twilio waits 15 s at most; listening to a voice note and re-planning take longer, so a
        # worker answers through Twilio's API and this request returns at once.
        boto3.client("lambda", region_name=settings.REGION).invoke(
            FunctionName=settings.INBOUND_FUNCTION, InvocationType="Event",
            Payload=json.dumps({"from": form.get("From", ""), "body": form.get("Body", ""), "voice": voice,
                                "on": plan_date().isoformat()}).encode())
        return Response(content="<?xml version='1.0' encoding='UTF-8'?><Response/>", media_type="application/xml")
    r = handle_inbound(form.get("From", ""), form.get("Body", ""), plan_date(), "whatsapp")
    xml = f"<?xml version='1.0' encoding='UTF-8'?><Response><Message>{_xml(r['reply'])}</Message></Response>"
    return Response(content=xml, media_type="application/xml")


def inbound_work(event: dict) -> dict:
    """The worker's half of the WhatsApp webhook: listen (if it is a voice note), understand, answer, re-plan."""
    phone, on = event["from"].replace("whatsapp:", "").strip(), date.fromisoformat(event["on"])
    if not event.get("voice"):
        return handle_inbound(phone, event.get("body", ""), on, "whatsapp", deliver=True)
    try:
        said = msg.transcribe_voice(event["voice"])
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"event": "voice_error", "error": str(e)[:200]}))
        said = None
    if not said:
        fid = msg.field_for_phone(phone)
        msg.log(phone, fid, "in", "[voice note, not understood]", channel="whatsapp", voice_note=True)
        msg.send_whatsapp(phone, fid, msg.VOICE_UNCLEAR_PA, msg.VOICE_UNCLEAR_EN)
        return {"intent": "voice_unclear"}
    return {**handle_inbound(phone, said["text"], on, "whatsapp", deliver=True, heard=True), "language": said["language"]}


def _xml(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


@app.post("/farmer/message")
def farmer_message(body: dict = Body(...)):
    """Simulated WhatsApp for the Farmer screen (same handling as the Twilio webhook)."""
    fid = body["field_id"]
    phone = msg.phone_for(fid)
    if not phone:
        raise HTTPException(404, "no phone for field")
    return handle_inbound(phone, body["text"], plan_date(body.get("plan_date")), "simulated")


@app.get("/messages")
def messages(field_id: str):
    phone = msg.phone_for(field_id)
    rows = store.query("messages", "phone", phone) if phone else []
    return {"field_id": field_id, "messages": rows}


@app.post("/assistant/chat")
def assistant_chat(body: dict = Body(...)):
    from assistant.agent import chat

    fid = body.get("field_id") or (msg.field_for_phone(body["phone"]) if body.get("phone") else None)
    return chat(body["message"], fid)


# ---------------------------------------------------------------- plants, machines


@app.get("/plants/supply")
def plants_supply(weeks: int = 4, date: str | None = None):
    return supply(fields_all(), plan_date(date), max(1, min(weeks, 8)))


@app.get("/machines")
def get_machines(date: str | None = None):
    p = planning.load_plan(plan_date(date), "strawlink")
    stops = {a["machine_id"]: len(a["stops"]) for a in (p or {}).get("assignments", [])}
    return {"machines": [{**m, "stops_today": stops.get(m["machine_id"], 0)} for m in machine_rows()]}


@app.post("/machines/import")
async def import_machines(request: Request):
    """CSV: owner_name, village, machine_type, phone, available. Rates default to the synthetic type rates."""
    text = (await request.body()).decode("utf-8-sig")
    defaults = {m["type"]: m for m in settings.synthetic().get("machines", [])}
    vil = {v["properties"]["name"].lower(): v for v in settings.geojson("data/fields/villages.geojson")["features"]}
    added, skipped = [], []
    existing = {m["machine_id"] for m in machine_rows()}
    for i, row in enumerate(csv.DictReader(io.StringIO(text))):
        t = (row.get("machine_type") or "").strip().lower().replace(" ", "_")
        t = {"baler": "baler_set", "super_seeder": "seeder"}.get(t, t)
        v = vil.get((row.get("village") or "").strip().lower())
        if t not in defaults or not v:
            skipped.append({"row": i + 2, "reason": "unknown machine_type" if t not in defaults else "unknown village"})
            continue
        n = 1
        while f"IMP-{t[:2].upper()}{n:03d}" in existing:
            n += 1
        mid = f"IMP-{t[:2].upper()}{n:03d}"
        existing.add(mid)
        m = {"machine_id": mid, "type": t, "base": v["geometry"]["coordinates"],
             "rate_t_per_hr": defaults[t]["rate_t_per_hr"], "hours_per_day": defaults[t]["hours_per_day"],
             "available": str(row.get("available", "yes")).strip().lower() in ("1", "yes", "true", "y"),
             "village_id": v["properties"]["village_id"], "village_name": v["properties"]["name"],
             "owner_name": row.get("owner_name", "").strip(), "phone": row.get("phone", "").strip(),
             "imported": True, "rate_note": "default rate for type (ASSUMPTION)"}
        store.put("machines", m)
        added.append(mid)
    return {"added": added, "skipped": skipped}


# ---------------------------------------------------------------- certificates


@app.get("/certificates/{cid}")
def get_certificate(cid: str):
    c = store.get("certificates", cert_id=cid)
    if not c:
        raise HTTPException(404, "certificate not found")
    return {**certs.public_view(c), "pdf_url": store.presign(c["pdf_key"])}


@app.get("/verify/{cid}")
def verify(cid: str):
    c = store.get("certificates", cert_id=cid)
    if not c:
        raise HTTPException(404, "certificate not found")
    return certs.public_view(c)


# ---------------------------------------------------------------- exposure, emissions


@app.get("/exposure")
def get_exposure(date: str | None = None):
    on = plan_date(date)
    p = planning.load_plan(on, "strawlink")
    if not p:
        raise HTTPException(404, "no plan for this date; run a re-plan first")
    scheduled = {s["field_id"] for a in p["assignments"] for s in a["stops"] if a["type"] != "truck"}
    prios = sorted((f["priority"] for f in p["fields"]), reverse=True)
    cut = prios[max(0, len(prios) // 10 - 1)] if prios else 0
    cents = {f["field_id"]: f["centroid"] for f in fields_all()}
    risk = [{"field_id": f["field_id"], "centroid": cents[f["field_id"]]} for f in p["fields"]
            if f["field_id"] in cents and (f["route"] == "at_risk" or (f["priority"] >= cut > 0 and f["field_id"] not in scheduled))]
    lon, lat = planning.block_centroid()
    try:
        wind = exposure_core.afternoon_wind(round(lon, 3), round(lat, 3), on.isoformat())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"wind data unavailable: {e}") from e
    return {"date": on.isoformat(), **exposure_core.exposure(risk, wind)}


@app.get("/emissions")
def get_emissions(date: str | None = None, tonnes: float | None = None):
    """What burning straw in the field would emit. Default: the straw on fields marked cleared by `date`.
    With `tonnes`, the same sum for that amount of straw (the web app passes a plan's tonnage)."""
    on = plan_date(date).isoformat()
    if tonnes is not None:
        return {"date": on, **emissions.estimate(max(0.0, min(1e6, tonnes)), basis="asked")}
    t = sum(float(f.get("straw_t", 0)) for f in fields_all() if f.get("cleared_on") and f["cleared_on"] <= on)
    return {"date": on, **emissions.estimate(t)}


# ---------------------------------------------------------------- backtest


@app.get("/backtest")
def backtest():
    r = cached("backtest", 300, lambda: store.s3_get_json("outputs/backtest/backtest_result.json"))
    if r is None:
        raise HTTPException(404, "backtest not published yet")
    sens = cached("backtest_sens", 300, lambda: store.s3_get_json("outputs/backtest/backtest_sensitivity_confirm0.5.json"))
    return {"results": r, "sensitivity": sens,
            "replay": "/backtest/replay?policy={policy}&scale={scale}",
            "caveats": ["Field boundaries are approximate grid parcels on real 2025 paddy pixels.",
                        "Harvest and burn dates come from satellite labels; burns without FIRMS confirmation may be over-counted.",
                        "Machines and plants are synthetic; results compare policies, not real-world capacity.",
                        "Burning is replayed as observed; the counterfactual assumes a cleared field would not have burned."]}


@app.get("/backtest/replay")
def backtest_replay(policy: str = "strawlink", scale: float = 1.0):
    r = store.s3_get_json(f"outputs/backtest/replay/{policy}/{scale}.json")
    if r is None:
        raise HTTPException(404, "replay not published")
    return r


# ---------------------------------------------------------------- routes (Amazon Location)


@app.get("/routes")
def routes(date: str | None = None, policy: str = "strawlink"):
    on = plan_date(date)
    p = planning.load_plan(on, policy)
    if not p:
        raise HTTPException(404, "no plan")
    key = f"outputs/routes/{p['plan_id']}.json"
    hit = store.s3_get_json(key)
    if hit:
        return hit
    cents = {f["field_id"]: f["centroid"] for f in fields_all()}
    bases = {m["machine_id"]: m.get("base") for m in machine_rows()}
    feats = []
    for a in p["assignments"]:
        if a["type"] == "truck" or not a["stops"]:
            continue
        pts = [bases.get(a["machine_id"])] + [cents[s["field_id"]] for s in a["stops"] if s["field_id"] in cents]
        pts = [q for q in pts if q]
        line, src = road_route(pts)
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line},
                      "properties": {"machine_id": a["machine_id"], "type": a["type"], "source": src,
                                     "stops": [s["field_id"] for s in a["stops"]]}})
    fc = {"type": "FeatureCollection", "plan_id": p["plan_id"], "features": feats}
    store.s3_put_json(key, fc)
    return fc


def road_route(pts: list[list[float]]) -> tuple[list, str]:
    if len(pts) < 2:
        return pts, "none"
    try:
        import boto3
        from botocore.config import Config

        c = boto3.client("geo-routes", region_name=os.environ.get("LOCATION_REGION", settings.REGION),
                         config=Config(connect_timeout=3, read_timeout=8, retries={"max_attempts": 1}))
        kw = {"Origin": pts[0], "Destination": pts[-1], "TravelMode": "Car", "LegGeometryFormat": "Simple"}
        if len(pts) > 2:
            kw["Waypoints"] = [{"Position": q} for q in pts[1:-1]]
        r = c.calculate_routes(**kw)
        line = []
        for leg in r["Routes"][0]["Legs"]:
            line += leg["Geometry"]["LineString"]
        return line, "amazon-location"
    except Exception:  # noqa: BLE001 — straight segments if routing is unavailable
        return pts, "straight"


handler = Mangum(app, lifespan="off")

