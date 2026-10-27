import AppKit
import SwiftUI

@main
struct AnthoraLibraryManagerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .task { await model.bootstrap() }
                .frame(minWidth: 760, minHeight: 480)
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Add Folder…") {
                    Task { await model.addFolder() }
                }
                .keyboardShortcut("o", modifiers: .command)

                Button("Connect SMB Share…") {
                    model.connectNetworkShare()
                }

                Button("Add Mounted Network Folder…") {
                    Task { await model.addMountedNetworkFolder() }
                }

                Button("Rescan") {
                    model.rescanSelection()
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.libraries.isEmpty)

                Button("Reveal in Finder") {
                    model.revealFocusedItem()
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(model.selectedItem == nil && model.viewerItem == nil)
            }

            CommandGroup(after: .textEditing) {
                Button("Find") {
                    model.requestSearchFocus()
                }
                .keyboardShortcut("f", modifiers: .command)
            }

            CommandGroup(after: .toolbar) {
                Button("Larger Thumbnails") {
                    model.stepGridZoom(1)
                }
                .keyboardShortcut("=", modifiers: .command)
                .disabled(model.gridZoom == .large)

                Button("Smaller Thumbnails") {
                    model.stepGridZoom(-1)
                }
                .keyboardShortcut("-", modifiers: .command)
                .disabled(model.gridZoom == .small)

                Divider()
            }
        }

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}

/// Ensures the app behaves as a regular foreground app even when the binary
/// is launched outside a finished .app bundle (e.g. `swift run`).
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
