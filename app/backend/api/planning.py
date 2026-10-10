"""Build PlannerInput from DynamoDB + config + rain, run the planner, store the plan."""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from functools import lru_cache

import boto3
import requests

from common import settings, store


# ---------------------------------------------------------------- field views


def effective_forecast(f: dict) -> dict | None:
    """A confirmation overrides the satellite forecast."""
    c = f.get("confirmed")
    if c:
        d = c["date"]
        return {"p10": d, "p50": d, "p90": d, "source": "confirmed", "confidence": 1.0,
                "issued_on": c.get("on", d), "confirmed_by": c.get("source")}
    return f.get("forecast")


def field_status(f: dict, on: date, rain_mm: float | None = None) -> str:
    """forecast | ready | scheduled | cleared | at_risk | wet (wet is UI-only)."""
    if f.get("cleared_on"):
        return "cleared"
    if f.get("route") == "at_risk":
        return "at_risk"
    slot = f.get("slot")
    if slot and slot.get("date") == on.isoformat():
        return "scheduled"
    fc = effective_forecast(f)
    if rain_mm is not None and rain_mm >= float(settings.params()["rain_wet_threshold_mm"]):
        if fc and fc["p50"] <= on.isoformat():
            return "wet"
    if fc and fc["p50"] <= on.isoformat():
        return "ready"
    return "forecast"


# ---------------------------------------------------------------- rain


def block_centroid() -> tuple[float, float]:
    vs = settings.geojson("data/fields/villages.geojson")["features"]
    if not vs:
        return 75.74, 30.36
    return (sum(v["geometry"]["coordinates"][0] for v in vs) / len(vs),
            sum(v["geometry"]["coordinates"][1] for v in vs) / len(vs))


@lru_cache(maxsize=64)
def _rain_series(lon: float, lat: float, start: str, end: str) -> dict[str, float]:
    recent = date.fromisoformat(end) >= settings.today() - timedelta(days=5)
    url = ("https://api.open-meteo.com/v1/forecast" if recent
           else "https://archive-api.open-meteo.com/v1/archive")
    try:
        r = requests.get(url, params={"latitude": lat, "longitude": lon, "daily": "precipitation_sum",
                                      "timezone": "Asia/Kolkata", "start_date": start, "end_date": end},
                         timeout=15)
        r.raise_for_status()
        d = r.json()["daily"]
        return {t: float(v or 0.0) for t, v in zip(d["time"], d["precipitation_sum"])}
    except Exception:  # noqa: BLE001 — weather unavailable → treat as no rain, flagged in response
        return {}


def rain_by_village(on: date) -> tuple[dict[str, float], dict]:
    """rain_mm over the 3 days ending `on`: Open-Meteo + injected demo rain events."""
    lon, lat = block_centroid()
    days = [(on - timedelta(days=k)).isoformat() for k in range(3)]
    series = _rain_series(round(lon, 3), round(lat, 3), days[-1], days[0])
    base = sum(series.get(d, 0.0) for d in days)
    villages = sorted({f["properties"]["village_id"] for f in settings.geojson("data/fields/fields.geojson")["features"]})
    out = {v: base for v in villages}
    injected = [e for e in store.query("events", "field_id", "RAIN") if e.get("date") in days]
    for e in injected:
        targets = villages if e.get("village_id") in (None, "all", "ALL") else [e["village_id"]]
        for v in targets:
            out[v] = out.get(v, 0.0) + float(e["mm"])
    return {k: round(v, 1) for k, v in out.items()}, {
        "source": "open-meteo" if series else "unavailable", "observed_mm_3d": round(base, 1),
        "injected_events": len(injected)}


# ---------------------------------------------------------------- state


def machines() -> list[dict]:
    rows = store.scan("machines")
    if not rows:
        rows = settings.synthetic().get("machines", [])
    vil = {v["properties"]["name"].lower(): v["geometry"]["coordinates"]
           for v in settings.geojson("data/fields/villages.geojson")["features"]}
    out = []
    for m in sorted(rows, key=lambda m: m["machine_id"]):
        base = m.get("base") or vil.get(str(m.get("village_name", "")).lower())
        if not base or m.get("type") not in ("baler_set", "truck", "seeder"):
            continue
        out.append({"machine_id": m["machine_id"], "type": m["type"], "base": [float(base[0]), float(base[1])],
                    "rate_t_per_hr": float(m["rate_t_per_hr"]), "hours_per_day": float(m["hours_per_day"]),
                    "available": bool(m.get("available", True))})
    return out


