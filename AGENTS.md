# AGENTS.md

This file is the canonical guidance for coding agents working in this repository.

## Project

CmdPilot turns a Mac into a browser-controlled trackpad, keyboard, deck, screen viewer, and optional
AI-agent remote. A Swift menu-bar helper serves a dependency-free HTML/JS client over HTTP and
WebSocket, then injects validated commands through Quartz Event Services.

- macOS helper: Swift, `LSUIElement`, Network.framework, Quartz/AppKit/Security
- phone/tablet client: vanilla HTML/CSS/JS, no build step
- project definition: XcodeGen `project.yml`; generated `.xcodeproj` is ignored
- default application port: `8766`; optional listeners on `80` and `443`
- bundle identifier: `com.cmdspace.cmdpilot.helper`
- LaunchAgent label: `com.cmdspace.cmdpilot.helper`

Comments and user-facing strings are predominantly Korean; match the surrounding file.

## Build, run, and validate

Run commands from the repository root.

```bash
xcodegen generate
open CmdPilot.xcodeproj

# Repeatable command-line build without signing or installation
./script/xcodebuild-clean.sh -project CmdPilot.xcodeproj -scheme CmdPilotHelper -configuration Release \
  -derivedDataPath ./.release CODE_SIGNING_ALLOWED=NO build

# Normal local deployment: build, sign, install, and restart the LaunchAgent
./deploy.sh
```

- Run `xcodegen generate` after adding or removing any source or web resource.
- There is no macOS unit-test suite or linter. A clean Release build is the minimum verification.
- Windows helper tests live under `WindowsHelper/` and are independent of the macOS target.
- Do not run from Xcode while the installed LaunchAgent is active; both instances bind the same ports.

## Runtime requirements

- Accessibility permission is required for `CGEvent` input injection.
- Screen Recording permission is separately required for capture and mirror features.
- The Mac must be awake and reachable over the same LAN or a private tailnet.
- Web-only changes can be copied to the local override with `./script/macpilotctl.sh sync-web`; Swift
  changes require a rebuild and deployment.

## Security and private configuration

CmdPilot can inject keyboard and pointer input. Keep it on a trusted LAN or private tailnet, never
port-forward it, and never enable a public Funnel/tunnel without a separate authentication layer.
Enable PIN pairing before using sensitive local integrations or an untrusted network.

- Browser WebSocket upgrades must remain same-origin and restricted to locally advertised hosts or a
  same-origin Tailscale-owned `*.ts.net` host.
- Optional session/search integration commands require PIN pairing.
- Certificates, private keys, tokens, personal vault names, hostnames, IPs, and production domains must
  not be committed. Use placeholders in examples.
- TLS PKCS#12 passwords and optional integration tokens live in macOS Keychain. Configure them with
  `./script/configure-secrets.sh`; local endpoint metadata lives in
  `~/Library/Application Support/CmdPilot/integrations.plist`.
- The cmux socket password is generated and stored by the helper in macOS Keychain; a legacy
  `cmux-socket.pass` is migrated and removed automatically.
- Deployment requires a stable signing identity by default because Accessibility and Keychain ACLs
  must survive rebuilds. Ad-hoc signing is an explicit degraded-mode opt-in only.
- TLS assets live under `~/Library/Application Support/CmdPilot/tls/` and are ignored by Git.
- Built-in PKCS#12 HTTPS requires macOS 15+ for memory-only import; use private Tailscale Serve on
  macOS 13–14.

## Architecture

### Mac side — `MacHelper/Sources/`

- `HelperServer.swift`: listeners, connection registry, command routing, diagnostics, PIN state
- `HTTPWebSocketConnection.swift`: HTTP serving, pairing gate, same-origin WebSocket handshake, frames
- `InboundCommand.swift`: flat JSON wire contract; keep emitted `app.js` commands in lockstep
- `EventInjector.swift`: serialized `CGEvent` synthesis and drag-state ownership
- `DeckStore.swift`: shared deck at `~/Library/Application Support/CmdPilot/deck.json`
- `CmuxBridge.swift`: allowlisted multiplexer state/read/send operations
- `OmniBridge.swift`: optional loopback-only service bridge; endpoint in local config, token in Keychain
- `CaptureService.swift` / `ScreenStreamer.swift`: screen capture, OCR, and mirror pipeline
- `MenuContentView.swift` / `CmdPilotHelperApp.swift`: menu-bar UI and lifecycle

### Browser side — `MacHelper/Web/`

`index.html`, `style.css`, and `app.js` capture gestures, render the deck/agent/mirror panels, and emit
the flat JSON protocol. They are bundled as resources and can also be served from the local web
override. Device-specific preferences, including optional Obsidian vault names, belong in browser
`localStorage`, never in tracked source.

## Conventions

- Keep the zero-dependency posture: no SwiftPM packages and no JavaScript libraries.
- Preserve compatibility identifiers such as `macpilot.settings.v2`, `macpilot://spotlight`, and the
  `macpilotctl.sh` filename unless a migration is included.
- Version is defined by `MARKETING_VERSION` in `project.yml`; `Info.plist` references build settings.
- Treat `InboundCommand.swift` as the protocol source of truth.
- Preserve unrelated user changes and do not force-push, rewrite published history, or remove local
  data without explicit approval.
