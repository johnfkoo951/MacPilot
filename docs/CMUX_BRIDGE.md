# cmux 원격 브리지 — 기술·기능 정리

> 이 앱이 cmux를 어떻게 연동하는지, 그리고 "권한을 받으려면 뭘 먼저 켜야 하나?"에 대한 답.
> 소스: `MacHelper/Sources/CmuxBridge.swift` · `HelperServer.swift` · `MacHelper/Web/app.js`
> 관련: `docs/DEVELOPMENT.md` §4 (요약본), 이 문서는 그 확장판.

---

## 0. 한 줄 요약

폰의 **에이전트 탭**에서 Mac의 [cmux](https://cmux.io)(GUI 에이전트 터미널)를 원격 조종한다 —
창·워크스페이스·탭을 칩으로 보고 한 번에 전환하고, 포커스된 터미널 화면을 텍스트로 미러링하며
문구를 타이핑까지 넣는다. Claude Code 등 **에이전트가 도는 창을 폰에서 확인·전환**하는 게 목적.

CmdPilot은 cmux의 **CLI/RPC**(`cmux rpc ...`)를 직접 호출하는 **외부 자동화 클라이언트**다.
별도 SDK 없이 `Process`로 CLI를 때리고, 응답 JSON을 폰으로 중계한다.

---

## 1. "권한을 받으려면 모바일 앱을 먼저? cmux를 먼저?" — 정확한 답

### 먼저 오해 정정: 이 권한은 **폰과 무관**하다

여기서 말하는 "권한"은 **Mac 안에서 `CmdPilot 헬퍼` ↔ `cmux 자동화 소켓` 사이의 인증**이다.
폰(모바일)은 그냥 브라우저 페이지이고, cmux 소켓 인증에는 **아무 역할이 없다.**
폰을 먼저 켜든 나중에 켜든, 심지어 폰이 아예 없어도 이 권한은 Mac 쪽에서 이미 성립한다.
(별도의 "모바일 앱"도 없다 — 폰은 브라우저 페이지/PWA일 뿐.)

### 왜 "순서" 문제가 생기나 — cmux의 소켓 모드

| 모드 | 누가 소켓을 조종할 수 있나 | CmdPilot 헬퍼는? |
|---|---|---|
| `cmuxOnly` (**기본값**) | cmux 자신이 띄운 **자식 프로세스만** | ❌ 외부라서 `Access denied` |
| `password` | 올바른 소켓 패스워드를 제시하는 **누구나** | ✅ 패스워드로 인증 |

CmdPilot 헬퍼는 cmux의 자식이 아니라 **독립 프로세스**다. 그래서 `password` 모드 +
소켓 패스워드가 있어야만 cmux를 조종할 수 있다.

### cmux가 스스로 인증을 깨뜨리는 지점 (self-heal이 필요한 이유)

cmux는 **재시작할 때** `~/.config/cmux/cmux.json`의 `automation.socketPassword`를
**지우고 키체인으로 옮겨버린다.** 결과: *"password 모드인데 파일엔 패스워드가 없음"* 상태 →
외부 프로세스는 인증 불가 → 폰 UI에 **`cmux 소켓 권한 대기 중`** 문구.

CmdPilot은 이걸 자동 복구한다:

1. 자기 소유의 **고정 패스워드**를 macOS Keychain에 보관한다. 구버전의
   `cmux-socket.pass`는 성공적으로 이전한 뒤 삭제한다.
2. 헬퍼 시작 시 `warmUp()` → cmux.json이 그 값과 다르면 다시 써넣는다(`ensureConfigured`).
3. 이후에도 인증 실패를 감지하면(아래 마커) cmux.json에 패스워드를 재기입하고,
   **cmux의 파일워치가 ~1–2초 내 핫리로드** → 폰의 다음 4초 폴링에서 성공.

### 그래서 실제 정답

```
질문:  "모바일 앱 먼저? cmux 먼저?"

답:    (1) 폰은 무관하다.
       (2) 순서와 무관하게 결국 self-heal로 자동 복구된다.
       (3) 가장 확실·즉시 되는 순서 =
             ① CmdPilot 헬퍼가 먼저 떠서 cmux.json에 패스워드를 심어둔다(warmUp)
             ② 그 상태에서 cmux를 켜거나 재시작하면 → cmux가 로드 시 그 패스워드를 채택 → 바로 동작
       (4) cmux를 먼저(신선하게) 켠 경우엔 첫 폴링에서 잠깐 denied가 뜰 수 있고,
           self-heal이 도는 ~2초 뒤 자동으로 붙거나, 폰 UI 안내대로
           "cmux를 한 번 재시작"하면 확실히 활성화된다.
```

핵심: **"모바일 먼저 → cmux" 가 아니라 "CmdPilot 헬퍼가 패스워드를 심어둠 → cmux가 로드 시 채택"** 이다.
헬퍼는 launchd로 상시 떠 있으므로, 실무에선 보통 **cmux만 한 번 재시작**하면 끝난다.

### 인증 실패 감지 마커 (self-heal 트리거)

`CmuxBridge.isAuthFailure` 가 cmux stderr에서 찾는 실측 문자열:

| 마커 | 의미 |
|---|---|
| `Authentication required` / `auth_required` | 패스워드는 있는데 클라이언트가 안/틀리게 보냄 |
| `Invalid password` | 파일 값과 cmux 로드값 불일치(로테이션 직후) |
| `no socket password is configured` / `Password mode is enabled` | ★재시작으로 패스워드가 지워진 상태 — **주 트리거** |
| `Access denied` | `cmuxOnly` 모드로 되돌아간 경우 |

> ⚠️ 닭-달걀: `cmux reload-config` 자체가 인증을 요구하므로 "패스워드 없음" 상태에선 못 쓴다.
> 그래서 파일에 쓰고 **cmux 파일워치가 반영하기를 기다리는**(1.8초 sleep 후 1회 재시도) 방식을 택했다.

---

## 2. 인증 핸드셰이크 + self-heal 시퀀스

```
  CmdPilot 헬퍼                     ~/.config/cmux/cmux.json                cmux 앱
      │                                    │                                  │
 warmUp()                                  │                                  │
      │── ensureConfigured() ────────────► │  automation.socketControlMode=   │
      │   (내 pass가 없거나 다르면 기입)     │  "password", socketPassword=<내값> │
      │                                    │ ─── 파일워치 감지(~1-2s) ────────►│ 로드
      │                                    │                                  │
   폰 요청: {t:"cmux"}                      │                                  │
      │── run(["list-windows","--json"]) ─ env CMUX_SOCKET_PASSWORD=<내값> ───►│ 인증 OK → JSON
      │◄──────────────────────────────────  state JSON  ───────────────────── │
      │
      │   (cmux 재시작 → cmux.json의 pass 삭제됨)
      │── run(...) ──────────────────────────────────────────────────────────►│ "Password mode is enabled"
      │◄── stderr(auth 실패) ─────────────────────────────────────────────────│
      │── ensureConfigured()(재기입) ─────► │ ─── 파일워치 반영(~1.8s 대기) ──►│ 로드
      │── run(..., allowHeal:false) 재시도 ──────────────────────────────────►│ 인증 OK → JSON
```

---

## 3. 처리하는 명령 (동사 화이트리스트)

> 이 통합은 **PIN 페어링이 켜지고 현재 쿠키 epoch가 유효할 때만** 열린다. 그 안에서도
> 아래 동사·액션 화이트리스트만 통과한다.

### 3.1 창/워크스페이스/탭 전환 — `t:"cmux"` (`HelperServer` → `CmuxBridge.handle`)

| `dir`(동사) | 대상(`target`) | 실행하는 cmux RPC |
|---|---|---|
| `state` | — | (읽기 전용) 최신 상태 합성 후 회신 |
| `select-workspace` | UUID | `cmux rpc workspace.select {"workspace_id":…}` |
| `focus-window` | UUID | `cmux rpc window.focus {"window_id":…}` |
| `focus-tab` | UUID | `cmux rpc surface.focus {"surface_id":…}` |
| `open-notif` | UUID | `cmux open-notification --id …` |
| `statuses` | 쉼표 구분 UUID(최대 6개) | 워크스페이스별 `list-status` 조회 |

- 상태 변경 동사는 실행 후 **최신 상태를 즉시 회신**(폰 UI 낙관적 갱신).
- `target`은 **UUID 형식만 통과**(`UUID(uuidString:)`), 화이트리스트 밖 동사는 조용히 무시.
- 셸 미경유: `Process.arguments` 배열로 직접 전달 → 인젝션 불가.

### 3.2 상태 페이로드 합성 (`stateJSON`)

폰 한 번의 `state` 요청에 세 소스를 합쳐 하나의 JSON으로 회신:

```
list-windows --json                                  → 창 목록(+ key=포커스 여부)
  └ 창마다 list-workspaces --json --id-format both    → 워크스페이스(제목·색·선택·pin)
rpc mobile.workspace.list {}                          → 선택 워크스페이스의 터미널 탭(제목·포커스)
```

응답: `{ t:"cmux", available, denied, windows[], tabs[], sessions[], notifications[] }`

- `available` = cmux CLI 실행파일 존재 여부(`/Applications/cmux.app/.../bin/cmux`).
- `denied` = `list-windows` 실패(소켓 인증 불가) → 폰이 "권한 대기 중" 안내.
  성공 지점 이후엔 `denied:false`.
- **성능 가드**: `list-windows`가 실패하면 다른 명령도 죄다 타임아웃까지 hang → 더 부르지 않고
  즉시 `denied:true` 반환(폴링 4초 뒤 재시도).

### 3.3 터미널 뷰 — `t:"cterm"` (포커스된 터미널 화면 미러 + 입력)

| `action` | 실행 | 회신 |
|---|---|---|
| `grid` | `cmux rpc mobile.terminal.replay {}` | `{ t:"ctermGrid", grid:<render_grid> }` |
| `input` | `cmux rpc mobile.terminal.input {"text":…}` | (없음, 단방향) |

픽셀 화면 미러(`mirror`/ScreenStreamer)와 달리 **터미널 UI 텍스트(row_spans + styles + cursor)만**
가져오므로 가볍고 선명하다. 폰에서 친 문구는 포커스된 cmux 터미널에 그대로 들어간다.

### 3.4 세션별 원격 — `t:"csess"`

| `action` | 검증 | 동작 |
|---|---|---|
| `read` | `workspace`/`surface` scope + UUID, 10–1000줄 | 포커스를 바꾸지 않고 화면 읽기 |
| `send` | scope + UUID + 비어 있지 않은 text | 특정 세션에 프롬프트 전송 |
| `key` | scope + UUID + 허용 키 | enter/escape/ctrl+c/up/down/tab만 전송 |

---

## 4. 실행 안전장치 (`run` / `exec`)

| 항목 | 구현 | 이유 |
|---|---|---|
| 짧은 타임아웃 | `exec`가 프로세스 종료를 **2초**만 대기, 초과 시 `terminate()` | 소켓이 깨지면 CLI가 무한 hang → 브리지 큐 점유 방지 |
| 데드락 회피 | 파이프(stdout/stderr)를 **종료 대기 전에 비동기로** 읽음 | 파이프 버퍼가 차서 자식이 블록되는 고전적 데드락 방지 |
| 셸 미경유 | `Process.arguments` 배열 직접 전달 | 명령 인젝션 원천 차단 |
| 재시도 1회 | 인증 실패 시 `ensureConfigured()` 후 `allowHeal:false`로 1회만 재귀 | 무한 self-heal 루프 방지 |
| 재대기 스로틀 | 최근 6초 내 heal 대기했으면 1.8초 sleep 생략(`lastHealPoll`) | 한 state 요청이 `run`을 여러 번 부르므로 중복 대기 방지 |
| 진단 로그 | `/tmp/cmdpilot-cmux.log` | 브리지 문제 추적(프롬프트·타깃 미기록) |

직렬 큐(`com.cmdspace.cmdpilot.cmux`)에서만 CLI를 실행 → 상태 일관성 유지.

---

## 5. 폰 쪽(app.js) 동작

- **에이전트 탭**을 열면 `startCmuxPoll()` → 즉시 1회 + **4초 주기** 상태 폴링
  (`document.visibilityState === "visible"`일 때만; 백그라운드면 멈춤).
- **깜빡임 방지**: 직전 상태 JSON(`lastCmuxJSON`)과 같으면 리렌더 생략.
- UI 상태 분기(`renderCmux`):
  - `available===false` → "cmux가 설치되어 있지 않습니다"
  - `denied` → "cmux 소켓 권한 대기 중 — cmux를 한 번 재시작하면 활성화됩니다 (↻로 재확인)"
  - 정상 → 창/워크스페이스/탭 칩(선택·색·pin 반영), 탭 칩 탭 시 `focus-tab`.
- `❯ cmux 열기` 버튼은 일반 `launch` 액션(`/Applications/cmux.app`)으로 앱을 띄운다.

---

## 6. 보안 요약

1. `cmux`/`cterm`/`csess`는 **PIN 페어링 + 현재 인증 epoch**가 유효한 연결에서만 처리한다.
2. 동사·액션·키 화이트리스트와 UUID 검증을 적용하고 셸을 거치지 않는다.
3. 소켓 패스워드 정본은 macOS Keychain에 보관한다. self-heal 때 cmux가 읽도록 권한 0600의
   `cmux.json`에 일시 미러하지만 브라우저에는 보내지 않는다.
4. 세션 화면·초안·검색 기록은 브라우저 `sessionStorage`에만 두고 연결 폐기 시 지운다.

---

## 7. 알려진 제약 / 결합도 리스크

- cmux 앱 경로 **하드코딩**: `/Applications/cmux.app/Contents/Resources/bin/cmux`.
- **cmux 내부 스키마·에러 문자열에 강결합** — self-heal이 `cmux.json` 키(`automation.socketPassword`,
  `socketControlMode`)와 stderr 마커 문자열에 의존. cmux가 이걸 바꾸면 브리지가 깨진다.
  → cmux 공식 automation-token API가 나오면 이관 권장(ROADMAP).
- 1.8초 동기 sleep이 heal 중 브리지 큐를 잠깐 점유.
- Windows 헬퍼엔 cmux 브리지 **미구현**(코어 입력만).

---

## 8. 관련 파일 한눈에

| 파일 | 역할 |
|---|---|
| `MacHelper/Sources/CmuxBridge.swift` | CLI/RPC 브리지 전부(인증 self-heal, 상태 합성, 터미널 grid/input) |
| `MacHelper/Sources/HelperServer.swift` | `t:"cmux"`/`t:"cterm"` 라우팅, 시작 시 `CmuxBridge.warmUp()` |
| `MacHelper/Web/app.js` | 에이전트 탭 폴링·렌더(`renderCmux`), 터미널 뷰 |
| `MacHelper/Web/index.html` | 에이전트/터미널 탭 마크업 |
| macOS Keychain `com.cmdspace.cmdpilot.cmux` / `socket` | CmdPilot이 관리하는 고정 소켓 패스워드 |
| `~/.config/cmux/cmux.json` | cmux 자동화 설정(우리가 password 모드로 맞춤) |
| `/tmp/cmdpilot-cmux.log` | 브리지 진단 로그 |
