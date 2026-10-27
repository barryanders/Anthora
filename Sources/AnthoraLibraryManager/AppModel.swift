import AppKit
import Foundation
import LibraryCore
import Observation
import Scanner
import ThumbnailEngine

enum SidebarSelection: Hashable {
    case allItems
    case recentlyAdded
    case favorites
    case library(Int64)
    case folder(libraryID: Int64, folderID: Int64, path: String)
    case collection(Int64)
}

/// Grid density. Values are the adaptive column bounds for LazyVGrid.
enum GridZoom: String, CaseIterable {
    case small
    case medium
    case large

    var cellMin: CGFloat {
        switch self {
        case .small: return 110
        case .medium: return 150
        case .large: return 210
        }
    }

    var cellMax: CGFloat {
        switch self {
        case .small: return 160
        case .medium: return 220
        case .large: return 300
        }
    }

    var label: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        }
    }
}

/// One node of a library's folder hierarchy for the sidebar outline.
struct FolderNode: Identifiable, Hashable {
    let id: Int64
    let libraryID: Int64
    let name: String
    let path: String
    let isLibraryRoot: Bool
    /// Items in this folder and all descendants.
    let subtreeCount: Int
    var children: [FolderNode]?
}

struct AIAnalysisProgress: Sendable {
    var completed: Int
    var total: Int
}

struct VisualFolder: Identifiable, Hashable {
    let folder: FolderRecord
    let cover: MediaItemRecord?
    let itemCount: Int
    var id: Int64 { folder.id }
}

@MainActor
@Observable
final class AppModel {
    private(set) var libraries: [LibraryRecord] = []
    private(set) var libraryCounts: [Int64: Int] = [:]
    private(set) var folderTrees: [Int64: FolderNode] = [:]
    private(set) var visualFolders: [VisualFolder] = []
    private(set) var collections: [CollectionRecord] = []
    private(set) var items: [MediaItemRecord] = []
    private(set) var totalCount = 0
    private(set) var activeScans: [Int64: ScanProgress] = [:]
    private(set) var isLoadingMore = false
    private(set) var aiAnalysisProgress: AIAnalysisProgress?
    private(set) var thumbnails: ThumbnailEngine?
    var errorMessage: String?

    // Grid selection and viewer.
    var selectedItemID: Int64?
    var viewerIndex: Int?

    // Collection-naming prompt (from the sidebar or "New Collection…" on an item).
    var isNamingCollection = false
    var collectionNameDraft = ""
    var pendingCollectionMember: MediaItemRecord?

    // Library-removal confirmation.
    var libraryPendingRemoval: LibraryRecord?

    // Bumped by the ⌘F menu command; the toolbar search field focuses on change.
    private(set) var searchFocusToken = 0

    var selection: SidebarSelection? = .allItems {
        didSet {
            selectedItemID = nil
            viewerIndex = nil
            Task {
                await refreshItems(reset: true)
                await refreshVisualFolders()
            }
        }
    }

    var mediaTypeFilter: MediaType? {
        didSet { Task { await refreshItems(reset: true) } }
    }

    var aiContentFilter: AIContentFilter = .all {
        didSet { Task { await refreshItems(reset: true) } }
    }

    var sort: MediaSort = .newestFirst {
        didSet { Task { await refreshItems(reset: true) } }
    }

    var searchText = "" {
        didSet { debounceSearch() }
    }

    var gridZoom: GridZoom = GridZoom(
        rawValue: UserDefaults.standard.string(forKey: "gridZoom") ?? ""
    ) ?? .medium {
        didSet { UserDefaults.standard.set(gridZoom.rawValue, forKey: "gridZoom") }
    }

    func stepGridZoom(_ delta: Int) {
        let all = GridZoom.allCases
        guard let index = all.firstIndex(of: gridZoom) else { return }
        let next = max(0, min(all.count - 1, index + delta))
        gridZoom = all[next]
    }

    private var store: LibraryStore?
    private var scanTasks: [Int64: Task<Void, Never>] = [:]
    private var searchTask: Task<Void, Never>?
    private var aiAnalysisTask: Task<Void, Never>?
    private var lastScanRefresh = Date.distantPast
    /// Bookmark-resolved URLs we hold security-scoped access to, per library,
    /// so thumbnailing and viewing keep working in a sandboxed build.
    private var scopedAccessURLs: [Int64: URL] = [:]
    private let pageSize = 400

