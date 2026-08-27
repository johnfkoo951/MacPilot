import Foundation

/// cmux CLI/RPC 브리지 — 폰(에이전트 탭)에서 cmux 창/워크스페이스/탭을 직접 전환한다.
///
/// ⚠️ 보안: 이 통합은 PIN 페어링 뒤에서만 열리며 임의 명령 실행은 절대 금지.
///   - 동사 화이트리스트(state / select-workspace / focus-window / focus-tab / open-notif)만 처리
///   - 대상 인자는 UUID 형식만 통과, 셸 미경유(Process 인자 배열 직접 전달)
enum CmuxBridge {
    private static let cliPath = "/Applications/cmux.app/Contents/Resources/bin/cmux"
    private static let queue = DispatchQueue(label: "com.cmdspace.cmdpilot.cmux", qos: .userInitiated)

    static var available: Bool { FileManager.default.isExecutableFile(atPath: cliPath) }

    private static func isUUID(_ s: String) -> Bool { UUID(uuidString: s) != nil }

    private static let cmuxConfigPath = "\(NSHomeDirectory())/.config/cmux/cmux.json"

    // MARK: - 소켓 인증 self-heal
    //
    // cmux 소켓은 기본 cmuxOnly(자식 프로세스만 허용)라 외부인 이 헬퍼는 password 모드로 인증해야 한다.
    // 문제: cmux 는 재시작할 때 cmux.json 의 socketPassword 를 파일에서 지우고 키체인으로 옮겨버려
    //       "password 모드 + 파일에 패스워드 없음" 상태가 되고, 외부 프로세스인 우리는 인증 불가가 된다.
    // 해법: 우리 소유의 고정 패스워드를 Keychain에 보관하고, cmux.json 이 그 값과 다르면 다시 써넣는다.
    //       cmux 가 파일을 핫리로드하므로 앱 재시작 없이 즉시 복구된다. (auth 실패 시 자동 발동)

    /// 우리가 관리하는 고정 소켓 패스워드. Keychain에 없으면 생성하며, 구버전의 평문 파일은
    /// 성공적으로 이전한 뒤 삭제한다.
    private static func canonicalPassword() -> String? {
        let service = "com.cmdspace.cmdpilot.cmux"
        let account = "socket"
        if let existing = KeychainSecret.read(service: service, account: account) { return existing }

        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CmdPilot", isDirectory: true)
        let url = dir.appendingPathComponent("cmux-socket.pass")
        if let existing = try? String(contentsOf: url, encoding: .utf8) {
            let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty,
               KeychainSecret.write(trimmed, service: service, account: account) {
                try? FileManager.default.removeItem(at: url)
                return trimmed
            }
        }
        let pass = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        guard KeychainSecret.write(pass, service: service, account: account) else {
            debugLog("canonicalPassword: Keychain 저장 실패")
            return nil
        }
        return pass
    }

