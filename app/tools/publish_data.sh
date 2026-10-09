#!/bin/sh
# Upload fields, fleet and pipeline outputs to the StrawLink bucket. S3 events run the loaders.
#   app/tools/publish_data.sh
set -e
REGION=${REGION:-ap-south-1}
STACK=${STACK:-strawlink}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUCKET=$(aws cloudformation describe-stacks --region $REGION --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
cp() { aws s3 cp --region $REGION --only-show-errors "$@"; }

cp "$ROOT/data/fields/fields.geojson" "s3://$BUCKET/data/fields/fields.geojson"
cp "$ROOT/config/synthetic.yaml" "s3://$BUCKET/config/synthetic.yaml"
sleep 20   # let the loader write Fields before forecasts update them
LIVE=$(ls "$ROOT/outputs/live" | sort | tail -1)
cp "$ROOT/outputs/live/$LIVE/planner_input.json" "s3://$BUCKET/outputs/live/$LIVE/planner_input.json"
cp "$ROOT/outputs/live/$LIVE/village_forecast.json" "s3://$BUCKET/outputs/live/$LIVE/village_forecast.json"
cp "$ROOT/outputs/live/$LIVE/forecast.json" "s3://$BUCKET/outputs/live/$LIVE/forecast.json"
sleep 10
cp "$ROOT/outputs/live/$LIVE/plan.json" "s3://$BUCKET/outputs/live/$LIVE/plan.json"
aws s3 cp --region $REGION --only-show-errors --recursive "$ROOT/outputs/backtest/replay" "s3://$BUCKET/outputs/backtest/replay"
for f in "$ROOT"/outputs/backtest/*.json; do cp "$f" "s3://$BUCKET/outputs/backtest/$(basename "$f")"; done
# forecast accuracy report: only on a machine that has run the pipeline (pipeline/.s3 is not in git)
REPORT="$ROOT/pipeline/.s3/derived/forecast_report.json"
if [ -f "$REPORT" ]; then cp "$REPORT" "s3://$BUCKET/derived/forecast_report.json"; else echo "no forecast_report.json on this machine; skipped"; fi
echo "published to s3://$BUCKET (live $LIVE)"
