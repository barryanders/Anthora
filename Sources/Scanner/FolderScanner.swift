import CryptoKit
import Darwin
import Foundation
import LibraryCore

public struct ScanProgress: Sendable, Equatable {
    public enum Phase: String, Sendable {
        case starting
        case scanning
        case finishing
        case done
        case failed
        case cancelled
    }

    public var phase: Phase
    public var filesDiscovered: Int
    public var itemsIndexed: Int
    public var currentFolderName: String?

    public init(phase: Phase, filesDiscovered: Int = 0, itemsIndexed: Int = 0, currentFolderName: String? = nil) {
        self.phase = phase
        self.filesDiscovered = filesDiscovered
        self.itemsIndexed = itemsIndexed
        self.currentFolderName = currentFolderName
    }

    public var isActive: Bool {
        switch phase {
        case .starting, .scanning, .finishing: return true
        case .done, .failed, .cancelled: return false
        }
    }
}

public enum ScanError: Error, CustomStringConvertible {
    case rootUnavailable(String)
    case enumerationFailed(String)

    public var description: String {
        switch self {
        case .rootUnavailable(let path):
            return "The folder \(path) is not reachable. It may be on a disconnected drive."
        case .enumerationFailed(let path):
            return "Couldn't read the contents of \(path)."
        }
    }
}

private struct PendingMediaFile {
    var folderID: Int64
    var url: URL
    var filename: String
    var ext: String
    var mediaType: MediaType
    var sizeBytes: Int64
    var createdAt: Date?
    var modifiedAt: Date?
    var contentHash: String?
}

private struct StreamingDirectoryEntry {
    let url: URL
    let isDirectory: Bool
    let isRegularFile: Bool
    let sizeBytes: Int64
    let createdAt: Date?
    let modifiedAt: Date?
}

/// Streams one directory entry at a time. Foundation's URL enumerator can
/// block while materializing every child of a very large network directory,
/// which prevents progress and cancellation from being reported.
private final class StreamingDirectoryWalker {
    private var pendingDirectories: [URL] = []
    private var pendingIndex = 0
    private var directory: UnsafeMutablePointer<DIR>?
    private var directoryURL: URL

    init(root: URL) throws {
        directoryURL = root
        guard let opened = opendir(root.path) else {
            throw ScanError.enumerationFailed(root.path)
        }
        directory = opened
    }

    deinit {
        if let directory { closedir(directory) }
    }

    func enqueue(_ url: URL) {
        pendingDirectories.append(url)
    }

    func next() -> StreamingDirectoryEntry? {
        while true {
            if let directory {
                while let entry = readdir(directory) {
                    guard let name = withUnsafePointer(to: &entry.pointee.d_name, { pointer in
                        String(validatingCString: UnsafeRawPointer(pointer).assumingMemoryBound(to: CChar.self))
                    }) else {
                        continue
                    }
                    guard name != ".", name != "..", !name.hasPrefix(".") else { continue }
                    var metadata = stat()
                    guard fstatat(dirfd(directory), name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else {
                        continue
                    }
                    let fileType = metadata.st_mode & mode_t(S_IFMT)
                    if fileType == mode_t(S_IFLNK) { continue }
                    let createdAt = metadata.st_birthtimespec.tv_sec > 0
                        ? Date(
                            timeIntervalSince1970: TimeInterval(metadata.st_birthtimespec.tv_sec)
                                + TimeInterval(metadata.st_birthtimespec.tv_nsec) / 1_000_000_000
                        )
                        : nil
                    let modifiedAt = metadata.st_mtimespec.tv_sec > 0
                        ? Date(
                            timeIntervalSince1970: TimeInterval(metadata.st_mtimespec.tv_sec)
                                + TimeInterval(metadata.st_mtimespec.tv_nsec) / 1_000_000_000
                        )
                        : nil
                    return StreamingDirectoryEntry(
                        url: directoryURL.appendingPathComponent(name),
                        isDirectory: fileType == mode_t(S_IFDIR),
                        isRegularFile: fileType == mode_t(S_IFREG),
                        sizeBytes: Int64(metadata.st_size),
                        createdAt: createdAt,
                        modifiedAt: modifiedAt
                    )
                }
                closedir(directory)
                self.directory = nil
            }

            guard pendingIndex < pendingDirectories.count else { return nil }
            let nextDirectory = pendingDirectories[pendingIndex]
            pendingIndex += 1
            guard let opened = opendir(nextDirectory.path) else { continue }
            directoryURL = nextDirectory
            directory = opened
        }
    }
}

/// Walks a library's folder tree, upserting folders and media items in
/// batches. Designed so first results land in the database (and the UI)
/// within the first batch, long before the scan completes. Cooperatively
/// cancellable via task cancellation; a cancelled scan keeps everything
/// indexed so far and never marks items missing.
public struct FolderScanner: Sendable {
    private let batchSize: Int

