import Foundation
import Darwin

@MainActor
final class NativeBackendManager: ObservableObject {
    @Published var walletURL: URL?
    @Published var errorMessage: String?

    let userAgent: String
    private var process: Process?
    private var started = false

    init() {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.9.1"
        userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) QRLWallet-Native/\(version) Safari/537.36"
    }

    func start() {
        guard !started else { return }
        started = true
        errorMessage = nil

        Task {
            do {
                let url = try await launchBackend()
                walletURL = url
            } catch {
                errorMessage = error.localizedDescription
                started = false
            }
        }
    }

    private func runtimeRoot() throws -> URL {
        if let envRoot = ProcessInfo.processInfo.environment["QRL_WALLET_ROOT"] {
            return URL(fileURLWithPath: envRoot, isDirectory: true)
        }

        // Packaged: QRLWallet.app/Contents/Resources/runtime
        if let resourceRuntime = Bundle.main.resourceURL?.appendingPathComponent("runtime", isDirectory: true) {
            let server = resourceRuntime.appendingPathComponent("native/backend/server.js")
            if FileManager.default.fileExists(atPath: server.path) {
                return resourceRuntime
            }
        }

        // Dev checkout: walk up to repo root
        var current = Bundle.main.bundleURL
        for _ in 0..<10 {
            let server = current.appendingPathComponent("native/backend/server.js")
            if FileManager.default.fileExists(atPath: server.path) {
                return current
            }
            current.deleteLastPathComponent()
        }

        throw NSError(domain: "QRLWallet", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Unable to locate native runtime",
        ])
    }

    private func launchBackend() async throws -> URL {
        let root = try runtimeRoot()
        let serverJs = root.appendingPathComponent("native/backend/server.js")
        let bundledNode = root.appendingPathComponent("bin/node")
        let port = try freePort()
        let host = "127.0.0.1"
        let url = URL(string: "http://\(host):\(port)/")!

        let proc = Process()
        if FileManager.default.fileExists(atPath: bundledNode.path) {
            proc.executableURL = bundledNode
            proc.arguments = [serverJs.path]
        } else {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", serverJs.path]
        }
        proc.currentDirectoryURL = root

        var env = ProcessInfo.processInfo.environment
        env["BIND_IP"] = host
        env["PORT"] = String(port)
        env["QRL_WALLET_ROOT"] = root.path
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        try proc.run()
        process = proc

        try await waitForReady(url: url.appendingPathComponent("api/health"))
        return url
    }

    private func waitForReady(url: URL, timeout: TimeInterval = 60) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let (_, response) = try? await URLSession.shared.data(from: url),
               let http = response as? HTTPURLResponse,
               (200..<500).contains(http.statusCode) {
                return
            }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        throw NSError(domain: "QRLWallet", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for native backend",
        ])
    }

    private func freePort() throws -> Int {
        let socketFD = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else {
            throw NSError(domain: "QRLWallet", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unable to allocate local port",
            ])
        }
        defer { Darwin.close(socketFD) }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        addr.sin_port = 0

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            throw NSError(domain: "QRLWallet", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unable to allocate local port",
            ])
        }

        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        var bound = sockaddr_in()
        let nameResult = withUnsafeMutablePointer(to: &bound) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(socketFD, $0, &len)
            }
        }
        guard nameResult == 0 else {
            throw NSError(domain: "QRLWallet", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unable to read allocated port",
            ])
        }

        return Int(UInt16(bigEndian: bound.sin_port))
    }

    deinit {
        process?.terminate()
    }
}
