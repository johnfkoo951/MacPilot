#!/usr/bin/env bash
# CmdPilot 로컬 비밀을 소스/설정 파일 대신 macOS Keychain에 저장한다.
set -euo pipefail

APP_PATH="$HOME/Applications/CmdPilot Helper.app"
CONFIG_DIR="$HOME/Library/Application Support/CmdPilot"
CONFIG_FILE="$CONFIG_DIR/integrations.plist"
TLS_SERVICE="com.cmdspace.cmdpilot.tls"
OMNI_SERVICE="com.cmdspace.cmdpilot.omni"

usage() {
  echo "사용: $0 status | tls | omni [http://127.0.0.1:PORT]"
  echo "  tls   PKCS#12 암호를 보이지 않게 입력"
  echo "  omni  선택적 로컬 에이전트 API 토큰을 보이지 않게 입력"
}

require_app() {
  if [ ! -d "$APP_PATH" ]; then
    echo "먼저 ./deploy.sh로 $APP_PATH 를 설치하세요." >&2
    exit 1
  fi
}

has_secret() {
  security find-generic-password -s "$1" -a "$2" >/dev/null 2>&1
}

case "${1:-}" in
  status)
    has_secret "$TLS_SERVICE" pkcs12 && echo "TLS: configured" || echo "TLS: not configured"
    has_secret "$OMNI_SERVICE" api && echo "Omni integration: configured" || echo "Omni integration: not configured"
    [ -f "$CONFIG_FILE" ] && echo "Integration config: $CONFIG_FILE" || echo "Integration config: not configured"
    ;;
  tls)
    require_app
    echo "PKCS#12 암호를 입력하세요(화면에 표시되지 않음)."
    security add-generic-password -U -a pkcs12 -s "$TLS_SERVICE" -T "$APP_PATH" -w
    echo "TLS Keychain 항목을 저장했습니다. 헬퍼를 재시작하면 적용됩니다."
    ;;
  omni)
    require_app
    BASE_URL="${2:-http://127.0.0.1:8765}"
    if [[ ! "$BASE_URL" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}/?$ ]]; then
      echo "보안을 위해 loopback HTTP URL만 허용합니다: http://127.0.0.1:PORT" >&2
      exit 1
    fi
    BASE_PORT="${BASE_URL##*:}"
    BASE_PORT="${BASE_PORT%/}"
    if (( BASE_PORT < 1 || BASE_PORT > 65535 )); then
      echo "포트는 1~65535 범위여야 합니다." >&2
      exit 1
    fi
    mkdir -p "$CONFIG_DIR"
    if [ ! -f "$CONFIG_FILE" ]; then
      plutil -create xml1 "$CONFIG_FILE"
    fi
    if plutil -type omni.baseURL "$CONFIG_FILE" >/dev/null 2>&1; then
      plutil -replace omni.baseURL -string "$BASE_URL" "$CONFIG_FILE"
    elif plutil -type omni "$CONFIG_FILE" >/dev/null 2>&1; then
      plutil -insert omni.baseURL -string "$BASE_URL" "$CONFIG_FILE"
    else
      plutil -insert omni -json "{\"baseURL\":\"$BASE_URL\"}" "$CONFIG_FILE"
    fi
    chmod 600 "$CONFIG_FILE"
    echo "로컬 API 토큰을 입력하세요(화면에 표시되지 않음)."
    security add-generic-password -U -a api -s "$OMNI_SERVICE" -T "$APP_PATH" -w
    echo "선택적 통합 설정을 저장했습니다. 헬퍼를 재시작하면 적용됩니다."
    ;;
  *)
    usage
    exit 2
    ;;
esac
