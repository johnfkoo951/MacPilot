# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**CmdPilot** — 구요한(johnfkoo951)'s branded fork of MacPilot (upstream: joonlab/MacPilot,
MIT, keep the credit). It turns a Mac into a wireless trackpad / keyboard / Stream-Deck controlled
from any phone's browser. A menu-bar Swift helper runs a hand-rolled HTTP + WebSocket server on the LAN (port 8765);
the phone opens a URL, gets a vanilla HTML/JS web client, and its gestures/taps are streamed back as
JSON commands that the Mac injects as real input via Quartz Event Services (`CGEvent`). No phone app,
no Swift frameworks beyond the SDK, no JS dependencies. LAN-only, unauthenticated.

The project is XcodeGen-defined (no checked-in `.xcodeproj`) and codebase comments are in Korean.

## Build, run, deploy

```bash
xcodegen generate            # regenerate CmdPilot.xcodeproj from project.yml — run after ANY file add/remove
open CmdPilot.xcodeproj       # then build/run target CmdPilotHelper in Xcode (📡 menu-bar icon appears)

./deploy.sh                  # Release build → ~/Applications/CmdPilot Helper.app → restart launchd agent
./script/macpilotctl.sh      # status|start|stop|restart|logs|open|url|install|sync-web|unsync-web
./script/macpilotctl.sh sync-web   # web-only edits: rsync Web/ → App Support override, NO rebuild
./script/watchdog.sh check   # 헬퍼가 '살아 있는데 서빙은 안 하는' 상태인지 (🟢/🔴)
```

- **폰에서 접속이 안 될 때는 `docs/CONNECTION.md` 런북부터**. 요약: 주소는
  `https://pilot.cmdspace.work`이고 **tailnet 전용**(A레코드 = 이 맥의 Tailscale IP,
  헬퍼가 :443에서 Let's Encrypt로 직접 TLS) — 폰에 Tailscale이 켜져 있어야 한다.
  맥에서 자기 Tailscale IP로 찌르는 테스트는 하이핀 불가라 **항상 실패하는 오탐**이니,
  loopback + 올바른 SNI(`--resolve`)로 확인할 것. 헬퍼가 소켓만 쥔 채 accept를 안 하는
  먹통 상태가 실제로 34시간 무음 장애를 냈고(2026-08-10), `script/watchdog.sh`가
  OmniControl `cmdpilot-watchdog` 잡(5분)으로 그걸 자동 복구한다.

- **Web-only changes never need a rebuild**: the server serves files from
  `~/Library/Application Support/CmdPilot/web/` first (if present), then the bundle. `sync-web`
  populates it; `unsync-web` reverts to bundle. This matters because a rebuild = new ad-hoc
  signature = Accessibility grant reset.

- There is no test suite and no linter. All commands must run from the repo root
  (`xcodegen generate` looks for `project.yml` in cwd).
- `deploy.sh` is the normal dev loop once set up: it does NOT open Xcode — it builds Release,
  signs with the keychain's *Apple Development* cert if one exists (stable identity keeps the
  Accessibility grant across rebuilds), otherwise falls back to **ad-hoc signing** (works, but
  Accessibility must be re-granted after every rebuild). It installs to `~/Applications`,
  **auto-creates the LaunchAgent plist if missing**, and (re)starts the always-on agent.
  See `SERVER.md` for launchd management commands.
- **Do not run the app from Xcode while the launchd server is running** — both bind port 8765 and collide.
- Adding/removing a source or web file means editing what `project.yml` globs (`MacHelper/Sources`,
  `MacHelper/Web`) then re-running `xcodegen generate`.

## Two runtime requirements that bite

- **Accessibility permission** (System Settings → Privacy & Security → Accessibility). Without it
  `CGEvent` injection silently no-ops. `HelperServer` polls grant status every 1.5s. Ad-hoc re-signing
  resets this grant, which is why `deploy.sh` re-signs with a stable identity.
- **Same Wi-Fi + Mac awake.** The server sleeps when the Mac sleeps. The advertised URL uses the mDNS
  `.local` name (`scutil --get LocalHostName`) so it survives IP changes, falling back to raw IPv4.

## Architecture

Two halves talk over one WebSocket carrying flat JSON commands.

### Mac side — `MacHelper/Sources/` (Swift, menu-bar `LSUIElement` app)

