# CmdPilot 상시 서버 (launchd)

CmdPilot Helper는 GUI 세션의 사용자 LaunchAgent로 실행됩니다. 로그인 시 시작하고 프로세스가
종료되면 launchd가 다시 시작합니다. 손쉬운 사용 권한이 필요한 앱이므로 시스템 데몬이 아닙니다.

## 구성

- 앱: `~/Applications/CmdPilot Helper.app`
- LaunchAgent: `~/Library/LaunchAgents/com.cmdspace.cmdpilot.helper.plist`
- 기본 포트: `8766` (`HelperServer.swift`의 `port` 상수가 정본)
- LAN 주소: `http://<mac-name>.local:8766`
- 로컬 데이터: `~/Library/Application Support/CmdPilot/`

`deploy.sh`는 앱을 빌드·서명·설치하고, plist가 없으면 생성한 뒤 LaunchAgent를 재시작합니다.

## 관리

```bash
./script/macpilotctl.sh status
./script/macpilotctl.sh stop
./script/macpilotctl.sh start
./script/macpilotctl.sh restart
./script/macpilotctl.sh logs
./script/macpilotctl.sh open
```

직접 launchctl을 사용할 때:

```bash
uid="$(id -u)"
label="com.cmdspace.cmdpilot.helper"
plist="$HOME/Library/LaunchAgents/$label.plist"

launchctl print "gui/$uid/$label"
launchctl bootout "gui/$uid" "$plist"
launchctl bootstrap "gui/$uid" "$plist"
launchctl kickstart -k "gui/$uid/$label"
```

## 코드 반영

```bash
./script/macpilotctl.sh sync-web  # HTML/JS/CSS만 로컬 override에 반영
./deploy.sh                       # Swift 또는 번들 리소스 변경을 빌드·설치
```

네이티브와 웹 프로토콜을 함께 바꾼 경우에는 `sync-web`만 실행하지 말고 `./deploy.sh`를
사용합니다. 배포 시 기존 웹 override도 같은 소스로 맞춘 뒤 서버를 재시작합니다.

Xcode에서 직접 실행하기 전에는 설치된 LaunchAgent를 중지해야 포트 충돌이 나지 않습니다.

## TLS와 비밀

PKCS#12 및 인증서는 `~/Library/Application Support/CmdPilot/tls/`에 두고 Git에 넣지 않습니다.
PKCS#12 암호는 소스나 셸 이력에 쓰지 말고 다음 명령의 보안 프롬프트로 Keychain에 저장합니다.
내장 PKCS#12 HTTPS는 메모리 전용 import가 가능한 macOS 15 이상에서만 켜집니다. macOS 13–14는
`script/tailscale-https.sh`의 private Tailscale Serve 경로를 사용하세요.

```bash
./script/configure-secrets.sh tls
./script/macpilotctl.sh restart
```

원격 접속과 장애 점검은 [docs/CONNECTION.md](docs/CONNECTION.md)를 참고하세요.
