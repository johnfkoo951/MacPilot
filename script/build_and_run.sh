#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
APP_NAME="CmdPilot Helper"
LABEL="com.cmdspace.cmdpilot.helper"

case "$MODE" in
  run)
    "$ROOT_DIR/deploy.sh"
    "$ROOT_DIR/script/macpilotctl.sh" status
    ;;
  --verify|verify)
    "$ROOT_DIR/deploy.sh"
    sleep 1
    "$ROOT_DIR/script/macpilotctl.sh" status
    curl -fsS --max-time 3 "http://127.0.0.1:$(sed -n 's/.*let port: UInt16 = \([0-9][0-9]*\).*/\1/p' "$ROOT_DIR/MacHelper/Sources/HelperServer.swift" | head -1)/" >/dev/null
    ;;
  --logs|logs)
    "$ROOT_DIR/deploy.sh"
    "$ROOT_DIR/script/macpilotctl.sh" logs
    ;;
  --telemetry|telemetry)
    "$ROOT_DIR/deploy.sh"
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\" || subsystem == \"$LABEL\""
    ;;
  --debug|debug)
    cd "$ROOT_DIR"
    xcodegen generate >/dev/null
    "$ROOT_DIR/script/xcodebuild-clean.sh" -project CmdPilot.xcodeproj -scheme CmdPilotHelper -configuration Debug -derivedDataPath ./.debug CODE_SIGNING_ALLOWED=NO build
    lldb -- "$ROOT_DIR/.debug/Build/Products/Debug/$APP_NAME.app/Contents/MacOS/$APP_NAME"
    ;;
  *)
    echo "usage: $0 [run|--verify|--logs|--telemetry|--debug]" >&2
    exit 2
    ;;
esac