    /// cmux.json 을 우리 패스워드 + password 모드로 맞춘다. 이미 맞으면 아무것도 안 하고 false 반환.
    /// clean JSON 이면 파싱→수정→직렬화(정확), JSONC(주석)면 정규식 삽입(폴백)으로 처리한다.
    @discardableResult
    static func ensureConfigured() -> Bool {
        guard available else { return false }
        guard let pass = canonicalPassword() else { return false }
        let text = (try? String(contentsOfFile: cmuxConfigPath, encoding: .utf8))
            ?? "{\n  \"schemaVersion\" : 1\n}\n"

        // 1) clean JSON 경로 (현재 cmux 가 쓰는 형식) — 안전·정확
        if let data = text.data(using: .utf8),
           var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            var automation = (obj["automation"] as? [String: Any]) ?? [:]
            if (automation["socketPassword"] as? String) == pass,
               (automation["socketControlMode"] as? String) == "password" {
                return false   // 이미 동기화됨
            }
            automation["socketControlMode"] = "password"
            automation["socketPassword"] = pass
            obj["automation"] = automation
            if let out = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
               let outStr = String(data: out, encoding: .utf8) {
                try? outStr.write(toFile: cmuxConfigPath, atomically: true, encoding: .utf8)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                                       ofItemAtPath: cmuxConfigPath)
                debugLog("ensureConfigured: clean-JSON 재작성")
                return true
            }
        }

        // 2) JSONC(주석 포함) 폴백 — 정규식 surgical 삽입
        var t = text
        if let re = try? NSRegularExpression(pattern: "\"socketPassword\"\\s*:\\s*\"[^\"]*\"") {
            let full = NSRange(t.startIndex..., in: t)
            if re.firstMatch(in: t, range: full) != nil {
                t = re.stringByReplacingMatches(in: t, range: full, withTemplate: "\"socketPassword\" : \"\(pass)\"")
            } else if let reAuto = try? NSRegularExpression(pattern: "\"automation\"\\s*:\\s*\\{"),
                      let m = reAuto.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)),
                      let r = Range(m.range, in: t) {
                t.replaceSubrange(r, with: String(t[r]) + "\n    \"socketPassword\" : \"\(pass)\",")
            } else if let brace = t.firstIndex(of: "{") {
                let after = t.index(after: brace)
                t.replaceSubrange(after..<after, with: "\n  \"automation\" : { \"socketControlMode\" : \"password\", \"socketPassword\" : \"\(pass)\" },")
            }
        }
        if let reMode = try? NSRegularExpression(pattern: "\"socketControlMode\"\\s*:\\s*\"[^\"]*\"") {
            let full = NSRange(t.startIndex..., in: t)
            if reMode.firstMatch(in: t, range: full) != nil {
                t = reMode.stringByReplacingMatches(in: t, range: full, withTemplate: "\"socketControlMode\" : \"password\"")
            }
        }
        try? t.write(toFile: cmuxConfigPath, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                               ofItemAtPath: cmuxConfigPath)
        debugLog("ensureConfigured: JSONC 정규식 삽입")
        return true
    }

    /// 헬퍼 시작 시 1회 미리 동기화 — 첫 폰 요청이 바로 되도록.
    static func warmUp() {
        queue.async { _ = ensureConfigured() }
    }

    /// t:"cmux" 명령 처리. 상태 변경 동사는 실행 후 최신 상태를 회신한다.
    static func handle(_ command: InboundCommand, reply: @escaping (String) -> Void) {
        queue.async {
            let verb = command.dir ?? "state"
            let target = command.target ?? ""
            switch verb {
            case "state":
                break
            case "select-workspace" where isUUID(target):
                _ = run(["rpc", "workspace.select", jsonArg(["workspace_id": target])])
            case "focus-window" where isUUID(target):
                _ = run(["rpc", "window.focus", jsonArg(["window_id": target])])
            case "focus-tab" where isUUID(target):
                _ = run(["rpc", "surface.focus", jsonArg(["surface_id": target])])
            case "open-notif" where isUUID(target):
                // cmux 네이티브: 해당 surface 포커스 + 알림 읽음처리를 한 번에.
                _ = run(["open-notification", "--id", target])
            case "statuses":
                // 사이드바 상태(결정 필·사분면·Running)를 카드에 실을 재료.
                // list-status가 워크스페이스당 ~0.4s 서브프로세스라 상태 폴에 못 끼움 —
                // 웹이 '카드에 보이는 워크스페이스만' 지연 요청한다 (최대 6개).
                let ids = target.split(separator: ",").map(String.init)
                    .filter(isUUID).prefix(6)
                var out: [String: [[String: Any]]] = [:]
                for id in ids { out[id] = listStatus(id) }
                let payload: [String: Any] = ["t": "cmuxStatuses", "statuses": out]
                if let data = try? JSONSerialization.data(withJSONObject: payload),
                   let json = String(data: data, encoding: .utf8) { reply(json) }
                else { reply("{\"t\":\"cmuxStatuses\",\"statuses\":{}}") }
                return
            default:
                return   // 화이트리스트 밖 → 무시
            }
            reply(stateJSON())
        }
    }

    /// `list-status --workspace <id>` 출력 파싱 — 줄 형식:
    /// `omni-ask=탭9·힌트… icon=questionmark.bubble.fill color=#FFD60A priority=92`
    /// value에 공백이 올 수 있어 오른쪽 끝에서 priority/color/icon 순으로 떼어낸다.
    private static func listStatus(_ wsID: String) -> [[String: Any]] {
        guard let data = run(["list-status", "--workspace", wsID]),
              let text = String(data: data, encoding: .utf8) else { return [] }
        var items: [[String: Any]] = []
        for raw in text.split(separator: "\n") {
            var line = String(raw)
            var icon = "", color = "", priority = 0
            if let r = line.range(of: " priority=", options: .backwards) {
                priority = Int(line[r.upperBound...].trimmingCharacters(in: .whitespaces)) ?? 0
                line = String(line[..<r.lowerBound])
            }
            if let r = line.range(of: " color=", options: .backwards) {
                color = String(line[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                line = String(line[..<r.lowerBound])
            }
            if let r = line.range(of: " icon=", options: .backwards) {
                icon = String(line[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                line = String(line[..<r.lowerBound])
            }
            guard let eq = line.firstIndex(of: "=") else { continue }
            items.append([
                "key": String(line[..<eq]),
                "text": String(line[line.index(after: eq)...]),
                "icon": icon, "color": color, "priority": priority,
            ])
        }
        return items.sorted { ($0["priority"] as? Int ?? 0) > ($1["priority"] as? Int ?? 0) }
    }

    private static func jsonArg(_ dict: [String: String]) -> String {
        (try? JSONSerialization.data(withJSONObject: dict)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    // MARK: - 터미널 뷰 (에이전트 원격의 확장 — 포커스된 cmux 터미널 화면을 텍스트로)

    /// 현재 포커스된 cmux 터미널의 렌더 그리드(row_spans + styles + cursor)를 폰에 회신.
    /// 화면 미러(픽셀)와 달리 터미널 UI 텍스트만 가져오므로 가볍고 선명하다.
    static func terminalGrid(reply: @escaping (String) -> Void) {
        queue.async {
            if let data = run(["rpc", "mobile.terminal.replay", "{}"]),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let grid = obj["render_grid"] {
                let payload: [String: Any] = ["t": "ctermGrid", "grid": grid]
                if let d = try? JSONSerialization.data(withJSONObject: payload),
                   let s = String(data: d, encoding: .utf8) { reply(s); return }
            }
            reply("{\"t\":\"ctermGrid\",\"error\":true}")
        }
    }

    /// 포커스된 cmux 터미널에 텍스트/제어문자 입력 (mobile.terminal.input).
    static func terminalInput(_ text: String) {
        guard !text.isEmpty else { return }
        queue.async { _ = run(["rpc", "mobile.terminal.input", jsonArg(["text": text])]) }
    }

    // MARK: - 세션별 원격 (포커스를 뺏지 않는 read/send — cmux CLI --workspace/--surface 타깃)
    //
    // 폰 세션 카드의 핵심: 다른 워크스페이스에서 일하는 중에도 특정 세션의 화면을 읽고
    // 프롬프트를 던질 수 있다. 맥 앞 사용자의 포커스는 건드리지 않는다.

    /// 허용 키 화이트리스트 (LAN 서버라 임의 키 조합은 금지 — 승인/중단/탐색만)
    private static let allowedKeys: Set<String> = ["enter", "escape", "ctrl+c", "up", "down", "tab"]

    private static func targetFlag(_ scope: String) -> String? {
        scope == "workspace" ? "--workspace" : (scope == "surface" ? "--surface" : nil)
    }

    /// read-screen — 해당 세션의 화면을 포커스 이동 없이 읽는다.
    /// surface 타깃이 현재 포커스된 탭이면 mobile.terminal.replay의 컬러 그리드를 먼저 시도
    /// (배경 탭은 cmux가 그리드를 유지하지 않아 실패 → 플레인 텍스트 폴백).
    static func readTarget(scope: String, id: String, lines: Int, reply: @escaping (String) -> Void) {
        guard let flag = targetFlag(scope), isUUID(id) else {
            reply("{\"t\":\"csessRead\",\"error\":true}"); return
        }
        let n = max(10, min(lines, 1000))
        queue.async {
            if scope == "surface",
               let gdata = run(["rpc", "mobile.terminal.replay", jsonArg(["terminal_id": id])]),
               let gobj = (try? JSONSerialization.jsonObject(with: gdata)) as? [String: Any],
               let grid = gobj["render_grid"] {
                let payload: [String: Any] = ["t": "csessRead", "id": id, "grid": grid]
                if let d = try? JSONSerialization.data(withJSONObject: payload),
                   let s = String(data: d, encoding: .utf8) { reply(s); return }
            }
            guard let data = run(["read-screen", flag, id, "--lines", String(n)]),
                  let text = String(data: data, encoding: .utf8) else {
                reply("{\"t\":\"csessRead\",\"id\":\"\(id)\",\"error\":true}"); return
            }
            let payload: [String: Any] = ["t": "csessRead", "id": id, "text": text]
            if let d = try? JSONSerialization.data(withJSONObject: payload),
               let s = String(data: d, encoding: .utf8) { reply(s) }
            else { reply("{\"t\":\"csessRead\",\"id\":\"\(id)\",\"error\":true}") }
        }
    }

    /// send — 프롬프트 텍스트를 해당 세션으로 전송 (submit 시 enter까지).
    static func sendTarget(scope: String, id: String, text: String, submit: Bool) {
        guard let flag = targetFlag(scope), isUUID(id), !text.isEmpty else { return }
        queue.async {
            _ = run(["send", flag, id, "--", text])
            if submit { _ = run(["send-key", flag, id, "enter"]) }
        }
    }

    /// send-key — 승인(enter)/중단(escape, ctrl+c)/탐색 키만 화이트리스트로 허용.
    static func sendKeyTarget(scope: String, id: String, key: String) {
        guard let flag = targetFlag(scope), isUUID(id), allowedKeys.contains(key) else { return }
        queue.async { _ = run(["send-key", flag, id, key]) }
    }

    /// 창 + 창별 워크스페이스 + 선택 워크스페이스의 탭(터미널)을 한 페이로드로 만든다.
    private static func stateJSON() -> String {
        // list-windows 하나로 건강 상태를 판정한다(내부에서 self-heal). 실패하면 다른 명령들도
        // 죄다 타임아웃까지 행하므로, 더 부르지 말고 즉시 "복구 중"을 반환한다.
        // → self-heal 이 패스워드를 이미 다시 써넣었으니 폰의 다음 폴링(4초)에서 성공한다.
        guard let winRoot = run(["list-windows", "--json"]),
              let list = (try? JSONSerialization.jsonObject(with: winRoot)) as? [[String: Any]] else {
            return "{\"t\":\"cmux\",\"available\":\(available),\"denied\":true,\"windows\":[],\"tabs\":[]}"
        }

        var windows: [[String: Any]] = []
        do {
            for win in list {
                guard let id = win["id"] as? String else { continue }
                var spaces: [[String: Any]] = []
                if let wdata = run(["list-workspaces", "--json", "--id-format", "both", "--window", id]),
                   let obj = (try? JSONSerialization.jsonObject(with: wdata)) as? [String: Any],
                   let items = obj["workspaces"] as? [[String: Any]] {
                    for ws in items {
                        spaces.append([
                            "id": ws["id"] as? String ?? "",
                            "title": ws["title"] as? String ?? "(무제)",
                            "selected": ws["selected"] as? Bool ?? false,
                            "color": ws["custom_color"] as? String ?? "",
                            "pinned": ws["pinned"] as? Bool ?? false,
                        ])
                    }
                }
                windows.append([
                    "id": id,
                    "index": win["index"] as? Int ?? 0,
                    "key": win["key"] as? Bool ?? false,
                    "workspaces": spaces,
                ])
            }
        }
        // 전 워크스페이스의 탭(터미널) — 제목에 에이전트 상태가 실려 있어 원격 확인에 유용.
        // tabs = 선택 워크스페이스(기존 계약 유지), sessions = 전체 (세션 카드용).
        var tabs: [[String: Any]] = []
        var sessions: [[String: Any]] = []
        if let tdata = run(["rpc", "mobile.workspace.list", "{}"]),
           let obj = (try? JSONSerialization.jsonObject(with: tdata)) as? [String: Any],
           let items = obj["workspaces"] as? [[String: Any]] {
            // 그룹 id → 이름 (카드의 "소속" 표기용)
            var groupName: [String: String] = [:]
            for g in (obj["groups"] as? [[String: Any]]) ?? [] {
                if let gid = g["id"] as? String { groupName[gid] = g["name"] as? String ?? "" }
            }
            for ws in items {
                let selected = (ws["is_selected"] as? Bool) == true
                var terms: [[String: Any]] = []
                for term in (ws["terminals"] as? [[String: Any]]) ?? [] {
                    let entry: [String: Any] = [
                        "id": term["id"] as? String ?? "",
                        "title": term["title"] as? String ?? "터미널",
                        "focused": term["is_focused"] as? Bool ?? false,
                    ]
                    terms.append(entry)
                    if selected { tabs.append(entry) }
                }
                sessions.append([
                    "id": ws["id"] as? String ?? "",
                    "title": ws["title"] as? String ?? "(무제)",
                    "selected": selected,
                    "terminals": terms,
                    // 카드 색 매칭 + 소속 표기: 워크스페이스 색·그룹 이름
                    "color": ws["custom_color"] as? String ?? "",
                    "group": groupName[ws["group_id"] as? String ?? ""] ?? "",
                ])
            }
        }
        // list-windows 가 성공한 지점이라 인증은 정상 — denied 는 false.
        // notifications: cmux 알림 피드에서 "지금 나를 기다리는 세션"(에이전트 상태) — 워크스페이스 교차.
        let payload: [String: Any] = ["t": "cmux", "available": available, "denied": false,
                                       "windows": windows, "tabs": tabs, "sessions": sessions,
                                       "notifications": notificationsJSON()]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return "{\"t\":\"cmux\",\"available\":false,\"windows\":[],\"tabs\":[]}" }
        return json
    }

    // MARK: - 에이전트 알림 (⑤ AGENT_STATE — "지금 나를 기다리는 세션")

    /// cmux 알림 피드에서 액션가능한 세션 상태를 뽑아 폰에 회신.
    /// `list-notifications --json` = cmux 가 Claude Code 훅으로 만든 시맨틱 상태 소스라, 터미널
    /// 화면을 정규식으로 긁을 필요가 없다. cmux `subtitle` 은 일관성이 없어(같은 대기인데 빈 값도
    /// 있음) body 텍스트로 카테고리를 정규화한다 — 파싱 지식을 여기 한 곳에 가둔다.
    /// 필터(사용자 확정): unread 이거나 아직 waiting/permission 인 것 + 최근 48h + 최신순 상위 15.
    private static let notifISO = ISO8601DateFormatter()

    private static func notifCategory(subtitle: String, body: String) -> String {
        if subtitle.hasPrefix("Completed") { return "completed" }
        if subtitle == "Permission" || body.localizedCaseInsensitiveContains("needs your permission") { return "permission" }
        if subtitle == "Waiting" || body.localizedCaseInsensitiveContains("waiting for your input") { return "waiting" }
        return "other"
    }

    private static func notificationsJSON() -> [[String: Any]] {
        guard let data = run(["list-notifications", "--json"]),
              let items = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        else { return [] }   // best-effort — 실패해도 상태 폴링 전체를 막지 않는다.

        let cutoff = Date().addingTimeInterval(-48 * 3600)
        var out: [[String: Any]] = []
        for it in items {   // CLI 는 최신순으로 준다 → 그대로 순회 + 상위 15 캡.
            let sub = (it["subtitle"] as? String) ?? ""
            let body = (it["body"] as? String) ?? ""
            let read = (it["is_read"] as? Bool) ?? false
            let cat = notifCategory(subtitle: sub, body: body)
            let actionable = (cat == "waiting" || cat == "permission")
            guard !read || actionable else { continue }
            let ts = (it["created_at"] as? String) ?? ""
            if let d = notifISO.date(from: ts), d < cutoff { continue }   // stale 유령 컷
            out.append([
                "id": it["id"] as? String ?? "",
                "cat": cat,
                "body": String(body.prefix(120)),
                "read": read,
                "ts": ts,
                "surface": it["surface_id"] as? String ?? "",
                "ws": it["workspace_id"] as? String ?? "",
                "wsTitle": it["tab_title"] as? String ?? "",
            ])
            if out.count >= 15 { break }
        }
        return out
    }

    /// cmux CLI 실행. 소켓 인증 실패면 cmux.json 을 복구(ensureConfigured)하고 1회 재시도한다.
    private static func run(_ args: [String], allowHeal: Bool = true) -> Data? {
        guard available else { debugLog("not executable: \(cliPath)"); return nil }
        let result = exec(args)
        guard let result else { return nil }   // spawn/timeout 실패
        if result.status == 0 { return result.stdout }

        let errStr = String(data: result.stderr, encoding: .utf8) ?? ""
        debugLog("exit \(result.status) \(args.prefix(2).joined(separator: " ")): \(errStr)")

        // 인증 실패 감지 → self-heal 후 1회 재시도.
        // ⚠️ cmux reload-config 는 인증이 필요해 이 상황(패스워드 없음)에선 실패한다(닭-달걀).
        //    대신 cmux 의 파일워치가 cmux.json 쓰기를 ~2초 내 자동 반영하므로, 쓰고 기다린다.
        if allowHeal, isAuthFailure(errStr) {
            let changed = ensureConfigured()
            // 깨진 상태에선 cmux 명령이 타임아웃까지 행(hang)하므로 ping 폴링은 금물.
            // cmux.json 을 쓴 직후 한 번만 잠깐 기다렸다 재시도한다. (파일워치 채택 ~1-2초)
            // 한 상태요청은 run()을 여러 번 부르므로, 최근 대기했으면 재대기 생략.
            healLock.lock()
            let shouldWait = changed && Date().timeIntervalSince(lastHealPoll) > 6
            if shouldWait { lastHealPoll = Date() }
            healLock.unlock()
            if shouldWait { usleep(1_800_000) }
            debugLog("self-heal 재시도: \(args.first ?? "")")
            return run(args, allowHeal: false)
        }
        return nil
    }

    private static let healLock = NSLock()
    private static var lastHealPoll = Date.distantPast

    /// cmux 소켓 인증 실패 마커 (실측 확인한 실제 출력 문자열).
    /// - "Authentication required"/"auth_required": 패스워드는 있는데 클라이언트가 안/틀리게 보냄
    /// - "Invalid password": 우리 파일 값과 cmux 로드값 불일치(로테이션 직후)
    /// - "no socket password is configured"/"Password mode is enabled": ★재시작으로 패스워드가
    ///   지워진 상태 — cmux 가 실제로 내는 문자열. 이게 self-heal 의 주 트리거다.
    /// - "Access denied": cmuxOnly 모드(자식만 허용)로 되돌아간 경우
    private static func isAuthFailure(_ err: String) -> Bool {
        let markers = [
            "Authentication required", "auth_required", "Invalid password",
            "no socket password is configured", "Password mode is enabled", "Access denied",
        ]
        return markers.contains { err.localizedCaseInsensitiveContains($0) }
    }

    /// 단발 프로세스 실행 (3초 타임아웃). 파이프는 종료 대기 전에 비동기로 읽어 데드락 회피.
    private static func exec(_ args: [String]) -> (stdout: Data, stderr: Data, status: Int32)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cliPath)
        process.arguments = args
        guard let pass = canonicalPassword() else { return nil }
        var env = ProcessInfo.processInfo.environment
        env["CMUX_SOCKET_PASSWORD"] = pass   // cmux CLI가 요구하는 프로세스 한정 인증 전달
        process.environment = env
        let out = Pipe(); let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        do { try process.run() } catch {
            debugLog("spawn 실패 \(args.first ?? ""): \(error)")
            return nil
        }
        var data = Data(); var errData = Data()
        let readDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            data = out.fileHandleForReading.readDataToEndOfFile()
            errData = err.fileHandleForReading.readDataToEndOfFile()
            readDone.signal()
        }
        let exitDone = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            process.waitUntilExit()
            exitDone.signal()
        }
        if exitDone.wait(timeout: .now() + 2) == .timedOut {
            process.terminate()
            debugLog("timeout: \(args.prefix(2).joined(separator: " "))")
            return nil
        }
        _ = readDone.wait(timeout: .now() + 1)
        return (data, errData, process.terminationStatus)
    }

    /// 브리지 문제 진단용 로그. 사용자 프롬프트/타깃 값은 기록하지 않는다.
    private static func debugLog(_ message: String) {
        let line = "[\(Date())] \(message)\n"
        if let handle = FileHandle(forWritingAtPath: "/tmp/cmdpilot-cmux.log") {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? line.write(toFile: "/tmp/cmdpilot-cmux.log", atomically: true, encoding: .utf8)
        }
    }
}
