"""OR-Tools prize-collecting VRP with time windows over a multi-day horizon.

Each machine is one vehicle across the whole horizon (time in minutes from day-1
00:00 IST). It may only start service inside a working window of a day on which the
cluster is serviceable (ready_day ≤ day ≤ sowing_deadline); it waits overnight at
its last stop, so day k+1 starts where day k ended. Cluster nodes carry a
disjunction penalty of round(priority × penalty_scale) so higher-priority work is
dropped last. Any solver failure falls back to greedy insertion.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .models import MachineIn
from .prepare import Cluster, Prepared
from .travel import minutes_matrix

DAY = 1440


@dataclass
class Visit:
    cluster: Cluster
    machine: MachineIn
    start: int  # minutes from horizon start
    end: int

    @property
    def day(self) -> int:
        return self.start // DAY


@dataclass
class SolveResult:
    visits: list[Visit]
    status: str
    objective: float | None
    runtime_s: float


class PointIndex:
    """One travel matrix over every point the planner needs."""

    def __init__(self, prep: Prepared):
        pts: list[tuple[float, float]] = []
        self.idx: dict[tuple[str, str], int] = {}

        def add(kind: str, key: str, pt):
            self.idx[(kind, key)] = len(pts)
            pts.append((float(pt[0]), float(pt[1])))

        for c in prep.clusters:
            add("cluster", c.cluster_id, c.centroid)
        for fp in prep.fields.values():
            add("field", fp.f.field_id, fp.f.centroid)
        for m in prep.state.machines:
            add("machine", m.machine_id, m.base)
        for p in prep.state.plants:
            add("plant", p.plant_id, p.location)
        self.m = minutes_matrix(pts, prep.state.travel) if pts else None

    def minutes(self, a: tuple[str, str], b: tuple[str, str]) -> int:
        return int(math.ceil(self.m[self.idx[a], self.idx[b]]))


def service_min(tonnes: float, rate: float) -> int:
    return int(math.ceil(tonnes / rate * 60))


def _windows(prep: Prepared, c: Cluster, service: int, hours: float) -> list[tuple[int, int]]:
    s0 = int(prep.state.params.get("day_start_hour", 8)) * 60
    work = int(hours * 60)
    out = []
    for k, d in enumerate(prep.horizon):
        if c.ready <= d <= c.deadline and service <= work:
            out.append((k * DAY + s0, k * DAY + s0 + work - service))
    return out


def _machine_windows(prep: Prepared, c: Cluster, machines: list[MachineIn]):
    """Conservative node windows valid for every machine of the type (slowest, shortest day)."""
    slow = min(m.rate_t_per_hr for m in machines)
    hours = min(m.hours_per_day for m in machines)
    return _windows(prep, c, service_min(c.tonnes, slow), hours)


def solve_type(prep: Prepared, pidx: PointIndex, route: str, mtype: str, time_limit_s: float) -> SolveResult:
    t0 = time.monotonic()
    machines = sorted(
        (m for m in prep.state.machines if m.available and m.type == mtype),
        key=lambda m: m.machine_id,
    )
    clusters = [c for c in prep.clusters if c.route == route]
    if not machines or not clusters:
        return SolveResult([], "empty", None, 0.0)

    wins = {c.cluster_id: _machine_windows(prep, c, machines) for c in clusters}
    nodes = [c for c in clusters if wins[c.cluster_id]]
    if not nodes:
        return SolveResult([], "no_feasible_nodes", None, time.monotonic() - t0)

    try:
        res = _solve_ortools(prep, pidx, nodes, wins, machines, time_limit_s)
    except Exception as e:  # noqa: BLE001
        res = None
        status = f"error:{type(e).__name__}"
    else:
        status = res.status if res else "no_solution"
    if res is None or not res.visits and res.status != "ok":
        g = greedy(prep, pidx, nodes, wins, machines)
        g.status = f"greedy_fallback({status})"
        g.runtime_s = time.monotonic() - t0
        return g
    res.runtime_s = time.monotonic() - t0
    return res


def _solve_ortools(prep, pidx, nodes, wins, machines, time_limit_s) -> SolveResult | None:
    n, V = len(nodes), len(machines)
    starts = [n + 2 * v for v in range(V)]
    ends = [n + 2 * v + 1 for v in range(V)]
    keys: list[tuple[str, str] | None] = [("cluster", c.cluster_id) for c in nodes]
    for m in machines:
        keys += [("machine", m.machine_id), None]  # end node: open route
    N = len(keys)

    travel = [[0] * N for _ in range(N)]
    for i in range(N):
        for j in range(N):
            if i != j and keys[i] is not None and keys[j] is not None:
                travel[i][j] = pidx.minutes(keys[i], keys[j])

    manager = pywrapcp.RoutingIndexManager(N, V, starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    def travel_cb(fi, ti):
        return travel[manager.IndexToNode(fi)][manager.IndexToNode(ti)]

    arc = routing.RegisterTransitCallback(travel_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(arc)

    svc = [[0] * N for _ in range(V)]
    for v, m in enumerate(machines):
        for i, c in enumerate(nodes):
            svc[v][i] = service_min(c.tonnes, m.rate_t_per_hr)

    def make_time_cb(v):
        def cb(fi, ti):
            a, b = manager.IndexToNode(fi), manager.IndexToNode(ti)
            return svc[v][a] + travel[a][b]

        return cb

    time_cbs = [routing.RegisterTransitCallback(make_time_cb(v)) for v in range(V)]
    horizon_min = len(prep.horizon) * DAY
    routing.AddDimensionWithVehicleTransits(time_cbs, horizon_min, horizon_min, False, "Time")
    tdim = routing.GetDimensionOrDie("Time")

    s0 = int(prep.state.params.get("day_start_hour", 8)) * 60
    for v in range(V):
        tdim.CumulVar(routing.Start(v)).SetRange(s0, s0)
    for i, c in enumerate(nodes):
        w = wins[c.cluster_id]
        idx = manager.NodeToIndex(i)
        cv = tdim.CumulVar(idx)
        cv.SetRange(w[0][0], w[-1][1])
        for (_, hi), (lo, _) in zip(w, w[1:]):
            if lo > hi + 1:
                cv.RemoveInterval(hi + 1, lo - 1)
        scale = float(prep.state.params.get("penalty_scale", 1000))
        routing.AddDisjunction([idx], max(1, int(round(c.priority * scale))))
        # serve sooner: each day of delay past the first feasible day costs a share of the prize
        frac = float(prep.state.params.get("delay_cost_per_day_frac", 0.1))
        coef = int(round(c.priority * scale * frac / DAY))
        if coef > 0:
            tdim.SetCumulVarSoftUpperBound(idx, w[0][1], coef)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    params.time_limit.FromMilliseconds(int(time_limit_s * 1000))
    # Deterministic stop: a fixed solution count, with the time limit only as a safety net.
    params.solution_limit = int(prep.state.params.get("solver_solution_limit", 200))

    sol = routing.SolveWithParameters(params)
    if sol is None:
        return None
    visits: list[Visit] = []
    for v, m in enumerate(machines):
        idx = routing.Start(v)
        while not routing.IsEnd(idx):
            node = manager.IndexToNode(idx)
            if node < n:
                st = sol.Value(tdim.CumulVar(idx))
                visits.append(Visit(nodes[node], m, st, st + svc[v][node]))
            idx = sol.Value(routing.NextVar(idx))
    return SolveResult(visits, "ok", float(sol.ObjectiveValue()), 0.0)


def greedy(prep, pidx, nodes, wins, machines) -> SolveResult:
    """Highest-priority first; insert at the machine that can start it earliest."""
    s0 = int(prep.state.params.get("day_start_hour", 8)) * 60
    pos = {m.machine_id: ("machine", m.machine_id) for m in machines}
    free = {m.machine_id: s0 for m in machines}
    visits = []
    for c in sorted(nodes, key=lambda c: (-c.priority, c.cluster_id)):
        best = None
        for m in machines:
            svc = service_min(c.tonnes, m.rate_t_per_hr)
            arrive = free[m.machine_id] + pidx.minutes(pos[m.machine_id], ("cluster", c.cluster_id))
            for k, d in enumerate(prep.horizon):
                if not (c.ready <= d <= c.deadline):
                    continue
                lo = k * DAY + s0
                hi = lo + int(m.hours_per_day * 60) - svc
                st = max(arrive, lo)
                if st <= hi:
                    cand = (st, m.machine_id, m, svc)
                    if best is None or cand[:2] < best[:2]:
                        best = cand
                    break
        if best:
            st, mid, m, svc = best
            visits.append(Visit(c, m, st, st + svc))
            free[mid] = st + svc
            pos[mid] = ("cluster", c.cluster_id)
    visits.sort(key=lambda v: (v.machine.machine_id, v.start))
    return SolveResult(visits, "greedy", None, 0.0)
