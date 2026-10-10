"""Environment, shared config (params/synthetic/contracts/data) and small helpers.

In Lambda the repo's config/, contracts/ and data/ are copied to backend/shared/
by app/tools/sync_shared.sh; locally they are read from the repo root.
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parents[1]
SHARED = Path(os.environ.get("SHARED_DIR") or (HERE / "shared" if (HERE / "shared").exists() else HERE.parents[1]))
IST = timezone(timedelta(hours=5, minutes=30))

REGION = os.environ.get("AWS_REGION", "ap-south-1")
BUCKET = os.environ.get("STRAWLINK_BUCKET", "")
PLANNER_FUNCTION = os.environ.get("PLANNER_FUNCTION", "")
INBOUND_FUNCTION = os.environ.get("INBOUND_FUNCTION", "")  # worker that answers WhatsApp messages after the webhook returns
VOICE_LANGUAGES = os.environ.get("VOICE_LANGUAGES", "pa-IN,hi-IN,en-IN").split(",")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "")
PUBLIC_WEB_URL = os.environ.get("PUBLIC_WEB_URL", "http://localhost:5173")
TWILIO_PARAM = os.environ.get("TWILIO_PARAM", "/strawlink/twilio")
DEMO_PHONE_PARAM = os.environ.get("DEMO_PHONE_PARAM", "/strawlink/demo_phone_map")
TABLES = {
    k: os.environ.get(f"{k.upper()}_TABLE", f"strawlink-{k}")
    for k in ("fields", "plans", "events", "certificates", "machines", "messages")
}


def today() -> date:
    return datetime.now(IST).date()


def now_iso() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


@lru_cache
def params() -> dict:
    return yaml.safe_load((SHARED / "config" / "params.yaml").read_text(encoding="utf-8"))


@lru_cache
def synthetic() -> dict:
    f = SHARED / "config" / "synthetic.yaml"
    return yaml.safe_load(f.read_text(encoding="utf-8")) if f.exists() else {}


@lru_cache
def schema(name: str) -> dict:
    return json.loads((SHARED / "contracts" / f"{name}.schema.json").read_text(encoding="utf-8"))


@lru_cache
def geojson(rel: str) -> dict:
    f = SHARED / rel
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {"type": "FeatureCollection", "features": []}


def validate(doc, name: str) -> None:
    import jsonschema

    jsonschema.validate(doc, schema(name))


def assumptions() -> list[dict]:
    """Every ASSUMPTION / TODO / synthetic input, for the UI's assumptions panel."""
    out = []
    text = (SHARED / "config" / "params.yaml").read_text(encoding="utf-8").splitlines()
    for line in text:
        if ":" not in line or line.strip().startswith("#"):
            continue
        key, rest = line.split(":", 1)
        if not key or key.startswith(" "):
            continue
        val, _, comment = rest.partition("#")
        if "ASSUMPTION" in comment or "TODO" in val or "TODO" in comment:
            out.append({"key": key.strip(), "value": val.strip(), "note": comment.strip(), "source": "config/params.yaml"})
    syn = synthetic()
    for t, note in (syn.get("machine_type_notes") or {}).items():
        out.append({"key": f"machines.{t}", "value": "synthetic fleet", "note": note, "source": "config/synthetic.yaml"})
    if syn.get("plants"):
        out.append({"key": "plants", "value": f"{len(syn['plants'])} synthetic plants",
                    "note": "locations and capacities invented for the demo", "source": "config/synthetic.yaml"})
    fc = geojson("data/fields/fields.geojson")
    if fc.get("note"):
        out.append({"key": "field boundaries", "value": "grid_cell_approx", "note": fc["note"], "source": "data/fields/fields.geojson"})
    return out
