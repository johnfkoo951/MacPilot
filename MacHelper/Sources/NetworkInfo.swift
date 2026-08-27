import Foundation
import Security
import SystemConfiguration

enum NetworkInfo {
    /// mDNS .local 호스트네임 (예: "my-mac.local"). IP가 바뀌어도 안 변함.
    static func localHostName() -> String? {
        guard let cf = SCDynamicStoreCopyLocalHostName(nil) else { return nil }
        let name = (cf as String).trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : "\(name).local"
    }

    /// LAN IPv4 주소를 반환 (en0 = Wi-Fi 우선). 아이폰에 보여줄 접속 주소용.
    static func primaryIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return nil }
        defer { freeifaddrs(ifaddr) }

        var candidates: [String: String] = [:]
        var pointer = ifaddr
        while let ptr = pointer {
            defer { pointer = ptr.pointee.ifa_next }

            let flags = Int32(ptr.pointee.ifa_flags)
            guard let addr = ptr.pointee.ifa_addr,
                  (flags & IFF_UP) != 0,
                  (flags & IFF_LOOPBACK) == 0,
                  addr.pointee.sa_family == UInt8(AF_INET)
            else { continue }

            let name = String(cString: ptr.pointee.ifa_name)
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(addr, socklen_t(addr.pointee.sa_len),
                        &host, socklen_t(host.count),
                        nil, 0, NI_NUMERICHOST)
            candidates[name] = String(cString: host)
        }

        return candidates["en0"] ?? candidates["en1"] ?? candidates.values.first
    }

    /// 브라우저 WebSocket Host 화이트리스트. same-origin 비교만으로는 공격자 도메인이
    /// LAN IP로 재해석되는 DNS rebinding을 막지 못하므로 이 Mac이 실제로 광고하는 이름만 허용한다.
    static func webSocketAllowedHosts() -> Set<String> {
        var hosts: Set<String> = ["localhost", "127.0.0.1", "::1"]
        func add(_ value: String?) {
            guard var value else { return }
            value = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            while value.hasSuffix(".") { value.removeLast() }
            if !value.isEmpty { hosts.insert(value) }
        }
        if let local = localHostName() {
            add(local)
            if local.lowercased().hasSuffix(".local") { add(String(local.dropLast(6))) }
        }
        add(primaryIPv4())
        add(tlsCertCommonName())
        return hosts
    }

    /// `tailscale serve` 로 앞단화된 tailnet HTTPS 주소 (예: https://mac.tailnet.ts.net).
    /// 에어마우스/모션 센서는 iOS가 secure context(HTTPS)에서만 허용하므로 이 주소로 접속해야 동작한다.
    /// serve 미설정이면 nil. tailscale CLI 를 짧게 호출한다(수백 ms).
    static func tailscaleHTTPSURL() -> String? {
        let bins = ["/usr/local/bin/tailscale",
                    "/opt/homebrew/bin/tailscale",
                    "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        guard let bin = bins.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return nil }
        guard let out = runTool(bin, ["serve", "status"]) else { return nil }
        // 출력 예: "https://mac.tailnet.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8766"
        for raw in out.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("https://") else { continue }
            var url = line.split(separator: " ").first.map(String.init) ?? line
            if url.hasSuffix("/") { url.removeLast() }
            return url
        }
        return nil
    }

    /// 앱이 :443에서 서빙하는 인증서(tls/pilot.cer)의 CN → https URL 광고용.
    static func tlsCertCommonName() -> String? {
        let cer = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CmdPilot/tls/pilot.cer")
        guard FileManager.default.fileExists(atPath: cer.path),
              let raw = try? Data(contentsOf: cer) else { return nil }
        let der: Data
        if let pem = String(data: raw, encoding: .utf8), pem.contains("BEGIN CERTIFICATE") {
            let body = pem.components(separatedBy: .newlines)
                .filter { !$0.hasPrefix("-----") }.joined()
            guard let decoded = Data(base64Encoded: body) else { return nil }
            der = decoded
        } else {
            der = raw
        }
        guard let cert = SecCertificateCreateWithData(nil, der as CFData),
              let name = SecCertificateCopySubjectSummary(cert) as String? else { return nil }
        return name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func runTool(_ path: String, _ args: [String]) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()   // stderr 삼킴
        let done = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in done.signal() }
        do { try proc.run() } catch { return nil }
        if done.wait(timeout: .now() + 3) == .timedOut {
            proc.terminate()
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }
}
