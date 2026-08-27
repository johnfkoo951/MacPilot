#!/usr/bin/env bash
# Xcode가 API 키/토큰 환경변수를 DerivedData 메타데이터에 복사하지 않도록 최소 환경으로 빌드한다.
set -euo pipefail

current_user="$(id -un)"
exec env -i \
  HOME="$HOME" \
  USER="$current_user" \
  LOGNAME="$current_user" \
  TMPDIR=/tmp \
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  LANG=en_US.UTF-8 \
  LC_ALL=en_US.UTF-8 \
  /usr/bin/xcodebuild "$@"
