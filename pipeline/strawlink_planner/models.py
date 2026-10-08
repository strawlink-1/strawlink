"""Pydantic models mirroring contracts/planner_input.schema.json and plan.schema.json."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic import Field as PField

LonLat = tuple[float, float]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- input


class FieldIn(_Strict):
    field_id: str
    centroid: LonLat
    village_id: str
    straw_t: float = PField(ge=0)
    p10: date
    p50: date
    p90: date
    source: Literal["satellite", "confirmed"]
    sowing_deadline: date
    status: Literal["forecast", "ready", "scheduled", "cleared", "at_risk"]
    burned_last_season: bool | None
    rain_mm_3d: float = PField(ge=0)


class MachineIn(_Strict):
    machine_id: str
    type: Literal["baler_set", "truck", "seeder"]
    base: LonLat
    rate_t_per_hr: float = PField(gt=0)
    hours_per_day: float = PField(gt=0, le=24)
    available: bool


class PlantIn(_Strict):
    plant_id: str
    location: LonLat
    weekly_capacity_t: float = PField(ge=0)
    depot_capacity_t: float = PField(ge=0)
    fill_t: float = PField(ge=0)


class Travel(_Strict):
    method: Literal["osrm", "road_factor"] = "road_factor"
    road_factor: float = PField(default=1.3, gt=0)
    speed_kmh: float = PField(default=25, gt=0)


class PlannerInput(_Strict):
    date: date
    synthetic: bool | None = None
    fields: list[FieldIn]
    machines: list[MachineIn]
    plants: list[PlantIn]
    travel: Travel
    params: dict[str, Any]
    time_limit_s: float = PField(gt=0)


# ---------------------------------------------------------------- output


class PriorityParts(_Strict):
    tonnes: float
    urgency: float
    bonus: float
    dry: Literal[0, 1]


class FieldOut(_Strict):
    field_id: str
    priority: float
    priority_parts: PriorityParts
    route: Literal["bale", "seed", "at_risk"]
    route_reason: str
    cluster_id: str | None
    days_left: int
    dry: bool


class Stop(_Strict):
    field_id: str
    arrive: str
    depart: str
    tonnes: float
    method: Literal["bale", "seed"]


class Delivery(_Strict):
    plant_id: str
    tonnes: float
    arrive: str


class Assignment(_Strict):
    machine_id: str
    type: Literal["baler_set", "truck", "seeder"]
    stops: list[Stop]
    deliveries: list[Delivery]


class Unassigned(_Strict):
    field_id: str
    reason: Literal["capacity", "deadline", "wet", "no_machine"]


class Totals(_Strict):
    tonnes_planned: float
    fields_planned: int
    fields_at_risk: int


class SolverInfo(_Strict):
    status: str
    runtime_s: float
    objective: float | None


class Plan(_Strict):
    plan_id: str
    date: date
    policy: Literal["strawlink", "baseline"]
    synthetic: bool
    fields: list[FieldOut]
    assignments: list[Assignment]
    unassigned: list[Unassigned]
    totals: Totals
    solver: SolverInfo

    def to_json_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