def plants() -> list[dict]:
    return [{k: p[k] for k in ("plant_id", "location", "weekly_capacity_t", "depot_capacity_t", "fill_t")}
            for p in settings.synthetic().get("plants", [])]


def build_state(on: date, time_limit_s: float | None = None) -> tuple[dict, dict]:
    import os

    time_limit_s = time_limit_s or float(os.environ.get("PLANNER_TIME_LIMIT_S", "12"))
    p = settings.params()
    rain, rain_meta = rain_by_village(on)
    fields = []
    for f in sorted(store.scan("fields"), key=lambda f: f["field_id"]):
        fc = effective_forecast(f)
        if not fc:
            continue
        status = "cleared" if f.get("cleared_on") else ("ready" if fc["p50"] <= on.isoformat() else "forecast")
        fields.append({
            "field_id": f["field_id"], "centroid": f["centroid"], "village_id": f["village_id"],
            "straw_t": float(f["straw_t"]), "p10": fc["p10"], "p50": fc["p50"], "p90": fc["p90"],
            "source": fc["source"], "sowing_deadline": f["sowing_deadline"], "status": status,
            "burned_last_season": f.get("burned_last_season"),
            "rain_mm_3d": float(rain.get(f["village_id"], 0.0)),
        })
    state = {"date": on.isoformat(), "synthetic": True, "fields": fields, "machines": machines(),
             "plants": plants(), "travel": {"method": "road_factor", "road_factor": 1.3, "speed_kmh": 25},
             "params": p, "time_limit_s": time_limit_s}
    return state, {"rain": rain, **rain_meta}


# ---------------------------------------------------------------- run + store


def run_planner(state: dict, policy: str) -> dict:
    if settings.PLANNER_FUNCTION:
        r = boto3.client("lambda", region_name=settings.REGION).invoke(
            FunctionName=settings.PLANNER_FUNCTION, Payload=json.dumps({"state": state, "policy": policy}).encode())
        body = json.loads(r["Payload"].read())
        if r.get("FunctionError") or "error" in body:
            raise RuntimeError(f"planner failed: {body}")
        return body
    from strawlink_planner import plan_day, plan_day_baseline  # local dev

    return (plan_day if policy == "strawlink" else plan_day_baseline)(state).to_json_dict()


def store_plan(plan: dict, trigger: str) -> None:
    body = json.dumps(plan, ensure_ascii=False)
    item = {"date": plan["date"], "plan_id": plan["plan_id"], "policy": plan["policy"],
            "created_at": settings.now_iso(), "trigger": trigger}
    if len(body) > 350_000:
        key = f"outputs/replans/{plan['date']}/{plan['plan_id']}.json"
        store.s3_put_json(key, plan)
        item["s3_key"] = key
    else:
        item["plan_json"] = body
    store.put("plans", item)
    store.put("plans", {**item, "plan_id": f"latest#{plan['policy']}"})


def load_plan(on: date, policy: str) -> dict | None:
    it = store.get("plans", date=on.isoformat(), plan_id=f"latest#{policy}")
    if not it:
        return None
    return json.loads(it["plan_json"]) if "plan_json" in it else store.s3_get_json(it["s3_key"])


def apply_plan_to_fields(plan: dict) -> list[dict]:
    """Write route/priority/slot onto Fields. Returns the day-1 field stops (for messaging)."""
    slots = {}
    for a in plan["assignments"]:
        if a["type"] == "truck":
            continue
        for s in a["stops"]:
            slots[s["field_id"]] = {"date": plan["date"], "machine_id": a["machine_id"], "type": a["type"],
                                    "arrive": s["arrive"], "depart": s["depart"], "method": s["method"],
                                    "plan_id": plan["plan_id"]}
    unassigned = {u["field_id"]: u["reason"] for u in plan["unassigned"]}
    for f in plan["fields"]:
        store.update("fields", {"field_id": f["field_id"]}, {
            "route": f["route"], "route_reason": f["route_reason"], "priority": f["priority"],
            "priority_parts": f["priority_parts"], "cluster_id": f["cluster_id"], "days_left": f["days_left"],
            "dry": f["dry"], "slot": slots.get(f["field_id"]), "unassigned_reason": unassigned.get(f["field_id"]),
            "plan_id": plan["plan_id"], "plan_date": plan["date"],
        })
    return [{"field_id": k, **v} for k, v in sorted(slots.items())]


