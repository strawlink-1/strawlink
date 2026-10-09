"""DynamoDB + S3 helpers. Floats ↔ Decimal handled here so callers use plain JSON types."""

from __future__ import annotations

import json
from decimal import Decimal
from functools import lru_cache
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

from . import settings


@lru_cache
def _ddb():
    return boto3.resource("dynamodb", region_name=settings.REGION)


@lru_cache
def _s3():
    return boto3.client("s3", region_name=settings.REGION)


def table(name: str):
    return _ddb().Table(settings.TABLES[name])


def to_ddb(x: Any) -> Any:
    if isinstance(x, float):
        return Decimal(str(round(x, 6)))
    if isinstance(x, dict):
        return {k: to_ddb(v) for k, v in x.items()}
    if isinstance(x, list):
        return [to_ddb(v) for v in x]
    return x


def from_ddb(x: Any) -> Any:
    if isinstance(x, Decimal):
        return int(x) if x == x.to_integral_value() and "." not in str(x) else float(x)
    if isinstance(x, dict):
        return {k: from_ddb(v) for k, v in x.items()}
    if isinstance(x, list):
        return [from_ddb(v) for v in x]
    return x


def put(name: str, item: dict) -> None:
    table(name).put_item(Item=to_ddb(item))


def get(name: str, **key) -> dict | None:
    r = table(name).get_item(Key=key)
    return from_ddb(r["Item"]) if "Item" in r else None


def update(name: str, key: dict, values: dict) -> None:
    if not values:
        return
    names = {f"#k{i}": k for i, k in enumerate(values)}
    vals = {f":v{i}": to_ddb(v) for i, v in enumerate(values.values())}
    expr = "SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(values)))
    table(name).update_item(Key=key, UpdateExpression=expr, ExpressionAttributeNames=names,
                            ExpressionAttributeValues=vals)


def scan(name: str) -> list[dict]:
    t, out, kw = table(name), [], {}
    while True:
        r = t.scan(**kw)
        out += r["Items"]
        if "LastEvaluatedKey" not in r:
            return [from_ddb(i) for i in out]
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def query(name: str, pk: str, value: str, index: str | None = None, desc: bool = False) -> list[dict]:
    kw = {"KeyConditionExpression": Key(pk).eq(value), "ScanIndexForward": not desc}
    if index:
        kw["IndexName"] = index
    t, out = table(name), []
    while True:
        r = t.query(**kw)
        out += r["Items"]
        if "LastEvaluatedKey" not in r:
            return [from_ddb(i) for i in out]
        kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]


def remove(name: str, key: dict, attrs: list[str]) -> None:
    """Drop attributes from one row."""
    if not attrs:
        return
    names = {f"#k{i}": a for i, a in enumerate(attrs)}
    table(name).update_item(Key=key, UpdateExpression="REMOVE " + ", ".join(names), ExpressionAttributeNames=names)


def clear(name: str, key_names: tuple[str, ...]) -> int:
    """Delete every row of a table (demo reset). Returns how many were removed."""
    rows = scan(name)
    with table(name).batch_writer() as w:
        for r in rows:
            w.delete_item(Key={k: r[k] for k in key_names})
    return len(rows)


def batch_put(name: str, items: list[dict]) -> None:
    with table(name).batch_writer() as w:
        for it in items:
            w.put_item(Item=to_ddb(it))


# ---------------------------------------------------------------- S3


def s3_get_json(key: str) -> Any | None:
    try:
        body = _s3().get_object(Bucket=settings.BUCKET, Key=key)["Body"].read()
    except _s3().exceptions.NoSuchKey:
        return None
    except Exception as e:  # noqa: BLE001
        if "NoSuchKey" in str(e) or "404" in str(e):
            return None
        raise
    return json.loads(body)


def s3_put_json(key: str, doc: Any) -> None:
    _s3().put_object(Bucket=settings.BUCKET, Key=key, Body=json.dumps(doc, ensure_ascii=False).encode(),
                     ContentType="application/json")


def s3_put_bytes(key: str, data: bytes, content_type: str) -> None:
    _s3().put_object(Bucket=settings.BUCKET, Key=key, Body=data, ContentType=content_type)


def s3_list(prefix: str) -> list[str]:
    keys, kw = [], {"Bucket": settings.BUCKET, "Prefix": prefix}
    while True:
        r = _s3().list_objects_v2(**kw)
        keys += [o["Key"] for o in r.get("Contents", [])]
        if not r.get("IsTruncated"):
            return keys
        kw["ContinuationToken"] = r["NextContinuationToken"]


def presign(key: str, seconds: int = 3600) -> str:
    return _s3().generate_presigned_url("get_object", Params={"Bucket": settings.BUCKET, "Key": key},
                                        ExpiresIn=seconds)


def ssm_json(name: str) -> dict | None:
    try:
        r = boto3.client("ssm", region_name=settings.REGION).get_parameter(Name=name, WithDecryption=True)
        return json.loads(r["Parameter"]["Value"])
    except Exception:  # noqa: BLE001 — parameter not created yet → feature runs simulated
        return None
