import AppKit
import LibraryCore
import SwiftUI
import UniformTypeIdentifiers
import WebKit

@main
struct AnthoraApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var library = LocalLibraryModel()

    var body: some Scene {
        WindowGroup(ProductBrand.appName) {
            Group {
                if let serviceURL = library.bootstrapURL {
                    AnthoraWebView(serviceURL: serviceURL, library: library)
                } else {
                    LocalStartupView(library: library)
                }
            }
                .frame(minWidth: 780, minHeight: 540)
                .ignoresSafeArea()
                .onOpenURL { url in
                    Task { try? await library.openLibrary(at: url) }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 820)
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Reload") {
                    NotificationCenter.default.post(name: .reloadAnthora, object: nil)
                }
                .keyboardShortcut("r", modifiers: .command)
            }
            CommandGroup(after: .help) {
                Button("Check for Updates…") {
                    AnthoraSupport.openUpdates()
                }
                Button("Report a Problem…") {
                    AnthoraSupport.openProblemReport()
                }
            }
        }
    }
}

private enum AnthoraSupport {
    private static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
    }

    static func openUpdates() {
        var components = URLComponents(string: "https://github.com/barryanders/Anthora/releases")
        components?.queryItems = [
            URLQueryItem(name: "app", value: "anthora"),
            URLQueryItem(name: "name", value: ProductBrand.appName),
            URLQueryItem(name: "version", value: version),
        ]
        if let url = components?.url { NSWorkspace.shared.open(url) }
    }

    static func openProblemReport() {
        var components = URLComponents(string: "https://github.com/barryanders/Anthora/issues")
        components?.queryItems = [
            URLQueryItem(name: "app", value: "anthora"),
            URLQueryItem(name: "name", value: ProductBrand.appName),
            URLQueryItem(name: "version", value: version),
            URLQueryItem(name: "os", value: ProcessInfo.processInfo.operatingSystemVersionString),
        ]
        if let url = components?.url { NSWorkspace.shared.open(url) }
    }
}

