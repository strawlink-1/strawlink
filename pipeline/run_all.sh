#!/bin/zsh
set -e
cd "$(dirname "$0")"
P=.venv/bin/python
$P -m strawlink_pipeline.ingest --season 2022-2026
$P -m strawlink_pipeline.labels --seasons 2022-2025
$P -m strawlink_pipeline.burns --seasons 2022-2025
$P -m strawlink_pipeline.qa --season 2025
$P -m strawlink_pipeline.forecast --train --validate 2025 --version v1
$P -m strawlink_pipeline.backtest --season 2025 --scales 0.75,1.0,1.25 --workers 6
$P -m strawlink_pipeline.live --date 2026-10-08
echo PIPELINE_DONE
