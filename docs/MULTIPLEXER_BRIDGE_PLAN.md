# 다중 멀티플렉서 브리지 — 기획 보고

> 목표: `CmuxBridge`(cmux 전용)를 **tmux · Zellij · Herdr · cmux · Orca**를 어댑터로 갈아끼우는
> **다중 백엔드 브리지**로 일반화할지 검토. 각 앱의 **API 방식**을 CmdPilot의 5-op 계약에 매핑.
> 근거: 공식 문서 대조 조사 5건 + 적대적 검증 5건(환각 색출 포함).
> 결론은 **하나 고르기가 아니라 어댑터로 쌓기**다.

---

## 0. 핵심 결론 (3줄)

1. **코어 4-op(LIST/FOCUS/READ/SEND)은 5개 앱 전부 값싸다** — 전부 `--json` CLI 셸아웃, 기존 `CmuxBridge`와 동형. 어댑터화는 앱당 S~M.
2. **갈리는 건 ⑤ AGENT_STATE(킬러 기능) 하나** — **Herdr만 네이티브 시맨틱 상태 + 이벤트 push**. tmux/Zellij/cmux/Orca는 제목 스크레이핑/합성/플러그인.
3. **추천 조합 = cmux(로컬 네이티브) + tmux(원격 서버 SSH) + Herdr(에이전트 상태 쇼케이스).** Zellij는 선택, Orca는 보류(자사 모바일 앱과 중복).

---

## 1. 브리지 계약 = 5개 연산

`CmuxBridge`가 cmux로 이미 구현한 것이 곧 계약. 다른 백엔드도 이걸 충족하면 어댑터가 된다.

| # | 연산 | 폰 UI 용도 |
|---|---|---|
| ① LIST | 창/워크스페이스/탭/pane 목록(제목·선택) | 칩 스트립 |
| ② FOCUS | 특정 창/워크스페이스/탭/pane 전환 | 칩 탭 |
| ③ READ_SCREEN | 포커스(이상적으론 임의) pane 화면 텍스트 | 터미널 미러 뷰 |
| ④ SEND_INPUT | pane에 텍스트/키 입력 | 입력창 |
| ⑤ AGENT_STATE | working/blocked/done/idle | **킬러 기능** (원격에서 "지금 나 기다리는 에이전트" 파악) |

---

## 2. 5-op 커버리지 매트릭스 (검증본)

✅ 완전 · 🟡 부분/합성 필요 · ❌ 없음

| op | tmux | Zellij | **Herdr** | cmux (기준선) | Orca |
|---|:---|:---|:---|:---|:---|
| ① LIST | ✅ `list-panes/-windows/-sessions -F` | ✅ `action list-panes/list-tabs --json` | ✅ `workspace/tab/pane list` + `agent list` | ✅ `list-windows`·`list-workspaces`·`tree` | ✅ `terminal list --json`·`worktree ps` |
| ② FOCUS | ✅ `select-window/-pane`·`switch-client` | ✅ `action go-to-tab`·**`focus-pane-id`** | 🟡 ws/tab는 id, **pane는 방향(directional)** | ✅ `rpc window.focus/workspace.select/surface.focus`† | ✅ `terminal switch --terminal <h>` |
| ③ READ | ✅ `capture-pane -p -t` **(임의 pane)** | ✅ `action dump-screen --pane-id --full --ansi` **(임의)** | ✅ `pane read <id> --source visible/recent` **(임의)** | ✅ `rpc mobile.terminal.replay`† **(포커스만)** | ✅ `terminal read --terminal <h>` (스크롤백·커서) |
| ④ SEND | ✅ `send-keys -t` **(임의)** | ✅ `action write-chars/write --pane-id`·`send-keys -p` | ✅ `pane send-text/send-keys <id>` **(임의)** | ✅ `rpc mobile.terminal.input`† **(포커스만)** | ✅ `terminal send --terminal <h> --text --enter` |
| ⑤ STATE | 🟡 휴리스틱 `#{pane_current_command}`·제목관례 | 🟡 `list-panes --json` exited/title (신뢰형은 WASM 플러그인) | ✅✅ **네이티브** `agent list --json` (idle/working/blocked/done) **+ push** | 🟡 **탭 제목 스크레이핑** (구조화 필드 없음) | 🟡 합성 `terminal wait --for tui-idle`만 |