    // MARK: - Lifecycle

    func bootstrap() async {
        guard store == nil else { return }
        do {
            store = try LibraryStore(databaseURL: AppPaths.databaseURL())
            thumbnails = ThumbnailEngine(cacheDirectory: try AppPaths.thumbnailsDirectory())
            await refreshLibraries()
            await rebuildFolderTrees()
            await refreshCollections()
            await refreshItems(reset: true)
            await refreshVisualFolders()
            for library in libraries {
                beginScopedAccess(for: library)
            }
            startNextUnscannedLibrary()
        } catch {
            errorMessage = "Couldn't open the library database: \(error)"
        }
    }

    private func beginScopedAccess(for library: LibraryRecord) {
        guard scopedAccessURLs[library.id] == nil,
              let bookmarkData = library.bookmarkData,
              let resolved = try? FolderBookmark.resolve(bookmarkData),
              resolved.url.startAccessingSecurityScopedResource() else { return }
        scopedAccessURLs[library.id] = resolved.url
    }

    private func endScopedAccess(for libraryID: Int64) {
        scopedAccessURLs.removeValue(forKey: libraryID)?.stopAccessingSecurityScopedResource()
    }

    // MARK: - Libraries

    func addFolder() async {
        await addFolders(FolderPicker.pickFolders())
    }

    func addMountedNetworkFolder() async {
        await addFolders(FolderPicker.pickMountedNetworkFolders())
    }

    func connectNetworkShare() {
        FolderPicker.connectNetworkShare()
    }

    private func addFolders(_ urls: [URL]) async {
        guard let store else { return }
        for url in urls {
            do {
                if let existing = try await store.library(rootPath: url.path) {
                    let bookmark = try? FolderBookmark.create(for: url)
                    try await store.updateLibraryBookmark(id: existing.id, bookmarkData: bookmark)
                    let authorized = try await store.library(id: existing.id) ?? existing
                    beginScopedAccess(for: authorized)
                    startScan(authorized)
                    selection = .library(authorized.id)
                    continue
                }
                let bookmark = try? FolderBookmark.create(for: url)
                let library = try await store.createLibrary(
                    name: url.lastPathComponent,
                    rootPath: url.path,
                    bookmarkData: bookmark
                )
                await refreshLibraries()
                beginScopedAccess(for: library)
                selection = .library(library.id)
                startScan(library)
            } catch {
                errorMessage = "Couldn't add \(url.lastPathComponent): \(error)"
            }
        }
    }

    func rescan(libraryID: Int64) {
        Task {
            guard let store, let library = try? await store.library(id: libraryID) else { return }
            startScan(library)
        }
    }

    func rescanSelection() {
        switch selection {
        case .library(let id):
            rescan(libraryID: id)
        case .folder(let libraryID, _, _):
            rescan(libraryID: libraryID)
        default:
            for library in libraries {
                rescan(libraryID: library.id)
            }
        }
    }

    func confirmRemoveLibrary(_ library: LibraryRecord) {
        libraryPendingRemoval = library
    }

    /// Removes the library's index rows only; nothing on disk is touched.
    func removeLibrary(_ library: LibraryRecord) {
        guard let store else { return }
        scanTasks[library.id]?.cancel()
        endScopedAccess(for: library.id)
        switch selection {
        case .library(library.id):
            selection = .allItems
        case .folder(let libraryID, _, _) where libraryID == library.id:
            selection = .allItems
        default:
            break
        }
        Task {
            do {
                try await store.removeLibrary(id: library.id)
            } catch {
                errorMessage = "Couldn't remove \(library.name): \(error)"
            }
            await refreshLibraries()
            await rebuildFolderTrees()
            await refreshCollections()
            await refreshItems(reset: true)
        }
    }

    func revealLibraryInFinder(_ library: LibraryRecord) {
        NSWorkspace.shared.activateFileViewerSelecting([library.rootURL])
    }

    // MARK: - Scanning

    private func startScan(_ library: LibraryRecord) {
        guard let store, scanTasks[library.id] == nil else { return }
        activeScans[library.id] = ScanProgress(phase: .starting)
        let scanner = FolderScanner()
        let libraryID = library.id
        scanTasks[libraryID] = Task {
            do {
                _ = try await scanner.scan(library: library, store: store) { progress in
                    Task { @MainActor in
                        self.applyScanProgress(progress, libraryID: libraryID)
                    }
                }
            } catch is CancellationError {
                // Cancelled scans keep what they found; nothing to report.
            } catch {
                self.errorMessage = "Scan of \(library.name) failed: \(error)"
            }
            self.finishScan(libraryID: libraryID)
        }
    }

