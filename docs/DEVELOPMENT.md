# CmdSpace Pilot — 개발 현황 기술 문서 (2026-07-03 스냅샷)

> 최종 갱신: 2026-07-03 (커밋 `09038cf` 기준)
> 업스트림: joonlab/MacPilot (MIT)의 CMDSPACE 브랜드 포크
> 이후 아키텍처와 운영 규칙은 [AGENTS.md](../AGENTS.md), 최신 기능은 [CHANGELOG.md](../CHANGELOG.md)가 정본이다.

## 1. 제품 개요

Mac을 폰 브라우저에서 조작하는 무선 트랙패드 / 키보드 / Stream-Deck.

- Mac 쪽: 메뉴바 상주 Swift 헬퍼(`LSUIElement`)가 LAN에서 HTTP + WebSocket 서버 구동 (기본 **포트 8766**)
- 폰 쪽: 브라우저로 URL을 열면 바닐라 HTML/JS 웹 클라이언트가 서빙됨. 별도 앱 설치 불필요 (PWA 홈 화면 추가 지원)
- 제스처/탭 입력이 플랫 JSON 명령으로 WebSocket을 타고 넘어오면, Mac이 Quartz Event Services(`CGEvent`)로 실제 입력을 주입
- 의존성 제로: SwiftPM 패키지 없음, JS 라이브러리 없음, 프레임워크 없음
- LAN 전용·무인증 (신뢰된 홈/사무실 네트워크 전제)

## 2. 개발 타임라인 (커밋 이력)

| 커밋 | 내용 |
|---|---|
| `c0c1a9a` | 초기 구현 — 트랙패드, 키보드, Stream-Deck 덱, 매크로 |
| `1f71afa` | 시스템 컨트롤(볼륨·밝기, HID 미디어 키) + deploy.sh 안정 서명 |
| `d178936` | 좌/우 클릭 버튼 + 길게 눌러 드래그 |
| `234acd8`~`8add4bd` | README 데모 영상(GIF/mp4, R2 호스팅) |
| `88ada37` | **CmdSpace Pilot 리브랜딩** — 네이티브 메뉴 UI 전면 개편, 모션 파이프라인, 서버 제어(macpilotctl.sh, build_and_run.sh), AGENTS.md/CLAUDE.md |
| `4a8e2d4` | CMDS 브랜딩 자산, **PWA 홈 화면 앱**(manifest + 아이콘), 적응형 네트워크 프리셋, **TCP_NODELAY** 지연 개선 |
| `3db1895` | **에이전트 탭** 신설, 퀵바, 시트 디텐트, 네이티브 SVG 아이콘, 지연 폴리싱 |
| `d866eb0` | 화면 모드 선택(자동/폰/태블릿) + 갤럭시(Android) 대응 |
| `5173fd8` | **cmux 원격 브리지** — 폰에서 cmux 창·워크스페이스·탭 전환 (`CmuxBridge.swift`) |
| `09038cf` | 에이전트 탭 표시 중 4초 자동 갱신 (변경 없으면 리렌더 생략) |

## 3. 아키텍처

두 반쪽이 WebSocket 하나로 플랫 JSON 명령을 주고받는다.

```
[폰 브라우저: index.html + app.js (~1,200줄)]
        │  HTTP GET → 정적 파일 서빙 (App Support 오버라이드 우선, 그 다음 번들)
        │  WS Upgrade → JSON 명령 스트림
        ▼
[HelperServer (NWListener :8766, TCP_NODELAY + .responsiveData)]
        ├─ getDeck / saveDeck → DeckStore (deck.json 서버측 단일 저장소)
        ├─ getApps            → AppList (설치 앱 스캔 + 아이콘 캐시)
        ├─ cmux               → CmuxBridge (동사 화이트리스트 검증)
        └─ 나머지 전부        → EventInjector (단일 직렬 큐에서 CGEvent 주입)
```

### 3.1 Mac 측 소스 (`MacHelper/Sources/`, 총 ~1,600줄)

