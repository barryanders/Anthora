import CryptoKit
import Foundation
import Testing
import LibraryCore
@testable import Scanner

/// A real, valid 1×1 PNG so ImageIO can read its dimensions.
private let onePixelPNG = Data(base64Encoded:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)!

private struct Fixture {
    let root: URL
    let store: LibraryStore
    let library: LibraryRecord
}

private func makeFixture() async throws -> Fixture {
    let base = FileManager.default.temporaryDirectory
        .appendingPathComponent("AnthoraScan-\(UUID().uuidString)", isDirectory: true)
    // The database lives outside the scanned root so the scanner never sees it.
    let root = base.appendingPathComponent("media", isDirectory: true)
    let sub = root.appendingPathComponent("clips", isDirectory: true)
    try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)

    try onePixelPNG.write(to: root.appendingPathComponent("pixel.png"))
    try Data("not media".utf8).write(to: root.appendingPathComponent("notes.txt"))
    try Data().write(to: sub.appendingPathComponent("video.mp4"))

    let store = try LibraryStore(
        databaseURL: base.appendingPathComponent("db", isDirectory: true).appendingPathComponent("test.sqlite")
    )
    let library = try await store.createLibrary(name: "Fixture", rootPath: root.path, bookmarkData: nil)
    return Fixture(root: root, store: store, library: library)
}

