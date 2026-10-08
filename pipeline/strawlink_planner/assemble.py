"""Turn solver visits into a contract-shaped Plan: field stops, truck hauls, reasons."""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone

from .models import (
    Assignment,
    Delivery,
    FieldOut,
    Plan,
    PriorityParts,
    SolverInfo,
    Stop,
    Totals,
    Unassigned,
)
from .prepare import Prepared
from .solve import DAY, PointIndex, Visit
from .travel import haversine_km

IST = timezone(timedelta(hours=5, minutes=30))


@dataclass
class FieldStop:
    field_id: str
    machine_id: str
    mtype: str
    start: int
    end: int
    tonnes: float
    method: str
    priority: float

    @property
    def day(self) -> int:
        return self.start // DAY


def ts(prep: Prepared, minutes: int) -> str:
    base = datetime.combine(prep.horizon[0], time(0, 0), IST)
    return (base + timedelta(minutes=int(minutes))).isoformat(timespec="seconds")


def expand(prep: Prepared, visits: list[Visit]) -> list[FieldStop]:
    """Split each cluster visit into consecutive per-field stops (intra-cluster travel ≈ 0)."""
    out = []
    for v in visits:
        fids = sorted(v.cluster.field_ids)
        total = v.cluster.tonnes or 1.0
        t = float(v.start)
        for fid in fids:
            fp = prep.fields[fid]
            dur = (v.end - v.start) * fp.f.straw_t / total
            out.append(
                FieldStop(
                    fid, v.machine.machine_id, v.machine.type, int(round(t)),
                    int(round(t + dur)), fp.f.straw_t,
                    "bale" if v.machine.type == "baler_set" else "seed", fp.priority,
                )
            )
            t += dur
    return out


def haul(prep: Prepared, pidx: PointIndex, bale_stops: list[FieldStop]):
    """Allocate baled tonnes to trucks and plants, day by day.

    Returns (kept stops, dropped field_ids, truck assignments for day 1).
    """
    p = prep.state.params
    cap_t = float(p.get("truck_capacity_t", 10))
    trips_per_day = int(p.get("truck_trips_per_day", 4))
    radius = float(p["haul_radius_km"])
    trucks = sorted(
        (m for m in prep.state.machines if m.available and m.type == "truck"),
        key=lambda m: m.machine_id,
    )
    plant_left = dict(prep.plant_capacity)
    loc = {pl.plant_id: pl.location for pl in prep.state.plants}
    s0 = int(p.get("day_start_hour", 8)) * 60
    kept, dropped = [], set()
    day1: dict[str, Assignment] = {}

    for k in range(len(prep.horizon)):
        todays = sorted((s for s in bale_stops if s.day == k), key=lambda s: (s.end, s.field_id))
        # truck trips: drop lowest-priority stops until the day fits
        budget = len(trucks) * trips_per_day
        by_prio = sorted(todays, key=lambda s: (-s.priority, s.field_id))
        allowed, used = set(), 0
        for s in by_prio:
            need = max(1, math.ceil(s.tonnes / cap_t))
            if used + need <= budget:
                allowed.add(s.field_id)
                used += need
            else:
                dropped.add(s.field_id)
        truck_pos = {t.machine_id: ("machine", t.machine_id) for t in trucks}
        truck_free = {t.machine_id: k * DAY + s0 for t in trucks}
        truck_trips = {t.machine_id: 0 for t in trucks}
        for s in todays:
            if s.field_id not in allowed:
                continue
            fkey = ("field", s.field_id)
            plants = sorted(
                (pidx.minutes(fkey, ("plant", pl.plant_id)), pl.plant_id) for pl in prep.state.plants
            )
            fp = prep.fields[s.field_id]
            target = next(
                (
                    pid
                    for _, pid in plants
                    if plant_left[pid] >= s.tonnes
                    and haversine_km(fp.f.centroid, loc[pid]) <= radius
                ),
                None,
            )
            if target is None:
                dropped.add(s.field_id)
                continue
            plant_left[target] -= s.tonnes
            kept.append(s)
            left = s.tonnes
            while left > 1e-9:
                avail = [t for t in trucks if truck_trips[t.machine_id] < trips_per_day]
                t = min(avail, key=lambda t: (truck_free[t.machine_id], t.machine_id))
                pickup = max(truck_free[t.machine_id] + pidx.minutes(truck_pos[t.machine_id], fkey), s.end)
                load = min(cap_t, left)
                arrive = pickup + pidx.minutes(fkey, ("plant", target))
                truck_free[t.machine_id] = arrive
                truck_pos[t.machine_id] = ("plant", target)
                truck_trips[t.machine_id] += 1
                left -= load
                if k == 0:
                    a = day1.setdefault(t.machine_id, Assignment(machine_id=t.machine_id, type="truck", stops=[], deliveries=[]))
                    a.stops.append(Stop(field_id=s.field_id, arrive=ts(prep, pickup), depart=ts(prep, pickup), tonnes=round(load, 3), method="bale"))
                    a.deliveries.append(Delivery(plant_id=target, tonnes=round(load, 3), arrive=ts(prep, arrive)))
    return kept, dropped, [day1[k] for k in sorted(day1)]


def plan_id(prep: Prepared, policy: str) -> str:
    h = hashlib.sha1(prep.state.model_dump_json().encode()).hexdigest()[:8]
    return f"{policy}-{prep.state.date.isoformat()}-{h}"


def field_outs(prep: Prepared) -> list[FieldOut]:
    out = []
    for fid in sorted(prep.fields):
        fp = prep.fields[fid]
        out.append(
            FieldOut(
                field_id=fid,
                priority=round(fp.priority, 6),
                priority_parts=PriorityParts(
                    tonnes=fp.f.straw_t, urgency=round(fp.urgency, 6), bonus=fp.bonus, dry=1 if fp.dry else 0
                ),
                route=fp.route,
                route_reason=fp.route_reason,
                cluster_id=fp.cluster_id,
                days_left=fp.days_left,
                dry=fp.dry,
            )
        )
    return out


def build_plan(
    prep: Prepared,
    policy: str,
    stops: list[FieldStop],
    truck_assignments: list[Assignment],
    unassigned: dict[str, str],
    status: str,
    runtime_s: float,
    objective: float | None,
) -> Plan:
    day1 = sorted((s for s in stops if s.day == 0), key=lambda s: (s.machine_id, s.start))
    by_machine: dict[str, Assignment] = {}
    for s in day1:
        a = by_machine.setdefault(s.machine_id, Assignment(machine_id=s.machine_id, type=s.mtype, stops=[], deliveries=[]))
        a.stops.append(
            Stop(field_id=s.field_id, arrive=ts(prep, s.start), depart=ts(prep, s.end), tonnes=round(s.tonnes, 3), method=s.method)
        )
    assignments = [by_machine[k] for k in sorted(by_machine)] + truck_assignments
    fouts = field_outs(prep)
    synthetic = prep.state.synthetic if prep.state.synthetic is not None else True
    return Plan(
        plan_id=plan_id(prep, policy),
        date=prep.state.date,
        policy=policy,
        synthetic=synthetic,
        fields=fouts,
        assignments=assignments,
        unassigned=[Unassigned(field_id=f, reason=r) for f, r in sorted(unassigned.items())],
        totals=Totals(
            tonnes_planned=round(sum(s.tonnes for s in day1), 3),
            fields_planned=len({s.field_id for s in day1}),
            fields_at_risk=sum(1 for f in fouts if f.route == "at_risk"),
        ),
        solver=SolverInfo(status=status, runtime_s=round(runtime_s, 3), objective=objective),
    )
