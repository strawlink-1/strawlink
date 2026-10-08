#!/bin/sh
# Copy shared repo files into the Lambda package (backend/shared) before `sam build`.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/app/backend/shared"
rm -rf "$DEST" && mkdir -p "$DEST/data"
cp -R "$ROOT/config" "$ROOT/contracts" "$DEST/"
cp -R "$ROOT/data/fields" "$ROOT/data/osm" "$DEST/data/"
echo "synced shared files to $DEST"
rm -rf "$ROOT/app/backend/planner_fn/strawlink_planner"
cp -R "$ROOT/pipeline/strawlink_planner" "$ROOT/app/backend/planner_fn/strawlink_planner"
find "$ROOT/app/backend" -name __pycache__ -type d -prune -exec rm -rf {} +
echo "copied strawlink_planner into planner_fn"
