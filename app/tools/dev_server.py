"""Local API on an in-memory AWS mock (moto), loaded with repo data + pipeline outputs.

    app/.venv/bin/python app/tools/dev_server.py --date 2026-10-24 --port 8000

Everything AWS is mocked, so Bedrock is off locally: messages use the hand-written Punjabi
template and the assistant endpoint is unavailable. Use the deployed API for those.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "app" / "backend"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="2026-10-24")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    os.environ.update({"AWS_REGION": "ap-south-1", "AWS_DEFAULT_REGION": "ap-south-1", "AWS_ACCESS_KEY_ID": "dev",
                       "AWS_SECRET_ACCESS_KEY": "dev", "STRAWLINK_BUCKET": "strawlink-dev", "DEMO_DATE": a.date,
                       "SHARED_DIR": str(ROOT), "PLANNER_TIME_LIMIT_S": "10", "BEDROCK_MODEL_ID": ""})
    from moto import mock_aws

    with mock_aws():
        import boto3
        import uvicorn

        ddb = boto3.client("dynamodb")
        from common import settings

        keys = {"fields": [("field_id", "HASH")], "plans": [("date", "HASH"), ("plan_id", "RANGE")],
                "events": [("field_id", "HASH"), ("ts", "RANGE")], "certificates": [("cert_id", "HASH")],
                "machines": [("machine_id", "HASH")], "messages": [("phone", "HASH"), ("ts", "RANGE")]}
        for name, ks in keys.items():
            attrs, kw = {k for k, _ in ks}, {}
            if name == "certificates":
                attrs.add("field_id")
                kw["GlobalSecondaryIndexes"] = [{"IndexName": "by_field", "KeySchema": [{"AttributeName": "field_id", "KeyType": "HASH"}],
                                                 "Projection": {"ProjectionType": "ALL"}}]
            ddb.create_table(TableName=settings.TABLES[name], BillingMode="PAY_PER_REQUEST",
                             AttributeDefinitions=[{"AttributeName": x, "AttributeType": "S"} for x in sorted(attrs)],
                             KeySchema=[{"AttributeName": k, "KeyType": t} for k, t in ks], **kw)
        s3 = boto3.client("s3")
        s3.create_bucket(Bucket="strawlink-dev", CreateBucketConfiguration={"LocationConstraint": "ap-south-1"})
        out = ROOT / "outputs"
        for f in list((out / "live").rglob("*.json")) + list((out / "backtest").glob("*.json")) + list((out / "backtest" / "replay").rglob("*.json")):
            s3.upload_file(str(f), "strawlink-dev", f.relative_to(ROOT).as_posix())  # posix keys on Windows too
        rep = ROOT / "pipeline" / ".s3" / "derived" / "forecast_report.json"
        if rep.exists():
            s3.upload_file(str(rep), "strawlink-dev", "derived/forecast_report.json")

        from loaders import handler as L

        L.load_fields(json.loads((ROOT / "data" / "fields" / "fields.geojson").read_text()))
        L.load_machines(settings.synthetic())
        live = sorted((out / "live").iterdir())[-1]
        L.load_forecast(json.loads((live / "forecast.json").read_text()), json.loads((live / "planner_input.json").read_text()))
        from api import main as api

        print(json.dumps({"event": "replan", **api.planning.replan(__import__("datetime").date.fromisoformat(a.date), "dev")["strawlink"]}))
        uvicorn.run(api.app, host="127.0.0.1", port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
