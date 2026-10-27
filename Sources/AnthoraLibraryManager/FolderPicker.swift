import AppKit
import LibraryCore

@MainActor
enum FolderPicker {
    static func pickFolders(
        startingAt directoryURL: URL? = nil,
        message: String = "Choose folders of photos and videos. Your files stay exactly where they are — nothing is moved, copied, or uploaded.",
        prompt: String = "Add"
    ) -> [URL] {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.directoryURL = directoryURL
        panel.message = message
        panel.prompt = prompt
        guard panel.runModal() == .OK else { return [] }
        return panel.urls
    }

    static func pickMountedNetworkFolders() -> [URL] {
        pickFolders(
            startingAt: URL(fileURLWithPath: "/Volumes", isDirectory: true),
            message: "Choose the mounted network share or a folder inside it. Tailscale keeps the connection private; \(ProductBrand.appName) indexes the files in place.",
            prompt: "Add Network Folder"
        )
    }

    static func connectNetworkShare() {
        let input = NSTextField(string: "smb://")
        input.placeholderString = "smb://mac-mini-name.local/Share"
        input.frame = NSRect(x: 0, y: 0, width: 360, height: 24)

        let alert = NSAlert()
        alert.messageText = "Connect Network Folder"
        alert.informativeText = "Enter an SMB, AFP, or NFS address. Finder will mount it; then add the mounted folder from /Volumes."
        alert.accessoryView = input
        alert.addButton(withTitle: "Connect in Finder")
        alert.addButton(withTitle: "Cancel")

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let rawValue = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: rawValue),
              ["smb", "afp", "nfs"].contains(url.scheme?.lowercased() ?? "") else {
            NSSound.beep()
            return
        }
        NSWorkspace.shared.open(url)
    }
}
