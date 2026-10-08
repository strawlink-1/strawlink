# contracts/ CHANGELOG

Change any schema only with both owners' agreement; bump `version` and add a line here.

- **0.1** (2026-10-08, Yash — DRAFT, pending Shambhvi review): initial schemas transcribed
  from root CLAUDE.md §4. Parquet contracts (field_series, forecast, burn_record) are
  described as arrays of row objects; their examples are JSON arrays. Optional
  `synthetic` boolean allowed on records. Plan stop/delivery times are ISO datetimes
  (`YYYY-MM-DDTHH:MM[:SS][+05:30]`), IST.
  `backtest_result.daily[].cleared_fields` / `cleared_t` are cumulative to that date;
  `at_risk` is that day's plan count. `plan_baseline.json` stubs/examples use `plan.schema.json`.
  `window_coverage` / `village_volume_mape` are forecast metrics → null on baseline rows.
