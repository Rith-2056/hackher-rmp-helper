#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/build"
EXT_DIR="$ROOT/extension"
ZIP_PATH="$OUT_DIR/rmp-helper.zip"

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"

cd "$EXT_DIR"
zip -r "$ZIP_PATH" . -x "*.DS_Store"

echo "Packed extension to: $ZIP_PATH"

