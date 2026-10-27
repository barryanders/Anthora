import AppKit
import LibraryCore
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selection) {
            Section("Media") {
                Label("All Items", systemImage: "square.grid.2x2")
                    .tag(SidebarSelection.allItems)
                Label("Recently Added", systemImage: "clock")
                    .tag(SidebarSelection.recentlyAdded)
                Label("Favorites", systemImage: "heart")
                    .tag(SidebarSelection.favorites)
            }

            Section("Folders") {
                ForEach(model.libraries) { library in
                    if let tree = model.folderTrees[library.id] {
                        OutlineGroup([tree], children: \.children) { node in
                            FolderNodeRow(node: node, library: library)
                                .tag(selection(for: node))
                        }
                    } else {
                        // Library added but not yet scanned into the tree.
                        LibraryRow(library: library)
                            .tag(SidebarSelection.library(library.id))
                    }
                }
                if model.libraries.isEmpty {
                    Text("No folders yet")
                        .foregroundStyle(.tertiary)
                        .font(.callout)
                }
            }

            Section(ProductBrand.anthologies) {
                ForEach(model.collections) { collection in
                    CollectionRow(collection: collection)
                        .tag(SidebarSelection.collection(collection.id))
                }
                Button {
                    model.promptNewCollection()
                } label: {
                    Label("New Album…", systemImage: "plus.circle")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            // The sidebar keeps one quiet entry point for local or mounted folders.
            Button {
                Task { await model.addFolder() }
            } label: {
                Label("Add Folder", systemImage: "plus.circle")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .padding(10)
        }
    }

    private func selection(for node: FolderNode) -> SidebarSelection {
        node.isLibraryRoot
            ? .library(node.libraryID)
            : .folder(libraryID: node.libraryID, folderID: node.id, path: node.path)
    }
}

/// A row in the folder outline: the library root or any nested subfolder.
private struct FolderNodeRow: View {
    @Environment(AppModel.self) private var model
    let node: FolderNode
    let library: LibraryRecord

    var body: some View {
        HStack {
            Label(node.name, systemImage: node.isLibraryRoot ? "folder.badge.gearshape" : "folder")
                .lineLimit(1)
            Spacer()
            if node.isLibraryRoot, model.activeScans[library.id] != nil {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(node.subtreeCount.formatted())
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .contextMenu {
            if node.isLibraryRoot {
                Button("Rescan") {
                    model.rescan(libraryID: library.id)
                }
                Button("Reveal in Finder") {
                    model.revealLibraryInFinder(library)
                }
                Divider()
                Button("Remove from \(ProductBrand.appName)…", role: .destructive) {
                    model.confirmRemoveLibrary(library)
                }
            } else {
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(
                        [URL(fileURLWithPath: node.path, isDirectory: true)]
                    )
                }
            }
        }
        .help(node.path)
    }
}

private struct LibraryRow: View {
    @Environment(AppModel.self) private var model
    let library: LibraryRecord

    var body: some View {
        HStack {
            Label(library.name, systemImage: "folder")
                .lineLimit(1)
            Spacer()
            if model.activeScans[library.id] != nil {
                ProgressView()
                    .controlSize(.small)
            } else if let count = model.libraryCounts[library.id] {
                Text(count.formatted())
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .contextMenu {
            Button("Rescan") {
                model.rescan(libraryID: library.id)
            }
            Button("Reveal in Finder") {
                model.revealLibraryInFinder(library)
            }
            Divider()
            Button("Remove from \(ProductBrand.appName)…", role: .destructive) {
                model.confirmRemoveLibrary(library)
            }
        }
        .help(library.rootPath)
    }
}

private struct CollectionRow: View {
    @Environment(AppModel.self) private var model
    let collection: CollectionRecord
    @State private var isRenaming = false
    @State private var nameDraft = ""

    var body: some View {
        HStack {
            Label(collection.name, systemImage: "rectangle.stack")
                .lineLimit(1)
            Spacer()
            Text(collection.itemCount.formatted())
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .contextMenu {
            Button("Rename…") {
                nameDraft = collection.name
                isRenaming = true
            }
            Button("Delete Album", role: .destructive) {
                model.deleteCollection(collection)
            }
        }
        .alert("Rename Album", isPresented: $isRenaming) {
            TextField("Name", text: $nameDraft)
            Button("Rename") {
                model.renameCollection(collection, to: nameDraft)
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}
