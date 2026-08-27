import CryptoKit
import Foundation

/// 선택적 PIN 페어링. **기본 비활성**(이전과 동일하게 같은 Wi-Fi면 누구나 접속).
/// 활성화하면 폰이 PIN 을 1회 입력 → 서버가 쿠키(`mp_auth`)를 발급한다. 같은 오리진이라
/// 브라우저가 `/ws` 핸드셰이크에도 쿠키를 자동 첨부 → **웹 클라이언트는 무변경**.
/// 토큰은 PIN 에서 파생(stateless)되어 서버 재시작에도 페어링이 유지된다.
final class Pairing {
    static let cookieName = "mp_auth"

    private let lock = NSLock()
    private var _enabled: Bool
    private var _pin: String
    private var _token: String
    private var _authorizationEpoch: UInt64 = 1
    private struct AttemptState {
        var failures: Int
        var blockedUntil: Date
        var lastSeen: Date
    }
    private var attemptsByPeer: [String: AttemptState] = [:]

    init() {
        let d = UserDefaults.standard
        _enabled = d.bool(forKey: "pairingEnabled")
        if let saved = d.string(forKey: "pairingPin"), saved.count == 6 {
            _pin = saved
        } else {
            _pin = Pairing.generatePin()
            d.set(_pin, forKey: "pairingPin")
        }
        _token = Pairing.token(for: _pin)
    }

    var enabled: Bool { lock.lock(); defer { lock.unlock() }; return _enabled }
    var pin: String { lock.lock(); defer { lock.unlock() }; return _pin }

    func setEnabled(_ on: Bool) {
        lock.lock()
        if _enabled != on { _authorizationEpoch &+= 1 }
        _enabled = on
        lock.unlock()
        UserDefaults.standard.set(on, forKey: "pairingEnabled")
    }

    func regeneratePin() {
        let p = Pairing.generatePin()
        lock.lock()
        _pin = p
        _token = Pairing.token(for: p)
        _authorizationEpoch &+= 1
        attemptsByPeer.removeAll()
        lock.unlock()
        UserDefaults.standard.set(p, forKey: "pairingPin")
    }

    /// 6자리 PIN (암호학적 RNG)
    static func generatePin() -> String {
        String(format: "%06d", Int.random(in: 0 ..< 1_000_000))
    }

    private static func token(for pin: String) -> String {
        let digest = SHA256.hash(data: Data(("macpilot-pair-v1:" + pin).utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// 성공한 PIN 입력 후 쿠키에 넣을 토큰
    func currentToken() -> String { lock.lock(); defer { lock.unlock() }; return _token }

    func verifyPin(_ candidate: String?, peer: String) -> Bool {
        let now = Date()
        lock.lock()
        if let attempt = attemptsByPeer[peer], attempt.blockedUntil > now {
            lock.unlock()
            return false
        }
        let pin = _pin
        if Pairing.constantTimeEqual(candidate, pin) {
            attemptsByPeer.removeValue(forKey: peer)
            lock.unlock()
            return true
        }
        let failures = min((attemptsByPeer[peer]?.failures ?? 0) + 1, 10)
        let delay = min(30.0, pow(2.0, Double(failures - 1)))
        attemptsByPeer[peer] = AttemptState(
            failures: failures,
            blockedUntil: now.addingTimeInterval(delay),
            lastSeen: now
        )
        if attemptsByPeer.count > 256,
           let oldest = attemptsByPeer.min(by: { $0.value.lastSeen < $1.value.lastSeen })?.key {
            attemptsByPeer.removeValue(forKey: oldest)
        }
        lock.unlock()
        return false
    }

    /// 요청 인가 여부. **비활성이면 항상 true(개방)** → 하위 호환.
    func isAuthorized(cookieToken: String?) -> Bool {
        lock.lock(); let on = _enabled; let tok = _token; lock.unlock()
        if !on { return true }
        return Pairing.constantTimeEqual(cookieToken, tok)
    }

    /// WS 업그레이드 시 유효한 쿠키에 현재 epoch를 부여한다. PIN 전환·재생성은 epoch를
    /// 즉시 바꾸므로 closeAllConnections가 큐에서 실행되기 전에도 이전 연결은 폐기된다.
    func authorizedEpoch(cookieToken: String?) -> UInt64? {
        lock.lock()
        let on = _enabled, tok = _token, epoch = _authorizationEpoch
        lock.unlock()
        guard on, Pairing.constantTimeEqual(cookieToken, tok) else { return nil }
        return epoch
    }

    func isCurrentAuthorization(epoch: UInt64?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return _enabled && epoch == _authorizationEpoch
    }

    static func readCookie(_ header: String?, name: String) -> String? {
        guard let header else { return nil }
        for part in header.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces) == name {
                return kv[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    private static func constantTimeEqual(_ a: String?, _ b: String) -> Bool {
        guard let a else { return false }
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0 ..< y.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }

    /// 미인증 접속 시 보여줄 자체완결 PIN 입력 페이지(인라인 CSS, 재사용 웹 클라이언트 비의존).
    static func pairPageHTML(error: Bool) -> String {
        let err = error ? "PIN이 올바르지 않습니다. 다시 시도하세요." : ""
        return """
        <!DOCTYPE html>
        <html lang="ko">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <meta name="theme-color" content="#141416">
        <title>CmdPilot · 연결</title>
        <style>
          :root { color-scheme: dark; }
          * { box-sizing: border-box; }
          body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
                 background:#141416; color:#f2f2f4; font:16px/1.5 -apple-system,system-ui,sans-serif; }
          .card { width:min(92vw,360px); background:#1c1c20; border:1px solid #2a2a30; border-radius:18px;
                  padding:28px 24px; box-shadow:0 12px 40px rgba(0,0,0,.4); }
          h1 { margin:0 0 4px; font-size:20px; }
          p { margin:0 0 18px; color:#9a9aa2; font-size:14px; }
          input { width:100%; padding:14px; font-size:24px; letter-spacing:6px; text-align:center;
                  background:#0f0f12; color:#fff; border:1px solid #3a3a42; border-radius:12px; }
          button { width:100%; margin-top:14px; padding:14px; font-size:16px; font-weight:600;
                   background:#85714D; color:#fff; border:0; border-radius:12px; }
          .err { color:#ff7b7b; font-size:13px; margin-top:10px; min-height:18px; text-align:center; }
        </style>
        </head>
        <body>
          <form class="card" action="/pair" method="get" autocomplete="off">
            <h1>CmdPilot 연결</h1>
            <p>Mac 메뉴바에 표시된 PIN을 입력하세요.</p>
            <input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autofocus
                   placeholder="••••••" aria-label="PIN">
            <button type="submit">연결</button>
            <div class="err">\(err)</div>
          </form>
        </body>
        </html>
        """
    }
}
