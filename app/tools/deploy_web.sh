#!/bin/sh
# Build the web app against the deployed API and publish it to AWS Amplify Hosting (manual deploy).
#   app/tools/deploy_web.sh            # uses stack outputs from `strawlink` in ap-south-1
set -e
REGION=ap-south-1
STACK=strawlink
APP_NAME=strawlink-web
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

API_URL=$(aws cloudformation describe-stacks --region $REGION --stack-name $STACK \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
KEY_NAME=$(aws cloudformation describe-stacks --region $REGION --stack-name $STACK \
  --query "Stacks[0].Outputs[?OutputKey=='MapsApiKeyName'].OutputValue" --output text)
MAPS_KEY=$(aws location describe-key --region $REGION --key-name "$KEY_NAME" --query Key --output text)

APP_ID=$(aws amplify list-apps --region $REGION --query "apps[?name=='$APP_NAME'].appId | [0]" --output text)
if [ "$APP_ID" = "None" ] || [ -z "$APP_ID" ]; then
  APP_ID=$(aws amplify create-app --region $REGION --name $APP_NAME --platform WEB \
    --custom-rules '[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>","target":"/index.html","status":"200"}]' \
    --query app.appId --output text)
  aws amplify create-branch --region $REGION --app-id "$APP_ID" --branch-name main >/dev/null
fi
WEB_URL="https://main.$APP_ID.amplifyapp.com"

cd "$ROOT/app/web"
VITE_API_URL="$API_URL" VITE_MAPS_KEY="$MAPS_KEY" VITE_MAPS_REGION=$REGION npm run build
rm -f /tmp/strawlink-web.zip && (cd dist && zip -qr /tmp/strawlink-web.zip .)

DEP=$(aws amplify create-deployment --region $REGION --app-id "$APP_ID" --branch-name main --output json)
JOB=$(echo "$DEP" | python3 -c "import json,sys; print(json.load(sys.stdin)['jobId'])")
URL=$(echo "$DEP" | python3 -c "import json,sys; print(json.load(sys.stdin)['zipUploadUrl'])")
curl -sf -T /tmp/strawlink-web.zip "$URL" -H "Content-Type: application/zip"
aws amplify start-deployment --region $REGION --app-id "$APP_ID" --branch-name main --job-id "$JOB" >/dev/null
echo "API_URL=$API_URL"
echo "WEB_URL=$WEB_URL"