† = **cmux 계약서에 문서화 안 된 v2 소켓 RPC.** MacPilot이 의존하는 `window.focus`·`workspace.select`·`surface.focus`·`mobile.workspace.list`·`mobile.terminal.replay`·`mobile.terminal.input` **6개 전부 미문서** → cmux 릴리스에 취약(§6 하드닝).

---

## 3. 앱별 API 방식 요약 (검증 교정 반영)

### tmux — 가장 깨끗·보편 (환각 0건)
- **메커니즘**: `tmux <cmd>` CLI 셸아웃(unix socket `/tmp/tmux-<uid>/`). 리치는 control mode `tmux -CC`(라인 RPC + `%`-이벤트 push).
- **인증**: 무인증(소켓 파일권한만). 헬퍼를 동일 UID로.
- **원격**: ★ tmux의 본진. `ssh host tmux capture-pane -p -t …`로 로컬과 동일 → **원격 서버 잠금해제**.
- **⑤**: 네이티브 없음. `#{pane_title}`이 **공식적으로 앱이 설정 가능**하므로 "에이전트가 제목에 상태 표기" 관례는 정당한 폴백(단 에이전트 협조 필요).
- **공수 M** (기계적 코어만 S).

### Zellij — 코어 4-op은 오히려 cmux보다 깔끔 (검증이 상향)
- **메커니즘**: `zellij action <sub>` CLI 셸아웃(세션 unix 소켓). 무인증.
- **검증 교정**: 조사본이 "pane를 id로 직접 포커스 불가"라 했으나 **`focus-pane-id` 실재**(과소평가였음). `send-keys -p`·`paste -p`도 있어 특수키 전송이 더 깔끔.
- **강점**: `list-panes/list-tabs --json`(네이티브 토폴로지) + `dump-screen`·`write`·`write-chars`가 **전부 `--pane-id`** → 포커스 전환 없이 임의 pane 읽기/쓰기.
- **⑤**: 네이티브 없음. 무플러그인은 exited/exit_status/title로 crude. 신뢰형은 `PaneUpdate`/`CommandChanged` 구독하는 **소형 Rust WASM 플러그인 + `zellij pipe`**(L 델타).
- **주의**: `--json` 토폴로지는 **v0.43+/0.44** 필요. 원격은 SSH 또는 내장 web client(127.0.0.1:8082, token auth, 기본 off).
- **공수 M** (코어만 S).

### Herdr — ⑤ 킬러 기능의 유일한 1급 시민 ⭐
- **메커니즘**: 로컬 unix 소켓 위 **newline-JSON**(`{"id","method","params"}`) + 동형 `herdr` CLI. cmux와 달리 **패스워드 없음**.
- **⑤**: **네이티브 시맨틱 상태** `herdr agent list --json` → `idle/working/blocked/done` + **진짜 push** `events.subscribe` → `pane.agent_status_changed`. 제목 스크레이핑도 폴링도 불필요. `done` = "끝났는데 아직 안 본 pane" → **폰 '가서 봐' 알림에 완벽**.
- **원격**: `herdr --remote <host-alias>` thin client + **폰 reattach** = MacPilot 철학과 동형.
- **검증 교정**: ⚠️ `herdr api snapshot`은 **발명된 명령**(존재 X) → 원샷 토폴로지는 소켓 `session.snapshot` 또는 `workspace/tab/pane/agent list` 조합. ⚠️ 인증 서술 오류 — `HERDR_ENV=1`은 **인증 게이트가 아니라 힌트**(소켓 파일권한만이 실제 게이트). FOCUS는 pane 방향이동이라 약함.
- **하드 블로커**: **herdr가 이미 호스트 터미널 안에서 라이브 TUI 서버로 떠 있어야** 함 — MacPilot이 자기 launchd 서버처럼 headless로 못 띄움. 소켓 경로(`HERDR_SOCKET_PATH`/`HERDR_SESSION`) 발견 필요.
- **공수 S→M**.

