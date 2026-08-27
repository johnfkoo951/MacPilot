#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="CmdPilot Helper"
LABEL="com.cmdspace.cmdpilot.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_BINARY="$HOME/Applications/$APP_NAME.app/Contents/MacOS/$APP_NAME"
LOG_FILE="$HOME/Library/Logs/CmdPilot/helper.log"
PORT="$(sed -n 's/.*let port: UInt16 = \([0-9][0-9]*\).*/\1/p' "$ROOT_DIR/MacHelper/Sources/HelperServer.swift" | head -1)"
PORT="${PORT:-8766}"

url() {
  local host
  host="$(scutil --get LocalHostName 2>/dev/null || printf localhost)"
  printf 'http://%s.local:%s\n' "$host" "$PORT"
}

print_status() {
  echo "CmdPilot Helper"
  echo "URL: $(url)"
  echo

  local job
  job="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null || true)"
  if [[ -n "$job" ]]; then
    echo "LaunchAgent: loaded"
    echo "$job" | awk '/state =|pid =|path =|program =|properties =/ { sub(/^[ \t]+/, ""); print }'
  else
    echo "LaunchAgent: not loaded"
  fi

  echo
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT: listening"
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  else
    echo "Port $PORT: not listening"
  fi

  echo
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "HTTP: ok"
  else
    echo "HTTP: unavailable"
  fi
}

start_agent() {
  if [[ ! -f "$PLIST" ]]; then
    "$ROOT_DIR/deploy.sh"
    return
  fi

  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
  else
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
}

stop_agent() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$PLIST"
  fi
  pkill -f "$APP_BINARY" >/dev/null 2>&1 || true
}

case "${1:-status}" in
  status)
    print_status
    ;;
  start)
    start_agent
    print_status
    ;;
  stop)
    stop_agent
    print_status
    ;;
  restart)
    stop_agent
    start_agent
    print_status
    ;;
  logs)
    mkdir -p "$(dirname "$LOG_FILE")"
    touch "$LOG_FILE"
    tail -n 80 -f "$LOG_FILE"
    ;;
  open)
    /usr/bin/open "$(url)"
    ;;
  url)
    url
    ;;
  install)
    "$ROOT_DIR/deploy.sh"
    ;;
  sync-web)
    # 웹 파일만 고쳤을 때: Swift 재빌드·재배포 없이 즉시 반영.
    # 서버는 이 폴더에 파일이 있으면 번들 대신 여기서 서빙한다.
    WEB_OVERRIDE="$HOME/Library/Application Support/CmdPilot/web"
    mkdir -p "$WEB_OVERRIDE"
    rsync -a --delete "$ROOT_DIR/MacHelper/Web/" "$WEB_OVERRIDE/"
    echo "동기화 완료 → $WEB_OVERRIDE (폰에서 새로고침하면 반영)"
    ;;
  unsync-web)
    WEB_OVERRIDE="$HOME/Library/Application Support/CmdPilot/web"
    if [ -e "$WEB_OVERRIDE" ]; then
      find "$WEB_OVERRIDE" -depth -delete
    fi
    echo "오버라이드 해제 — 번들 웹 리소스로 복귀"
    ;;
  *)
    echo "usage: $0 {status|start|stop|restart|logs|open|url|install|sync-web|unsync-web}" >&2
    exit 2
    ;;
esac
