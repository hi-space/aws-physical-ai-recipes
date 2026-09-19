#!/usr/bin/env bash
# Export every page of the multi-page .drawio to PNG (embedded XML, re-editable in draw.io).
set -euo pipefail
cd "$(dirname "$0")"
python3 gen_diagrams.py
CLI=${DRAWIO_CLI:-drawio}
RUN=()
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then RUN=(xvfb-run -a); fi
while IFS=$'\t' read -r idx name; do
  slug=$(python3 -c "import re,sys;print(re.sub(r'[^0-9A-Za-z\uac00-\ud7a3]+','-',sys.argv[1]).strip('-'))" "$name")
  "${RUN[@]}" "$CLI" -x -f png -e -b 20 -p "$idx" -o "${slug}.drawio.png" physical-ai-dashboard-features.drawio 2>/dev/null | grep -v -iE "autoupdate|package-type|Found package" || true
done < pages.txt
ls -la *.png
