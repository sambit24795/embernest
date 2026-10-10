#!/usr/bin/env bash
# Capture each tab (and the styleguide) at phone and desktop size, in both themes.
# Usage: scripts/screenshot.sh <base-url> <outdir>
# Uses a throwaway Firefox profile, so it does not clash with an open Firefox.
# Firefox shoots right after the page loads. For pages that fetch data (the model
# search), set CHROME_BIN to a Chromium/Chrome binary: it waits for network and timers
# (WAIT_MS, default 8000) before the screenshot.
set -euo pipefail

BASE="${1:?usage: screenshot.sh <base-url> <outdir>}"
OUT="${2:?usage: screenshot.sh <base-url> <outdir>}"
BASE="${BASE%/}"
mkdir -p "$OUT"

# name|path-with-hash
PAGES=(
  "chat|/#tab=chat"
  "create-generate|/#tab=create&mode=generate"
  "create-transform|/#tab=create&mode=transform"
  "create-edit|/#tab=create&mode=edit"
  "models|/#tab=models"
  "models-search|/#tab=models&q=realistic"
  "settings|/#tab=settings"
  "styleguide|/styleguide.html"
)
SIZES=("390,844" "1440,900")
THEMES=(dark light)

for page in "${PAGES[@]}"; do
  name="${page%%|*}"
  path="${page#*|}"
  for size in "${SIZES[@]}"; do
    for theme in "${THEMES[@]}"; do
      # The theme query goes before any #fragment.
      case "$path" in
        *"#"*) url="$BASE${path%%#*}?theme=$theme#${path#*#}" ;;
        *)     url="$BASE$path?theme=$theme" ;;
      esac
      file="$OUT/${name}-${size/,/x}-${theme}.png"
      if [ -n "${CHROME_BIN:-}" ]; then
        "$CHROME_BIN" --headless --no-sandbox --disable-gpu --hide-scrollbars \
          --window-size="$size" --virtual-time-budget="${WAIT_MS:-8000}" \
          --screenshot="$file" "$url" >/dev/null 2>&1 || echo "failed: $url" >&2
      else
        profile="$(mktemp -d)"
        firefox --headless --no-remote -profile "$profile" \
          --window-size="$size" --screenshot "$file" "$url" >/dev/null 2>&1 || echo "failed: $url" >&2
        rm -rf "$profile"
      fi
      echo "$file"
    done
  done
done
