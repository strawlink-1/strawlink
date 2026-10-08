"""Paths and config loaders shared by the pipeline."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config"
CONTRACTS = ROOT / "contracts"
DATA = ROOT / "data"
OUTPUTS = ROOT / "outputs"
LOCAL_S3 = ROOT / "pipeline" / ".s3"  # local mirror of the bucket layout when no bucket


@lru_cache
def params() -> dict:
    with open(CONFIG / "params.yaml") as f:
        return yaml.safe_load(f)


def schema(name: str) -> dict:
    with open(CONTRACTS / f"{name}.schema.json") as f:
        return json.load(f)


def bucket() -> str | None:
    return os.environ.get("STRAWLINK_BUCKET") or None


def upload(local: Path, key: str) -> bool:
    """Upload a file to s3://$STRAWLINK_BUCKET/key. Returns False if no bucket configured."""
    b = bucket()
    if not b:
        return False
    import boto3

    boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-south-1")).upload_file(
        str(local), b, key
    )
    return True
