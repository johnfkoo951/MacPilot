# CONNECTION — 폰에서 어떻게 닿는가, 안 될 때 무엇을 보는가

> 설계 배경·대안 비교는 [CONNECTION_RESEARCH.md](CONNECTION_RESEARCH.md).
> 이 문서는 **운영 런북**이다: 지금 어떤 경로로 서비스되고 있고, 끊겼을 때 어디부터 보는가.

## 지금 쓰는 경로

```
폰 (Tailscale ON)
  │  https://pilot.cmdspace.work
  │  DNS A레코드 = 이 맥의 Tailscale IP (100.x.x.x, CGNAT 대역)
  ▼
CmdPilot Helper (:443)  ← Let's Encrypt 인증서로 앱이 직접 TLS 종단
  │  App Support/CmdPilot/tls/pilot.p12  (acme.sh 발급, 갱신 훅이 헬퍼 재시작)
  ├─ :8766  평문 HTTP/WebSocket (LAN·로컬)
  └─ :80    평문 (리다이렉트/LAN)
```

| 항목 | 값 |
|---|---|
| 주소 | `https://pilot.cmdspace.work` |
| 도달 조건 | **폰에 Tailscale이 켜져 있을 것** (tailnet 전용 — 공개 인터넷에 열려 있지 않다) |
| 인증서 | acme.sh → Let's Encrypt, `~/.acme.sh/pilot.cmdspace.work_ecc/` |
| 왜 HTTPS인가 | iOS는 DeviceMotion/Orientation을 secure context에서만 허용 — 에어마우스가 HTTPS를 요구한다 |
| 앱 인증 | **없음**. 방어선은 네트워크 계층(tailnet 신원)이다 |

`https://<맥이름>.<tailnet>.ts.net` (tailscale serve) 경로도 대안으로 있으나
현재 serve 설정은 비어 있고, 커스텀 도메인 + 앱 :443이 생산 경로다.

## 안 될 때 — 순서대로

### 0. 맥에서 자기 Tailscale IP로 테스트하지 말 것 (오탐)

```bash
curl https://100.125.183.54        # ← 실패해도 정상. 하이핀 불가.
tailscale ping 100.125.183.54      # → "is local Tailscale IP"
```
Tailscale은 자기 자신의 tailnet 주소로 도는 트래픽을 루프백하지 않는다.
맥에서 서버 건강을 확인하려면 **loopback + 올바른 호스트명(SNI)** 으로:

```bash
curl -s -o /dev/null -w '%{http_code} · TLS %{ssl_verify_result}\n' \
  --resolve pilot.cmdspace.work:443:127.0.0.1 https://pilot.cmdspace.work
# 기대: 200 · TLS 0
```

### 1. 헬퍼가 "살아 있는데 서빙은 안 하는" 상태인가 ← 실제로 물린 사례

```bash
bash script/watchdog.sh check      # 🟢/🔴 한 줄
./script/macpilotctl.sh status     # HTTP: ok / unavailable
```

2026-08-10에 헬퍼가 **34시간 동안** 8766·80·443 소켓을 쥔 채 accept를 하지
않았다. 프로세스는 살아 있었으므로 LaunchAgent `KeepAlive`는 개입하지 않았고
(keepalive는 '프로세스 존재'만 본다), 폰에서는 그냥 접속이 안 됐다.
로컬 `curl 127.0.0.1:8766`도 실패한다는 것이 결정적 증거다 — 네트워크가
아니라 프로세스 문제라는 뜻.

```bash
./script/macpilotctl.sh restart    # 수동 복구
```

**자동 복구**: `script/watchdog.sh`가 5분마다 로컬 HTTP를 찔러 무응답이면
재시작하고 OmniControl 브리핑으로 알린다. 등록은 OmniControl 스케줄러가 한다
(스케줄러를 한 벌로 유지):

```bash
cmux-voice schedule status cmdpilot-watchdog
cmux-voice schedule logs   cmdpilot-watchdog
tail ~/Library/Logs/CmdPilot/watchdog.log    # 재시작 이력
```

### 2. 폰 쪽

- 폰의 **Tailscale이 켜져 있는가** (셀룰러여도 tailnet이면 된다)
- `tailscale status`에 폰이 보이는가: `tailscale status | grep -i iphone`
- 폰 브라우저 캐시 — 주소창에 직접 입력해 볼 것

### 3. 인증서 만료

```bash
openssl x509 -in ~/.acme.sh/pilot.cmdspace.work_ecc/fullchain.cer -noout -enddate
```
만료가 임박하면 acme.sh가 갱신하고 훅이 헬퍼를 재시작한다. 갱신 후에도
443이 옛 인증서를 물고 있으면 헬퍼 재시작.

### 4. 맥이 자거나 lid가 닫혔는가

헬퍼는 맥이 깨어 있을 때만 서빙한다. 원격에서 계속 필요하면 카페인/전원 설정.

## 관련

- OmniControl `config.mobile_url` — needs_input/error Telegram 메시지에 이 주소를
  붙여 "푸시 → 탭 → 승인" 루프를 만든다. 주소가 바뀌면 거기도 같이 바꿀 것.
- OmniControl `cmux-voice doctor` — 모바일 경로(로컬 헬퍼) 점검 1행 포함.