    func cancelAllScans() {
        for task in scanTasks.values {
            task.cancel()
        }
    }

    private func applyScanProgress(_ progress: ScanProgress, libraryID: Int64) {
        activeScans[libraryID] = progress.isActive ? progress : nil

        // Refresh the visible grid periodically so results appear while the
        // scan is still running — but only while the user is on page one,
        // so a deep scroll position is never yanked away.
        let now = Date()
        if now.timeIntervalSince(lastScanRefresh) > 1.0 {
            lastScanRefresh = now
            Task {
                await refreshLibraries()
                await refreshItems(reset: items.count <= pageSize)
            }
        }
    }

    private func finishScan(libraryID: Int64) {
        scanTasks[libraryID] = nil
        activeScans[libraryID] = nil
        Task {
            await refreshLibraries()
            await rebuildFolderTrees()
            await refreshItems(reset: items.count <= pageSize)
            startNextUnscannedLibrary()
        }
    }

    private func startNextUnscannedLibrary() {
        guard scanTasks.isEmpty,
              let library = libraries.first(where: {
                  $0.lastScannedAt == nil && $0.scanStatus == "idle"
              }) else { return }
        startScan(library)
    }

    /// Builds the sidebar outline from the folders table. Called on launch and
    /// after scans finish — not on every progress tick, since it walks every
    /// folder row of every library.
    func rebuildFolderTrees() async {
        guard let store else { return }
        var trees: [Int64: FolderNode] = [:]
        for library in libraries {
            guard let folders = try? await store.folders(libraryID: library.id), !folders.isEmpty else { continue }
            var childrenByParent: [String: [FolderRecord]] = [:]
            var roots: [FolderRecord] = []
            for folder in folders {
                if let parent = folder.parentPath {
                    childrenByParent[parent, default: []].append(folder)
                } else {
                    roots.append(folder)
                }
            }
            func node(for folder: FolderRecord, isRoot: Bool) -> FolderNode {
                let childNodes = (childrenByParent[folder.path] ?? [])
                    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                    .map { node(for: $0, isRoot: false) }
                return FolderNode(
                    id: folder.id,
                    libraryID: library.id,
                    name: isRoot ? library.name : folder.name,
                    path: folder.path,
                    isLibraryRoot: isRoot,
                    subtreeCount: folder.itemCount + childNodes.reduce(0) { $0 + $1.subtreeCount },
                    children: childNodes.isEmpty ? nil : childNodes
                )
            }
            if let root = roots.first {
                trees[library.id] = node(for: root, isRoot: true)
            }
        }
        folderTrees = trees
    }

    var totalActiveScanCount: Int {
        activeScans.values.reduce(0) { $0 + $1.itemsIndexed }
    }

    func refreshVisualFolders() async {
        guard let store else { return }
        let location: (libraryID: Int64, path: String)?
        switch selection {
        case .library(let libraryID):
            location = libraries.first(where: { $0.id == libraryID }).map { (libraryID, $0.rootPath) }
        case .folder(let libraryID, _, let path):
            location = (libraryID, path)
        default:
            location = nil
        }
        guard let location else {
            visualFolders = []
            return
        }

        do {
            let children = try await store.childFolders(
                libraryID: location.libraryID,
                parentPath: location.path
            )
            // `media` is an implementation detail of profile storage, not a
            // useful extra navigation level.
            if children.count == 1 && children[0].name.lowercased() == "media" {
                visualFolders = []
                return
            }
            var folders: [VisualFolder] = []
            folders.reserveCapacity(children.count)
            for folder in children {
                let cover = try await store.folderCoverItem(folderID: folder.id)
                let itemCount = try await store.folderSubtreeItemCount(folderID: folder.id)
                folders.append(VisualFolder(folder: folder, cover: cover, itemCount: itemCount))
            }
            visualFolders = folders
        } catch {
            errorMessage = "Couldn't load folder covers: \(error)"
        }
    }

    // MARK: - Items

