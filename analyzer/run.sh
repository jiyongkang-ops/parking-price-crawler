#!/bin/bash
# 使い方: analyzer/run.sh analyzer/targets/<物件>.json
set -e
cd "$(dirname "$0")/.."
[ -f analyzer/.pk-creds.sh ] && source analyzer/.pk-creds.sh
node analyzer/analyze.mjs "$1" --pdf
