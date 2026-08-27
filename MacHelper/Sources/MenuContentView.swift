import CoreImage.CIFilterBuiltins
import SwiftUI

/// CMDSPACE 브랜드 컬러 (cmdspace.work 디자인 토큰)
enum CMDSBrand {
    static let green = Color(red: 0x13 / 255, green: 0x45 / 255, blue: 0x38 / 255)   // #134538
    static let pink  = Color(red: 0xE9 / 255, green: 0x85 / 255, blue: 0xA2 / 255)   // #E985A2
}

struct MenuContentView: View {
    @ObservedObject var server: HelperServer

    private var serverTint: Color { server.isRunning ? .green : .orange }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            metrics
            connectionPanel
            permissionPanel
            pairingPanel
            operations
            footer
        }
        .padding(16)
        .frame(width: 360)
        .onAppear { server.refreshAccessibility() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.regularMaterial)
                    .frame(width: 38, height: 38)
                if let logo = NSImage(named: "logo") {
                    // CMDS 라운드 로고 (번들 logo.png)
                    Image(nsImage: logo)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 32, height: 32)
                        .clipShape(Circle())
                } else {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(serverTint)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("CmdPilot")
                    .font(.headline)
                Text(server.launchModeDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            StatusPill(
                title: server.isRunning ? "Online" : "Offline",
                systemImage: server.isRunning ? "checkmark.circle.fill" : "exclamationmark.circle.fill",
                tint: serverTint
            )
        }
    }

    private var metrics: some View {
        HStack(spacing: 8) {
            MetricTile(
                title: "포트",
                value: "\(server.port)",
                systemImage: "network",
                tint: .blue
            )
            MetricTile(
                title: "클라이언트",
                value: "\(server.activeClients)",
                systemImage: server.activeClients > 0 ? "iphone.gen3.radiowaves.left.and.right" : "iphone.slash",
                tint: server.activeClients > 0 ? .green : .secondary
            )
            MetricTile(
                title: "명령",
                value: "\(server.commandCount)",
                systemImage: "keyboard",
                tint: .purple
            )
        }
    }

    private var connectionPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("접속 주소", systemImage: "link")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    server.copyURL()
                } label: {
                    Label("복사", systemImage: "doc.on.doc")
                }
                .labelStyle(.iconOnly)
                .help("접속 주소 복사")

                Button {
                    server.openWebUI()
                } label: {
                    Label("열기", systemImage: "safari")
                }
                .labelStyle(.iconOnly)
                .help("브라우저에서 열기")
            }

            Text(server.httpURL)
                .font(.system(.callout, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

            if !server.ipFallback.isEmpty {
                Text(server.ipFallback)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }

            // 에어마우스/모션 = iOS가 HTTPS(secure context)에서만 허용 → tailnet HTTPS 주소 안내
            if !server.httpsURL.isEmpty {
                Divider().padding(.vertical, 2)
                HStack(spacing: 6) {
                    Image(systemName: "gyroscope").foregroundStyle(.tint)
                    Text("에어마우스·모션 (HTTPS)").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button { server.copyHTTPSURL() } label: {
                        Image(systemName: "doc.on.doc")
                    }.buttonStyle(.borderless).help("HTTPS 주소 복사")
                    Button { server.openURLString(server.httpsURL) } label: {
                        Image(systemName: "safari")
                    }.buttonStyle(.borderless).help("브라우저에서 열기")
                }
                Text(server.httpsURL)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Text("Tailscale 켠 폰에서 이 주소로 접속해야 에어마우스가 동작합니다.")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if server.isRunning, let qr = Self.makeQR(server.httpURL) {
                HStack(spacing: 12) {
                    Image(nsImage: qr)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 104, height: 104)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Label("같은 Wi-Fi에서 접속", systemImage: "wifi")
                            .font(.callout)
                        Text(server.restartBehaviorDescription)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("최근: \(server.lastCommand)")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer()
                }
            }
        }
        .panelStyle()
    }

    private var permissionPanel: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: server.accessibilityGranted ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                .font(.title3)
                .foregroundStyle(server.accessibilityGranted ? .green : .orange)

            VStack(alignment: .leading, spacing: 4) {
                Text(server.accessibilityGranted ? "손쉬운 사용 권한 OK" : "손쉬운 사용 권한 필요")
                    .font(.subheadline.weight(.semibold))
                Text(server.accessibilityGranted ? "마우스/키보드 주입 가능" : "권한이 없으면 명령은 도착해도 실제 입력이 움직이지 않습니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            if server.accessibilityGranted {
                Button {
                    server.refreshAccessibility()
                } label: {
                    Label("새로고침", systemImage: "arrow.clockwise")
                }
                .labelStyle(.iconOnly)
                .help("권한 상태 새로고침")
            } else {
                Button {
                    server.promptAccessibility()
                    server.openAccessibilitySettings()
                } label: {
                    Label("권한 열기", systemImage: "hand.raised.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(CMDSBrand.pink)
                .controlSize(.small)
                .help("손쉬운 사용 설정 열기 — ad-hoc 서명으로 재빌드한 경우 다시 켜야 합니다")
            }
        }
        .panelStyle()
    }

    /// PIN 페어링 (upstream 기능): 같은 네트워크의 타인 접속 차단. 기본 off.
    private var pairingPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { server.pairingEnabled },
                                 set: { server.setPairing($0) })) {
                Label("PIN 페어링", systemImage: "lock.shield")
                    .font(.subheadline.weight(.semibold))
            }
            .toggleStyle(.switch)
            .tint(CMDSBrand.pink)

            if server.pairingEnabled {
                HStack {
                    Text(server.pairingPin)
                        .font(.system(.title3, design: .monospaced))
                        .bold()
                        .textSelection(.enabled)
                    Spacer()
                    Button("새 PIN") { server.regeneratePairingPin() }
                        .controlSize(.small)
                }
                Text("접속하는 기기가 이 PIN을 한 번 입력하면 1년간 기억됩니다. 켜는 순간 기존 연결은 끊깁니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("켜면 같은 네트워크(공용 Wi-Fi 등)의 타인이 함부로 조작하지 못합니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .panelStyle()
    }

    private var operations: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    server.restart()
                } label: {
                    Label("서버 재시작", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }

                Button {
                    server.openLogsFolder()
                } label: {
                    Label("로그", systemImage: "folder")
                        .frame(maxWidth: .infinity)
                }
            }

            HStack(spacing: 8) {
                Button {
                    server.copyStatusCommand()
                } label: {
                    Label("상태 명령 복사", systemImage: "terminal")
                        .frame(maxWidth: .infinity)
                }

                Button(role: .destructive) {
                    NSApplication.shared.terminate(nil)
                } label: {
                    Label("앱 종료", systemImage: "power")
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Circle().fill(CMDSBrand.pink).frame(width: 6, height: 6)
            Text("CMDSPACE")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
            Text("CmdPilot v\(appVersion) · fork of MacPilot(JoonLab)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Spacer()
            Image(systemName: "slider.horizontal.3")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Text("성능 설정은 폰 ⚙")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "-"
    }

    /// 문자열을 QR 코드 NSImage 로 변환
    static func makeQR(_ string: String) -> NSImage? {
        guard !string.isEmpty else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

private struct StatusPill: View {
    let title: String
    let systemImage: String
    let tint: Color

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(tint.opacity(0.12), in: Capsule())
    }
}

private struct MetricTile: View {
    let title: String
    let value: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
            Text(value)
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .monospacedDigit()
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private extension View {
    func panelStyle() -> some View {
        self
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