    private var currentQuery: MediaQuery {
        var query = MediaQuery(limit: pageSize)
        query.mediaType = mediaTypeFilter
        query.aiContentFilter = aiContentFilter
        query.sort = sort
        let trimmedSearch = searchText.trimmingCharacters(in: .whitespaces)
        query.searchText = trimmedSearch.isEmpty ? nil : trimmedSearch
        switch selection {
        case .allItems, nil:
            break
        case .recentlyAdded:
            query.sort = .recentlyAdded
        case .favorites:
            query.favoritesOnly = true
        case .library(let id):
            query.libraryID = id
        case .folder(let libraryID, _, let path):
            query.libraryID = libraryID
            query.folderSubtreePath = path
        case .collection(let id):
            query.collectionID = id
        }
        return query
    }

    func refreshItems(reset: Bool) async {
        guard let store else { return }
        do {
            let query = currentQuery
            totalCount = try await store.itemCount(matching: query)
            if reset {
                items = try await store.items(matching: query)
                if let viewerIndex, viewerIndex >= items.count {
                    self.viewerIndex = items.isEmpty ? nil : items.count - 1
                }
            }
        } catch {
            errorMessage = "Couldn't load items: \(error)"
        }
    }

    func loadMoreIfNeeded(after item: MediaItemRecord) {
        guard !isLoadingMore,
              items.count < totalCount,
              let index = items.firstIndex(where: { $0.id == item.id }),
              index >= items.count - 60 else { return }
        isLoadingMore = true
        Task {
            defer { isLoadingMore = false }
            guard let store else { return }
            var query = currentQuery
            query.offset = items.count
            if let more = try? await store.items(matching: query) {
                items.append(contentsOf: more)
            }
        }
    }

    func refreshLibraries() async {
        guard let store else { return }
        do {
            libraries = try await store.allLibraries()
            var counts: [Int64: Int] = [:]
            for library in libraries {
                counts[library.id] = try await store.itemCount(matching: MediaQuery(libraryID: library.id))
            }
            libraryCounts = counts
        } catch {
            errorMessage = "Couldn't load libraries: \(error)"
        }
    }

