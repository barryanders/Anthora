import Foundation
import Testing
import LibraryCore
@testable import Scanner

@Suite struct ScaleSmoke {
    @Test func scanAndRescanTwentyFiveThousandFilesInBoundedBatches() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraScale-\(UUID().uuidString)", isDirectory: true)
        let root = base.appendingPathComponent("media", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }
        for d in 0..<100 {
            let dir = root.appendingPathComponent("folder-\(d)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for f in 0..<250 {
                #expect(FileManager.default.createFile(
                    atPath: dir.appendingPathComponent("clip-\(d)-\(f).mp4").path,
                    contents: Data()
                ))
            }
        }
        let store = try LibraryStore(databaseURL: base.appendingPathComponent("t.sqlite"))
        let library = try await store.createLibrary(name: "Scale", rootPath: root.path, bookmarkData: nil)
        let start = Date()
        let summary = try await FolderScanner().scan(library: library, store: store) { _ in }
        let elapsed = Date().timeIntervalSince(start)
        print("SCALE: indexed \(summary.itemsIndexed) items in \(String(format: "%.2f", elapsed))s (\(Int(Double(summary.itemsIndexed)/elapsed))/s)")
        #expect(summary.itemsIndexed == 25_000)

        let rescanStart = Date()
        let rescan = try await FolderScanner().scan(library: library, store: store) { _ in }
        let rescanElapsed = Date().timeIntervalSince(rescanStart)
        print("SCALE: rescanned \(rescan.itemsIndexed) items in \(String(format: "%.2f", rescanElapsed))s")
        #expect(rescan.itemsIndexed == 25_000)
        #expect(try await store.itemCount(matching: MediaQuery(libraryID: library.id)) == 25_000)
    }
}
