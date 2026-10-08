"""First-come baseline: what happens today without StrawLink.

- A field enters the queue the day AFTER it is actually harvested (booking after
  harvest). In the state, "actually harvested" = source=confirmed and p50 < date.
- Queue order = entry date, then field_id.
- Bale route only; nearest baler set that can still finish today.
- No rain awareness: wet fields are scheduled anyway (the backtest fails them).
- Plant full → field waits.
"""

from __future__ import annotations

import time as _time
from datetime import timedelta
from typing import Any

from .assemble import FieldStop, build_plan, haul
from .models import Plan, PlannerInput
from .prepare import prepare
from .solve import PointIndex, service_min
from .travel import haversine_km


def plan_day_baseline(state: PlannerInput | dict[str, Any]) -> Plan:
    t0 = _time.monotonic()
    if not isinstance(state, PlannerInput):
        state = PlannerInput.model_validate(state)
    # baseline plans one day only
    state = state.model_copy(update={"params": {**state.params, "horizon_days": 1}})
    prep = prepare(state)
    pidx = PointIndex(prep)
    p = state.params
    s0 = int(p.get("day_start_hour", 8)) * 60
    radius = float(p["haul_radius_km"])

    for fp in prep.fields.values():
        fp.cluster_id = None
        if fp.route != "at_risk":
            fp.route = "bale"
            fp.route_reason = "first-come baseline: bale only, served in booking order"

    queue = sorted(
        (
            fp
            for fp in prep.fields.values()
            if fp.f.source == "confirmed" and fp.f.p50 < state.date
        ),
        key=lambda fp: (fp.f.p50 + timedelta(days=1), fp.f.field_id),
    )
    balers = sorted(
        (m for m in state.machines if m.available and m.type == "baler_set"),
        key=lambda m: m.machine_id,
    )
    pos = {m.machine_id: ("machine", m.machine_id) for m in balers}
    free = {m.machine_id: s0 for m in balers}
    plant_left = dict(prep.plant_capacity)
    stops: list[FieldStop] = []
    unassigned: dict[str, str] = {}

    for rank, fp in enumerate(queue):
        fid = fp.f.field_id
        if not balers:
            unassigned[fid] = "no_machine"
            continue
        reach = [
            pl.plant_id
            for pl in sorted(state.plants, key=lambda pl: haversine_km(fp.f.centroid, pl.location))
            if haversine_km(fp.f.centroid, pl.location) <= radius
            and plant_left[pl.plant_id] >= fp.f.straw_t
        ]
        if not reach:
            unassigned[fid] = "capacity"  # plant full → field waits
            continue
        best = None
        for m in balers:
            arrive = free[m.machine_id] + pidx.minutes(pos[m.machine_id], ("field", fid))
            end = arrive + service_min(fp.f.straw_t, m.rate_t_per_hr)
            if end <= s0 + int(m.hours_per_day * 60):
                d = pidx.minutes(pos[m.machine_id], ("field", fid))
                if best is None or (d, m.machine_id) < best[0]:
                    best = ((d, m.machine_id), m, arrive, end)
        if best is None:
            unassigned[fid] = "capacity"
            continue
        _, m, arrive, end = best
        plant_left[reach[0]] -= fp.f.straw_t
        free[m.machine_id] = end
        pos[m.machine_id] = ("field", fid)
        # earlier in the queue = kept first if trucks run short
        stops.append(FieldStop(fid, m.machine_id, m.type, arrive, end, fp.f.straw_t, "bale", -rank))

    kept, dropped, trucks = haul(prep, pidx, stops)
    available = {m.type for m in state.machines if m.available}
    for fid in dropped:
        unassigned[fid] = "capacity" if "truck" in available else "no_machine"
    return build_plan(
        prep, "baseline", kept, trucks, unassigned,
        status="first_come", runtime_s=_time.monotonic() - t0, objective=None,
    )