def replan(on: date, trigger: str, policies=("strawlink", "baseline")) -> dict:
    state, meta = build_state(on)
    settings.validate(state, "planner_input")
    out = {}
    for policy in policies:
        plan = run_planner(state, policy)
        settings.validate(plan, "plan")
        store_plan(plan, trigger)
        if policy == "strawlink":
            out["scheduled"] = apply_plan_to_fields(plan)
        out[policy] = {"plan_id": plan["plan_id"], "totals": plan["totals"], "solver": plan["solver"]}
    out["inputs"] = meta
    return out


# ---------------------------------------------------------------- scenarios (the simulator)

_PREFIX = {"baler_set": "BA", "seeder": "SE", "truck": "TR"}


def fleet_of(base: list[dict], want: dict[str, int]) -> list[dict]:
    """The fleet resized for a scenario. Fewer: the last machines of that type are left out.
    More: copies of an existing machine of that type, based at the next village in turn."""
    vil = [v["geometry"]["coordinates"] for v in settings.geojson("data/fields/villages.geojson")["features"]]
    out = []
    for mtype, prefix in _PREFIX.items():
        have = [m for m in base if m["type"] == mtype]
        n = max(0, int(want.get(mtype, len(have))))
        out += have[:n]
        for k in range(len(have), n):
            if not have:
                break  # no machine of this type to copy rates from
            at = vil[k % len(vil)] if vil else have[0]["base"]
            out.append({**have[k % len(have)], "machine_id": f"{prefix}{k + 1:02d}", "base": [float(at[0]), float(at[1])]})
    return out


def scenario(on: date, fleet: dict[str, int], rain_mm: float = 0.0, rain_village: str = "all",
             confirmed: tuple[str, ...] = (), time_limit_s: float = 3.0) -> dict:
    """Plan one day under what-if inputs. Nothing is stored: the saved plan and fields are untouched.

    With nothing changed (the real fleet, no extra rain, no extra confirmations) the answer is the
    saved plan itself, so the simulator starts from the plan farmers have been told about."""
    state, meta = build_state(on, time_limit_s)
    real_fleet = [m["machine_id"] for m in state["machines"]]
    wet_above = float(state["params"]["rain_wet_threshold_mm"])
    for f in state["fields"]:
        if rain_mm and rain_village in ("all", "ALL", None, f["village_id"]):
            f["rain_mm_3d"] = round(f["rain_mm_3d"] + rain_mm, 1)
        if f["field_id"] in confirmed and f["status"] != "cleared":
            # a farmer's word that the field is harvested today overrides the satellite forecast
            f.update(p10=on.isoformat(), p50=on.isoformat(), p90=on.isoformat(), source="confirmed", status="ready")
    state["machines"] = fleet_of(state["machines"], fleet)
    untouched = not rain_mm and not confirmed and [m["machine_id"] for m in state["machines"]] == real_fleet
    plan = load_plan(on, "strawlink") if untouched else None
    saved = plan is not None
    if not saved:
        settings.validate(state, "planner_input")
        plan = run_planner(state, "strawlink")
        settings.validate(plan, "plan")

    visited = {s["field_id"] for a in plan["assignments"] if a["type"] != "truck" for s in a["stops"]}
    route = {f["field_id"]: f["route"] for f in plan["fields"]}
    status = {}
    for f in state["fields"]:
        fid = f["field_id"]
        status[fid] = ("cleared" if f["status"] == "cleared" else "scheduled" if fid in visited
                       else "at_risk" if route.get(fid) == "at_risk" else "forecast" if f["status"] == "forecast"
                       else "wet" if f["rain_mm_3d"] >= wet_above else "ready")
    return {
        "date": on.isoformat(), "synthetic": True, "plan": plan, "status": status, "machines": state["machines"],
        "inputs": {"fleet": {t: sum(m["type"] == t for m in state["machines"]) for t in _PREFIX},
                   "rain_mm": rain_mm, "rain_village": rain_village, "rain_wet_threshold_mm": wet_above,
                   "confirmed": sorted(confirmed), "saved": saved,
                   "observed_rain_mm_3d": meta.get("observed_mm_3d"), "time_limit_s": time_limit_s},
    }


def haversine_km(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))
