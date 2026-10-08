"""S3 → DynamoDB loaders.

data/fields/fields.geojson            → Fields (static props; dynamic attributes kept)
config/synthetic.yaml                 → Machines (synthetic rows; imported rows kept)
outputs/live/{date}/forecast.json     → Fields.forecast (+ burned_last_season from planner_input.json)
outputs/live/{date}/plan.json         → Plans + Fields(route, priority, slot)
outputs/live/{date}/burn_status.json  → Certificates
"""

from __future__ import annotations

import json
import urllib.parse

import boto3
import yaml

from common import settings, store


def _body(bucket: str, key: str) -> bytes:
    return boto3.client("s3", region_name=settings.REGION).get_object(Bucket=bucket, Key=key)["Body"].read()


def load_fields(fc: dict) -> int:
    for feat in fc["features"]:
        p = feat["properties"]
        ring = feat["geometry"]["coordinates"][0]
        if feat["geometry"]["type"] == "MultiPolygon":
            ring = feat["geometry"]["coordinates"][0][0]
        pts = ring[:-1] if ring[0] == ring[-1] else ring
        centroid = [round(sum(x for x, _ in pts) / len(pts), 6), round(sum(y for _, y in pts) / len(pts), 6)]
        store.update("fields", {"field_id": p["field_id"]}, {
            "village_id": p["village_id"], "village_name": p.get("village_name"), "area_ha": p["area_ha"],
            "straw_t": p["straw_t"], "sowing_deadline": p["sowing_deadline"], "plant_hint": p.get("plant_hint"),
            "geometry": json.dumps(feat["geometry"]), "centroid": centroid,
            "synthetic": bool(p.get("synthetic", fc.get("synthetic", False))), "boundary": p.get("boundary"),
        })
    return len(fc["features"])


def load_machines(doc: dict) -> int:
    rows = doc.get("machines", [])
    store.batch_put("machines", rows)
    return len(rows)


def load_forecast(rows: list[dict], planner_input: dict | None) -> int:
    settings.validate(rows, "forecast")
    burned = {f["field_id"]: f.get("burned_last_season") for f in (planner_input or {}).get("fields", [])}
    for r in rows:
        vals = {"forecast": {k: r[k] for k in ("issued_on", "p10", "p50", "p90", "source", "confidence")}}
        if r["field_id"] in burned:
            vals["burned_last_season"] = burned[r["field_id"]]
        store.update("fields", {"field_id": r["field_id"]}, vals)
    return len(rows)


def load_plan(plan: dict) -> int:
    from api import planning

    settings.validate(plan, "plan")
    planning.store_plan(plan, "pipeline_live")
    if plan["policy"] == "strawlink":
        planning.apply_plan_to_fields(plan)
    return len(plan["fields"])


def load_burn_status(rows: list[dict]) -> int:
    from certificates import core as certs

    n = 0
    for r in rows:
        for c in store.query("certificates", "field_id", r["field_id"], index="by_field"):
            if certs.apply_burn_status(c["cert_id"], r["status"], r.get("image_dates", [])):
                n += 1
    return n


def route(bucket: str, key: str) -> dict:
    name = key.rsplit("/", 1)[-1]
    if key == "data/fields/fields.geojson":
        return {"fields": load_fields(json.loads(_body(bucket, key)))}
    if key == "config/synthetic.yaml":
        return {"machines": load_machines(yaml.safe_load(_body(bucket, key)))}
    if key.startswith("outputs/live/") and name == "forecast.json":
        pi_key = key.replace("forecast.json", "planner_input.json")
        try:
            pi = json.loads(_body(bucket, pi_key))
        except Exception:  # noqa: BLE001
            pi = None
        return {"forecast": load_forecast(json.loads(_body(bucket, key)), pi)}
    if key.startswith("outputs/live/") and name == "plan.json":
        return {"plan": load_plan(json.loads(_body(bucket, key)))}
    if key.startswith("outputs/live/") and name == "burn_status.json":
        return {"burn_status": load_burn_status(json.loads(_body(bucket, key)))}
    return {"ignored": key}


def handler(event, _context):
    out = []
    for rec in event.get("Records", []):
        b = rec["s3"]["bucket"]["name"]
        k = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])
        r = route(b, k)
        print(json.dumps({"event": "loaded", "key": k, **r}))
        out.append(r)
    return out
