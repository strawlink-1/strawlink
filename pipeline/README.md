# pipeline/ (Yash)

```
cd pipeline && uv venv --python 3.11 && uv pip install -e ".[dev]"
.venv/bin/python -m pytest -q
```

Run order (local mirror of the S3 layout lives in `pipeline/.s3/`; set `STRAWLINK_BUCKET` to also upload):

```
python -m strawlink_pipeline.stubs                      # outputs/stubs/* (all validated)
python -m strawlink_pipeline.stubs --examples           # contracts/examples/*
python -m strawlink_pipeline.aoi --pick                 # outputs/aoi_pick.json
python -m strawlink_pipeline.ingest --season 2022-2025  # derived/field_series.parquet
python -m strawlink_pipeline.labels --seasons 2022-2025 # derived/labels.parquet
python -m strawlink_pipeline.burns --seasons 2022-2025  # derived/burn_record.parquet (FIRMS if FIRMS_MAP_KEY)
python -m strawlink_pipeline.qa --season 2025           # outputs/qa/labels_2025.png
python -m strawlink_pipeline.forecast --train --validate 2025   # models/harvest_lgbm/{v, v-val2025}
python -m strawlink_pipeline.live --date 2026-10-10     # outputs/live/{date}/
python -m strawlink_pipeline.backtest --season 2025 --scales 0.75,1.0,1.25 --workers 6
```

Planner API for app/: `from strawlink_planner import plan_day, plan_day_baseline` →
`plan_day(state_dict).to_json_dict()` (validates against `contracts/plan.schema.json`).

Known caveats
- Fleet/plants: read from `config/synthetic.yaml`; until it exists a synthetic fleet is
  placed at the fields' villages (labelled synthetic).
- dNBR-only burn flags over-count (post-harvest tillage also drives NBR negative);
  validate against FIRMS before quoting burn numbers.
- Landsat ingest (`--landsat`) is not implemented yet (optional).