| 파일 | 줄수 | 역할 |
|---|---|---|
| `HelperServer.swift` | 246 | NWListener :8766. 연결 수락, `InboundCommand` 디코드·라우팅. `@Published` 진단(클라이언트 수, 명령 수, 접근성 상태 — 1.5초 폴링) |
| `HTTPWebSocketConnection.swift` | 274 | 수제 HTTP/1.1 + WebSocket (핸드셰이크, 프레임 파싱/조립). 정적 파일 서빙 + `Upgrade:` 처리 |
| `EventInjector.swift` | 302 | 입력 합성 유일 지점. 단일 직렬 큐로 드래그 상태·이벤트 순서 보장. `move/down/up/click/scroll/key/text/macro/launch/gesture/zoom/volume/brightness` 디스패치. 소켓 끊기면 `releaseAll()` |
| `InboundCommand.swift` | 40 | **와이어 계약** — 전 필드 옵셔널의 플랫 Decodable 구조체 + `MacroStep`. app.js 와 반드시 동기 유지 |
| `CmuxBridge.swift` | 164 | cmux CLI/RPC 브리지 (아래 §4) |
| `DeckStore.swift` | 24 | 덱 JSON을 `~/Library/Application Support/CmdPilot/deck.json`에 원문 저장. Mac이 단일 저장소 → 모든 기기가 한 덱 공유 |
| `AppList.swift` | 54 | 설치 앱(경로·이름·아이콘) 스캔, 덱 launch 액션 피커용 |
| `MediaKeys.swift` / `SpaceSwitcher.swift` | 33/100 | HID 미디어 키(볼륨·밝기) / 3손가락 스와이프 → Mission Control·스페이스 전환 |
| `MenuContentView.swift` | 316 | SwiftUI 메뉴바 UI — URL·QR, 권한 안내, 진단, 서버 제어 |
| `CmdPilotHelperApp.swift` / `NetworkInfo.swift` | 17/40 | 앱 엔트리 / mDNS `.local`·IPv4 주소 해석 |

### 3.2 폰 측 (`MacHelper/Web/`)

- `index.html`(155줄) + `style.css`(237줄) + `app.js`(1,206줄), 프레임워크·빌드 스텝 없음
- 탭 구성: 트랙패드 · 키보드 · 덱(Stream-Deck) · **에이전트**(cmux 원격) + 퀵바
- PWA: `manifest.webmanifest` + 180/192/512 아이콘 → 홈 화면 앱 설치 가능
- 화면 모드: 자동/폰/태블릿 수동 선택, Android(갤럭시) 터치 이벤트 대응
- 시트 디텐트 UI, 네이티브 SVG 아이콘, 적응형 네트워크 프리셋(지연에 따른 move 이벤트 스로틀)
- 에이전트 탭 표시 중 4초 주기 cmux 상태 폴링 (상태 불변 시 리렌더 생략)
- 덱 동기화: 접속 시 서버 덱에 `folders`가 있으면 서버 우선 (폰 localStorage 캐시보다 우선)

## 4. cmux 원격 브리지 (최근 작업의 핵심)

> 📖 전체 딥다이브(인증 self-heal 시퀀스, "권한 순서" 문답, RPC 매핑)는 **`docs/CMUX_BRIDGE.md`** 참조. 아래는 요약.

폰의 에이전트 탭에서 Mac의 cmux(터미널 멀티플렉서) 창/워크스페이스/탭을 전환·모니터링한다. 탭 제목에 에이전트 상태가 실려 있어 원격에서 Claude Code 등 에이전트 진행 상황 확인이 목적.

- **보안 설계**:
  - cmux/터미널/세션 통합은 PIN 페어링과 현재 인증 epoch가 유효한 연결에서만 처리
  - 동사 화이트리스트만 처리: `state` / `select-workspace` / `focus-window` / `focus-tab` / `open-notif` / `statuses`
  - 대상 인자는 UUID 형식만 통과, 셸 미경유(Process 인자 배열 직접 전달) — 임의 명령 실행 불가
  - cmux 소켓 패스워드의 정본은 macOS Keychain이며, self-heal 때 권한 `0600`인 cmux 설정에 일시 미러
- **상태 페이로드**: `list-windows` + 창별 `list-workspaces` + `mobile.workspace.list` + 알림을 합쳐 `windows[]`, `tabs[]`, `sessions[]`, `notifications[]`로 회신
- **실행 안전장치**: CLI 호출 2초 타임아웃, 파이프 비동기 읽기, 프롬프트를 남기지 않는 진단 로그 `/tmp/cmdpilot-cmux.log`

