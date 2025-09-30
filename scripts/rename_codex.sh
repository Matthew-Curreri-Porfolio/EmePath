#!/usr/bin/env bash
set -euo pipefail
ROOT="/oss-codex"
NEW_DISPLAY="${1:-Codexz}"
NEW_SLUG="${2:-codexz}"   # used for config key + command ids
OLD_DISPLAY="OSS Codex"
OLD_CFG="ossCodex"
OLD_CMD_PREFIX="ossCodex"
OLD_STATUS="CODEx:"
OLD_LOG_TAG="codex"

find "$ROOT" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.json' -o -name '*.md' \) \
  ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/logs/*' ! -path '*/.git/*' \
  -print0 | while IFS= read -r -d '' f; do
  sed -i \
    -e "s/${OLD_DISPLAY}/${NEW_DISPLAY}/g" \
    -e "s/\"${OLD_CFG}\"/\"${NEW_SLUG}\"/g" \
    -e "s/${OLD_CMD_PREFIX}\./${NEW_SLUG}\./g" \
    -e "s/${OLD_STATUS}/${NEW_DISPLAY}:/g" \
    -e "s/\\[${OLD_LOG_TAG}\\]/[${NEW_SLUG}]/g" \
    -e "s|// ${OLD_LOG_TAG}:|// ${NEW_SLUG}:|g" \
    "$f"
done

# Extension package name -> codexz-extension (safe, targeted)
if [ -f "$ROOT/extension/package.json" ]; then
  sed -i \
    -e 's/"name": *"oss-codex-extension"/"name": "codexz-extension"/' \
    -e "s/\"displayName\": *\"[^\"]*\"/\"displayName\": \"${NEW_DISPLAY}\"/" \
    "$ROOT/extension/package.json"
fi

echo "[ok] Renamed to display='${NEW_DISPLAY}', slug='${NEW_SLUG}'"
