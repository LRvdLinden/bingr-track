import SwiftUI
import WebKit
import CryptoKit
import CommonCrypto
import Security

@main
struct BingrTrackApp: App {
    @StateObject private var bridge = TrackBridge()

    var body: some Scene {
        WindowGroup {
            TrackView(bridge: bridge).preferredColorScheme(.dark)
                .onOpenURL { url in
                    if url.scheme == "bingrtrack", url.host == "oauth", url.path == "/trakt" {
                        bridge.invoke("oauth", [url.absoluteString])
                    }
                }
        }
    }
}

struct TrackView: UIViewRepresentable {
    let bridge: TrackBridge

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(bridge, name: "track")
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.navigationDelegate = bridge
        bridge.view = view
        if let file = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            view.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        }
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

final class TrackBridge: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate {
    weak var view: WKWebView?

    private var config: [String: String] {
        ["url": setting("BingrURL"), "key": setting("BingrPublishableKey"), "trakt": setting("TraktClientID")]
    }

    private func setting(_ name: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: name) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func invoke(_ function: String, _ arguments: [Any]) {
        view?.callAsyncJavaScript("window." + function + "(...values)", arguments: ["values": arguments],
                                   in: nil, contentWorld: .page, completionHandler: nil)
    }

    private func reply(_ id: Int, _ value: Any) {
        invoke("reply", [id, ["value": value]])
    }

    private func fail(_ id: Int) {
        invoke("reply", [id, ["error": "De aanvraag kon niet worden uitgevoerd."]])
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any],
              let id = body["id"] as? Int, let action = body["action"] as? String else { return }
        switch action {
        case "config":
            reply(id, config)
        case "open":
            guard let raw = body["url"] as? String, let url = URL(string: raw), url.scheme == "https",
                  ["bingr.online", "trakt.tv"].contains(url.host ?? "") else { fail(id); return }
            UIApplication.shared.open(url)
            reply(id, true)
        case "pkce":
            guard let verifier = randomToken(), let state = randomToken() else { fail(id); return }
            reply(id, ["verifier": verifier, "state": state, "challenge": base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))])
        case "verifyPIN":
            guard let pin = body["pin"] as? String, let hash = body["hash"] as? [String: Any] else { fail(id); return }
            DispatchQueue.global(qos: .userInitiated).async {
                let valid = Self.verify(pin, hash)
                DispatchQueue.main.async { self.reply(id, valid) }
            }
        case "request":
            send(body, id)
        default:
            fail(id)
        }
    }

    private func randomToken() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        return base64URL(Data(bytes))
    }

    private func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func verify(_ pin: String, _ hash: [String: Any]) -> Bool {
        guard pin.range(of: "^[0-9]{4,8}$", options: .regularExpression) != nil,
              hash["alg"] as? String == "pbkdf2-sha256", let rounds = hash["iter"] as? Int,
              (10_000...2_000_000).contains(rounds), let saltText = hash["salt"] as? String,
              let salt = Data(base64Encoded: saltText), salt.count == 16, let hashText = hash["hash"] as? String,
              let expected = Data(base64Encoded: hashText), expected.count == 32 else { return false }
        let saltBytes = [UInt8](salt)
        var output = [UInt8](repeating: 0, count: 32)
        let result = pin.withCString { password in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, pin.utf8.count,
                                 saltBytes, saltBytes.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                                 UInt32(rounds), &output, 32)
        }
        return result == kCCSuccess && zip(expected, output).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    private func send(_ body: [String: Any], _ id: Int) {
        guard let raw = body["url"] as? String, let url = URL(string: raw), url.scheme == "https",
              let host = url.host, [URL(string: setting("BingrURL"))?.host, "api.trakt.tv"].contains(host),
              let method = body["method"] as? String, ["GET", "POST"].contains(method) else { fail(id); return }
        var request = URLRequest(url: url, timeoutInterval: 25)
        request.httpMethod = method
        for (name, value) in body["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
        if let payload = body["body"], JSONSerialization.isValidJSONObject(payload) {
            request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        session.dataTask(with: request) { data, response, _ in
            session.finishTasksAndInvalidate()
            let status = (response as? HTTPURLResponse)?.statusCode
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0, options: .fragmentsAllowed) }
            DispatchQueue.main.async {
                if let status { self.reply(id, ["status": status, "data": json ?? NSNull()]) }
                else { self.fail(id) }
            }
        }.resume()
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