### cmux — 기준선, 그러나 구조적 취약 (하드닝 대상)
- **메커니즘**: `/Applications/cmux.app/.../bin/cmux` 셸아웃 → v2 JSON-RPC over `~/Library/Application Support/cmux/cmux.sock`. password 인증 + self-heal.
- **검증 지적**: MacPilot이 쓰는 **6개 RPC가 전부 미문서**(†) + 인증 self-heal이 역공학된 stderr 마커에 강결합 → **cmux 업데이트 한 번에 조용히 깨질 수 있음**. ⑤는 구조화 필드 없이 **탭 제목 스크레이핑**.
- **좋은 소식(하드닝 경로)**: 계약서에 **문서화된 대체재 존재** — `focus-window`/`read-screen`·`capture-pane`(handle)/`send`·`send-key`(handle), 재접속 가능한 **`cmux events` 스트림**, **`cmux list-notifications`** 피드. 이걸 쓰면 미문서 RPC 의존 + 제목 스크레이핑을 동시에 제거.
- **공수 S** (이미 구현). 하드닝은 별도 S~M.

### Orca — 기술적으론 되나 자사 앱과 중복 (보류)
- **검증 결과**: `orca terminal list/read/send/switch/wait`가 계약에 ~1:1 매핑, 전부 `--json`, cmux와 동일한 CLI 셸아웃 → 공수 M. `terminal read`는 스크롤백+커서 페이징(재시작에도 생존).
- **검증 교정**: ⚠️ `orca tab profile list`는 **발명**(→ `orca tab list`). handle은 **runtime-scoped라 stale** → op마다 재획득 필요. CLI는 **Experimental**.
- **⑤**: `tui-idle`만 문서화, working/blocked/done enum 없음 → 합성 필요.
- **전략적 중복 ★**: Orca가 **이미 1급 iOS/Android 컴패니언 앱**("폰에서 에이전트 감시·조종 + 완료 알림")을 판다 = **MacPilot 용도와 정면 중복**. 깨끗한 상태 신호도 CLI가 아니라 자사 앱에만 감.
- **공수 M**, but 우선순위 낮음.

---

## 4. 아키텍처 — `MultiplexerBackend` 프로토콜 + 어댑터

`CmuxBridge`를 프로토콜로 추출하고, cmux를 그 첫 어댑터로 강등(behavior 불변).

```swift
protocol MultiplexerBackend {
    var id: String { get }                 // "cmux" | "tmux" | "herdr" | "zellij" | "orca"
    var available: Bool { get }            // CLI/소켓 존재 여부 (폰 스위처가 이걸로 필터)
    func warmUp()                          // 인증 프리싱크 (cmux 전용, 대부분 no-op)
    func state(reply: @escaping (String) -> Void)                         // ① LIST + ⑤ STATE 합성 JSON
    func focus(verb: String, target: String, reply: @escaping (String) -> Void)  // ②
    func readScreen(handle: String?, reply: @escaping (String) -> Void)          // ③ (nil=포커스)
    func sendInput(handle: String?, text: String)                                // ④
    func subscribeState(onChange: @escaping (String) -> Void) -> Cancellable?    // 선택(Herdr push)
}

enum BridgeRouter {
    static let backends: [MultiplexerBackend] = [CmuxBackend(), TmuxBackend(), HerdrBackend()/*…*/]
    static func backend(_ id: String?) -> MultiplexerBackend? { backends.first { $0.id == (id ?? "cmux") && $0.available } }
}
```

**와이어 프로토콜(최소 침습)**: 기존 `t:"cmux"`/`t:"cterm"` 유지 + **`backend` 필드 추가**(기본 `"cmux"` → 하위호환). `state` 응답에 `available` 백엔드 목록을 실어 폰이 **스위처 칩**을 그린다.

