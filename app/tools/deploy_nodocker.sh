#!/bin/sh
# Build and deploy StrawLink with no Docker and no SAM CLI — only pip, the AWS CLI and npm.
# Linux (arm64) wheels are fetched with pip; CloudFormation applies the SAM transform itself.
#
#   app/tools/deploy_nodocker.sh build     # make app/.build (Lambda packages + template); touches nothing on AWS
#   app/tools/deploy_nodocker.sh stack     # create or update the `strawlink` stack
#   app/tools/deploy_nodocker.sh data      # upload fields, fleet, forecasts, plan, backtest; first re-plan
#   app/tools/deploy_nodocker.sh web       # build the web app against the deployed API, publish to Amplify
#   app/tools/deploy_nodocker.sh check     # call the deployed API and print what answers
#   app/tools/deploy_nodocker.sh all       # build → stack → data → web → stack (with the web URL) → check
#
# Uses the AWS CLI's current login. REGION, STACK and DEMO_DATE can be overridden in the environment.
set -e
REGION=${REGION:-ap-south-1}
STACK=${STACK:-strawlink}
DEMO_DATE=${DEMO_DATE:-2026-10-24}
WEB_APP=${WEB_APP:-strawlink-web}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/app"
OUT="$APP/.build"
if [ -x "$APP/.venv/Scripts/python.exe" ]; then PY="$APP/.venv/Scripts/python.exe"; else PY="$APP/.venv/bin/python"; fi

out() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

# Third-party packages for one Lambda, as Linux arm64 wheels. Kept in app/.build-deps and reused
# until the requirements file changes, because pip takes many minutes to resolve them.
#   deps <name> <requirements file> <pip platform arguments…>
deps() {
  name=$1; req=$2; shift 2
  key=$("$PY" -c "import hashlib,sys; print(hashlib.sha1(open(sys.argv[1],'rb').read()).hexdigest()[:12])" "$req")
  dir="$APP/.build-deps/$name-$key"
  if [ ! -d "$dir" ]; then
    echo "fetching Linux packages for $name (slow the first time)…"
    rm -rf "$APP/.build-deps/$name-"* && mkdir -p "$APP/.build-deps"
    "$PY" -m pip install --quiet --disable-pip-version-check -r "$req" --target "$dir.tmp" \
      --implementation cp --only-binary=:all: "$@"
    rm -rf "$dir.tmp/bin" && mv "$dir.tmp" "$dir"
  fi
  mkdir -p "$OUT/$name" && cp -R "$dir/." "$OUT/$name/"
}

build() {
  "$APP/tools/sync_shared.sh"
  rm -rf "$OUT" && mkdir -p "$OUT"
  # API, loader and daily job share one package: python3.11 on Amazon Linux 2, arm64
  deps api "$APP/backend/requirements.txt" --platform manylinux2014_aarch64 --python-version 3.11
  for d in api assistant certificates common emissions exposure loaders messaging shared; do
    cp -R "$APP/backend/$d" "$OUT/api/"
  done
  # planner: python3.12 on Amazon Linux 2023, arm64 (ortools needs the newer glibc)
  deps planner "$APP/backend/planner_fn/requirements.txt" \
    --platform manylinux_2_28_aarch64 --platform manylinux2014_aarch64 --python-version 3.12
  cp "$APP/backend/planner_fn/app.py" "$OUT/planner/"
  cp -R "$APP/backend/planner_fn/strawlink_planner" "$OUT/planner/"
  find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +
  sed -e 's#CodeUri: backend/planner_fn/#CodeUri: planner/#' -e 's#CodeUri: backend/#CodeUri: api/#' \
    "$APP/template.yaml" > "$OUT/template.yaml"
  "$PY" - "$OUT" <<'EOF'
import pathlib, sys
out = pathlib.Path(sys.argv[1])
for name in ("api", "planner"):
    files = [f for f in (out / name).rglob("*") if f.is_file()]
    mb = sum(f.stat().st_size for f in files) / 1e6
    win = [f.name for f in files if f.suffix in (".pyd", ".dll")]
    print(f"{name}: {len(files)} files, {mb:.0f} MB unzipped (Lambda limit 250 MB)" + (f"  WINDOWS BINARIES: {win[:5]}" if win else ""))
    if mb > 250 or win:
        sys.exit(1)
EOF
}

