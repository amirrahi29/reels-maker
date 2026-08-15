#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
PY="/opt/homebrew/bin/python3.12"
if [ ! -x "$PY" ]; then
  PY="/opt/homebrew/bin/python3.13"
fi
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/pip install -q -r requirements.txt
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 5051 --timeout-keep-alive 300