    private func debounceSearch() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await refreshItems(reset: true)
        }
    }

    func requestSearchFocus() {
        searchFocusToken += 1
    }

    // MARK: - Grid selection & viewer

    var selectedItem: MediaItemRecord? {
        selectedItemID.flatMap { id in items.first(where: { $0.id == id }) }
    }

    var viewerItem: MediaItemRecord? {
        viewerIndex.flatMap { items.indices.contains($0) ? items[$0] : nil }
    }

    func moveSelection(by delta: Int) {
        guard !items.isEmpty else { return }
        let newIndex: Int
        if let id = selectedItemID, let currentIndex = items.firstIndex(where: { $0.id == id }) {
            newIndex = max(0, min(items.count - 1, currentIndex + delta))
        } else {
            newIndex = 0
        }
        selectedItemID = items[newIndex].id
        loadMoreIfNeeded(after: items[newIndex])
    }

    func openViewer(_ item: MediaItemRecord) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        selectedItemID = item.id
        viewerIndex = index
    }

    func openViewerForSelection() {
        if let selectedItem {
            openViewer(selectedItem)
        } else if let first = items.first {
            openViewer(first)
        }
    }

    func closeViewer() {
        viewerIndex = nil
    }

    func viewerStep(_ delta: Int) {
        guard let index = viewerIndex else { return }
        let next = index + delta
        guard items.indices.contains(next) else { return }
        viewerIndex = next
        selectedItemID = items[next].id
        loadMoreIfNeeded(after: items[next])
    }

    // MARK: - Item actions

    func toggleFavorite(_ item: MediaItemRecord) {
        guard let store else { return }
        let newValue = !item.favorite
        if let index = items.firstIndex(where: { $0.id == item.id }) {
            items[index].favorite = newValue
        }
        Task {
            try? await store.setFavorite(itemID: item.id, isFavorite: newValue)
            if case .favorites = selection {
                await refreshItems(reset: true)
            }
        }
    }

    func toggleFavoriteForFocus() {
        if let viewerItem {
            toggleFavorite(viewerItem)
        } else if let selectedItem {
            toggleFavorite(selectedItem)
        }
    }

    func revealInFinder(_ item: MediaItemRecord) {
        NSWorkspace.shared.activateFileViewerSelecting([item.fileURL])
    }

    func revealFocusedItem() {
        if let viewerItem {
            revealInFinder(viewerItem)
        } else if let selectedItem {
            revealInFinder(selectedItem)
        }
    }

    func openFolder(_ folder: FolderRecord) {
        selection = .folder(libraryID: folder.libraryID, folderID: folder.id, path: folder.path)
    }

    func useAsCurrentFolderCover(_ item: MediaItemRecord) {
        guard let store, case .folder(_, let folderID, _) = selection else { return }
        Task {
            do {
                try await store.setFolderCover(folderID: folderID, mediaItemID: item.id)
                await refreshVisualFolders()
            } catch {
                errorMessage = "Couldn't set folder cover: \(error)"
            }
        }
    }

    func useAutomaticCover(for folder: FolderRecord) {
        guard let store else { return }
        Task {
            do {
                try await store.setFolderCover(folderID: folder.id, mediaItemID: nil)
                await refreshVisualFolders()
            } catch {
                errorMessage = "Couldn't reset folder cover: \(error)"
            }
        }
    }

    // MARK: - AI analysis

    func startAIAnalysis() {
        guard let store, aiAnalysisTask == nil else { return }
        aiAnalysisTask = Task {
            do {
                let total = try await store.unanalyzedImageCount(
                    modelVersion: TextAnalysisEngine.modelVersion
                )
                aiAnalysisProgress = AIAnalysisProgress(completed: 0, total: total)
                var completed = 0

                while !Task.isCancelled {
                    let batch = try await store.unanalyzedImages(
                        modelVersion: TextAnalysisEngine.modelVersion,
                        limit: 50
                    )
                    if batch.isEmpty { break }

                    for item in batch {
                        if Task.isCancelled { break }
                        let url = item.fileURL
                        let result = await Task.detached(priority: .utility) {
                            TextAnalysisEngine.analyze(url: url)
                        }.value
                        try await store.saveTextAnalysis(
                            itemID: item.id,
                            modelVersion: TextAnalysisEngine.modelVersion,
                            result: result
                        )
                        completed += 1
                        aiAnalysisProgress = AIAnalysisProgress(completed: completed, total: total)
                    }
                    if aiContentFilter != .all {
                        await refreshItems(reset: true)
                    }
                }
                await refreshItems(reset: true)
            } catch {
                errorMessage = "AI analysis stopped: \(error)"
            }
            aiAnalysisProgress = nil
            aiAnalysisTask = nil
        }
    }

    func cancelAIAnalysis() {
        aiAnalysisTask?.cancel()
    }

    // MARK: - Collections

    func refreshCollections() async {
        guard let store else { return }
        do {
            collections = try await store.allCollections()
        } catch {
            errorMessage = "Couldn't load collections: \(error)"
        }
    }

    func promptNewCollection(adding item: MediaItemRecord? = nil) {
        pendingCollectionMember = item
        collectionNameDraft = ""
        isNamingCollection = true
    }

    func createCollectionFromPrompt() {
        let name = collectionNameDraft.trimmingCharacters(in: .whitespaces)
        let member = pendingCollectionMember
        pendingCollectionMember = nil
        guard let store, !name.isEmpty else { return }
        Task {
            do {
                let collection = try await store.createCollection(name: name)
                if let member {
                    try await store.addItems([member.id], toCollection: collection.id)
                }
                await refreshCollections()
            } catch {
                errorMessage = "Couldn't create collection: \(error)"
            }
        }
    }

    func add(_ item: MediaItemRecord, toCollection collectionID: Int64) {
        guard let store else { return }
        Task {
            do {
                try await store.addItems([item.id], toCollection: collectionID)
                await refreshCollections()
            } catch {
                errorMessage = "Couldn't add to collection: \(error)"
            }
        }
    }

    func removeFromCurrentCollection(_ item: MediaItemRecord) {
        guard let store, case .collection(let collectionID) = selection else { return }
        Task {
            do {
                try await store.removeItem(item.id, fromCollection: collectionID)
                await refreshCollections()
                await refreshItems(reset: true)
            } catch {
                errorMessage = "Couldn't remove from collection: \(error)"
            }
        }
    }

    func renameCollection(_ collection: CollectionRecord, to name: String) {
        guard let store else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        Task {
            try? await store.renameCollection(id: collection.id, name: trimmed)
            await refreshCollections()
        }
    }

    func deleteCollection(_ collection: CollectionRecord) {
        guard let store else { return }
        if selection == .collection(collection.id) {
            selection = .allItems
        }
        Task {
            try? await store.deleteCollection(id: collection.id)
            await refreshCollections()
        }
    }
}