private struct LocalStartupView: View {
    @Bindable var library: LocalLibraryModel

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.98, green: 0.96, blue: 1), Color(red: 0.92, green: 0.97, blue: 1)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 18) {
                ZStack {
                    RoundedRectangle(cornerRadius: 25)
                        .fill(Color(red: 0.34, green: 0.19, blue: 0.92))
                        .frame(width: 86, height: 86)
                        .rotationEffect(.degrees(-6))
                    Text("A")
                        .font(.system(size: 47, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }

                if let error = library.localError {
                    Text("Anthora couldn't start")
                        .font(.system(size: 28, weight: .semibold))
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 430)
                    Button("Try again") { Task { await library.retry() } }
                        .buttonStyle(.borderedProminent)
                } else {
                    ProgressView()
                        .controlSize(.small)
                    Text("Opening your library")
                        .font(.system(size: 21, weight: .semibold))
                    Text("Everything stays on this Mac.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(48)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

extension Notification.Name {
    static let reloadAnthora = Notification.Name("reloadAnthora")
}

struct AnthoraWebView: NSViewRepresentable {
    let serviceURL: URL
    let library: LocalLibraryModel

    func makeCoordinator() -> Coordinator { Coordinator(library: library) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.addScriptMessageHandler(
            context.coordinator,
            contentWorld: .page,
            name: "anthora"
        )
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            document.documentElement.dataset.shell = 'native';
            const anthoraWindowRegion = target => target.closest('.topbar, .brand');
            document.addEventListener('mousedown', event => {
              if (event.button !== 0) return;
              const region = anthoraWindowRegion(event.target);
              if (!region) return;
              const interactive = event.target.closest('button, input, select, a, [role="button"]');
              if (interactive && !interactive.classList.contains('brand')) return;
              window.webkit.messageHandlers.anthora.postMessage({action: 'dragWindow'});
            });
            document.addEventListener('dblclick', event => {
              const region = anthoraWindowRegion(event.target);
              if (!region) return;
              const interactive = event.target.closest('button, input, select, a, [role="button"]');
              if (interactive && !interactive.classList.contains('brand')) return;
              event.preventDefault();
              window.webkit.messageHandlers.anthora.postMessage({action: 'toggleZoom'});
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        context.coordinator.allowedOrigin = serviceURL.origin
        context.coordinator.loadedURL = serviceURL
        if serviceURL.host == "127.0.0.1" || serviceURL.host == "localhost" {
            configuration.userContentController.addUserScript(WKUserScript(
                source: """
                window.anthoraNative = {
                  saveBookPDF: (name, data) => window.webkit.messageHandlers.anthora.postMessage({action: 'saveBookPDF', name, data}),
                  readDroppedFolders: () => window.webkit.messageHandlers.anthora.postMessage({action: 'readDroppedFolders'}),
                  chooseFolder: () => window.webkit.messageHandlers.anthora.postMessage({action: 'chooseFolder'}),
                  revealPath: (path) => window.webkit.messageHandlers.anthora.postMessage({action: 'revealPath', path}),
                  libraries: () => window.webkit.messageHandlers.anthora.postMessage({action: 'libraries'}),
                  createLibrary: () => window.webkit.messageHandlers.anthora.postMessage({action: 'createLibrary'}),
                  openLibrary: () => window.webkit.messageHandlers.anthora.postMessage({action: 'openLibrary'}),
                  switchLibrary: (id) => window.webkit.messageHandlers.anthora.postMessage({action: 'switchLibrary', id})
                };
                """,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            context.coordinator.hasNativeBridge = true
        }
        let view = AnthoraTitlebarWebView(frame: .zero, configuration: configuration)
        view.initialRequest = URLRequest(
            url: serviceURL,
            cachePolicy: .reloadIgnoringLocalCacheData
        )
        view.onWindowAttached = { [weak coordinator = context.coordinator, weak view] window in
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.styleMask.insert(.fullSizeContentView)
            window.toolbar = nil
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = true
            guard let view else { return }
            coordinator?.manageWindow(window, webView: view)
        }
        view.navigationDelegate = context.coordinator
        view.onLayout = { [weak coordinator = context.coordinator] in
            coordinator?.positionNativeWindowControls()
        }
        view.allowsMagnification = true
        context.coordinator.observer = NotificationCenter.default.addObserver(
            forName: .reloadAnthora, object: nil, queue: .main
        ) { [weak view] _ in
            Task { @MainActor in
                guard let view else { return }
                if view.url == nil {
                    view.loadInitialRequestIfReady()
                } else {
                    view.reload()
                }
            }
        }
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard context.coordinator.loadedURL != serviceURL else { return }
        context.coordinator.allowedOrigin = serviceURL.origin
        context.coordinator.loadedURL = serviceURL
        nsView.load(URLRequest(url: serviceURL, cachePolicy: .reloadRevalidatingCacheData))
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        coordinator.stopManagingWindow()
        if let observer = coordinator.observer { NotificationCenter.default.removeObserver(observer) }
        nsView.configuration.userContentController.removeScriptMessageHandler(
            forName: "anthora",
            contentWorld: .page
        )
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        let library: LocalLibraryModel
        var observer: NSObjectProtocol?
        var allowedOrigin: String?
        var loadedURL: URL?
        var hasNativeBridge = false
        private weak var managedWindow: NSWindow?
        private weak var managedWebView: WKWebView?
        private var windowObservers: [NSObjectProtocol] = []
        private var nativeButtonOffsets: [CGFloat] = []
        private let toolbarHeight: CGFloat = 68

        init(library: LocalLibraryModel) {
            self.library = library
        }

        func manageWindow(_ window: NSWindow, webView: WKWebView) {
            managedWindow = window
            managedWebView = webView
            let nativeButtons = [
                window.standardWindowButton(.closeButton),
                window.standardWindowButton(.miniaturizeButton),
                window.standardWindowButton(.zoomButton),
            ].compactMap { $0 }
            let leadingX = nativeButtons.first?.frame.minX ?? 0
            nativeButtonOffsets = nativeButtons.map { $0.frame.minX - leadingX }
            stopObservingWindow()
            let names: [Notification.Name] = [
                NSWindow.didBecomeKeyNotification,
                NSWindow.didResizeNotification,
                NSWindow.didEndLiveResizeNotification,
                NSWindow.didExitFullScreenNotification,
            ]
            windowObservers = names.map { name in
                NotificationCenter.default.addObserver(
                    forName: name,
                    object: window,
                    queue: .main
                ) { [weak self] _ in
                    Task { @MainActor in self?.positionNativeWindowControls() }
                }
            }
            positionNativeWindowControls()
            DispatchQueue.main.async { [weak self] in
                self?.positionNativeWindowControls()
            }
        }

        func stopManagingWindow() {
            stopObservingWindow()
            managedWindow = nil
            managedWebView = nil
        }

        private func stopObservingWindow() {
            windowObservers.forEach(NotificationCenter.default.removeObserver)
            windowObservers.removeAll()
        }

        func positionNativeWindowControls() {
            guard let window = managedWindow, let webView = managedWebView,
                  webView.bounds.height > 0, !window.styleMask.contains(.fullScreen) else { return }
            let buttons = [
                window.standardWindowButton(.closeButton),
                window.standardWindowButton(.miniaturizeButton),
                window.standardWindowButton(.zoomButton),
            ].compactMap { $0 }
            // AppKit's compact titlebar is shorter than our toolbar. Keep the
            // native hierarchy, but give its leading control region enough
            // height for both drawing and hit testing. Limit its width so the
            // titlebar cannot intercept the web search and sidebar controls.
            if let titlebar = buttons.first?.superview,
               let host = titlebar.superview,
               host !== window.contentView {
                let width: CGFloat = 96
                let hostFrame = NSRect(x: host.frame.minX,
                                       y: host.frame.maxY - toolbarHeight,
                                       width: width, height: toolbarHeight)
                if host.frame != hostFrame { host.frame = hostFrame }
                let titlebarFrame = NSRect(x: 0, y: 0, width: width, height: toolbarHeight)
                if titlebar.frame != titlebarFrame { titlebar.frame = titlebarFrame }
            }
            for (index, button) in buttons.enumerated() {
                button.isHidden = false
                guard let container = button.superview else { continue }
                // Move the actual AppKit buttons without changing their size,
                // artwork, actions, or native horizontal spacing. Convert the
                // center first so flipped titlebar views align correctly too.
                let offset = nativeButtonOffsets.indices.contains(index)
                    ? nativeButtonOffsets[index] : CGFloat(index * 20)
                let headerCenter = NSPoint(
                    x: 20 + offset + button.frame.width / 2,
                    y: webView.isFlipped ? toolbarHeight / 2 : webView.bounds.height - toolbarHeight / 2
                )
                let center = container.convert(webView.convert(headerCenter, to: nil), from: nil)
                button.setFrameOrigin(NSPoint(
                    x: center.x - button.frame.width / 2,
                    y: center.y - button.frame.height / 2
                ))
                container.updateTrackingAreas()
                button.updateTrackingAreas()
                window.invalidateCursorRects(for: button)
            }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
        ) {
            guard let body = message.body as? [String: Any],
                  let action = body["action"] as? String else {
                replyHandler(nil, "Unsupported Anthora action")
                return
            }
            if action == "dragWindow" {
                if let event = NSApp.currentEvent {
                    managedWindow?.performDrag(with: event)
                }
                replyHandler(["dragging": true], nil)
                return
            }
            if action == "toggleZoom" {
                managedWindow?.zoom(nil)
                replyHandler(["zoomed": true], nil)
                return
            }
            if action == "readDroppedFolders" {
                guard hasNativeBridge, message.frameInfo.isMainFrame,
                      message.frameInfo.request.url?.origin == allowedOrigin,
                      message.frameInfo.securityOrigin.host == "127.0.0.1" || message.frameInfo.securityOrigin.host == "localhost" else {
                    replyHandler(nil, "Folder drops are available only in the local Anthora app.")
                    return
                }
                let urls = NSPasteboard(name: .drag).readObjects(
                    forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]
                ) as? [URL] ?? []
                do {
                    let paths = try SourceFolderSelection.paths(from: urls)
                    replyHandler(paths.map { ["path": $0, "name": URL(fileURLWithPath: $0).lastPathComponent] }, nil)
                } catch { replyHandler(nil, error.localizedDescription) }
                return
            }
            if action == "saveBookPDF" {
                guard message.frameInfo.isMainFrame,
                      message.frameInfo.request.url?.origin == allowedOrigin,
                      message.frameInfo.securityOrigin.host == "127.0.0.1" || message.frameInfo.securityOrigin.host == "localhost",
                      let encoded = body["data"] as? String, encoded.count < 100_000_000,
                      let data = Data(base64Encoded: encoded), data.starts(with: Data("%PDF-".utf8)) else {
                    replyHandler(nil, "Invalid book PDF")
                    return
                }
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.pdf]
                panel.nameFieldStringValue = String((body["name"] as? String ?? "Anthora book.pdf").prefix(100))
                panel.begin { result in
                    guard result == .OK, let url = panel.url else {
                        replyHandler(["cancelled": true], nil)
                        return
                    }
                    do {
                        try data.write(to: url, options: .atomic)
                        replyHandler(["saved": true], nil)
                    } catch { replyHandler(nil, error.localizedDescription) }
                }
                return
            }
            if action == "revealPath" {
                guard let path = body["path"] as? String, !path.isEmpty else {
                    replyHandler(nil, "A folder path is required")
                    return
                }
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                replyHandler(["revealed": true], nil)
                return
            }
            if action == "libraries" {
                replyHandler(library.libraryPayload(), nil)
                return
            }
            if action == "switchLibrary" {
                guard let id = body["id"] as? String else {
                    replyHandler(nil, "Choose a library")
                    return
                }
                Task { @MainActor in
                    await library.switchLibrary(id: id)
                    if let error = library.localError {
                        replyHandler(nil, error)
                    } else {
                        replyHandler(library.libraryPayload(), nil)
                    }
                }
                return
            }
            if action == "createLibrary" || action == "openLibrary" {
                let panel: NSSavePanel = action == "createLibrary" ? NSSavePanel() : NSOpenPanel()
                panel.allowedContentTypes = [.init(filenameExtension: "anthora")!]
                panel.canCreateDirectories = true
                panel.title = action == "createLibrary" ? "Create Anthora Library" : "Open Anthora Library"
                panel.prompt = action == "createLibrary" ? "Create Library" : "Open Library"
                if action == "createLibrary" {
                    panel.nameFieldStringValue = "New Library.anthora"
                } else if let openPanel = panel as? NSOpenPanel {
                    openPanel.canChooseDirectories = true
                    openPanel.canChooseFiles = true
                    openPanel.allowsMultipleSelection = false
                }
                panel.begin { response in
                    guard response == .OK, let url = panel.url else {
                        replyHandler(nil, nil)
                        return
                    }
                    Task { @MainActor in
                        do {
                            if action == "createLibrary" {
                                try await self.library.createLibrary(at: url)
                            } else {
                                try await self.library.openLibrary(at: url)
                            }
                            replyHandler(self.library.libraryPayload(), nil)
                        } catch {
                            replyHandler(nil, error.localizedDescription)
                        }
                    }
                }
                return
            }
            guard action == "chooseFolder" else {
                replyHandler(nil, "Unsupported Anthora action")
                return
            }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = false
            panel.prompt = "Choose Folder"
            panel.message = "Anthora will index photos and videos in place."
            panel.begin { response in
                guard response == .OK, let url = panel.url else {
                    replyHandler(nil, nil)
                    return
                }
                replyHandler(["path": url.path, "name": url.lastPathComponent], nil)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            guard navigationAction.request.url?.origin != allowedOrigin else {
                decisionHandler(.allow)
                return
            }
            if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
}

final class AnthoraTitlebarWebView: WKWebView {
    var onWindowAttached: ((NSWindow) -> Void)?
    var onLayout: (() -> Void)?
    var initialRequest: URLRequest?
    private var hasStartedInitialLoad = false

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window { onWindowAttached?(window) }
        loadInitialRequestIfReady()
    }

    override func layout() {
        super.layout()
        loadInitialRequestIfReady()
        onLayout?()
    }

    func loadInitialRequestIfReady() {
        guard !hasStartedInitialLoad,
              window != nil,
              bounds.width > 0,
              bounds.height > 0,
              let initialRequest else { return }
        hasStartedInitialLoad = true
        load(initialRequest)
    }
}

private extension URL {
    var origin: String? {
        guard let scheme, let host else { return nil }
        return "\(scheme)://\(host):\(port ?? (scheme == "https" ? 443 : 80))"
    }
}
