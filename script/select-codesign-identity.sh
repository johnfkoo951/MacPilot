#!/usr/bin/env bash
# stdout에는 선택한 identity(없으면 빈 문자열)만 출력한다.
set -euo pipefail

if [ "${CODESIGN_IDENTITY:-}" = "-" ]; then
  # codesign의 '-'는 ad-hoc identity다. 호출자의 ALLOW_ADHOC_SIGNING gate로 보낸다.
  printf '\n'
  exit 0
fi
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  printf '%s\n' "$CODESIGN_IDENTITY"
  exit 0
fi

IDENTITIES=""
for _ in 1 2 3 4; do
  IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if printf '%s\n' "$IDENTITIES" | awk '/^[[:space:]]*[0-9]+\)/ { found=1 } END { exit !found }'; then
    break
  fi
  sleep 1
done

APPLE_COUNT="$(printf '%s\n' "$IDENTITIES" | awk '/^[[:space:]]*[0-9]+\).*Apple Development/ { n++ } END { print n+0 }')"
APPLE_CERT="$(printf '%s\n' "$IDENTITIES" | awk '/^[[:space:]]*[0-9]+\).*Apple Development/ { print $2; exit }')"
if [ "$APPLE_COUNT" -eq 1 ]; then
  printf '%s\n' "$APPLE_CERT"
  exit 0
fi
if [ "$APPLE_COUNT" -gt 1 ]; then
  echo "Apple Development identity가 여러 개입니다." >&2
  echo "CODESIGN_IDENTITY를 명시해 서명 identity를 고정하세요." >&2
  exit 2
fi

VALID_COUNT="$(printf '%s\n' "$IDENTITIES" | awk '/^[[:space:]]*[0-9]+\)/ { n++ } END { print n+0 }')"
if [ "$VALID_COUNT" -eq 1 ]; then
  printf '%s\n' "$IDENTITIES" | awk '/^[[:space:]]*[0-9]+\)/ { print $2; exit }'
  exit 0
fi
if [ "$VALID_COUNT" -gt 1 ]; then
  echo "Apple Development identity가 없고 유효 identity가 여러 개입니다." >&2
  echo "CODESIGN_IDENTITY를 명시해 서명 identity를 고정하세요." >&2
  exit 2
fi

# 유효 identity가 전혀 없으면 호출자가 명시적으로 ad-hoc 폴백한다.
printf '\n'
