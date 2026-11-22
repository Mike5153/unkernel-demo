#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_PATH="$SCRIPT_DIR/../../public/raft-node"
mkdir -p "$(dirname "$OUT_PATH")"
cd "$SCRIPT_DIR"
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o "$OUT_PATH" .
ls -lh "$OUT_PATH"