**핸들 정규화(중요)**: 백엔드마다 핸들 포맷이 다름 — cmux UUID / tmux `sess:win.pane` / Zellij `terminal_3` / Herdr `1-1`·`w1:p1` / Orca opaque. **어댑터가 불투명 문자열 토큰으로 정규화**하고 폰은 파싱하지 않는다. (검증이 Herdr/Orca 핸들 불일치·stale 경고.)

**자동 감지**: 각 어댑터의 `available`(CLI 경로/소켓 존재)로 **설치된 것만** 폰에 노출.

**보안**: 모든 백엔드가 로컬 무인증(또는 로컬 password) → **폰 게이트는 CmdPilot 자신의 레이어**(동사 화이트리스트 + PIN). **화이트리스트는 백엔드별로** 정의(각 CLI의 위험 표면이 다름).

---

## 4½. 런타임 토폴로지 — cmux 로컬 콕핏 + herdr 원격 런타임

> 운영 모델의 결정적 사실: **"session persistence — cmux는 layout만 복구", "live process는 원격 tmux가 담당."**

cmux의 "원격 워크스페이스"는 실은 로컬 pane에서 `ssh host`를 실행하는 것이다. 실제 원격 프로세스는 그 SSH 세션 안에 살고, **맥이 잠들거나 cmux를 끄면 SSH가 끊겨 원격 작업이 죽는다.** cmux는 재시작 시 **레이아웃(=`ssh` 재실행)만** 복구하지 세션 상태를 복구하지 않는다. → **원격 에이전트가 맥 슬립·연결끊김을 견디는 유일한 방법은 원격 서버 위의 멀티플렉서(herdr, 또는 tmux).**

- **Q. cmux→herdr 라이브 핸드오프 가능?** — 불가. 별개 앱이고 cmux가 세션을 쥐고 있지 않으니 "옮길" 것 자체가 없다. 이음매는 프로세스가 아니라 **git 상태**. 기존 `cmux→SSH→원격 tmux` 패턴에서 원격 tmux를 **원격 herdr**로 바꾸는 것.
- **Q. 애초에 원격은 herdr에서 띄워야?** — **예.** 원격 작업은 처음부터 원격 herdr 안에서 태어나야 서버측 persistent PTY(슬립 생존) + 네이티브 에이전트 상태를 얻는다. cmux는 macOS 전용이라 원격 런타임이 될 수 없다.

```
 로컬 (Mac)                         원격 (Linux devbox)
┌──────────────┐                   ┌────────────────────┐
│    cmux      │ ── SSH ─────────► │   herdr (server)   │
│  (콕핏/뷰어)  │  cmux workspace:  │  persistent PTYs   │
│  로컬 작업     │  "ssh box -t      │  에이전트 상태       │
│              │   herdr attach"   │  슬립에도 생존       │
└──────┬───────┘                   └─────────┬──────────┘
       │ MacPilot backend=cmux               │ backend=herdr (SSH 릴레이)
       └──────────────── 폰 ─────────────────┘
```

### 통합 깊이 — 깊은 경로(상위호환) 채택 ✅ [P2 확정]

| 깊이 | 방식 | 폰이 받는 상태 신호 |
|---|---|---|
| 얕게 | herdr을 cmux pane 안에서 SSH 실행 → **cmux 백엔드**가 그 pane을 미러 | **시각(TUI 렌더)만** |
| **깊게 ✅** | MacPilot **herdr 백엔드**가 `ssh box herdr agent list --json` 등 **SSH 릴레이** | **구조화 상태 칩 + push** |

깊은 경로가 얕은 경로를 **포함(상위호환)** 하므로 — herdr 백엔드는 로컬 herdr도, cmux-pane-속-herdr도 다 커버 — **herdr 백엔드(SSH 릴레이)를 구현**한다. `ssh ControlMaster/ControlPersist`로 콜드 SSH(150ms~1s)를 완화한다. **전제**: 원격 박스에 herdr 설치(`curl -fsSL https://herdr.dev/install.sh | sh`). 원격 대상·SSH 옵션은 `~/Library/Application Support/CmdPilot/herdr.json`으로 설정(하드코딩 없음).

