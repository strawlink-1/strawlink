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
    e = client.get("/emissions").json()
    assert e["status"] == "pending_source"
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
    assert "sowing_deadline_default" in keys and "emission_factors" in keys