    public init(batchSize: Int = 400) {
        self.batchSize = batchSize
    }

    static func mediaRoot(for sourceRoot: URL) -> URL {
        let archiveDatabase = sourceRoot.appendingPathComponent("_database/archive.sqlite3")
        let userMedia = sourceRoot.appendingPathComponent("u", isDirectory: true)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: archiveDatabase.path),
           FileManager.default.fileExists(atPath: userMedia.path, isDirectory: &isDirectory),
           isDirectory.boolValue {
            return userMedia
        }
        return sourceRoot
    }

    public func scan(
        library: LibraryRecord,
        store: LibraryStore,
        maximumItems: Int? = nil,
        isCancellationRequested: @escaping @Sendable () -> Bool = { false },
        onProgress: @escaping @Sendable (ScanProgress) -> Void
    ) async throws -> ScanSummary {
        var progress = ScanProgress(phase: .starting)
        onProgress(progress)

        let scanStart = Date()
        let jobID = try await store.createScanJob(libraryID: library.id)
        try await store.updateLibraryScanStatus(id: library.id, status: "scanning", lastScannedAt: nil)

        // Resolve folder access: security-scoped bookmark first, raw path as fallback.
        // scopedURL is kept separate because stopAccessing must be balanced on
        // the exact URL instance that granted access.
        var rootURL = library.rootURL
        var scopedURL: URL?
        if let bookmarkData = library.bookmarkData,
           let resolved = try? FolderBookmark.resolve(bookmarkData) {
            rootURL = resolved.url
            if resolved.url.startAccessingSecurityScopedResource() {
                scopedURL = resolved.url
            }
            if resolved.isStale, let fresh = try? FolderBookmark.create(for: resolved.url) {
                try? await store.updateLibraryBookmark(id: library.id, bookmarkData: fresh)
            }
        }
        rootURL = Self.mediaRoot(for: rootURL)
        defer {
            scopedURL?.stopAccessingSecurityScopedResource()
        }

        func fail(_ error: ScanError) async throws -> Never {
            try? await store.finishScanJob(id: jobID, status: "failed", errorMessage: error.description)
            try? await store.updateLibraryScanStatus(id: library.id, status: "error", lastScannedAt: nil)
            progress.phase = .failed
            onProgress(progress)
            throw error
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            try await fail(.rootUnavailable(library.rootPath))
        }

        // The enumerator hands back symlink-resolved URLs (e.g. /var → /private/var).
        // Resolve the root the same way so folder paths line up across the scan.
        // realpath(3) rather than URL.resolvingSymlinksInPath(), which
        // deliberately leaves /var, /tmp, and /etc unresolved.
        if let resolvedPath = rootURL.path.withCString({ realpath($0, nil) }) {
            rootURL = URL(fileURLWithPath: String(cString: resolvedPath), isDirectory: true)
            free(resolvedPath)
        }

        let rootValues = try? rootURL.resourceValues(forKeys: [.volumeIsLocalKey])
        let readsImageDimensionsDuringScan = rootValues?.volumeIsLocal != false
        let deletedFingerprintSizes = try await store.deletedFingerprintSizes()
        var folderIDs: [String: Int64] = [:]
        let rootFolderID = try await store.upsertFolder(
            libraryID: library.id,
            path: rootURL.path,
            parentPath: nil,
            name: rootURL.lastPathComponent
        )
        folderIDs[rootURL.path] = rootFolderID

        let walker: StreamingDirectoryWalker
        do {
            walker = try StreamingDirectoryWalker(root: rootURL)
        } catch {
            try await fail(.enumerationFailed(rootURL.path))
        }

        progress.phase = .scanning
        var batch: [PendingMediaFile] = []
        var itemsIndexed = 0
        var filesDiscovered = 0
        var foldersSeen = 1
        var cancelled = false
        var limitReached = false

        func flushBatch() async throws {
            guard !batch.isEmpty else { return }
            let existingState = try await store.mediaScanState(
                libraryID: library.id,
                paths: batch.map { $0.url.path }
            )
            let files = batch.map { pending in
                var width: Int?
                var height: Int?
                // A copied or moved file can retain its bytes while receiving a
                // new modification date. Reuse dimensions unless its byte size
                // changed.
                let unchanged = existingState[pending.url.path]?.sizeBytes == pending.sizeBytes
                if readsImageDimensionsDuringScan,
                   !unchanged,
                   pending.mediaType == .image,
                   let dimensions = ImageMetadataReader.pixelDimensions(of: pending.url) {
                    width = dimensions.width
                    height = dimensions.height
                }
                return ScannedMediaFile(
                    folderID: pending.folderID,
                    path: pending.url.path,
                    filename: pending.filename,
                    ext: pending.ext,
                    mediaType: pending.mediaType,
                    sizeBytes: pending.sizeBytes,
                    createdAt: pending.createdAt,
                    modifiedAt: pending.modifiedAt,
                    width: width,
                    height: height,
                    contentHash: pending.contentHash
                )
            }
            try await store.upsertMediaItems(files, libraryID: library.id)
            itemsIndexed += batch.count
            batch.removeAll(keepingCapacity: true)
            progress.itemsIndexed = itemsIndexed
            progress.filesDiscovered = filesDiscovered
            onProgress(progress)
            try? await store.updateScanJobProgress(id: jobID, progress: Double(itemsIndexed))
        }

        func folderID(forParent parentPath: String) async throws -> Int64 {
            if let cached = folderIDs[parentPath] { return cached }
            let parentURL = URL(fileURLWithPath: parentPath, isDirectory: true)
            let id = try await store.upsertFolder(
                libraryID: library.id,
                path: parentPath,
                parentPath: parentURL.deletingLastPathComponent().path,
                name: parentURL.lastPathComponent
            )
            folderIDs[parentPath] = id
            return id
        }

        let packageExtensions: Set<String> = [
            "app", "bundle", "framework", "pkg", "photolibrary", "photoslibrary",
        ]
        while let entry = walker.next() {
            if Task.isCancelled || isCancellationRequested() {
                cancelled = true
                break
            }
            let fileURL = entry.url

            if entry.isDirectory {
                let path = fileURL.path
                let id = try await store.upsertFolder(
                    libraryID: library.id,
                    path: path,
                    parentPath: fileURL.deletingLastPathComponent().path,
                    name: fileURL.lastPathComponent
                )
                folderIDs[path] = id
                foldersSeen += 1
                progress.currentFolderName = fileURL.lastPathComponent
                if !packageExtensions.contains(fileURL.pathExtension.lowercased()) {
                    walker.enqueue(fileURL)
                }
                continue
            }

            guard entry.isRegularFile else { continue }
            filesDiscovered += 1

            let ext = fileURL.pathExtension.lowercased()
            guard let mediaType = MediaFileType.mediaType(forExtension: ext) else { continue }

            if let maximumItems, itemsIndexed + batch.count >= maximumItems {
                limitReached = true
                break
            }

            let sizeBytes = entry.sizeBytes
            let contentHash = deletedFingerprintSizes.contains(sizeBytes)
                ? try? Self.sha256(url: fileURL)
                : nil
            batch.append(PendingMediaFile(
                folderID: try await folderID(forParent: fileURL.deletingLastPathComponent().path),
                url: fileURL,
                filename: fileURL.lastPathComponent,
                ext: ext,
                mediaType: mediaType,
                sizeBytes: sizeBytes,
                createdAt: entry.createdAt,
                modifiedAt: entry.modifiedAt,
                contentHash: contentHash
            ))

            if batch.count >= batchSize {
                try await flushBatch()
            }
        }

        try await flushBatch()

        var markedMissing = 0
        if cancelled || limitReached {
            try await store.finishScanJob(id: jobID, status: "cancelled", errorMessage: nil)
            try await store.updateLibraryScanStatus(id: library.id, status: "idle", lastScannedAt: nil)
            progress.phase = .cancelled
        } else {
            progress.phase = .finishing
            onProgress(progress)
            markedMissing = try await store.markItemsMissing(libraryID: library.id, notSeenSince: scanStart)
            try await store.recomputeFolderItemCounts(libraryID: library.id)
            try await store.finishScanJob(id: jobID, status: "completed", errorMessage: nil)
            try await store.updateLibraryScanStatus(id: library.id, status: "idle", lastScannedAt: Date())
            progress.phase = .done
        }
        progress.itemsIndexed = itemsIndexed
        progress.filesDiscovered = filesDiscovered
        onProgress(progress)

        return ScanSummary(
            itemsIndexed: itemsIndexed,
            foldersSeen: foldersSeen,
            markedMissing: markedMissing,
            cancelled: cancelled,
            limitReached: limitReached
        )
    }

    private static func sha256(url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 4 * 1_024 * 1_024), !data.isEmpty {
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
