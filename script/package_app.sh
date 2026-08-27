#!/bin/bash
# CmdPilot 를 Release 로 빌드해 배포용 아티팩트로 패키징한다.
#   → dist/CmdPilot.app  (재배포 가능한 앱 번들)
#   → dist/CmdPilot.zip  (공유용 압축본)
# deploy.sh 는 "상시 서버 설치"(~/Applications + launchd)용이고, 이 스크립트는 "배포 파일 산출"용이다.
# 앱 내부 실행 파일/표시 이름은 "CmdPilot Helper" 그대로지만, 배포 파일명은 CmdPilot 로 통일한다.
set -e
cd "$(dirname "$0")/.."

APP_NAME="CmdPilot Helper"      # xcodebuild PRODUCT_NAME
DIST_NAME="CmdPilot"           # 배포 파일명
OUT="dist"

VERSION=$(sed -n 's/.*MARKETING_VERSION: *"\([^"]*\)".*/\1/p' project.yml | head -1)
VERSION=${VERSION:-0.0.0}

echo "▸ 프로젝트 생성 + Release 빌드(서명 없이)…  (v$VERSION)"
xcodegen generate >/dev/null
./script/xcodebuild-clean.sh -project CmdPilot.xcodeproj -scheme CmdPilotHelper -configuration Release \
  -derivedDataPath ./.release CODE_SIGNING_ALLOWED=NO build >/dev/null

APP_SRC="./.release/Build/Products/Release/$APP_NAME.app"

# 서명: deploy.sh와 동일하게 명시값 → Apple Development → 유일 identity 순서.
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
    echo "     CODESIGN_IDENTITY를 지정하거나 ALLOW_ADHOC_SIGNING=1을 명시하세요." >&2
    exit 1
  fi
  codesign --force --deep --sign - "$APP_SRC" >/dev/null 2>&1
  echo "  ⚠️  고정 identity 없음 → ad-hoc 서명(Gatekeeper 경고, Keychain ACL 연속성 없음)."
fi

echo "▸ dist/ 패키징…"
if [ -e "$OUT" ]; then
  find "$OUT" -depth -delete
fi
mkdir -p "$OUT"
ditto "$APP_SRC" "$OUT/$DIST_NAME.app"
# 리소스 포크/확장속성 없는 배포용 zip — 버전 없는 최신본 + 버전 박힌 릴리즈 에셋
ditto -c -k --sequesterRsrc --keepParent "$OUT/$DIST_NAME.app" "$OUT/$DIST_NAME.zip"
cp "$OUT/$DIST_NAME.zip" "$OUT/$DIST_NAME-$VERSION.zip"

echo
echo "✅ 릴리즈 아티팩트 (v$VERSION):"
du -h -d0 "$OUT/$DIST_NAME.app" "$OUT/$DIST_NAME.zip" "$OUT/$DIST_NAME-$VERSION.zip" | sed 's/^/   /'
