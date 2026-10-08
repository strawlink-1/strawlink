"""Scheduled jobs (EventBridge)."""

from __future__ import annotations

import json
import os
from datetime import date

from common import settings, store

from .main import notify_and_replan


def daily(event, _context):
    """06:00 IST re-plan; also publishes the cleared list the pipeline's burn check reads."""
    on = date.fromisoformat(os.environ["DEMO_DATE"]) if os.environ.get("DEMO_DATE") else settings.today()
    r = notify_and_replan(on, "daily")
    cleared = [{"field_id": f["field_id"], "cleared_on": f["cleared_on"]}
               for f in store.scan("fields") if f.get("cleared_on")]
    store.s3_put_json("outputs/app/cleared.json", cleared)
    print(json.dumps({"event": "daily_replan", "date": on.isoformat(), "strawlink": r.get("strawlink")}))
    return {"ok": True}
