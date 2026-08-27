#!/usr/bin/env bash
# CmdPilot 헬퍼 워치독 — "살아 있는데 서빙은 안 하는" 상태를 잡는다.
#
# 왜 필요한가:
#   프로세스가 소켓을 쥔 채 HTTP 응답을 멈추면 LaunchAgent의 KeepAlive만으로는
#   복구되지 않는다. 이 스크립트는 '프로세스 존재'와 '실제 서빙' 사이를 점검한다.
#
# 동작: 로컬 HTTP가 응답하면 아무 출력 없이 종료(0). 실패하면 재시작하고
#       결과를 로그 + 로컬 macOS 알림으로 알린다.
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

# 워치독 알림은 외부 API 토큰 없이 로그인한 Mac의 알림 센터에만 보낸다.
brief() {
  local headline="$2"
  /usr/bin/osascript \
    -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title "CmdPilot"' \
    -e 'end run' \
    "$headline" >/dev/null 2>&1 || true
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
