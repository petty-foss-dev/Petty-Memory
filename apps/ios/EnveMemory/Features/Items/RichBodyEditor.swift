import EnveMemoryKit
import SwiftUI
import WebKit

// Bundled editor in an isolated web view with no network or persistent website data.
struct RichBodyEditor: UIViewRepresentable {
    @Binding var text: String
    let label: String
    let pickReference: () async -> ItemPicker.Choice?
    let askLink: (String?) async -> String?

    @Environment(\.hearth) var hearth

    /// The built editor ships in the bundle only after `scripts/build-editor.sh`; without it the plain editor is used.
    static var isAvailable: Bool {
        EditorAssets.folder.map { FileManager.default.fileExists(atPath: $0.appending(path: "editor.js").path) } ?? false
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        configuration.setURLSchemeHandler(EditorAssets(), forURLScheme: EditorAssets.scheme)
        configuration.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "pettyEditor")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.load(URLRequest(url: EditorAssets.page))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.update(self)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
    }

    final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
        weak var webView: WKWebView?
        private var parent: RichBodyEditor
        private var isMounted = false
        /// What the editor holds, so only a value changed outside it (never its own echo) is pushed back in.
        private var shown: String
        private var theme: [String: String] = [:]

        init(_ parent: RichBodyEditor) {
            self.parent = parent
            shown = parent.text
        }

        func update(_ parent: RichBodyEditor) {
            self.parent = parent
            guard isMounted else { return }
            if parent.text != shown {
                shown = parent.text
                call("pettyEditorHost.setMarkdown(markdown)", ["markdown": parent.text])
            }
            applyTheme()
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return (nil, nil) }
            switch type {
            case "loaded":
                isMounted = true
                shown = parent.text
                call("pettyEditorHost.mount({ markdown, label, placeholder: '' })", ["markdown": parent.text, "label": parent.label])
                applyTheme()
            case "change":
                guard let markdown = body["markdown"] as? String else { break }
                shown = markdown
                parent.text = markdown
            case "requestLink":
                return (await parent.askLink(body["current"] as? String) ?? NSNull(), nil)
            case "requestReference":
                guard let choice = await parent.pickReference() else { return (NSNull(), nil) }
                return (["id": choice.id, "label": choice.title], nil)
            default:
                break
            }
            return (nil, nil)
        }

        /// Only the bundled page itself; nothing in the text can navigate the editor.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.scheme == EditorAssets.scheme ? .allow : .cancel
        }

        private func applyTheme() {
            let hearth = parent.hearth
            let variables = [
                "--pm-fg": Self.css(hearth.textPrimary), "--pm-muted": Self.css(hearth.textSecondary), "--pm-border": Self.css(hearth.controlBorder),
                "--pm-bg": Self.css(hearth.surface), "--pm-accent": Self.css(hearth.accentText), "--pm-on-accent": Self.css(hearth.onAccent),
                "--pm-hover": Self.css(hearth.accentMuted), "--pm-active": Self.css(hearth.accentMuted), "--pm-code-bg": Self.css(hearth.surfaceSunken),
                "--pm-ref-bg": Self.css(hearth.accentMuted), "--pm-radius": "\(Int(HearthRadius.inner))px",
            ]
            guard variables != theme else { return }
            theme = variables
            call("pettyEditorHost.setTheme(variables)", ["variables": variables])
        }

        private func call(_ body: String, _ arguments: [String: Any]) {
            webView?.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page, completionHandler: nil)
        }

        private static func css(_ color: Color) -> String {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            return "rgba(\(Int(red * 255)), \(Int(green * 255)), \(Int(blue * 255)), \(alpha))"
        }
    }
}

/// Serves the editor's files from the bundle to its web view, and nothing else.
final class EditorAssets: NSObject, WKURLSchemeHandler {
    static let scheme = "petty-editor"
    static let page = URL(string: "\(scheme)://editor/index.html")!
    static let folder = Bundle.main.url(forResource: "Editor", withExtension: nil)

    private static let types = ["index.html": "text/html", "host.js": "text/javascript", "editor.js": "text/javascript",
                                "host.css": "text/css", "editor.css": "text/css"]

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.host() == "editor", url.pathComponents.count == 2,
              let type = Self.types[url.lastPathComponent], let folder = Self.folder,
              let data = try? Data(contentsOf: folder.appending(path: url.lastPathComponent)) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": "\(type); charset=utf-8", "Cache-Control": "no-store"])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
