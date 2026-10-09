from datetime import date

from exposure.core import angle_diff, bearing_deg, is_downwind
from messaging.core import guard_ok, regex_parse


def test_bearing_cardinal():
    o = (75.7, 30.3)
    assert abs(bearing_deg(o, (75.7, 30.4)) - 0) < 0.5
    assert abs(bearing_deg(o, (75.8, 30.3)) - 90) < 0.5
    assert abs(bearing_deg(o, (75.7, 30.2)) - 180) < 0.5
    assert angle_diff(350, 10) == 20


def test_downwind_sector():
    field = (75.7, 30.3)
    east_poi = (75.75, 30.3)  # ~4.8 km east
    # wind FROM the west (270°) blows TO the east → east POI exposed
    assert is_downwind(field, east_poi, 270, 10, 30)
    assert not is_downwind(field, east_poi, 90, 10, 30)
    assert not is_downwind(field, (75.9, 30.3), 270, 10, 30)  # too far


def test_translation_guard():
    src = "On 24-10-2026, between 08:00 and 10:30, field F0012."
    assert guard_ok(src, "੨੪-10-2026 ਨੂੰ 08:00 ਤੋਂ 10:30 ਵਿਚਕਾਰ, ਖੇਤ F0012।")
    assert not guard_ok(src, "24-10-2026 ਨੂੰ ਖੇਤ F0012।")  # times dropped
    assert not guard_ok(src, "25-10-2026 ਨੂੰ 08:00 ਤੋਂ 10:30, F0012")  # date changed


def test_regex_parse():
    on = date(2026, 10, 24)
    assert regex_parse("1", on)["intent"] == "confirm_slot"
    assert regex_parse("ਕਟਾਈ ੨੫/੧੦ ਨੂੰ", on) == {"intent": "harvest_date", "date": "2026-10-25"}
    assert regex_parse("aaj katai ho gayi", on)["date"] == "2026-10-24"
    assert regex_parse("kab aayegi machine?", on)["intent"] == "question"


def test_assistant_reply_drops_model_reasoning():
    from assistant.agent import clean_reply

    assert clean_reply("<thinking> the tool says no slot </thinking> No slot yet.") == "No slot yet."
    assert clean_reply("  Your machine comes at 10:20.  ") == "Your machine comes at 10:20."
