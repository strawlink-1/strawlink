"""Planner Lambda: {"state": PlannerInput, "policy": "strawlink"|"baseline"} → plan JSON."""

from __future__ import annotations

import json
import time

from strawlink_planner import plan_day, plan_day_baseline


def handler(event, _context):
    t0 = time.monotonic()
    try:
        fn = plan_day_baseline if event.get("policy") == "baseline" else plan_day
        plan = fn(event["state"]).to_json_dict()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"event": "planner_error", "error": repr(e)}))
        return {"error": repr(e)}
    print(json.dumps({"event": "planned", "policy": plan["policy"], "totals": plan["totals"],
                      "solver": plan["solver"], "wall_s": round(time.monotonic() - t0, 2)}))
    return plan
