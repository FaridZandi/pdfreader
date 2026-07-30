#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [[ ! -x .venv/bin/python ]]; then
  echo "Run ./scripts/setup.sh first." >&2
  exit 1
fi

if [[ ! -f webui_static/pdfjs/pdf.mjs ]]; then
  npm run sync-pdfjs
fi

source .venv/bin/activate
export HF_HOME="${HF_HOME:-$project_root/.hf-cache}"
exec python local_webui.py "$@"