- **`HelperServer.swift`** — `NWListener` on :8765. Accepts connections, routes each decoded
  `InboundCommand`. Three command types are handled here, not injected: `getDeck`/`saveDeck` (deck
  sync via `DeckStore`) and `getApps` (`AppList`). Everything else is logged and forwarded to
  `EventInjector`. Publishes `@Published` diagnostics (client count, command count, last command,
  accessibility state) consumed by the menu UI.
- **`HTTPWebSocketConnection.swift`** — hand-rolled HTTP/1.1 + WebSocket (handshake, frame parse/build)
  over a raw `NWConnection`. Serves the web client (App Support override dir first, then bundle),
  upgrades on `Upgrade:`. The listener runs with **TCP_NODELAY** + `.responsiveData`
  (`HelperServer.start`) — Nagle batching small move frames was the main perceived-latency source.
- **`EventInjector.swift`** — the only place that synthesizes input. All events run on a single serial
  `DispatchQueue` so drag state (`isMouseDown`/`downButton`) and event ordering stay consistent.
  Dispatches on `command.t`: `move`/`down`/`up`/`click`/`scroll`/`key`/`text`/`macro`/`launch`/
  `gesture`/`zoom`/`volume`/`brightness`. `releaseAll()` is called on socket close so a button never
  stays stuck down after a dropped connection.
- **`InboundCommand.swift`** — the wire contract. One flat `Decodable` struct (all optional fields) plus
  `MacroStep`. This is the source of truth for the JS↔Swift protocol; keep `app.js`'s emitted JSON and
  this struct in lockstep.
- **`DeckStore.swift`** — persists the deck JSON verbatim to
  `~/Library/Application Support/CmdPilot/deck.json`. The Mac is the single store, so all phones/tablets
  share one deck.
- **`AppList.swift`** — scans installed apps (path + name + icon) for the deck's launch-action picker;
  icons rendered on the main thread, cached after first build.
- **`MediaKeys.swift` / `SpaceSwitcher.swift`** — system HID media keys (volume/brightness) and
  three-finger-swipe → Mission Control / space switching.
- **`MenuContentView.swift` / `CmdPilotHelperApp.swift` / `NetworkInfo.swift`** — SwiftUI menu-bar UI
  (URL, QR, permission prompt, diagnostics), app entry, and `.local`/IPv4 resolution.

### Phone side — `MacHelper/Web/` (vanilla, bundled as app resources)

`index.html` + `style.css` + `app.js` (~850 lines, no framework/build step). Captures touch
gestures and deck interactions, opens the WebSocket, and emits the flat JSON commands that
`InboundCommand` decodes. Edited as plain files — they ship as bundle resources via `project.yml`'s
`buildPhase: resources`, so a rebuild/redeploy is needed for changes to reach a phone.

## Conventions

- The port is the `port` constant in `HelperServer.swift`. **On this machine it is 8766** —
  8765 is permanently taken by the OmniControl bridge (`~/DEV/OmniControl/bridge/server.py`).
  `deploy.sh` auto-detects the constant for its final URL echo.
- **OmniControl 연동 (t:"omni" / t:"csess")** — `OmniBridge.swift`가 데몬(127.0.0.1:8765)
  `/state`를 토큰 서버사이드 주입으로 프록시(토큰은 폰에 절대 안 내려감). 에이전트 탭 상단
  "대기 결정 카드"(#sess-cards)가 pending+notifications를 병합 렌더, 카드 탭 → 세션 상세 시트
  (#sess-sheet): `cmux read-screen/send/send-key --workspace|--surface`로 **포커스 안 뺏는**
  세션별 화면 읽기(3초 폴)+프롬프트 전송. 키는 화이트리스트(enter/escape/ctrl+c/up/down/tab),
  타깃은 UUID 검증. cmux state 페이로드에 `sessions[]`(전 워크스페이스의 터미널) 추가됨.
- Deck personalization lives server-side in `~/Library/Application Support/CmdPilot/deck.json`;
  on connect the phone adopts the server deck whenever it has `folders` (server wins over the
  phone's localStorage cache), so seeding/editing that file is how you preconfigure devices.
- Comments and user-facing strings are predominantly **Korean**; match that when editing existing files.
- Bundle id prefix `com.cmdspace.cmdpilot`; helper id `com.cmdspace.cmdpilot.helper` (also the launchd label).
- Version lives in `project.yml` (`MARKETING_VERSION`), not Info.plist.
- Keep the **zero-dependency** posture on both sides (no SwiftPM packages, no JS libraries).
