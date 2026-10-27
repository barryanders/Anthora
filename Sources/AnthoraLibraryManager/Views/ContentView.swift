import LibraryCore
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.system

    var body: some View {
        @Bindable var model = model
        ZStack {
            NavigationSplitView {
                SidebarView()
                    .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 320)
            } detail: {
                DetailView()
            }

            if model.viewerItem != nil {
                ViewerView()
                    .transition(.opacity)
            }
        }
        .animation(
            .easeOut(duration: 0.15),
            value: model.viewerItem != nil
        )
        .preferredColorScheme(appearance.colorScheme)
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
        .alert("New Album", isPresented: $model.isNamingCollection) {
            TextField("Name", text: $model.collectionNameDraft)
            Button("Create") { model.createCollectionFromPrompt() }
            Button("Cancel", role: .cancel) { model.pendingCollectionMember = nil }
        } message: {
            Text(
                model.pendingCollectionMember == nil
                    ? "Albums group items without moving any files."
                    : "“\(model.pendingCollectionMember?.filename ?? "")” will be added to the new album."
            )
        }
        .confirmationDialog(
            "Remove “\(model.libraryPendingRemoval?.name ?? "")” from \(ProductBrand.appName)?",
            isPresented: Binding(
                get: { model.libraryPendingRemoval != nil },
                set: { if !$0 { model.libraryPendingRemoval = nil } }
            )
        ) {
            Button("Remove Folder", role: .destructive) {
                if let library = model.libraryPendingRemoval {
                    model.removeLibrary(library)
                }
                model.libraryPendingRemoval = nil
            }
            Button("Cancel", role: .cancel) {
                model.libraryPendingRemoval = nil
            }
        } message: {
            Text("Only \(ProductBrand.appName)'s index is removed. The folder and its files on disk are not touched.")
        }
    }
}

struct DetailView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            content
            if !model.activeScans.isEmpty {
                ScanStatusBar()
            }
        }
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItemGroup {
                TextField("Search", text: $model.searchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 190)
                    .focused($searchFocused)

                Picker("Media Type", selection: $model.mediaTypeFilter) {
                    Text("All").tag(MediaType?.none)
                    Text("Images").tag(MediaType?.some(.image))
                    Text("Videos").tag(MediaType?.some(.video))
                }
                .pickerStyle(.segmented)

                Menu {
                    Picker("AI Filter", selection: $model.aiContentFilter) {
                        Text("All Items").tag(AIContentFilter.all)
                        Text("Text-heavy").tag(AIContentFilter.textHeavy)
                        Text("Other analyzed images").tag(AIContentFilter.other)
                        Text("Unanalyzed images").tag(AIContentFilter.unanalyzed)
                    }

                    Divider()

                    if model.aiAnalysisProgress == nil {
                        Button("Analyze Unanalyzed Images") {
                            model.startAIAnalysis()
                        }
                    } else {
                        Button("Stop Analysis", role: .destructive) {
                            model.cancelAIAnalysis()
                        }
                    }
                } label: {
                    if let progress = model.aiAnalysisProgress {
                        Label(
                            "\(progress.completed.formatted()) / \(progress.total.formatted())",
                            systemImage: "sparkle.magnifyingglass"
                        )
                    } else {
                        Label("AI", systemImage: "sparkle.magnifyingglass")
                    }
                }
                .help("Analyze and filter images locally")

                Menu {
                    Picker("Sort", selection: $model.sort) {
                        Text("Newest First").tag(MediaSort.newestFirst)
                        Text("Oldest First").tag(MediaSort.oldestFirst)
                        Text("Name").tag(MediaSort.nameAscending)
                        Text("Recently Added").tag(MediaSort.recentlyAdded)
                    }
                    Divider()

                    Picker("Thumbnail Size", selection: $model.gridZoom) {
                        ForEach(GridZoom.allCases, id: \.self) { zoom in
                            Text(zoom.label).tag(zoom)
                        }
                    }
                } label: {
                    Label("View", systemImage: "arrow.up.arrow.down")
                }
                .help("Sort order and thumbnail size")

                Menu {
                    Button {
                        Task { await model.addFolder() }
                    } label: {
                        Label("Add Folder…", systemImage: "folder.badge.plus")
                    }

                    Divider()

                    Button {
                        Task { await model.addMountedNetworkFolder() }
                    } label: {
                        Label("Add Mounted Share…", systemImage: "externaldrive.connected.to.line.below")
                    }

                    Button {
                        model.connectNetworkShare()
                    } label: {
                        Label("Connect SMB Share…", systemImage: "network")
                    }

                } label: {
                    Label("Add", systemImage: "plus")
                }
                .help("Add a folder or connect a source (⌘O for folders)")
            }
        }
        .onChange(of: model.searchFocusToken) {
            searchFocused = true
        }
    }

    @ViewBuilder
    private var content: some View {
        if !model.visualFolders.isEmpty {
            FolderGalleryView()
        } else if model.libraries.isEmpty && model.activeScans.isEmpty {
            EmptyLibraryView()
        } else if model.items.isEmpty {
            EmptyResultsView()
        } else {
            MediaGridView()
        }
    }

    private var title: String {
        switch model.selection {
        case .allItems, nil:
            return "All Items"
        case .recentlyAdded:
            return "Recently Added"
        case .favorites:
            return "Favorites"
        case .library(let id):
            return model.libraries.first(where: { $0.id == id })?.name ?? "Folder"
        case .folder(_, _, let path):
            return URL(fileURLWithPath: path).lastPathComponent
        case .collection(let id):
            return model.collections.first(where: { $0.id == id })?.name ?? ProductBrand.anthology
        }
    }

    private var subtitle: String {
        return model.totalCount == 1 ? "1 item" : "\(model.totalCount.formatted()) items"
    }
}
