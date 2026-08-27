# 연결 방식 연구 — "다른 방식으로 연결할 수 있나?"

> 폰↔Mac 연결 전송을 대안까지 확장 검토. 5개 전략을 병렬 조사 + 적대적 검증(각 전략의 핵심 주장을 회의적으로 재검토).
> 방법: 서브에이전트 5(조사) + 5(검증), 웹 확인 포함. 아래 판정은 **검증 통과본**이며, 검증이 뒤집은 주장은 `⚠️ 검증 교정`으로 표기.
> 컨텍스트: 터미널 멀티플렉서 비교 — tmux·Zellij·Herdr·Cmux·Orca·Warp·Ghostty.
> 상태: **과거 설계 연구 스냅샷**. 현재 구현은 same-origin+Host 검증과 PIN epoch 검증을 포함하므로 운영 기준은 `docs/CONNECTION.md`를 따른다.

---

## 0. 한 줄 결론

**"더 멀리서 연결하기"는 사실 전송(transport) 문제가 아니라 인증(auth) 문제다.**
MacPilot은 **무인증 `CGEvent` 주입기** — LAN 밖으로 노출되는 순간 원격 키보드·마우스·앱실행·매크로 =
사실상 **원격 RCE 등가**다. 그래서 모든 "다른 연결 방식"은 **딱 하나의 선행조건**을 공유한다: *인증 하드닝*.
그리고 **제로 의존성 + 앱 없음(브라우저)** 이라는 정체성이 화려한 전송(WebRTC·BLE HID·Multipeer)을 전부 탈락시킨다.

```
지금 해야 할 일 우선순위:
  ① 인증 하드닝        ← 모든 원격 확장의 전제조건. 싸고, 제로 의존성, 지연 0.
  ② Tailscale 유지     ← 이미 채택한 1차 원격 경로 = 무인증 도구의 정답.
  ③ (선택) CF Tunnel+Access ← "폰에 Tailscale 없이 아무 셀룰러 브라우저" 4번째 모드. ①이 전제.
  ─ 보류: SSH로 원격 cmux 릴레이 (수요 미검증)
  ✗ 스킵: WebRTC / BLE HID / Multipeer (제로 의존성·앱 없음 붕괴)
```

---

## 1. 현재 연결 스택 (기준선)

| # | 경로 | 프로토콜 | 도달 범위 | 용도 |
|---|---|---|---|---|
| 1 | mDNS `http://<mac>.local:8766` | `ws://` | 같은 LAN | 기본 |
| 2 | `tailscale serve` → `https://<mac>.<tailnet>.ts.net` | `wss://` | tailnet 멤버 | 원격 + secure context |
| 3 | 앱 `:443` + 유효 인증서(예: `control.example.com`) | `wss://` | private network 전용 | 에어마우스(iOS 모션) 경로 |
| (aux) | `:80` 보조 리스너 | `ws://` | 포트 없는 주소용 | 선택 |

- `app.js`는 페이지가 `https:`면 자동으로 `wss`, 아니면 `ws` 선택(코드 변경 없이 전송이 따라옴).
- 보안 현황: **기본 무인증.** 선택적 6자리 PIN 페어링(`Pairing.swift`, **기본 OFF**)만 존재.
- 오늘의 실질 방어선은 앱 인증이 아니라 **네트워크 계층**(LAN + WireGuard tailnet 신원).

---

## 2. 모든 전략이 통과해야 하는 3개 필터

1. **제로 의존성** — SwiftPM 패키지 금지, JS 라이브러리 금지. (외부 CLI/서비스는 허용 — tailscale를 이미 씀.)
2. **앱 없음** — 폰은 브라우저 페이지/PWA. 네이티브 앱을 요구하는 전송은 정체성 붕괴 + Android 배제 위험.
3. **무인증 주입기 = RCE** — 도달 범위를 넓히는 모든 것은 인증 하드닝을 **선행**해야 한다.

---

## 3. 전략별 판정 (검증 통과본)

| 전략 | 조사 | 검증 후 | 공수 | 핵심 |
|---|---|---|---|---|
| **메시 VPN** (Tailscale/WireGuard) | 🟢 강력 | 🟢 **강력** | S | 이미 채택. 무인증 도구의 원격 정답. |
| **인증 하드닝** (native의 절반) | 🟡 보통 | 🟢 **즉시 권고** | M | 리스트에서 **지금 유일하게 가치 있는 실행 항목**. |
| **공개 터널** (CF Tunnel + Access) | 🟡 보통 | 🟡 **조건부** | M | 진짜 신규 4번째 모드. 단 ①이 전제 + 함정 있음. |
| **원격 cmux (SSH 릴레이)** | 🟢 강력 | 🟡 **보류** | L | 모델 B 확장으로 그럴듯하나 수요 미검증 + 함정. |
| **WebRTC** | 🔴 약함 | 🔴 **불가** | L | 제로 의존성 정면 위반. LAN 지연 이득 sub-perceptual. |
| **전송-우회** (BLE HID·Multipeer·Continuity) | — | 🔴 **불가** | — | 앱 없음·제로 의존성·Android 붕괴. |

