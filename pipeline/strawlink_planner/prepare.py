"""Dry flag, fair-queue priority, village clustering (DBSCAN-equivalent) and route chooser.

priority = straw_t × exp(−days_left / urgency_tau_days) × (1 + bonus) × dry
bonus    = loyalty_bonus if burned_last_season is False else 0
Burn history NEVER raises priority: True and None both get bonus 0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta

from .models import FieldIn, PlannerInput
from .travel import haversine_km


@dataclass
class FieldPrep:
    f: FieldIn
    ready: date
    days_left: int
    dry: bool
    urgency: float
    bonus: float
    priority: float
    route: str = "seed"
    route_reason: str = ""
    cluster_id: str | None = None
    candidate: bool = False  # serviceable inside the horizon
    unassigned_reason: str | None = None


@dataclass
class Cluster:
    cluster_id: str
    village_id: str
    field_ids: list[str]
    tonnes: float
    priority: float
    ready: date
    deadline: date
    centroid: tuple[float, float]
    route: str = "seed"
    plant_id: str | None = None


@dataclass
class Prepared:
    state: PlannerInput
    horizon: list[date]
    fields: dict[str, FieldPrep]
    clusters: list[Cluster]
    plant_remaining: dict[str, float]
    plant_capacity: dict[str, float] = field(default_factory=dict)


def priority_parts(f: FieldIn, params: dict, ready: date | None = None) -> tuple[float, float, int, bool, float, int]:
    """Return (urgency, bonus, days_left, dry, priority, dry_int) for one field."""
    ready = ready or f.p50
    days_left = (f.sowing_deadline - ready).days
    dry = f.rain_mm_3d < float(params["rain_wet_threshold_mm"])
    urgency = math.exp(-max(days_left, 0) / float(params["urgency_tau_days"]))
    # Only an explicit no-burn record earns the bonus. True / None → 0. Never negative-to-positive.
    bonus = float(params["loyalty_bonus"]) if f.burned_last_season is False else 0.0
    dry_int = 1 if dry else 0
    priority = f.straw_t * urgency * (1.0 + bonus) * dry_int
    return urgency, bonus, days_left, dry, priority, dry_int


def plant_free_t(state: PlannerInput, horizon_days: int) -> dict[str, float]:
    """Tonnes a plant can accept over the horizon: free depot space + plant use in that time."""
    return {
        p.plant_id: max(0.0, p.depot_capacity_t - p.fill_t)
        + p.weekly_capacity_t * horizon_days / 7.0
        for p in state.plants
    }


def _day_cap_t(state: PlannerInput, params: dict) -> float:
    caps = [
        m.rate_t_per_hr * m.hours_per_day
        for m in state.machines
        if m.available and m.type in ("baler_set", "seeder")
    ]
    if not caps:
        return math.inf
    return min(caps) * float(params.get("cluster_max_day_frac", 0.8))


def connected_components(points: list[tuple[float, float]], eps_km: float) -> list[int]:
    """DBSCAN with min_samples=1 == connected components of the 'within eps' graph (haversine).

    Labels are numbered by first appearance, so they are deterministic for a given input order.
    """
    n = len(points)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if haversine_km(points[i], points[j]) <= eps_km:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[max(ri, rj)] = min(ri, rj)
    labels, seen = [], {}
    for i in range(n):
        labels.append(seen.setdefault(find(i), len(seen)))
    return labels


def _split_cluster(members: list[FieldPrep], cap_t: float) -> list[list[FieldPrep]]:
    """Greedy split so each group has a non-empty window and fits one machine-day."""
    members = sorted(members, key=lambda x: (x.ready, x.f.field_id))
    groups: list[list[FieldPrep]] = []
    cur: list[FieldPrep] = []
    for fp in members:
        if cur:
            lo = max(max(c.ready for c in cur), fp.ready)
            hi = min(min(c.f.sowing_deadline for c in cur), fp.f.sowing_deadline)
            tonnes = sum(c.f.straw_t for c in cur) + fp.f.straw_t
            if lo > hi or tonnes > cap_t:
                groups.append(cur)
                cur = []
        cur.append(fp)
    if cur:
        groups.append(cur)
    return groups


def prepare(state: PlannerInput) -> Prepared:
    p = state.params
    h = int(p.get("horizon_days", 3))
    horizon = [state.date + timedelta(days=i) for i in range(h)]
    h_end = horizon[-1]

    fields: dict[str, FieldPrep] = {}
    for f in sorted(state.fields, key=lambda x: x.field_id):
        if f.status == "cleared":
            continue
        urgency, bonus, days_left, dry, prio, _ = priority_parts(f, p)
        fp = FieldPrep(f, f.p50, days_left, dry, urgency, bonus, prio)
        if f.sowing_deadline < state.date or days_left < 0:
            fp.route = "at_risk"
            fp.route_reason = (
                "sowing deadline has passed"
                if f.sowing_deadline < state.date
                else f"harvest expected {f.p50.isoformat()}, after sowing deadline"
            )
            fp.unassigned_reason = "deadline"
        elif f.p50 <= h_end:
            if not dry:
                fp.unassigned_reason = "wet"
            else:
                fp.candidate = True
        fields[f.field_id] = fp

    # --- clustering of candidate (dry, in-horizon) fields, per village
    cap_t = _day_cap_t(state, p)
    eps_km = float(p["cluster_radius_m"]) / 1000.0
    clusters: list[Cluster] = []
    by_village: dict[str, list[FieldPrep]] = {}
    for fp in fields.values():
        if fp.candidate:
            by_village.setdefault(fp.f.village_id, []).append(fp)
    for vid in sorted(by_village):
        members = by_village[vid]
        labels = connected_components([tuple(fp.f.centroid) for fp in members], eps_km)
        groups: dict[int, list[FieldPrep]] = {}
        for lab, fp in zip(labels, members):
            groups.setdefault(int(lab), []).append(fp)
        # order groups by their smallest field_id for stable ids
        k = 0
        for g in sorted(groups.values(), key=lambda g: min(x.f.field_id for x in g)):
            for sub in _split_cluster(g, cap_t):
                cid = f"{vid}-C{k:02d}"
                k += 1
                t = sum(x.f.straw_t for x in sub)
                lon = sum(x.f.centroid[0] * x.f.straw_t for x in sub) / t if t else sub[0].f.centroid[0]
                lat = sum(x.f.centroid[1] * x.f.straw_t for x in sub) / t if t else sub[0].f.centroid[1]
                for x in sub:
                    x.cluster_id = cid
                clusters.append(
                    Cluster(
                        cluster_id=cid,
                        village_id=vid,
                        field_ids=[x.f.field_id for x in sub],
                        tonnes=t,
                        priority=sum(x.priority for x in sub),
                        ready=max(x.ready for x in sub),
                        deadline=min(x.f.sowing_deadline for x in sub),
                        centroid=(lon, lat),
                    )
                )

    # --- route chooser, descending priority
    remaining = plant_free_t(state, h)
    capacity = dict(remaining)
    radius = float(p["haul_radius_km"])
    plants = sorted(state.plants, key=lambda x: x.plant_id)

    def plants_in_reach(pt: tuple[float, float]) -> list[tuple[float, str]]:
        d = sorted((haversine_km(pt, pl.location), pl.plant_id) for pl in plants)
        return [x for x in d if x[0] <= radius]

    for c in sorted(clusters, key=lambda c: (-c.priority, c.cluster_id)):
        reach = plants_in_reach(c.centroid)
        chosen = next(((km, pid) for km, pid in reach if remaining[pid] >= c.tonnes), None)
        if chosen:
            km, pid = chosen
            remaining[pid] -= c.tonnes
            c.route, c.plant_id = "bale", pid
            reason = f"bale: {pid} is {km:.0f} km away with room for {c.tonnes:.0f} t"
        elif reach:
            c.route = "seed"
            reason = f"seed in place: plants within {radius:.0f} km are full this week"
        else:
            c.route = "seed"
            reason = f"seed in place: no plant within {radius:.0f} km haul radius"
        for fid in c.field_ids:
            fields[fid].route, fields[fid].route_reason = c.route, reason

    # tentative route for fields not routed now (wet or outside the horizon)
    for fp in fields.values():
        if fp.candidate or fp.route == "at_risk":
            continue
        reach = plants_in_reach(fp.f.centroid)
        why = (
            f"too wet ({fp.f.rain_mm_3d:.0f} mm rain); waiting to dry"
            if not fp.dry
            else f"harvest expected {fp.ready.isoformat()}"
        )
        if reach:
            fp.route = "bale"
            fp.route_reason = f"{why}; tentatively bale to {reach[0][1]} ({reach[0][0]:.0f} km)"
        else:
            fp.route = "seed"
            fp.route_reason = f"{why}; tentatively seed (no plant within {radius:.0f} km)"

    return Prepared(state, horizon, fields, clusters, remaining, capacity)
