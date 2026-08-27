import CFNetwork
import Foundation

/// 선택적 로컬 에이전트 서비스 브리지 — 폰 에이전트 탭의 상태·검색 데이터 소스.
///
/// 엔드포인트는 로컬 전용 `integrations.plist`, 토큰은 macOS Keychain에서 읽는다.
/// 토큰은 서버사이드 요청에만 주입하며 폰/브라우저로 보내지 않는다.
enum OmniBridge {
    private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    /// loopback 응답의 redirect를 따라가면 사용자 정의 토큰 헤더가 외부 Location으로
    /// 전달될 수 있으므로 모든 통합 요청은 30x를 최종 응답으로 취급한다.
    private static let httpSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.connectionProxyDictionary = [
            kCFNetworkProxiesHTTPEnable as String: false,
            kCFNetworkProxiesHTTPSEnable as String: false,
            kCFNetworkProxiesProxyAutoConfigEnable as String: false,
            kCFNetworkProxiesSOCKSEnable as String: false
        ]
        return URLSession(configuration: config,
                          delegate: NoRedirectDelegate(), delegateQueue: nil)
    }()

    private struct IntegrationConfig: Decodable {
        struct Omni: Decodable { let baseURL: String }
        let omni: Omni?
    }

    private static let configURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("CmdPilot/integrations.plist")

    /// 로컬 loopback HTTP만 허용해 설정 오입력으로 외부 호스트에 토큰이 전달되지 않게 한다.
    private static func baseURL() -> URL? {
        guard let data = try? Data(contentsOf: configURL),
              let raw = try? PropertyListDecoder().decode(IntegrationConfig.self, from: data),
              let url = raw.omni.flatMap({ URL(string: $0.baseURL) }),
              url.scheme == "http",
              let host = url.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1"].contains(host),
              let port = url.port, (1 ... 65_535).contains(port),
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        return url
    }

    /// 토큰은 매 요청 Keychain에서 읽는다(회전 즉시 반영, 캐시로 인한 stale 인증 방지).
    private static func token() -> String? {
        KeychainSecret.read(service: "com.cmdspace.cmdpilot.omni", account: "api")
    }

    private static func endpoint(_ path: String) -> URL? {
        baseURL()?.appendingPathComponent(path)
    }

    /// GET /search — 세션 코퍼스 검색/브라우즈 프록시 (read-only, redact된 스니펫).
    /// mode: q=질의 검색 · browse=projects | (browse=sessions + cwd)
    static func search(q: String, browse: String, cwd: String, requestID: String?,
                       reply: @escaping (String) -> Void) {
        guard let searchURL = endpoint("search") else {
            reply(searchUnavailable(requestID: requestID)); return
        }
        var comps = URLComponents(url: searchURL, resolvingAgainstBaseURL: false)
        var items: [URLQueryItem] = []
        if !browse.isEmpty {
            items.append(URLQueryItem(name: "browse", value: browse))
            if !cwd.isEmpty { items.append(URLQueryItem(name: "cwd", value: cwd)) }
        } else {
            items.append(URLQueryItem(name: "q", value: q))
            items.append(URLQueryItem(name: "limit", value: "15"))
        }
        comps?.queryItems = items
        guard let tok = token(), let url = comps?.url else {
            reply(searchUnavailable(requestID: requestID)); return
        }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.setValue(tok, forHTTPHeaderField: "X-CMUX-Token")
        httpSession.dataTask(with: req) { data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard let data, code == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data),
                  let payload = try? JSONSerialization.data(withJSONObject:
                      ["t": "omniSearch", "id": requestID ?? "",
                       "available": true, "result": obj]),
                  let json = String(data: payload, encoding: .utf8) else {
                // 503 = 인덱스 부재(저하 규약) — 폰에 이유를 전달
                reply(searchUnavailable(requestID: requestID, code: code))
                return
            }
            reply(json)
        }.resume()
    }

    /// POST /focus {session, cwd, revive} — 검색 히트를 맥에서 열기/부활.
    static func focusSession(session: String, cwd: String,
                             reply: @escaping (String) -> Void) {
        guard let tok = token(), let url = endpoint("focus"),
              !session.isEmpty else {
            reply("{\"t\":\"omniFocus\",\"ok\":false}"); return
        }
        var req = URLRequest(url: url, timeoutInterval: 45)   // 부활은 ~수 초 걸린다
        req.httpMethod = "POST"
        req.setValue(tok, forHTTPHeaderField: "X-CMUX-Token")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject:
            ["session": session, "cwd": cwd, "revive": true])
        httpSession.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            reply("{\"t\":\"omniFocus\",\"ok\":\(ok)}")
        }.resume()
    }

    /// POST /ptt {action, ref} — PTT 확인 카드 원격 결정 (send/cancel/hold).
    /// 데몬이 SSE ptt_decision으로 앱에 중계해 카드를 마감/정지시킨다.
    static func ptt(action: String, ref: String, requestID: String?,
                    reply: @escaping (String) -> Void) {
        let allowed = ["send", "cancel", "hold"]
        guard allowed.contains(action), let tok = token(),
              let url = endpoint("ptt") else {
            reply(pttResponse(ok: false, action: action, requestID: requestID)); return
        }
        var req = URLRequest(url: url, timeoutInterval: 3)
        req.httpMethod = "POST"
        req.setValue(tok, forHTTPHeaderField: "X-CMUX-Token")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["action": action, "ref": ref])
        httpSession.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            reply(pttResponse(ok: ok, action: action, requestID: requestID))
        }.resume()
    }

    /// GET /state → {"t":"omniState","available":Bool,"state":{pending:[…],last_brief:{…},…}}
    /// 데몬 다운/토큰 부재 시에도 에러 대신 available=false — 폰 UI는 cmux 단독으로 동작한다.
    static func state(reply: @escaping (String) -> Void) {
        guard let tok = token(), let url = endpoint("state") else {
            reply("{\"t\":\"omniState\",\"available\":false}"); return
        }
        var req = URLRequest(url: url, timeoutInterval: 3)
        req.setValue(tok, forHTTPHeaderField: "X-CMUX-Token")
        httpSession.dataTask(with: req) { data, resp, _ in
            guard let data,
                  (resp as? HTTPURLResponse)?.statusCode == 200,
                  let obj = try? JSONSerialization.jsonObject(with: data),
                  let payload = try? JSONSerialization.data(
                      withJSONObject: ["t": "omniState", "available": true, "state": obj]),
                  let json = String(data: payload, encoding: .utf8) else {
                reply("{\"t\":\"omniState\",\"available\":false}"); return
            }
            reply(json)
        }.resume()
    }

    private static func searchUnavailable(requestID: String?, code: Int? = nil) -> String {
        var payload: [String: Any] = [
            "t": "omniSearch", "id": requestID ?? "", "available": false
        ]
        if let code { payload["code"] = code }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"t\":\"omniSearch\",\"available\":false}"
        }
        return json
    }

    private static func pttResponse(ok: Bool, action: String, requestID: String?) -> String {
        let payload: [String: Any] = [
            "t": "omniPtt", "id": requestID ?? "", "ok": ok, "action": action
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"t\":\"omniPtt\",\"ok\":false}"
        }
        return json
    }
}
