# CONNECTION — 접속과 장애 점검

> 설계 배경은 [CONNECTION_RESEARCH.md](CONNECTION_RESEARCH.md), 프로세스 관리는
> [SERVER.md](../SERVER.md)를 참고하세요. 이 문서의 주소는 모두 공개용 예시입니다.

## 지원 경로

| 경로 | 예시 | 용도 |
|---|---|---|
| 같은 LAN | `http://<mac-name>.local:8766` | 기본 트랙패드·키보드·덱 |
| Tailscale Serve | `https://<mac-name>.<tailnet>.ts.net` | private tailnet 원격 + iOS secure context |
| 자체 TLS(선택) | `https://control.example.com` | 앱의 선택적 `:443` 리스너 |

CmdPilot은 원격 입력을 주입하므로 인터넷에 포트포워딩하거나 Tailscale Funnel로 공개하지 마세요.
공용 Wi‑Fi나 선택적 세션 통합을 사용할 때는 메뉴바에서 PIN 페어링을 켜야 합니다.

## 기본 상태 확인

```bash
./script/macpilotctl.sh status
bash script/watchdog.sh check
curl --fail --silent --show-error http://127.0.0.1:8766/ >/dev/null
```

프로세스는 살아 있어도 HTTP 응답이 멈출 수 있습니다. 로컬 probe가 실패하면:

```bash
./script/macpilotctl.sh restart
tail -n 50 "$HOME/Library/Logs/CmdPilot/watchdog.log"
```

## LAN에서 안 될 때

- Mac과 폰이 같은 Wi‑Fi에 있고 Mac이 깨어 있는지 확인합니다.
- 메뉴바의 `.local` 주소와 IPv4 대체 주소를 각각 시도합니다.
- macOS 방화벽에서 `CmdPilot Helper`의 수신 연결이 허용됐는지 확인합니다.
- 입력만 안 되면 시스템 설정의 손쉬운 사용 권한을 확인합니다.
- 미러/캡처만 안 되면 화면 기록 권한을 별도로 확인합니다.

## Tailscale에서 안 될 때

```bash
tailscale status
tailscale serve status
tailscale ip -4
```

Mac 자체 Tailscale IP를 같은 Mac에서 curl하는 self-hairpin 검사는 환경에 따라 실패할 수 있습니다.
애플리케이션 건강은 loopback으로, peer 도달성은 다른 tailnet 기기에서 확인하세요.

## 자체 TLS(선택)

내장 PKCS#12 HTTPS는 macOS 15 이상에서만 지원합니다. macOS 13–14에서는 위의 private
Tailscale Serve 경로를 사용하세요.

1. 인증서 CN/SAN이 가리키는 이름을 private network에서만 Mac으로 해석되게 합니다.
2. `pilot.p12`와 `pilot.cer`를 `~/Library/Application Support/CmdPilot/tls/`에 둡니다.
3. 암호를 Keychain에 저장하고 헬퍼를 재시작합니다.

```bash
./script/configure-secrets.sh tls
./script/macpilotctl.sh restart

host="control.example.com"
curl --fail --resolve "$host:443:127.0.0.1" "https://$host/" >/dev/null
```

인증서와 개인키, PKCS#12 암호, 실제 도메인·tailnet 주소는 저장소에 커밋하지 않습니다.

## 선택적 로컬 에이전트 통합

세션 검색·원격 결정 기능은 공개 기본값에서 비활성이고 PIN 페어링이 필수입니다. 앱 설치 후
loopback endpoint와 토큰을 로컬 설정/Keychain에 등록합니다.

```bash
./script/configure-secrets.sh omni http://127.0.0.1:8765
./script/macpilotctl.sh restart
```

토큰은 브라우저에 전달되지 않으며 `integrations.plist`에는 loopback URL만 기록됩니다.
로컬 서비스 요청은 시스템 proxy/PAC를 쓰지 않고 HTTP redirect도 따르지 않아 토큰이 다른 주소로
전달되지 않습니다.
