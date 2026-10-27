import SwiftUI

/// First-run state: the gallery is the first screen, so this is quiet and
/// action-first — no marketing surface, just the two ways to get media in.
struct EmptyLibraryView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "photo.stack")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(.tertiary)

            Text("Your archive starts here")
                .font(.title2.weight(.semibold))

            Text("Add a folder of photos and videos.\nNothing is moved or uploaded — files are indexed in place.")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button {
                    Task { await model.addFolder() }
                } label: {
                    Label("Add Folder…", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    Task { await model.addMountedNetworkFolder() }
                } label: {
                    Label("Add Network Folder…", systemImage: "externaldrive.connected.to.line.below")
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.large)
            .padding(.top, 6)

            Text("Local folders and mounted network shares are available from the Add menu.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct EmptyResultsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if !model.activeScans.isEmpty {
                VStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.large)
                    Text("Indexing your folder…")
                        .font(.headline)
                    Text("Items appear here as they are found.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } else if !model.searchText.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView.search(text: model.searchText)
            } else if model.mediaTypeFilter != nil {
                ContentUnavailableView(
                    model.mediaTypeFilter == .video ? "No videos here" : "No images here",
                    systemImage: model.mediaTypeFilter == .video ? "film" : "photo",
                    description: Text("Try a different filter, or rescan with ⌘R.")
                )
            } else {
                ContentUnavailableView(
                    "No items here",
                    systemImage: "photo.on.rectangle.angled",
                    description: Text("This folder has no indexed media yet. Rescan with ⌘R.")
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ScanStatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text(statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Button("Stop") {
                model.cancelAllScans()
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private var statusText: String {
        let indexed = model.totalActiveScanCount
        let folders = model.activeScans.compactMap(\.value.currentFolderName).first
        var text = "Indexing… \(indexed.formatted()) media items found"
        if let folders {
            text += " — \(folders)"
        }
        return text
    }
}