## 5. 와이어 프로토콜

단일 플랫 JSON 오브젝트, 필드 전부 옵셔널 (`InboundCommand.swift`가 진실의 원천):

| `t` | 방향 | 의미 |
|---|---|---|
| `move` / `down` / `up` / `click` / `scroll` | 폰→Mac | 포인터 |
| `key` / `text` | 폰→Mac | 키 입력 / 문자열 타이핑 |
| `macro` | 폰→Mac | `MacroStep` 배열 순차 실행 |
| `launch` | 폰→Mac | 앱 실행 |
| `gesture` / `zoom` | 폰→Mac | 스페이스 전환 / 핀치 줌 |
| `volume` / `brightness` | 폰→Mac | 시스템 HID 키 |
| `getDeck` / `saveDeck` | 양방향 | 덱 동기화 |
| `getApps` | 양방향 | 설치 앱 목록 |
| `cmux` (`dir`=동사, `target`=UUID) | 양방향 | cmux 브리지, 상태·알림·워크스페이스 전환 |
| `cterm` | 양방향 | 현재 터미널 컬러 grid 읽기·입력 |
| `csess` | 양방향 | UUID 타깃 세션 read/send/허용 키 전송 |
| `omni*` | 양방향 | Keychain 토큰을 쓰는 선택적 loopback 상태·검색·결정 프록시 |

## 6. 빌드·배포·운영

```bash
xcodegen generate              # 파일 추가/삭제 후 필수 (프로젝트는 project.yml 정의, .xcodeproj 비체크인)
./deploy.sh                    # Release 빌드 → ~/Applications 설치 → launchd 에이전트 재시작
./script/macpilotctl.sh        # status|start|stop|restart|logs|open|url|install|sync-web|unsync-web
./script/macpilotctl.sh sync-web   # 웹만 고칠 땐 rsync → 재빌드 불필요
```

- **웹 오버라이드**: 서버는 `~/Library/Application Support/CmdPilot/web/`을 번들보다 우선 서빙 → 웹 수정 시 재빌드 회피. ad-hoc 서명 환경에서는 권한 리셋도 피할 수 있음
- **프로토콜 변경 배포**: Swift와 웹 와이어 계약을 함께 바꿨다면 `deploy.sh` 사용. 기존 웹 override도 새 소스로 동기화한 뒤 재시작
- **서명 전략**: deploy/package 스크립트가 `CODESIGN_IDENTITY` → 유일한 Apple Development → 유일한 유효 identity 순으로 선택합니다. 후보가 여러 개면 명시값을 요구합니다. identity가 없을 때는 Keychain ACL·접근성 권한 단절을 피하려고 기본 실패하며, 임시 빌드만 `ALLOW_ADHOC_SIGNING=1`로 명시할 수 있습니다.
- **launchd**: 상시 서버. plist 없으면 deploy.sh가 자동 생성. Xcode 실행과 동시 구동 금지(포트 충돌)
- 버전은 `project.yml`의 `MARKETING_VERSION`. 번들 ID `com.cmdspace.cmdpilot.helper`

## 7. 런타임 요구사항 (주의점)

1. **접근성 권한** — 없으면 CGEvent 주입이 조용히 무시됨. 1.5초 주기로 권한 상태 폴링해 메뉴 UI에 표시
2. **동일 Wi-Fi + Mac 깨어 있음** — 안내 URL은 mDNS `.local` 이름 사용(IP 변경에 강함), IPv4 폴백

## 8. 남은 과제 / 알려진 제약

- 기본 원격 입력은 신뢰 LAN/사설 tailnet 전용이며, 공용 네트워크에서는 PIN 페어링 필수
- 세션 통합은 네트워크와 무관하게 PIN 페어링이 켜져야 동작
- 테스트 스위트·린터 없음
- cmux 브리지는 cmux 앱 경로(`/Applications/cmux.app`) 하드코딩, 소켓 password 모드 필요
- 웹 자산은 번들 리소스 → 폰 반영엔 재배포 또는 sync-web 필요
