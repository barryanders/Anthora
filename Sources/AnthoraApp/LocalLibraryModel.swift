import Foundation
import LibraryCore
import Observation

struct SavedAnthoraLibrary: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    let databasePath: String
    var bookmarkData: Data?

    var fallbackDatabaseURL: URL { URL(fileURLWithPath: databasePath) }
}

@MainActor
@Observable
final class LocalLibraryModel {
    private let runtime = LocalServiceRuntime()
    private let registryURL: URL
    private var activeSecurityScopedURL: URL?

    var localURL: URL?
    var localError: String?
    var isStarting = false
    private(set) var libraries: [SavedAnthoraLibrary] = []
    private(set) var activeLibraryID: String

    init() {
        let support = try! AppPaths.applicationSupportDirectory()
        registryURL = support.appendingPathComponent("libraries.json")
        let loaded = Self.loadRegistry(from: registryURL)
        if loaded.isEmpty {
            let legacy = support.appendingPathComponent("anthora.sqlite")
            let initial = SavedAnthoraLibrary(
                id: UUID().uuidString.lowercased(),
                name: "Family",
                databasePath: legacy.path,
                bookmarkData: nil
            )
            libraries = [initial]
            activeLibraryID = initial.id
            persistRegistry()
        } else {
            libraries = loaded
            let remembered = UserDefaults.standard.string(forKey: "activeAnthoraLibraryID")
            activeLibraryID = loaded.contains(where: { $0.id == remembered }) ? remembered! : loaded[0].id
        }
        Task { await start() }
    }

    var bootstrapURL: URL? { localURL }

    func retry() async {
        _ = await start()
    }

    var activeLibrary: SavedAnthoraLibrary {
        libraries.first(where: { $0.id == activeLibraryID }) ?? libraries[0]
    }

    func createLibrary(at url: URL) async throws {
        await waitUntilIdle()
        let packageURL = url.standardizedFileURL
        let databaseURL = packageURL.appendingPathComponent("Library.sqlite")
        guard !libraries.contains(where: { $0.fallbackDatabaseURL.standardizedFileURL == databaseURL }) else {
            throw LibraryRegistryError.alreadySaved
        }
        do {
            try FileManager.default.createDirectory(at: packageURL, withIntermediateDirectories: false)
        } catch {
            throw LibraryRegistryError.couldNotOpen("Anthora could not create the library package.")
        }
        let name = packageURL.deletingPathExtension().lastPathComponent
        let saved = SavedAnthoraLibrary(
            id: UUID().uuidString.lowercased(),
            name: name.isEmpty ? "Untitled Library" : name,
            databasePath: databaseURL.path,
            bookmarkData: securityScopedBookmark(for: packageURL)
        )
        let previousLibraries = libraries
        let previousID = activeLibraryID
        libraries.append(saved)
        activeLibraryID = saved.id
        persistRegistry()
        guard await start() else {
            let message = localError ?? "The library could not be created."
            libraries = previousLibraries
            activeLibraryID = previousID
            persistRegistry()
            _ = await start()
            throw LibraryRegistryError.couldNotOpen(message)
        }
    }

    func openLibrary(at url: URL) async throws {
        await waitUntilIdle()
        let selectedURL = url.standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: selectedURL.path, isDirectory: &isDirectory) else {
            throw LibraryRegistryError.notFound
        }
        let databaseURL = isDirectory.boolValue
            ? selectedURL.appendingPathComponent("Library.sqlite")
            : selectedURL
        guard FileManager.default.fileExists(atPath: databaseURL.path) else {
            throw LibraryRegistryError.notFound
        }
        if let existing = libraries.first(where: { $0.fallbackDatabaseURL.standardizedFileURL == databaseURL }) {
            await switchLibrary(id: existing.id)
            return
        }
        let name = selectedURL.deletingPathExtension().lastPathComponent
        let saved = SavedAnthoraLibrary(
            id: UUID().uuidString.lowercased(),
            name: name.isEmpty ? "Library" : name,
            databasePath: databaseURL.path,
            bookmarkData: securityScopedBookmark(for: isDirectory.boolValue ? selectedURL : databaseURL)
        )
        let previousLibraries = libraries
        let previousID = activeLibraryID
        libraries.append(saved)
        activeLibraryID = saved.id
        persistRegistry()
        guard await start() else {
            let message = localError ?? "The library could not be opened."
            libraries = previousLibraries
            activeLibraryID = previousID
            persistRegistry()
            _ = await start()
            throw LibraryRegistryError.couldNotOpen(message)
        }
    }

    func switchLibrary(id: String) async {
        await waitUntilIdle()
        guard libraries.contains(where: { $0.id == id }), id != activeLibraryID else { return }
        let previousID = activeLibraryID
        activeLibraryID = id
        persistRegistry()
        if !(await start()) {
            activeLibraryID = previousID
            persistRegistry()
            _ = await start()
        }
    }

    func libraryPayload() -> [String: Any] {
        [
            "activeLibraryId": activeLibraryID,
            "libraries": libraries.map { ["id": $0.id, "name": $0.name] },
        ]
    }

    @discardableResult
    private func start() async -> Bool {
        guard !isStarting else { return false }
        isStarting = true
        localError = nil
        localURL = nil
        do {
            let databaseURL = try activateAccess(for: activeLibrary)
            localURL = try await runtime.start(
                databaseURL: databaseURL,
                libraryID: activeLibrary.id
            )
        } catch {
            localError = error.localizedDescription
        }
        isStarting = false
        return localURL != nil
    }

    private func persistRegistry() {
        do {
            let data = try JSONEncoder().encode(libraries)
            try data.write(to: registryURL, options: .atomic)
            UserDefaults.standard.set(activeLibraryID, forKey: "activeAnthoraLibraryID")
        } catch {
            localError = "Anthora could not save its library list."
        }
    }

    private static func loadRegistry(from url: URL) -> [SavedAnthoraLibrary] {
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode([SavedAnthoraLibrary].self, from: data) else { return [] }
        return value.filter { !$0.id.isEmpty && !$0.databasePath.isEmpty }
    }

    private func securityScopedBookmark(for url: URL) -> Data? {
        guard ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil else { return nil }
        return try? url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    private func waitUntilIdle() async {
        while isStarting {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func activateAccess(for library: SavedAnthoraLibrary) throws -> URL {
        if let previous = activeSecurityScopedURL {
            previous.stopAccessingSecurityScopedResource()
            activeSecurityScopedURL = nil
        }
        guard let bookmark = library.bookmarkData else { return library.fallbackDatabaseURL }
        var stale = false
        let resolved = try URL(
            resolvingBookmarkData: bookmark,
            options: .withSecurityScope,
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        guard resolved.startAccessingSecurityScopedResource() else {
            throw LibraryRegistryError.notFound
        }
        activeSecurityScopedURL = resolved
        return resolved.pathExtension.lowercased() == "anthora"
            ? resolved.appendingPathComponent("Library.sqlite")
            : resolved
    }
}

private enum LibraryRegistryError: LocalizedError {
    case alreadySaved
    case notFound
    case couldNotOpen(String)

    var errorDescription: String? {
        switch self {
        case .alreadySaved: "That Anthora library is already saved."
        case .notFound: "That Anthora library file is no longer available."
        case .couldNotOpen(let message): message
        }
    }
}