---

## 4. 전략별 상세

### 4.1 🟢 메시 VPN을 전송계층으로 — *이미 정답, 유지*

WireGuard 기반 오버레이(Tailscale) 위로 평문 ws/http를 흘리면:
- **wire E2E 암호화**(ChaCha20-Poly1305) — 무인증 노출의 신뢰경계가 "같은 Wi-Fi 아무나" → "내 tailnet에 명시적으로 추가한 기기"로 축소.
- **MagicDNS** `<mac>.<tailnet>.ts.net` — IP 로밍에도 불변, LAN `.local`보다 이름 안정성 우수.
- 같은 LAN의 tailnet 피어는 **직결(WireGuard p2p)** 협상 → 지연 오버헤드 무시 수준. DERP 릴레이는 NAT 홀펀칭 실패 시 폴백일 뿐.
- **제로 의존성 완벽 부합** — 앱 코드 0줄, tailscale는 외부 CLI.

> ⚠️ **핵심 뉘앙스**: wire 암호화 ≠ secure context. tailnet 위 `ws://...:8766`도 `window.isSecureContext=false`라
> **iOS DeviceMotion/Orientation(에어마우스)이 차단**된다 → HTTPS(경로 2·3)가 여전히 별도로 필요.
> **Funnel은 절대 금지**(무인증 서버를 공개 노출 = ③의 함정). 직접 WireGuard/Nebula는 1인·1폰 용도에서 이점 없음(굳이 SaaS 의존을 끊으려면 Headscale만 고려).

### 4.2 🟢 인증 하드닝 — *지금 할 일*

현 `Pairing.swift` 위에 얹는 최소 강화(전부 **CryptoKit = SDK 내장 → 제로 의존성**, 정상상태 지연 0):

| 갭 (코드 검증됨) | 하드닝 |
|---|---|
| 토큰 = `SHA256("macpilot-pair-v1:"+PIN)` → 엔트로피 **10⁶뿐**, per-install 시크릿 없음 | **per-install 랜덤 시크릿으로 HMAC** 토큰 |
| `/pair`에 rate-limit·lockout **없음** | 시도 제한 + 지수 백오프 |
| WS 핸드셰이크에 **Origin 검증 전무**(`sec-websocket-key`만 확인) | **Origin 화이트리스트** (DNS-rebinding/cross-origin WS 차단) |
| 쿠키 Max-Age 1년, 회전·디바이스 바인딩 없음 | 쿠키 회전 + (선택) 디바이스 바인딩 |
| 수동 6자리 PIN | **QR에 1회용 페어링 토큰** 삽입(PIN 제거 + 보안 동시) |
| pairing **기본 OFF** | **공개 전송 활성 시 pairing 자동 강제** (정책 커플링) |

> ⚠️ **가장 큰 걸림돌은 코드 난이도가 아니라 운영 규율**: pairing이 default-OFF로 출하되고 오늘 방어가 네트워크 계층인 한,
> "공개 전송 켜짐 → pairing 강제 + WS Origin 검증"이라는 **정책 커플링**을 배선해두지 않으면,
> 훗날 편의로 Funnel을 켜는 순간 **조용히 무인증 RCE가 재개**된다.

### 4.3 🟡 공개 리버스 터널 (CF Tunnel + Cloudflare Access) — *조건부, ①이 전제*

Mac이 엣지로 아웃바운드 터널을 걸어 공인 인바운드를 되받는 방식(포트포워딩·공인IP 불필요).
**"폰에 Tailscale 필수" 마찰을 제거** → 아무 셀룰러 브라우저에서 동작. 기존의 **검증된 커스텀 도메인 인프라를 재사용**할 수 있다.

- **CF Tunnel(무료·무제한 대역폭)** + **CF Access(≤50명 무료, Email OTP/Google/GitHub OAuth)** = 요청이 `:8766`에 닿기 **전에 엣지에서 선인증**. `CF_Authorization` 쿠키가 same-origin이라 WS 핸드셰이크에도 실림.
- **제로 의존성 유지**: 웹/Swift 0줄(app.js가 https→wss 자동), cloudflared는 외부 바이너리(tailscale와 동급), Access는 엣지 설정.

