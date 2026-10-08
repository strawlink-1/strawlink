import json

import jsonschema
import pytest

from strawlink_pipeline.config import CONTRACTS, OUTPUTS, schema
from strawlink_pipeline.stubs import FILENAMES, schema_for


@pytest.mark.parametrize("name", sorted(FILENAMES))
def test_examples_validate(name):
    doc = json.loads((CONTRACTS / "examples" / FILENAMES[name]).read_text())
    jsonschema.validate(doc, schema(schema_for(name)))


@pytest.mark.parametrize("name", sorted(FILENAMES))
def test_stubs_validate(name):
    path = OUTPUTS / "stubs" / FILENAMES[name]
    if not path.exists():
        pytest.skip("stubs not generated")
    jsonschema.validate(json.loads(path.read_text()), schema(schema_for(name)))


def test_schemas_are_valid():
    for p in CONTRACTS.glob("*.schema.json"):
        jsonschema.Draft202012Validator.check_schema(json.loads(p.read_text()))