---

## 5. 도입 로드맵 (단계별)

| 단계 | 내용 | 공수 | 가치 |
|---|---|:---:|---|
| **P0 리팩터** | `CmuxBridge` → `MultiplexerBackend` 프로토콜 추출, cmux를 첫 어댑터로. behavior 불변. `backend` 필드 + 폰 스위처 골격. | S | 기반 |
| **P1 tmux** | 최고 ROI. 문서화된 무위험 API. **SSH → 원격 서버 잠금해제**(이동식 작전본부 명제). ⑤는 제목관례로. | M | ★★★ 도달범위 |
| **P2 Herdr** | ⑤ 네이티브 상태 + push = **MacPilot 에이전트-원격이 진짜 빛나는 지점**. "herdr 라이브" 전제 + 방향 포커스 처리. | M | ★★★ 킬러기능 |
| **P3 Zellij** | 코어 4-op 거의 공짜(`--json`·`--pane-id`·`focus-pane-id`). ⑤는 후순위(crude 또는 나중에 WASM 플러그인). | S(코어) | ★★ |
| **cmux 하드닝** | 미문서 RPC 6종 → 문서화 명령으로, `events` 스트림 + `list-notifications`로 ⑤ 신뢰화(제목 스크레이핑 제거). | S~M | ★★ 안정성 |
| **Orca 보류** | 기술적으론 M이나 **자사 iOS/Android 앱과 중복** + Experimental CLI + stale handle. Orca를 주력 ADE로 표준화할 때만 재검토. | — | 낮음 |

**추천 조합(당신 "정답은 조합" 명제 매핑)**:
- **cmux** = 로컬 macOS 네이티브 (일상, 이미 있음)
- **tmux** = 원격 서버 (SSH 도달 계층)
- **Herdr** = 에이전트 상태 쇼케이스 (킬러 기능 계층)

이 트리오가 로컬-네이티브 + 원격-보편 + 에이전트-인지를 모두 덮는다. Zellij 선택, Orca 스킵.

---

## 6. 리스크 & 미해결

- **cmux 결합도** — 어댑터가 미문서 v2 RPC 6종 + 역공학 인증에 의존 → 릴리스 취약. (하드닝으로 완화)
- **"herdr 라이브" 전제** — 헬퍼가 headless로 못 띄움. 소켓 발견/세션 부재 시 5-op 전부 조용히 실패 → 폰 UI에 "herdr 세션 없음" 안내 필요.
- **Zellij ⑤** — 신뢰형 상태는 별도 빌드·배포하는 Rust WASM 플러그인 필요(코어와 분리해 후순위).
- **Orca 중복** — 자사 모바일 앱과 정면 경합. 통합 ROI 낮음.
- **핸들 stale**(Herdr/Orca) — 폰이 핸들을 오래 쥐면 오타깃. op 전 재획득 또는 짧은 TTL.
- **⑤의 이질성** — 상태 소스의 급이 백엔드마다 다름(네이티브/제목/합성/플러그인). 폰 UI는 "상태 신뢰도"를 백엔드별로 다르게 표현하거나, 최소공통(idle/active)만 통일 노출하는 결정 필요.
- **연구 질문 연결** — `cmux Socket API는 CLI-agnostic인가`와 동일 축이며, 이 브리지가 실증 구현체가 됨.

---

## 부록 A. 조사 출처 (공식 문서, 2026-07 확인)
- tmux: man7.org/…/tmux.1, github.com/tmux/tmux/wiki/Control-Mode
- Zellij: zellij.dev/documentation (cli-actions·plugin-api·web-client), zellij-utils `cli.rs`
- Herdr: herdr.dev/docs/socket-api·cli-reference·agents, /agent-guide.md
- cmux: raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md + `MacHelper/Sources/CmuxBridge.swift`
- Orca: onorca.dev/docs/cli/reference, github.com/stablyai/orca
