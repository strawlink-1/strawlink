"""StrawLink planner. Public API: plan_day(state) and plan_day_baseline(state).

Pure Python — no S3/AWS calls — so app/ can package it into a Lambda image.
`state` is a PlannerInput or a dict matching contracts/planner_input.schema.json;
the result is a Plan (use `.to_json_dict()` for contracts/plan.schema.json).
"""

from __future__ import annotations

from typing import Any

from .assemble import build_plan, expand, haul
from .baseline import plan_day_baseline
from .models import Plan, PlannerInput
from .prepare import prepare
from .solve import PointIndex, solve_type

__all__ = ["Plan", "PlannerInput", "plan_day", "plan_day_baseline"]


def plan_day(state: PlannerInput | dict[str, Any]) -> Plan:
    if not isinstance(state, PlannerInput):
        state = PlannerInput.model_validate(state)
    prep = prepare(state)
    pidx = PointIndex(prep)

    budget = state.time_limit_s * 0.45  # two VRPs + assembly must fit the limit
    res_b = solve_type(prep, pidx, "bale", "baler_set", budget)
    res_s = solve_type(prep, pidx, "seed", "seeder", budget)

    bale_stops = expand(prep, res_b.visits)
    seed_stops = expand(prep, res_s.visits)
    kept_bale, dropped, trucks = haul(prep, pidx, bale_stops)
    stops = kept_bale + seed_stops
    served = {s.field_id for s in stops}

    available = {m.type for m in state.machines if m.available}
    need = {"bale": "baler_set", "seed": "seeder"}
    h_end = prep.horizon[-1]
    unassigned: dict[str, str] = {}
    for fid, fp in prep.fields.items():
        if fp.unassigned_reason:
            unassigned[fid] = fp.unassigned_reason
        elif fid in dropped:
            unassigned[fid] = "capacity" if "truck" in available else "no_machine"
        elif fp.candidate and fid not in served:
            if need[fp.route] not in available:
                unassigned[fid] = "no_machine"
            elif fp.f.sowing_deadline <= h_end:
                unassigned[fid] = "deadline"
                fp.route = "at_risk"
                fp.route_reason = "no machine can reach it before the sowing deadline"
            else:
                unassigned[fid] = "capacity"

    objs = [r.objective for r in (res_b, res_s) if r.objective is not None]
    return build_plan(
        prep,
        "strawlink",
        stops,
        trucks,
        unassigned,
        status=f"bale:{res_b.status};seed:{res_s.status}",
        runtime_s=res_b.runtime_s + res_s.runtime_s,
        objective=sum(objs) if objs else None,
    )