> ⚠️ **검증 교정 3건 (이거 모르면 삽질):**
> 1. **함정 — CF Access 세션 만료가 wss를 죽인다**: Access는 *최초 내비게이션*만 게이트하지만 조종은 *지속 wss 스트림*에 의존. 세션(기본 24h) 만료 시 살아있던 WebSocket이 조용히 끊기고, 재연결 핸드셰이크는 로그인으로 302되는데 **JS WS 클라이언트는 대화형 OAuth 리다이렉트를 못 따라간다** → 사용 도중 트랙패드가 죽고 페이지 리로드+재인증 강요. "아무 폰이나 집어 바로 조종"을 정면으로 깎는다.
> 2. **cloudflared는 "무설정"이 아니다**: Tunnel 기본 QUIC 전송이 WS `Upgrade` 헤더를 제거(→400)하는 문서화된 실패모드 → `--protocol http2` 지정 필요. (CDN/프록시 층의 WS 기본 on과 Tunnel 경로는 다름.)
> 3. **ngrok 배제 근거 정정**: ngrok 무료도 **엣지 OAuth(월 3 MAU)**가 있다. CF를 택할 진짜 이유는 "ngrok에 OAuth가 없어서"가 아니라 (a) **무제한 대역폭**(트랙패드 move-frame 스트림이 ngrok 무료 1GB/월을 넘길 수 있음), (b) **기존 커스텀 도메인 재사용**, (c) OAuth 50 vs 3 MAU, (d) 릴레이 지연. **Tailscale Funnel은 배제**(공개 노출·내장 인증 없음·항상 릴레이 지연·README가 금지).

**하드 전제조건**: ①(인증 하드닝, 최소한 Access 앞단)이 먼저. 맨몸 무인증 서버를 공개 터널에 노출하는 순진한 형태는 **금지**.

### 4.4 🟡 원격 cmux (SSH 릴레이) — *보류*

`CmuxBridge`의 화이트리스트 동사를 로컬 cmux 소켓 대신 `ssh remote -- cmux ...`로 프록시 → 폰에서 **클라우드 개발 박스의 cmux/Herdr/Orca 멀티플렉서**까지 조종(**모델 B**: 원격 에이전트 제어의 자연스러운 다음 단계). 시스템 `ssh` shell-out이라 제로 의존성 유지.

> ⚠️ **검증 교정 2건:**
> 1. **지연 "수십 ms"는 틀림**: 명령마다 새 SSH 연결이면 WAN 콜드 핸드셰이크(TCP 3-way + KEX + pubkey)가 **150ms~1s+**. 진짜 1-RTT를 원하면 **SSH ControlMaster/ControlPersist 멀티플렉싱** 필수(설계에 없었음). 게다가 `CmuxBridge.exec`의 **2초 타임아웃**을 콜드 SSH가 넘겨 헛-타임아웃을 유발할 수 있음.
> 2. mosh의 UDP+SSP·예측 로컬에코는 **이식 불가**(브라우저 raw UDP 불가). 그 목적(로밍·저지연 복구)은 MacPilot 모델 A가 이미 **델타 coalescing + RTT 적응 tier + 자동 재연결(1s) + `releaseAll()`**로 흡수. 잔여 가치는 재연결 시 held-modifier를 keyframe으로 리셋하는 초경량 폴리시 정도.

**하드 걸림돌**: "무인증 LAN 폰 → 원격 클라우드 서버 구동"이라는 **신규 공격면**은 비용이 실재·즉시(L + PIN 강제 + known_hosts/키 관리 + 원격측 화이트리스트 미러 + ControlMaster)인데, 효용("폰으로 원격 워크스페이스 전환")은 **수요 미검증·가설적**. → 실수요가 확인되면 착수.

### 4.5 🔴 WebRTC — *도입 불가 (좁은 예외 1개)*

- **제로 의존성 정면 위반**: 브라우저는 네이티브 `RTCPeerConnection`(JS 0)이지만, **macOS SDK에 공개 WebRTC 프레임워크가 없다** → Mac 피어는 **libwebrtc(수백MB C++ xcframework)** 또는 Pion/webrtc-rs 사이드카 강제 = 프로젝트가 취할 수 있는 **최대 단일 의존성**.
- **LAN 지연 이득 sub-perceptual**: 손실 0이라 TCP HOL blocking 없음 + Nagle은 이미 껐음(`noDelay=true`). UDP DataChannel 이점은 손실 큰 WAN/셀룰러에서만.
- **NAT 트래버설 존재 이유 없음**: 폰이 이미 Mac에 직접 도달(웹클라이언트·시그널링 모두 그 채널).

> ⚠️ **검증 교정**: "Network.framework가 DTLS를 못 한다"는 **틀림** — `NWParameters(dtls:)`로 DTLS는 1급 지원(WWDC18). 그래도 결론은 유지 — 진짜 차단막은 **SCTP 부재 + ICE + libwebrtc 상호운용**. "GoogleWebRTC pod 2021 아카이브"도 연·표현 부정확하나 "공식 pod은 죽었고 libwebrtc/사이드카 강제"는 성립.

