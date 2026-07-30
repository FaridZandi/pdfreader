#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${PYTHON_BIN:-python3}"

"$python_bin" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10 or newer is required"'
cd "$project_root"
"$python_bin" -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm ci
npm run sync-pdfjs