@Suite struct FolderScannerTests {
    @Test func unlimitedScanAndUpgradeRescanPassFiveHundred() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root.deletingLastPathComponent()) }
        for index in 1...600 {
            try onePixelPNG.write(to: fixture.root.appendingPathComponent("photo-\(index).png"))
        }
        let scanner = FolderScanner()
        let capped = try await scanner.scan(library: fixture.library, store: fixture.store, maximumItems: 500) { _ in }
        #expect(capped.itemsIndexed == 500)
        let upgraded = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }
        #expect(upgraded.itemsIndexed == 602)
        let freshStore = try LibraryStore(databaseURL: fixture.root.deletingLastPathComponent().appendingPathComponent("fresh.sqlite"))
        let fresh = try await freshStore.createLibrary(name: "Fresh unlimited", rootPath: fixture.root.path, bookmarkData: nil)
        let uncapped = try await scanner.scan(library: fresh, store: freshStore) { _ in }
        #expect(uncapped.itemsIndexed == 602)
    }

    @Test func socialArchiveSourceScansOnlyItsUserMediaTree() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraSocialScan-\(UUID().uuidString)", isDirectory: true)
        let userMedia = base.appendingPathComponent("u/person", isDirectory: true)
        let objects = base.appendingPathComponent("_objects", isDirectory: true)
        let database = base.appendingPathComponent("_database", isDirectory: true)
        try FileManager.default.createDirectory(at: userMedia, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: objects, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: database, withIntermediateDirectories: true)
        try Data().write(to: database.appendingPathComponent("archive.sqlite3"))
        try onePixelPNG.write(to: userMedia.appendingPathComponent("profile.png"))
        try FileManager.default.createSymbolicLink(
            at: userMedia.appendingPathComponent("profile-link.png"),
            withDestinationURL: userMedia.appendingPathComponent("profile.png")
        )
        try onePixelPNG.write(to: objects.appendingPathComponent("internal.png"))
        defer { try? FileManager.default.removeItem(at: base) }

        let store = try LibraryStore(
            databaseURL: base.appendingPathComponent("_test/test.sqlite")
        )
        let library = try await store.createLibrary(name: "Imported Archive", rootPath: base.path, bookmarkData: nil)
        let summary = try await FolderScanner().scan(library: library, store: store) { _ in }
        let items = try await store.items(matching: MediaQuery(libraryID: library.id))

        #expect(summary.itemsIndexed == 1)
        #expect(items.map(\.filename) == ["profile.png"])
        #expect(items.first?.path.hasSuffix("/u/person/profile.png") == true)
    }

    @Test func scanFindsMediaSkipsOthersAndReadsDimensions() async throws {
        let fixture = try await makeFixture()
        let summary = try await FolderScanner(batchSize: 1).scan(
            library: fixture.library,
            store: fixture.store
        ) { _ in }

        #expect(summary.itemsIndexed == 2)
        #expect(summary.foldersSeen == 2)
        #expect(summary.cancelled == false)

        let items = try await fixture.store.items(
            matching: MediaQuery(libraryID: fixture.library.id, sort: .nameAscending)
        )
        #expect(items.map(\.filename) == ["pixel.png", "video.mp4"])
        #expect(items[0].mediaType == .image)
        #expect(items[0].width == 1)
        #expect(items[0].height == 1)
        #expect(items[1].mediaType == .video)

        let folders = try await fixture.store.folders(libraryID: fixture.library.id)
        #expect(folders.count == 2)
        #expect(folders.contains { $0.name == "clips" && $0.itemCount == 1 })

        let library = try await fixture.store.library(id: fixture.library.id)
        #expect(library?.scanStatus == "idle")
        #expect(library?.lastScannedAt != nil)
    }

    @Test func rescanMarksDeletedFilesMissingWithoutDroppingRows() async throws {
        let fixture = try await makeFixture()
        let scanner = FolderScanner()
        _ = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }

        try FileManager.default.removeItem(
            at: fixture.root.appendingPathComponent("clips/video.mp4")
        )
        let second = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }

        #expect(second.markedMissing == 1)
        let visible = try await fixture.store.itemCount(matching: MediaQuery(libraryID: fixture.library.id))
        let total = try await fixture.store.itemCount(
            matching: MediaQuery(libraryID: fixture.library.id, includeMissing: true)
        )
        #expect(visible == 1)
        #expect(total == 2)
    }

    @Test func scanStateTracksCurrentFileMetadata() async throws {
        let fixture = try await makeFixture()
        _ = try await FolderScanner().scan(library: fixture.library, store: fixture.store) { _ in }
        let state = try await fixture.store.mediaScanState(libraryID: fixture.library.id)
        let pixel = try #require(state.first(where: { $0.key.hasSuffix("/pixel.png") })?.value)
        #expect(pixel.sizeBytes == Int64(onePixelPNG.count))
        #expect(pixel.modifiedAt != nil)
    }

    @Test func previouslyDeletedMediaRequiresApprovalBeforeReentry() async throws {
        let fixture = try await makeFixture()
        let scanner = FolderScanner()
        _ = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }

        let original = try #require(try await fixture.store.items(
            matching: MediaQuery(libraryID: fixture.library.id, sort: .nameAscending)
        ).first(where: { $0.filename == "pixel.png" }))
        let hash = SHA256.hash(data: onePixelPNG)
            .map { String(format: "%02x", $0) }
            .joined()
        try await fixture.store.finalizeDeletedMedia(itemID: original.id, contentHash: hash)

        _ = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }
        #expect(try await fixture.store.pendingReentryCount() == 1)
        #expect(try await fixture.store.itemCount(matching: MediaQuery(libraryID: fixture.library.id)) == 1)

        let quarantined = try #require(try await fixture.store.items(
            matching: MediaQuery(libraryID: fixture.library.id, includeMissing: true, sort: .nameAscending)
        ).first(where: { $0.filename == "pixel.png" }))
        #expect(quarantined.missing)
        #expect(quarantined.contentHash == hash)

        try await fixture.store.approveReentry(itemID: quarantined.id)
        #expect(try await fixture.store.pendingReentryCount() == 0)
        #expect(try await fixture.store.itemCount(matching: MediaQuery(libraryID: fixture.library.id)) == 2)

        _ = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }
        #expect(try await fixture.store.pendingReentryCount() == 0)
        #expect(try await fixture.store.itemCount(matching: MediaQuery(libraryID: fixture.library.id)) == 2)
    }

    @Test func changedExistingPathIsQuarantinedWhenItMatchesDeletedMedia() async throws {
        let fixture = try await makeFixture()
        let replacement = fixture.root.appendingPathComponent("replacement.png")
        try Data("different image bytes".utf8).write(to: replacement)
        let scanner = FolderScanner()
        _ = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }

        let original = try #require(try await fixture.store.items(
            matching: MediaQuery(libraryID: fixture.library.id, sort: .nameAscending)
        ).first(where: { $0.filename == "pixel.png" }))
        let hash = SHA256.hash(data: onePixelPNG)
            .map { String(format: "%02x", $0) }
            .joined()
        try await fixture.store.finalizeDeletedMedia(itemID: original.id, contentHash: hash)
        try FileManager.default.removeItem(at: fixture.root.appendingPathComponent("pixel.png"))
        try onePixelPNG.write(to: replacement)

        _ = try await scanner.scan(library: fixture.library, store: fixture.store) { _ in }
        #expect(try await fixture.store.pendingReentryCount() == 1)
        let quarantined = try #require(try await fixture.store.items(
            matching: MediaQuery(libraryID: fixture.library.id, includeMissing: true)
        ).first(where: { $0.filename == "replacement.png" }))
        #expect(quarantined.missing)
        #expect(quarantined.contentHash == hash)
    }

    @Test func scanOfUnreachableRootFailsGracefully() async throws {
        let fixture = try await makeFixture()
        let ghost = try await fixture.store.createLibrary(
            name: "Ghost",
            rootPath: "/tmp/anthora-does-not-exist-\(UUID().uuidString)",
            bookmarkData: nil
        )
        await #expect(throws: ScanError.self) {
            _ = try await FolderScanner().scan(library: ghost, store: fixture.store) { _ in }
        }
        let library = try await fixture.store.library(id: ghost.id)
        #expect(library?.scanStatus == "error")
    }

    @Test func cancelledScanKeepsIndexedItemsAndDoesNotMarkAnythingMissing() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root.deletingLastPathComponent()) }
        let marker = fixture.root.deletingLastPathComponent().appendingPathComponent("cancel")
        let summary = try await FolderScanner(batchSize: 1).scan(
            library: fixture.library,
            store: fixture.store,
            isCancellationRequested: { FileManager.default.fileExists(atPath: marker.path) }
        ) { progress in
            if progress.itemsIndexed == 1 {
                try? Data().write(to: marker)
            }
        }

        #expect(summary.cancelled)
        #expect(summary.itemsIndexed == 1)
        #expect(summary.markedMissing == 0)
        #expect(try await fixture.store.itemCount(
            matching: MediaQuery(libraryID: fixture.library.id, includeMissing: true)
        ) == 1)
        let library = try await fixture.store.library(id: fixture.library.id)
        #expect(library?.scanStatus == "idle")
        #expect(library?.lastScannedAt == nil)
    }

    @Test func freeEditionLimitStopsWithoutMarkingUnseenMediaMissing() async throws {
        let fixture = try await makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root.deletingLastPathComponent()) }
        let summary = try await FolderScanner(batchSize: 1).scan(
            library: fixture.library,
            store: fixture.store,
            maximumItems: 1
        ) { _ in }

        #expect(summary.limitReached)
        #expect(summary.cancelled == false)
        #expect(summary.itemsIndexed == 1)
        #expect(summary.markedMissing == 0)
        #expect(try await fixture.store.itemCount(
            matching: MediaQuery(libraryID: fixture.library.id, includeMissing: true)
        ) == 1)
    }
}
