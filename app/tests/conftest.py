import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import boto3
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "app" / "backend"))
sys.path.insert(0, str(ROOT / "pipeline"))  # strawlink_planner, without installing the pipeline

os.environ.update({
    "AWS_DEFAULT_REGION": "ap-south-1", "AWS_REGION": "ap-south-1", "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test", "STRAWLINK_BUCKET": "strawlink-test", "BEDROCK_MODEL_ID": "",
    "PLANNER_FUNCTION": "", "DEMO_DATE": "2026-10-24", "PLANNER_TIME_LIMIT_S": "5",
    "SHARED_DIR": str(ROOT), "LOCATION_REGION": "ap-south-1",
})


@pytest.fixture(scope="session")
def aws():
    from moto import mock_aws

    with mock_aws():
        from common import settings

        ddb = boto3.client("dynamodb")
        keys = {"fields": [("field_id", "HASH")], "plans": [("date", "HASH"), ("plan_id", "RANGE")],
                "events": [("field_id", "HASH"), ("ts", "RANGE")], "certificates": [("cert_id", "HASH")],
                "machines": [("machine_id", "HASH")], "messages": [("phone", "HASH"), ("ts", "RANGE")]}
        for name, ks in keys.items():
            kw = {}
            attrs = {k for k, _ in ks}
            if name == "certificates":
                attrs.add("field_id")
                kw["GlobalSecondaryIndexes"] = [{"IndexName": "by_field", "KeySchema": [{"AttributeName": "field_id", "KeyType": "HASH"}],
                                                 "Projection": {"ProjectionType": "ALL"}}]
            ddb.create_table(TableName=settings.TABLES[name], BillingMode="PAY_PER_REQUEST",
                             AttributeDefinitions=[{"AttributeName": a, "AttributeType": "S"} for a in sorted(attrs)],
                             KeySchema=[{"AttributeName": k, "KeyType": t} for k, t in ks], **kw)
        boto3.client("s3").create_bucket(Bucket="strawlink-test",
                                         CreateBucketConfiguration={"LocationConstraint": "ap-south-1"})
        yield


@pytest.fixture(scope="session")
def loaded(aws):
    """Fields from data/, synthetic machines, and a forecast around the demo date."""
    from common import settings
    from loaders import handler as L

    fc = json.loads((ROOT / "data" / "fields" / "fields.geojson").read_text())
    L.load_fields(fc)
    L.load_machines(settings.synthetic())
    on = date(2026, 10, 24)
    rows = []
    for i, f in enumerate(fc["features"]):
        p50 = on + timedelta(days=(i % 9) - 3)
        rows.append({"field_id": f["properties"]["field_id"], "issued_on": "2026-10-20",
                     "p10": (p50 - timedelta(days=2)).isoformat(), "p50": p50.isoformat(),
                     "p90": (p50 + timedelta(days=3)).isoformat(), "source": "satellite", "confidence": 0.6})
    L.load_forecast(rows, {"fields": [{"field_id": r["field_id"], "burned_last_season": [True, False, None][i % 3]}
                                      for i, r in enumerate(rows)]})
    return fc


@pytest.fixture(scope="session")
def client(loaded, monkeypatch_session):
    from fastapi.testclient import TestClient

    from api import main, planning

    monkeypatch_session.setattr(planning, "_rain_points", lambda *a: [])
    monkeypatch_session.setattr(main, "road_route", lambda pts: (pts, "straight"))
    return TestClient(main.app)


@pytest.fixture(scope="session")
def monkeypatch_session():
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()