**유일한 재검토 여지**: 화면 미러링을 MJPEG(intra-only) → **H.264 하드웨어 인코딩 WebRTC 비디오 트랙**으로 승격(대역폭·유창성 대폭 개선). 단 미러링이 1급 기능이 되고 zero-dep을 **명시적으로 완화**할 때만.

### 4.6 🔴 전송-우회 (BLE HID · Multipeer · Continuity) — *불가*

- **BLE HID**: iOS Safari에 **Web Bluetooth 자체가 없음**(Apple 2020.6 프라이버시 사유 거부, 2026 현재도 부재). 게다가 **iOS는 앱이 HID 주변기기로 광고 불가**(HID 호스트지 peripheral 아님) → 아이폰을 BT 키보드/마우스로 쓰려면 **외부 브리지 HW(ESP32/InputStick)** 필요.
- **Multipeer/Continuity**: **네이티브 iOS 앱 강제** → "앱 없음" 붕괴 + **Apple 전용**(Android 배제). Universal Control은 **아이폰 미지원**(Mac+iPad 전용).

> ⚠️ **검증 교정**: Bluefy/WebBLE 등 자체 BLE 스택 번들 서드파티 브라우저는 실재하나 (a) 별도 앱 = no-app 붕괴, (b) Web Bluetooth는 브라우저에 BLE *central* 역할만 줄 뿐 폰을 HID *peripheral*로 못 만듦 → 전송-우회는 오히려 **더 확실히 죽어 있음**. 또 BLE connection interval(7.5~15ms+)이 TCP_NODELAY LAN Wi-Fi RTT(~1~5ms)보다 **흔히 더 느려** 지연 이점조차 없음.

---

## 5. 터미널 비교표 → MacPilot 매핑

비교한 7개 앱에서 뽑은 "원격 연결 패턴"을 CmdPilot의 두 모델에 대응:

| 앱 | 원격 방식 | MacPilot 대응 | 이식 가치 |
|---|---|---|---|
| tmux / Zellij | Unix 소켓 + SSH attach | 모델 B (원격 멀티플렉서) | SSH 릴레이 패턴 = §4.4 |
| **Herdr** | thin-remote (소켓 원격 노출) | 모델 B | §4.4의 직접 청사진 |
| **Cmux** | 로컬 socket + CLI | **이미 CmuxBridge로 구현(로컬판)** | 원격 확장 = §4.4 |
| **Orca** | CLI + RPC | 모델 B | §4.4와 동일 계열 |
| **Warp** | 클라우드 릴레이(Warp Drive) | 모델 A/B "어디서나" | **중복** — Tailscale/wss가 이미 해결 |
| mosh | UDP + SSP + 예측 에코 | 모델 A (저지연 스트림) | 전송은 이식 불가(§4.4), 목적은 이미 흡수 |
| Ghostty | 멀티플렉서 아님(+ssh 래퍼) | — | 해당 없음 |

**요지**: 이식 가치가 있는 단 하나의 패턴은 **"로컬 제어 소켓/CLI/RPC를 SSH로 원격 노출"**(Herdr/cmux/Orca 계열). 이미 `CmuxBridge`가 그 로컬판이라, 원격 SSH 릴레이가 자연스러운 확장이다 — 단 §4.4의 함정(ControlMaster·2초 타임아웃·공격면)과 수요 검증이 선결.

---

## 6. 권고 요약

1. **지금**: 인증 하드닝(§4.2). 싸고 제로 의존성이며 **다른 모든 원격 확장의 전제**. 특히 "공개 전송 켜짐 → pairing 강제 + WS Origin 검증" **정책 커플링**을 반드시 배선.
2. **유지**: Tailscale를 1차 원격 경로로(§4.1). 에어마우스 secure context는 경로 2·3(HTTPS)로. **Funnel 금지**.
3. **선택(①후)**: CF Tunnel + Access(§4.3)로 "폰에 Tailscale 없이 아무 셀룰러 브라우저" 4번째 모드. 세션 만료→wss 끊김, `--protocol http2` 함정 인지.
4. **보류**: 원격 cmux SSH 릴레이(§4.4) — 실수요 확인 시.
5. **스킵**: WebRTC(§4.5, 미러링 H.264 예외만) · BLE HID/Multipeer/Continuity(§4.6).

> 다음 액션이 필요하면: `docs/ROADMAP.md`의 "LAN 무인증" 항목을 이 §4.2 하드닝 체크리스트로 확장하거나,
> CF Tunnel+Access PoC(§4.3)를 `script/`에 토글 스크립트로 뽑을 수 있음 — 말씀 주세요.
