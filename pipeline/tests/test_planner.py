import copy
import time
from datetime import date

import jsonschema
import pytest

from strawlink_pipeline.config import params, schema
from strawlink_pipeline.demo_state import demo_state
from strawlink_planner import plan_day, plan_day_baseline
from strawlink_planner.models import FieldIn, PlannerInput
from strawlink_planner.prepare import plant_free_t, prepare, priority_parts


@pytest.fixture(scope="module")
def state():
    return demo_state(n_fields=40, time_limit_s=10)


@pytest.fixture(scope="module")
def plan(state):
    return plan_day(state)


def _field(**kw):
    base = dict(
        field_id="F0001", centroid=(76.4, 30.3), village_id="V01", straw_t=12.0,
        p10=date(2026, 10, 18), p50=date(2026, 10, 20), p90=date(2026, 10, 22),
        source="satellite", sowing_deadline=date(2026, 11, 15), status="forecast",
        burned_last_season=None, rain_mm_3d=0.0,
    )
    base.update(kw)
    return FieldIn(**base)


def _strip_runtime(d):
    d = copy.deepcopy(d)
    d["solver"].pop("runtime_s")
    return d


def test_plan_validates_against_contract(plan, state):
    jsonschema.validate(plan.to_json_dict(), schema("plan"))
    jsonschema.validate(plan_day_baseline(state).to_json_dict(), schema("plan"))
    jsonschema.validate(state, schema("planner_input"))


def test_deterministic(state, plan):
    again = plan_day(state)
    assert _strip_runtime(plan.to_json_dict()) == _strip_runtime(again.to_json_dict())


@pytest.mark.parametrize("burned", [True, None, False])
def test_burn_history_never_raises_priority(burned):
    p = params()
    prio = {b: priority_parts(_field(burned_last_season=b), p)[4] for b in (True, None, False)}
    assert prio[True] <= prio[None]
    assert prio[True] <= prio[False]
    assert prio[True] == prio[None]  # burning is never rewarded or specially treated
    assert prio[False] > prio[None]  # only the no-burn record earns the bonus


def test_wet_field_has_zero_priority():
    p = params()
    wet = _field(rain_mm_3d=float(p["rain_wet_threshold_mm"]) + 1)
    assert priority_parts(wet, p)[4] == 0.0


def test_never_assigns_wet_fields(state, plan):
    wet = {f.field_id for f in plan.fields if not f.dry}
    assert wet, "fixture should contain wet fields"
    for a in plan.assignments:
        for s in a.stops:
            assert s.field_id not in wet
    reasons = {u.field_id: u.reason for u in plan.unassigned}
    assert all(reasons.get(f) == "wet" for f in wet if f in reasons)


def test_respects_plant_capacity(state, plan):
    st = PlannerInput.model_validate(state)
    free = plant_free_t(st, 1)  # day-1 deliveries must fit even one day's room
    free_h = plant_free_t(st, int(st.params["horizon_days"]))
    delivered = {}
    for a in plan.assignments:
        for d in a.deliveries:
            delivered[d.plant_id] = delivered.get(d.plant_id, 0) + d.tonnes
    for pid, t in delivered.items():
        assert t <= free_h[pid] + 1e-6
    assert set(delivered) <= set(free)


def test_tight_plant_forces_seed_route(state):
    s = copy.deepcopy(state)
    for pl in s["plants"]:
        pl["weekly_capacity_t"] = 0
        pl["fill_t"] = pl["depot_capacity_t"]
    plan = plan_day(s)
    routed = [f for f in plan.fields if f.cluster_id]
    assert routed and all(f.route == "seed" for f in routed)
    assert not any(a.deliveries for a in plan.assignments)


def test_each_field_served_at_most_once_and_within_day(plan, state):
    seen = set()
    hours = {m["machine_id"]: m["hours_per_day"] for m in state["machines"]}
    for a in plan.assignments:
        if a.type == "truck":
            continue
        for s in a.stops:
            assert s.field_id not in seen
            seen.add(s.field_id)
            assert s.arrive[:10] == state["date"]
        assert a.stops[-1].depart <= f"{state['date']}T{8 + int(hours[a.machine_id]):02d}:00:00+05:30"


def test_returns_within_time_limit():
    s = demo_state(n_fields=120, n_villages=5, n_balers=5, n_seeders=3, n_trucks=4, time_limit_s=8)
    t = time.monotonic()
    plan_day(s)
    assert time.monotonic() - t < 8 * 1.5


def test_no_machines_means_no_machine_reason(state):
    s = copy.deepcopy(state)
    for m in s["machines"]:
        m["available"] = False
    plan = plan_day(s)
    assert plan.assignments == []
    assert {u.reason for u in plan.unassigned} <= {"no_machine", "wet", "deadline"}
    assert any(u.reason == "no_machine" for u in plan.unassigned)


def test_deadline_passed_is_at_risk(state):
    s = copy.deepcopy(state)
    s["fields"][0]["sowing_deadline"] = "2026-10-01"
    plan = plan_day(s)
    f = next(f for f in plan.fields if f.field_id == s["fields"][0]["field_id"])
    assert f.route == "at_risk"


def test_clusters_stay_in_one_village(state):
    prep = prepare(PlannerInput.model_validate(state))
    for c in prep.clusters:
        assert {prep.fields[f].f.village_id for f in c.field_ids} == {c.village_id}
        assert c.ready <= c.deadline


def test_baseline_only_serves_harvested_and_bale(state):
    plan = plan_day_baseline(state)
    harvested = {f["field_id"] for f in state["fields"] if f["source"] == "confirmed" and f["p50"] < state["date"]}
    for a in plan.assignments:
        for s in a.stops:
            assert s.field_id in harvested
            assert s.method == "bale"
