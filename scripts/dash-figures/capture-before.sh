#!/bin/bash
#
# Renders the dash figure panels using the pre-9.4 dash implementation, so the docs can show
# honest before/after pairs.
#
# Only the three behavior-carrying sources are reverted. The render spec, the geometry it
# draws and the test harness all stay at the current revision, so both halves of every pair
# render exactly the same scene and differ only in the code under test. Reverting the whole
# tree instead would compare against whatever geometry those cases happened to use back then,
# which for several of them is not the geometry they use now.
#
# The renders are collected from the `-fail.png` files the harness writes on a golden
# mismatch, which is its documented way of surfacing an actual render (see
# scripts/print-golden-image.js). Every reverted case is expected to fail here - that failure
# is the output.
#
# Usage:
#   scripts/dash-figures/capture-before.sh [baseline-ref] [output-dir]
#
# Set DASH_FIGURES_RENDER_CMD to override how the render project is invoked, for environments
# where `yarn test-render` cannot launch its pinned browser.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

BASELINE="${1:-master}"
OUT_DIR="${2:-.dash-figures/before}"
RENDER_CMD="${DASH_FIGURES_RENDER_CMD:-yarn test-render}"

SOURCES=(
  modules/extensions/src/path-style/shaders.glsl.ts
  modules/extensions/src/path-style/path-style-extension.ts
  modules/layers/src/path-layer/path-layer-vertex.glsl.ts
)

GOLDEN_DIR=test/render/golden-images

restore_sources() {
  git checkout HEAD -- "${SOURCES[@]}"
}
trap restore_sources EXIT

echo "Reverting dash sources to $BASELINE..."
for source in "${SOURCES[@]}"; do
  git show "$BASELINE:$source" > "$source"
done

rm -f "$GOLDEN_DIR"/path-dash-*-fail.png "$GOLDEN_DIR"/path-dash-*-diff.png
mkdir -p "$OUT_DIR"

echo "Rendering with the reverted implementation (mismatches are expected)..."
$RENDER_CMD test/render/test-cases/path-dash.spec.ts || true

count=0
for failed in "$GOLDEN_DIR"/path-dash-*-fail.png; do
  [ -e "$failed" ] || continue
  name=$(basename "$failed")
  cp "$failed" "$OUT_DIR/${name%-fail.png}.png"
  count=$((count + 1))
done
rm -f "$GOLDEN_DIR"/path-dash-*-fail.png "$GOLDEN_DIR"/path-dash-*-diff.png

echo "Captured $count before panels into $OUT_DIR"
if [ "$count" -eq 0 ]; then
  echo "No panels captured - every case matched its golden, which means the revert did nothing." >&2
  exit 1
fi
