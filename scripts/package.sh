#!/usr/bin/env bash
# Build a clean, store-ready zip of the extension. The same package is accepted
# by both the Chrome Web Store and Firefox Add-ons (AMO): Chrome ignores the
# browser_specific_settings.gecko block, Firefox reads it.
#
# Whitelist only. We never zip the whole tree, so local-only files (docs/,
# CLAUDE.md), the icon source SVG, git metadata, and prior builds can't leak into
# a published package.
#
# Usage: ./scripts/package.sh   ->   dist/shorts-dislike-v<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' manifest.json \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
out="dist/shorts-dislike-v${version}.zip"

# Exactly what the extension loads, plus LICENSE and README for transparency.
files=(
  manifest.json
  LICENSE
  README.md
  src/content.js
  src/bridge.js
  src/styles.css
  icons/icon-16.png
  icons/icon-32.png
  icons/icon-48.png
  icons/icon-128.png
)

# Fail loudly if a referenced file is missing rather than shipping a broken zip.
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
done

mkdir -p dist
rm -f "$out"
zip -q -X "$out" "${files[@]}"
echo "Built $out"
unzip -l "$out"
