#!/bin/sh
# package.sh — tar up host-tools/ for upload to the board's Updates page
# (ota-server.js, port 3006).
#
# Dev-side convenience only; there is nothing magic in the output. The
# equivalent by hand is:
#
#   tar czf host-tools.tar.gz --exclude node_modules host-tools
#
# node_modules is deliberately excluded — it is ~100MB of arm64-native
# builds that would be wrong for your laptop anyway. ota-server.js carries
# the board's existing node_modules across, and re-runs `npm install` only
# if package.json changed.
#
# Usage:  ./package.sh [output.tar.gz]

set -e

ROOT=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-"$ROOT/host-tools.tar.gz"}

cd "$ROOT"

tar czf "$OUT" \
  --exclude=node_modules \
  --exclude=debug.log \
  --exclude='*.log' \
  host-tools

echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
echo
echo "Upload it on the board's Updates page:  http://<board>:3006/"
