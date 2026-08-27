#!/bin/bash
# CmdPilot 헬퍼를 Release 로 빌드해 ~/Applications 에 설치하고 LaunchAgent 를 (없으면 만들어서) 재시작.
# 코드 수정 후 이 스크립트 한 번이면 상시 서버가 갱신된다. (Xcode 불필요)
set -e
cd "$(dirname "$0")"

APP_NAME="CmdPilot Helper"
LABEL="com.cmdspace.cmdpilot.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# 포트는 HelperServer.swift 의 상수에서 자동 감지
PORT=$(sed -n 's/.*let port: UInt16 = \([0-9][0-9]*\).*/\1/p' MacHelper/Sources/HelperServer.swift)
PORT=${PORT:-8766}

echo "▸ 프로젝트 생성 + Release 빌드(서명 없이)…"
xcodegen generate >/dev/null
./script/xcodebuild-clean.sh -project CmdPilot.xcodeproj -scheme CmdPilotHelper -configuration Release \
  -derivedDataPath ./.release CODE_SIGNING_ALLOWED=NO build >/dev/null

APP_SRC="./.release/Build/Products/Release/$APP_NAME.app"

# 서명: CODESIGN_IDENTITY를 우선하고, 없으면 Apple Development 또는 유일한 유효 identity를 선택한다.
# 고정 서명은 손쉬운 사용 권한과 Keychain ACL을 재빌드 후에도 안정적으로 유지한다.
if ! CERT="$(./script/select-codesign-identity.sh)"; then
  exit 1
fi
if [ -n "$CERT" ]; then
  if ! codesign --force --deep --sign "$CERT" "$APP_SRC" >/dev/null 2>&1 \
     || ! codesign --verify --deep --strict "$APP_SRC" >/dev/null 2>&1; then
    echo "  ❌ 코드 서명 실패 ($CERT). ad-hoc으로 자동 강등하지 않습니다." >&2
    exit 1
  fi
  echo "▸ 고정 identity 서명 OK ($CERT)"
else
  if [ "${ALLOW_ADHOC_SIGNING:-0}" != "1" ]; then
    echo "  ❌ 유효한 코드 서명 identity가 없습니다." >&2
    echo "     Keychain 통합과 손쉬운 사용 권한을 유지하려면 CODESIGN_IDENTITY를 지정하세요." >&2
    echo "     기능 저하를 감수하고 임시 빌드하려면 ALLOW_ADHOC_SIGNING=1을 명시하세요." >&2
    exit 1
  fi
  codesign --force --deep --sign - "$APP_SRC" >/dev/null 2>&1
  echo "  ⚠️  유효한 코드 서명 identity 없음 → ad-hoc 서명."
  echo "     재빌드마다 손쉬운 사용 권한 재부여 필요: 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → '$APP_NAME' 껐다 켜기"
  echo "     Keychain 기반 cmux/TLS/선택 통합도 다음 재빌드에서 재설정 또는 승인 프롬프트가 필요할 수 있습니다."
fi

echo "▸ ~/Applications 갱신…"
INSTALLED_APP="$HOME/Applications/$APP_NAME.app"
if [ -e "$INSTALLED_APP" ]; then
  find "$INSTALLED_APP" -depth -delete
fi
ditto "$APP_SRC" "$INSTALLED_APP"

# 개발용 웹 override가 남아 있으면 번들보다 우선 서빙된다. 네이티브/웹 프로토콜을
# 함께 바꾼 배포에서 구 override가 새 헬퍼를 가리지 않도록 같은 소스로 맞춘다.
WEB_OVERRIDE="$HOME/Library/Application Support/CmdPilot/web"
if [ -d "$WEB_OVERRIDE" ]; then
  echo "▸ 기존 웹 override 동기화…"
  rsync -a --delete "./MacHelper/Web/" "$WEB_OVERRIDE/"
fi

# LaunchAgent: plist 가 없으면 생성 (로그인 시 자동 시작 + 죽으면 자동 재시작)
if [ ! -f "$PLIST" ]; then
  echo "▸ LaunchAgent 생성…"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/CmdPilot"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/Applications/$APP_NAME.app/Contents/MacOS/$APP_NAME</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/CmdPilot/helper.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/CmdPilot/helper.log</string>
</dict>
</plist>
PLISTEOF
fi

echo "▸ 서버 재시작…"
# launchd 밖에서 직접 실행된 인스턴스가 있으면 종료 (포트 충돌 방지)
pkill -f "$APP_NAME.app/Contents/MacOS" 2>/dev/null || true
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

echo "✅ 배포 완료 — http://$(scutil --get LocalHostName).local:$PORT"