stack() {
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  ART="strawlink-artifacts-$ACCOUNT-$REGION"
  aws s3api head-bucket --bucket "$ART" --region "$REGION" 2>/dev/null \
    || aws s3 mb "s3://$ART" --region "$REGION"
  aws cloudformation package --region "$REGION" --template-file "$OUT/template.yaml" \
    --s3-bucket "$ART" --s3-prefix "$STACK" --output-template-file "$OUT/packaged.yaml" >/dev/null
  aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file "$OUT/packaged.yaml" \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset \
    --parameter-overrides "DemoDate=$DEMO_DATE" ${WEB_URL:+"PublicWebUrl=$WEB_URL"}
  echo "API_URL=$(out ApiUrl)"
}

data() {
  REGION="$REGION" STACK="$STACK" "$APP/tools/publish_data.sh"
  API_URL=$(out ApiUrl)
  echo "first re-plan…"
  curl -sS -m 60 -X POST "$API_URL/replan" -H 'content-type: application/json' -d '{}' | cut -c1-300; echo
}

web() {
  API_URL=$(out ApiUrl)
  APP_ID=$(aws amplify list-apps --region "$REGION" --query "apps[?name=='$WEB_APP'].appId | [0]" --output text)
  if [ "$APP_ID" = "None" ] || [ -z "$APP_ID" ]; then
    # single-page app: every path that is not a file is served index.html
    APP_ID=$(aws amplify create-app --region "$REGION" --name "$WEB_APP" --platform WEB \
      --custom-rules '[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>","target":"/index.html","status":"200"}]' \
      --query app.appId --output text)
    aws amplify create-branch --region "$REGION" --app-id "$APP_ID" --branch-name main >/dev/null
  fi
  WEB_URL="https://main.$APP_ID.amplifyapp.com"
  (cd "$APP/web" && VITE_API_URL="$API_URL" npm run build)
  "$PY" -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])" "$OUT/web" "$APP/web/dist"
  DEP=$(aws amplify create-deployment --region "$REGION" --app-id "$APP_ID" --branch-name main --output json)
  JOB=$(echo "$DEP" | "$PY" -c "import json,sys; print(json.load(sys.stdin)['jobId'])")
  URL=$(echo "$DEP" | "$PY" -c "import json,sys; print(json.load(sys.stdin)['zipUploadUrl'])")
  curl -sf -T "$OUT/web.zip" "$URL" -H "Content-Type: application/zip"
  aws amplify start-deployment --region "$REGION" --app-id "$APP_ID" --branch-name main --job-id "$JOB" >/dev/null
  echo "WEB_URL=$WEB_URL"
}

check() {
  API_URL=$(out ApiUrl)
  for path in /health /meta "/fields" /machines /roads "/plan" "/plants/supply?weeks=2" /backtest "/exposure" "/emissions"; do
    printf "%-26s " "$path"; curl -s -o /dev/null -m 40 -w "%{http_code} %{time_total}s\n" "$API_URL$path"
  done
  printf "%-26s " "POST /simulate"
  curl -s -m 40 -X POST "$API_URL/simulate" -H 'content-type: application/json' -d '{}' \
    | "$PY" -c "import json,sys; d=json.load(sys.stdin); print(d['plan']['totals'], d['plan']['solver']['status'])"
}

case "${1:-}" in
  build) build ;;
  stack) stack ;;
  data) data ;;
  web) web ;;
  check) check ;;
  all) build; stack; data; web; WEB_URL="https://main.$(aws amplify list-apps --region "$REGION" --query "apps[?name=='$WEB_APP'].appId | [0]" --output text).amplifyapp.com"; stack; check; echo "WEB_URL=$WEB_URL" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
