import Foundation
import Testing
@testable import LibraryCore

@Test func droppedSourceFoldersValidateAndResolveAliases() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = root.appendingPathComponent("Photos with spaces")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let alias = root.appendingPathComponent("Linked Photos")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: folder)
    #expect(try SourceFolderSelection.paths(from: [folder, alias]) == [folder.resolvingSymlinksInPath().path])
    let file = root.appendingPathComponent("image.jpg")
    try Data([1, 2, 3]).write(to: file)
    #expect(throws: (any Error).self) { try SourceFolderSelection.paths(from: [folder, file]) }
    #expect(throws: (any Error).self) { try SourceFolderSelection.paths(from: [root.appendingPathComponent("missing")]) }
    #expect(throws: (any Error).self) { try SourceFolderSelection.paths(from: [URL(string: "https://example.com/photos")!]) }
    for suffix in ["app", "photoslibrary", "anthora"] {
        let package = root.appendingPathComponent("Library.\(suffix)")
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        #expect(throws: (any Error).self) { try SourceFolderSelection.paths(from: [package]) }
    }
    #expect(try Data(contentsOf: file) == Data([1, 2, 3]))
}
