#!/usr/bin/env bash
# CmdPilot 헬퍼 워치독 — "살아 있는데 서빙은 안 하는" 상태를 잡는다.
#
# 왜 필요한가 (2026-08-10 실사례):
#   헬퍼가 34시간 동안 8766·80·443 소켓을 쥔 채 accept를 하지 않았다.
#   프로세스는 살아 있었으므로 LaunchAgent의 KeepAlive는 아무것도 하지 않았고,
#   폰에서 pilot.cmdspace.work가 조용히 죽어 있었다. keepalive는 '프로세스
#   존재'만 보고 '서빙 여부'는 보지 않는다 — 그 간극이 이 스크립트다.
#
# 동작: 로컬 HTTP가 응답하면 아무 출력 없이 종료(0). 실패하면 재시작하고
#       결과를 로그 + (가능하면) OmniControl 브리핑으로 알린다.
#
# 사용: bash script/watchdog.sh [check]    check = 진단만, 재시작 안 함
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.cmdspace.cmdpilot.helper"
LOG="$HOME/Library/Logs/CmdPilot/watchdog.log"
PORT="$(sed -n 's/.*let port: UInt16 = \([0-9][0-9]*\).*/\1/p' \
        "$ROOT_DIR/MacHelper/Sources/HelperServer.swift" 2>/dev/null | head -1)"
PORT="${PORT:-8766}"
PROBE="http://127.0.0.1:${PORT}/"
TIMEOUT=5

mkdir -p "$(dirname "$LOG")"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

alive() { curl -sf -o /dev/null -m "$TIMEOUT" "$PROBE"; }

# OmniControl 데몬이 있으면 브리핑으로 올린다 (없으면 조용히 건너뜀).
brief() {
  local event="$1" headline="$2"
  local cfg="$HOME/.config/cmux-voice/config.json"
  [ -f "$cfg" ] || return 0
  local token port
  token="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("auth_token",""))' "$cfg" 2>/dev/null)"
  port="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",8765))' "$cfg" 2>/dev/null)"
  [ -n "$token" ] || return 0
  /usr/bin/python3 - "$port" "$token" "$event" "$headline" <<'PY' 2>/dev/null || true
import json, sys, urllib.request
port, token, event, headline = sys.argv[1:5]
req = urllib.request.Request(
    "http://127.0.0.1:%s/test" % port,
    data=json.dumps({"event": event, "label": "CmdPilot",
                     "headline": headline}).encode(),
    headers={"Content-Type": "application/json", "X-CMUX-Token": token})
urllib.request.urlopen(req, timeout=5).read()
PY
}

if alive; then
  [ "${1:-}" = "check" ] && echo "🟢 CmdPilot 헬퍼 정상 ($PROBE)"
  exit 0
fi

if [ "${1:-}" = "check" ]; then
  echo "🔴 CmdPilot 헬퍼 무응답 ($PROBE) — 재시작 필요"
  exit 1
fi

log "무응답 감지 ($PROBE) — 재시작"
launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || {
  log "kickstart 실패 — LaunchAgent 미등록?"
  brief error "CmdPilot 헬퍼가 죽었고 재시작도 실패했습니다 (LaunchAgent 확인 필요)"
  exit 1
}

# 기동 대기 — 최대 15초.
for _ in $(seq 1 30); do
  sleep 0.5
  if alive; then
    log "재시작 성공"
    brief turn_done "CmdPilot 헬퍼가 응답하지 않아 재시작했습니다 — 폰 접속 복구됨"
    exit 0
  fi
done

log "재시작했으나 여전히 무응답"
brief error "CmdPilot 헬퍼 재시작 후에도 무응답 — 폰에서 접속 불가"
exit 1
