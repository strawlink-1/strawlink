import jsonschema

from common import settings


def test_replan_produces_valid_plans(client):
    r = client.post("/replan", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["strawlink"]["totals"]["fields_planned"] > 0
    for policy in ("strawlink", "baseline"):
        p = client.get("/plan", params={"policy": policy})
        assert p.status_code == 200
        jsonschema.validate(p.json(), settings.schema("plan"))


def test_fields_geojson_and_why_card(client):
    client.post("/replan", json={})
    fc = client.get("/fields").json()
    assert len(fc["features"]) == 200
    statuses = {f["properties"]["status"] for f in fc["features"]}
    assert statuses & {"scheduled", "ready", "forecast"}
    sched = next(f for f in fc["features"] if f["properties"]["status"] == "scheduled")
    w = client.get(f"/fields/{sched['properties']['field_id']}").json()
    assert w["slot"]["machine_id"] and w["route"] in ("bale", "seed")
    assert set(w["priority_parts"]) == {"tonnes", "urgency", "bonus", "dry"}
    assert w["harvest_window"]["p50"]


def test_confirm_overrides_forecast_and_replans(client):
    r = client.post("/events/confirm", json={"field_id": "F0150", "date": "2026-10-23", "source": "farmer"})
    assert r.status_code == 200, r.text
    w = client.get("/fields/F0150").json()
    assert w["harvest_window"]["source"] == "confirmed" and w["harvest_window"]["p50"] == "2026-10-23"


def test_rain_event_makes_fields_wet_and_unassigned(client):
    r = client.post("/events/rain", json={"village_id": "V01", "mm": 20})
    assert r.status_code == 200, r.text
    plan = client.get("/plan").json()
    v01 = {f["properties"]["field_id"] for f in client.get("/fields").json()["features"]
           if f["properties"]["village_id"] == "V01"}
    for a in plan["assignments"]:
        for s in a["stops"]:
            assert s["field_id"] not in v01
    assert any(u["reason"] == "wet" for u in plan["unassigned"])


def test_missed_call_confirms_today(client):
    r = client.post("/simulate/missed-call", json={"field_id": "F0002"})
    assert r.status_code == 200, r.text
    assert client.get("/fields/F0002").json()["confirmed"]["source"] == "missed_call"


def test_cleared_issues_certificate(client):
    r = client.post("/fields/F0010/cleared", json={})
    assert r.status_code == 200, r.text
    cid = r.json()["certificate"]["cert_id"]
    v = client.get(f"/verify/{cid}").json()
    assert v["status"] == "pending_check" and "Not an official approval" in v["footer"]
    assert client.get(f"/certificates/{cid}").json()["pdf_url"].startswith("https://")


def test_supply_and_emissions_and_machines(client):
    s = client.get("/plants/supply", params={"weeks": 3}).json()
    assert len(s["plants"]) == 3
    for p in s["plants"]:
        for w in p["weeks"]:
            assert w["tonnes_p10"] <= w["tonnes_p50"] <= w["tonnes_p90"]
    # 100 t × 0.80 burnt × 8.2 g/kg (= kg/t) × 1.0 → 656 kg of PM2.5, every factor with its source
    e = client.get("/emissions", params={"tonnes": 100}).json()
    assert e["status"] == "ok" and e["combustion_factor"]["value"] == 0.8
    pm = next(r for r in e["pollutants"] if r["pollutant"] == "pm2_5")
    assert pm["kg"] == 656.0 and "Andreae" in pm["source"]
    assert client.get("/machines").json()["machines"]


def test_machine_import(client):
    csv = "owner_name,village,machine_type,phone,available\nGurpreet,Alal,baler,+911,yes\nX,Nowhere,baler,+912,yes\n"
    r = client.post("/machines/import", content=csv).json()
    assert len(r["added"]) == 1 and r["skipped"][0]["reason"] == "unknown village"


def test_farmer_message_regex_path(client):
    r = client.post("/farmer/message", json={"field_id": "F0001", "text": "25/10"}).json()
    assert r["intent"] == "harvest_date" and r["parser"] == "regex"
    thread = client.get("/messages", params={"field_id": "F0001"}).json()["messages"]
    assert [m["direction"] for m in thread][-2:] == ["in", "out"]


def test_meta_lists_assumptions(client):
    m = client.get("/meta").json()
    keys = {a["key"] for a in m["assumptions"]}
    # emission factors now carry a cited source; the burn probability is still an assumption
    assert "sowing_deadline_default" in keys and "assumed_burn_probability" in keys
    assert "emission_factors" not in keys


def test_simulate_answers_the_sliders_and_stores_nothing(client):
    client.post("/replan", json={})
    stored = client.get("/plan").json()["plan_id"]
    # nothing changed: the simulator starts from the saved plan itself
    base = client.post("/simulate", json={"time_limit_s": 2}).json()
    jsonschema.validate(base["plan"], settings.schema("plan"))
    assert base["inputs"]["saved"] is True and base["plan"]["plan_id"] == stored
    assert base["synthetic"] is True and base["plan"]["totals"]["fields_planned"] > 0
    # a bigger fleet clears more; no machines clears nothing
    more = client.post("/simulate", json={"baler_set": 6, "seeder": 6, "truck": 6, "time_limit_s": 2}).json()
    assert len(more["machines"]) == 18 and more["inputs"]["saved"] is False
    assert more["plan"]["totals"]["fields_planned"] > base["plan"]["totals"]["fields_planned"]
    none = client.post("/simulate", json={"baler_set": 0, "seeder": 0, "truck": 0, "time_limit_s": 2}).json()
    assert none["plan"]["totals"]["fields_planned"] == 0
    # rain over the wet threshold keeps machines off the fields
    wet = client.post("/simulate", json={"rain_mm": 20, "time_limit_s": 2}).json()
    assert wet["plan"]["totals"]["fields_planned"] == 0 and "wet" in set(wet["status"].values())
    # a what-if never replaces the stored plan
    assert client.get("/plan").json()["plan_id"] == stored


def test_rain_is_read_per_village_and_a_past_day_can_be_replayed(client, monkeypatch):
    from api import planning

    asked = {}

    def weather(points, start, end):
        # two villages get 6.4 mm over the three days, the others 2.9 (the real pattern of 27 Sep 2022)
        asked.update(points=points, start=start, end=end)
        ids = sorted(planning.village_points())
        return [{end: 6.4 if v in ("V01", "V04") else 2.9} for v in ids]

    monkeypatch.setattr(planning, "_rain_points", weather)
    client.post("/replan", json={})
    w = client.get("/weather", params={"like": "2022-09-27"}).json()
    assert w["replay"] is True and w["weather_date"] == "2022-09-27" and w["source"] == "open-meteo"
    assert len(asked["points"]) == 4 and asked["end"] == "2022-09-27" and asked["start"] == "2022-09-25"
    assert {v["village_id"]: v["too_wet"] for v in w["villages"]} == {"V01": True, "V02": False, "V03": False, "V04": True}
    r = client.post("/simulate", json={"weather_date": "2022-09-27", "time_limit_s": 2}).json()
    assert r["inputs"]["saved"] is False and r["inputs"]["weather_replay"] is True
    assert r["inputs"]["rain_by_village"] == {"V01": 6.4, "V02": 2.9, "V03": 2.9, "V04": 6.4}
    village = {f["properties"]["field_id"]: f["properties"]["village_id"] for f in client.get("/fields").json()["features"]}
    visited = {s["field_id"] for a in r["plan"]["assignments"] if a["type"] != "truck" for s in a["stops"]}
    # machines work only where it is dry, and the wet villages' harvested fields are marked wet
    assert visited and {village[f] for f in visited} <= {"V02", "V03"}
    assert {village[f] for f, st in r["status"].items() if st == "wet"} == {"V01", "V04"}
    assert client.post("/simulate", json={"weather_date": "2999-01-01"}).status_code == 422


def test_demo_reset_undoes_events(client):
    client.post("/events/rain", json={"village_id": "all", "mm": 20})
    client.post("/events/confirm", json={"field_id": "F0150", "date": "2026-10-23", "source": "farmer"})
    client.post("/fields/F0010/cleared", json={})
    r = client.post("/demo/reset", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["fields_reset"] >= 2 and body["removed"]["events"] >= 3
    assert body["replan"]["strawlink"]["totals"]["fields_planned"] > 0  # dry again, so machines work
    assert client.get("/fields/F0150").json()["harvest_window"]["source"] != "confirmed"
    statuses = {f["properties"]["field_id"]: f["properties"]["status"] for f in client.get("/fields").json()["features"]}
    assert statuses["F0010"] != "cleared" and "wet" not in set(statuses.values())
