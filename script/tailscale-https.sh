#!/usr/bin/env bash
# 에어마우스/모션 센서용 HTTPS 활성화.
# iOS는 DeviceMotion/Orientation을 secure context(HTTPS)에서만 허용한다.
# tailscale serve 로 로컬 HTTP 서버(포트 8766)를 tailnet HTTPS 앞단에 붙인다.
# → https://<맥이름>.<tailnet>.ts.net 로 접속하면 에어마우스가 동작(같은 tailnet의 폰).
#
# 사용법: bash script/tailscale-https.sh [on|off|status]
set -euo pipefail

PORT=8766   # HelperServer.swift 의 기본 port 상수
TS="$(command -v tailscale || echo /usr/local/bin/tailscale)"
[ -x "$TS" ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || { echo "tailscale CLI를 찾지 못했습니다."; exit 1; }

cmd="${1:-on}"
case "$cmd" in
  on)
    echo "▶ tailscale serve: https:443 → http://127.0.0.1:${PORT}"
    "$TS" serve --bg --https=443 "http://127.0.0.1:${PORT}"
    DNS="$("$TS" status --json | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
    echo ""
    echo "✅ 에어마우스용 HTTPS 주소:  https://${DNS}"
    echo "   폰(Tailscale 켠 상태)에서 이 주소로 접속 → 🛸 에어 버튼 → 모션 권한 허용."
    ;;
  off)
    "$TS" serve --https=443 off && echo "HTTPS 프록시 해제됨."
    ;;
  status)
    "$TS" serve status
    ;;
  *)
    echo "사용법: $0 [on|off|status]"; exit 1;;
esac
