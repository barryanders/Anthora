import AVFoundation
import Darwin
import Foundation
import CoreML
import CoreGraphics
import CoreImage
import CryptoKit
import ImageIO
import LibraryCore
import Scanner
import UniformTypeIdentifiers
import Vision

enum ReaderError: Error, CustomStringConvertible {
    case usage
    case itemNotFound
    case libraryNotFound
    case authorizationMissing
    case authorizationFailed
    case invalidRange
    case decodeFailed
    case invalidRecoverySource
    case recoveryDownloadFailed
    case writeFailed
    case scanStalled
    case queuedCommandFailed(String)

    var description: String {
        switch self {
        case .usage: return "Usage: AnthoraMediaReader check | thumbnail <item-id> <pixels> <output> [seconds] | read <item-id> <offset> <length>"
        case .itemNotFound: return "Media item was not found"
        case .libraryNotFound: return "Library was not found"
        case .authorizationMissing: return "Library authorization is missing"
        case .authorizationFailed: return "Library authorization could not be activated"
        case .invalidRange: return "Requested byte range is invalid"
        case .decodeFailed: return "Image could not be decoded"
        case .invalidRecoverySource: return "Recovery requires a direct HTTPS media URL"
        case .recoveryDownloadFailed: return "The fresh copy could not be downloaded or validated"
        case .writeFailed: return "Output could not be written"
        case .scanStalled: return "The source folder stopped responding during the scan"
        case .queuedCommandFailed(let message): return message
        }
    }
}

private actor LibraryAccessCache {
    static let shared = LibraryAccessCache()
    private var roots: [Int64: URL] = [:]

    func authorizedRoot(for library: LibraryRecord) throws -> URL {
        if let root = roots[library.id] { return root }
        let access = try beginLibraryAccess(for: library)
        roots[library.id] = access.url
        return access.url
    }
}

private struct LibraryAccess {
    let url: URL
    let securityScoped: Bool

    func stop() {
        if securityScoped { url.stopAccessingSecurityScopedResource() }
    }
}

private func beginLibraryAccess(for library: LibraryRecord) throws -> LibraryAccess {
    // The headless helpers are not sandboxed. Activating persisted scopes
    // there can wedge APFS opens after a helper update despite a readable mount.
    if ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] == nil {
        return LibraryAccess(url: library.rootURL, securityScoped: false)
    }
    guard let bookmark = library.bookmarkData else { throw ReaderError.authorizationMissing }
    let resolved = try FolderBookmark.resolve(bookmark)
    guard resolved.url.startAccessingSecurityScopedResource() else {
        throw ReaderError.authorizationFailed
    }
    return LibraryAccess(url: resolved.url, securityScoped: true)
}

private func bundledFFmpegFrame(url: URL, maxPixelSize: Int, seconds: Double = 1) async -> CGImage? {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        .deletingLastPathComponent()
        .appendingPathComponent("AnthoraFFmpeg")
    guard FileManager.default.isExecutableFile(atPath: executable.path) else { return nil }

    let output = FileManager.default.temporaryDirectory
        .appendingPathComponent("AnthoraFrame-\(UUID().uuidString).jpg")
    let process = Process()
    process.executableURL = executable
    process.arguments = [
        "-v", "error", "-ss", String(format: "%.3f", max(0, seconds)), "-i", url.path,
        "-frames:v", "1",
        "-vf", "scale=\(maxPixelSize):\(maxPixelSize):force_original_aspect_ratio=decrease",
        "-c:v", "mjpeg", "-strict", "unofficial", "-q:v", "3",
        "-y", output.path,
    ]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice

    return await withCheckedContinuation { continuation in
        process.terminationHandler = { finished in
            defer { try? FileManager.default.removeItem(at: output) }
            guard finished.terminationStatus == 0,
                  let source = CGImageSourceCreateWithURL(output as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                continuation.resume(returning: nil)
                return
            }
            continuation.resume(returning: image)
        }
        do {
            try process.run()
            DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
                if process.isRunning { process.terminate() }
            }
        } catch {
            try? FileManager.default.removeItem(at: output)
            continuation.resume(returning: nil)
        }
    }
}

// Adapted from Apple's Queryable BPE tokenizer under the repository's MIT license.
private struct CLIPTokenizer {
    struct Pair: Hashable { let first: String; let second: String }
    private let merges: [Pair: Int]
    private let vocabulary: [String: Int]
    private let unknownID: Int

    init(mergesURL: URL, vocabularyURL: URL) throws {
        vocabulary = try JSONDecoder().decode([String: Int].self, from: Data(contentsOf: vocabularyURL))
        unknownID = vocabulary["<|endoftext|>"] ?? 0
        let lines = try String(contentsOf: mergesURL, encoding: .utf8).split(separator: "\n")
        merges = Dictionary(uniqueKeysWithValues: lines.enumerated().compactMap { index, line in
            guard !line.hasPrefix("#") else { return nil }
            let components = line.split(separator: " ")
            guard components.count == 2 else { return nil }
            return (Pair(first: String(components[0]), second: String(components[1])), index)
        })
    }

    func tokens(for input: String, count: Int = 77) -> [Int32] {
        var pieces = ["<|startoftext|>"]
        pieces += input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .split(whereSeparator: { $0.isWhitespace }).flatMap(encode)
        pieces.append("<|endoftext|>")
        var ids = pieces.prefix(count).map { Int32(vocabulary[$0] ?? unknownID) }
        if ids.count < count { ids += repeatElement(0, count: count - ids.count) }
        return ids
    }

    private func encode(_ word: Substring) -> [String] {
        var tokens = word.map(String.init)
        guard let last = tokens.indices.last else { return [] }
        tokens[last] += "</w>"
        while tokens.count > 1 {
            let candidates = adjacentPairs(tokens).compactMap { pair in merges[pair].map { (pair, $0) } }
            guard let selected = candidates.min(by: { $0.1 < $1.1 })?.0 else { break }
            var merged: [String] = []
            var index = 0
            while index < tokens.count {
                if index + 1 < tokens.count, tokens[index] == selected.first, tokens[index + 1] == selected.second {
                    merged.append(selected.first + selected.second)
                    index += 2
                } else {
                    merged.append(tokens[index])
                    index += 1
                }
            }
            tokens = merged
        }
        return tokens
    }

    private func adjacentPairs(_ tokens: [String]) -> Set<Pair> {
        Set(zip(tokens, tokens.dropFirst()).map { Pair(first: $0.0, second: $0.1) })
    }
}

@main
struct AnthoraMediaReader {
    private static let videoFingerprintModel = "video-dhash-samples-v1"

    private struct VideoFingerprintSample: Codable {
        let time: Double
        let hash: String
    }

    static func main() async {
        do {
            try await run(Array(CommandLine.arguments.dropFirst()))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }

    private static func run(_ arguments: [String]) async throws {
        guard let command = arguments.first else { throw ReaderError.usage }
        if command == "worker" {
            guard arguments.count == 2 else { throw ReaderError.usage }
            try await runWorker(queue: URL(fileURLWithPath: arguments[1], isDirectory: true))
            return
        }
        if command == "analysis-worker" {
            guard arguments.count == 2 else { throw ReaderError.usage }
            try await runAnalysisWorker(queue: URL(fileURLWithPath: arguments[1], isDirectory: true))
            return
        }
        if command == "self-test-consolidation" {
            try selfTestConsolidation()
            FileHandle.standardOutput.write(Data("ok\n".utf8))
            return
        }
        if command == "check-face-model" {
            guard FaceEmbeddingEngine.selfTest() else { throw ReaderError.decodeFailed }
            FileHandle.standardOutput.write(Data("ok\n".utf8))
            return
        }
        if command == "check-semantic-model" {
            guard MobileCLIPEngine.selfTest() else { throw ReaderError.decodeFailed }
            FileHandle.standardOutput.write(Data("ok\n".utf8))
            return
        }
        if command == "check-florence-model" {
            guard FlorencePeopleVerifier.isAvailable else { throw ReaderError.decodeFailed }
            FileHandle.standardOutput.write(Data("ok\n".utf8))
            return
        }
        if command == "check-florence-image" {
            guard arguments.count == 2 else { throw ReaderError.usage }
            let result = try await FlorencePeopleVerifier.analyze(
                url: URL(fileURLWithPath: arguments[1])
            )
            let payload: [String: Any] = [
                "personDetected": result.personDetected,
                "tokenCount": result.tokenCount,
                "modelVersion": FlorencePeopleVerifier.modelVersion,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            return
        }
        if command == "check-florence-images" {
            guard arguments.count > 1 else { throw ReaderError.usage }
            var payload: [[String: Any]] = []
            for path in arguments.dropFirst() {
                let result = try await FlorencePeopleVerifier.analyze(
                    url: URL(fileURLWithPath: path)
                )
                payload.append([
                    "path": path,
                    "personDetected": result.personDetected,
                    "tokenCount": result.tokenCount,
                ])
            }
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            return
        }
        let store = try LibraryStore(databaseURL: AppPaths.databaseURL())
        if command == "authorize-library" {
            guard arguments.count == 3, let libraryID = Int64(arguments[1]) else { throw ReaderError.usage }
            let url = URL(fileURLWithPath: arguments[2], isDirectory: true)
            let bookmark = try FolderBookmark.create(for: url)
            try await store.updateLibraryBookmark(id: libraryID, bookmarkData: bookmark)
            FileHandle.standardOutput.write(Data("ok\n".utf8))
            return
        }
        if command == "check" {
            let libraries = try await store.allLibraries()
            for library in libraries {
                let access = try beginLibraryAccess(for: library)
                defer { access.stop() }
                guard FileManager.default.isReadableFile(atPath: access.url.path) else {
                    throw ReaderError.authorizationFailed
                }
            }
            FileHandle.standardOutput.write(Data("ok\n".utf8))
            return
        }

        if command == "sync-references" {
            guard arguments.count == 2, let libraryID = Int64(arguments[1]),
                  let library = try await store.library(id: libraryID) else { throw ReaderError.libraryNotFound }
            let access = try beginLibraryAccess(for: library)
            defer { access.stop() }
            let references = reconcileReferences(root: access.url)
            try await store.replaceMediaReferences(libraryID: libraryID, references: references)
            return
        }

        if command == "scan-library" {
            guard (2...4).contains(arguments.count), let libraryID = Int64(arguments[1]),
                  let library = try await store.library(id: libraryID) else { throw ReaderError.libraryNotFound }
            let cancellationFile = arguments.count >= 3 ? URL(fileURLWithPath: arguments[2]) : nil
            let maximumItems = arguments.count == 4 ? Int(arguments[3]) : nil
            let summary = try await FolderScanner().scan(
                library: library,
                store: store,
                maximumItems: maximumItems,
                isCancellationRequested: {
                    cancellationFile.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
                }
            ) { _ in
                guard let path = ProcessInfo.processInfo.environment["ANTHORA_SCAN_HEARTBEAT"] else { return }
                if FileManager.default.fileExists(atPath: path) {
                    try? FileManager.default.setAttributes(
                        [.modificationDate: Date()],
                        ofItemAtPath: path
                    )
                } else {
                    FileManager.default.createFile(atPath: path, contents: Data())
                }
            }
            let payload: [String: Any] = [
                "itemsIndexed": summary.itemsIndexed,
                "foldersSeen": summary.foldersSeen,
                "markedMissing": summary.markedMissing,
                "cancelled": summary.cancelled,
                "limitReached": summary.limitReached,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            return
        }

        if command == "export-social-identities" {
            guard arguments.count == 2 else { throw ReaderError.usage }
            guard let library = try await store.allLibraries().first(where: { $0.name == "Social Archive" }) else { throw ReaderError.libraryNotFound }
            let access = try beginLibraryAccess(for: library)
            defer { access.stop() }
            let archive = access.url.appendingPathComponent("_database/archive.sqlite3")
            let snapshotDirectory = FileManager.default.temporaryDirectory
                .appendingPathComponent("Anthora-SocialArchive-Snapshot", isDirectory: true)
            try? FileManager.default.removeItem(at: snapshotDirectory)
            try FileManager.default.createDirectory(at: snapshotDirectory, withIntermediateDirectories: true)
            let snapshot = snapshotDirectory.appendingPathComponent("archive.sqlite3")
            for suffix in ["", "-wal", "-shm"] {
                let source = URL(fileURLWithPath: archive.path + suffix)
                guard FileManager.default.fileExists(atPath: source.path) else { continue }
                try FileManager.default.copyItem(
                    at: source,
                    to: URL(fileURLWithPath: snapshot.path + suffix)
                )
            }
            let identities = try SocialArchiveIdentityReader.read(databaseURL: snapshot)
            try? FileManager.default.removeItem(at: snapshotDirectory)
            let output = URL(fileURLWithPath: arguments[1])
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(identities).write(to: output, options: .atomic)
            return
        }

        if command == "social-archive-latest-ref" {
            guard arguments.count == 2 else { throw ReaderError.usage }
            guard let library = try await store.allLibraries().first(where: { $0.name == "Social Archive" }) else {
                throw ReaderError.libraryNotFound
            }
            let access = try beginLibraryAccess(for: library)
            defer { access.stop() }
            let archive = access.url.appendingPathComponent("_database/archive.sqlite3")
            let latestReferenceID = try SocialArchiveIdentityReader.latestReferenceID(databaseURL: archive)
            let output = URL(fileURLWithPath: arguments[1])
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            let payload = try JSONSerialization.data(
                withJSONObject: ["latestRefId": latestReferenceID],
                options: [.sortedKeys]
            )
            try payload.write(to: output, options: .atomic)
            return
        }

        if command == "analyze-text-batch" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 10, 50)) : 10
            let items = try await store.unanalyzedMedia(modelVersion: TextAnalyzer.modelVersion, limit: limit)
            for item in items {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let needsSemanticEmbedding = try await !store.hasSemanticEmbedding(
                    itemID: item.id,
                    modelVersion: MobileCLIPEngine.modelVersion
                )
                let result = await TextAnalyzer.analyze(
                    url: item.fileURL,
                    mediaType: item.mediaType,
                    includeSemanticEmbedding: needsSemanticEmbedding
                )
                access.stop()
                try await store.saveTextAnalysis(
                    itemID: item.id,
                    modelVersion: TextAnalyzer.modelVersion,
                    result: result.text
                )
                if result.text.errorMessage != nil,
                   let recovery = recoveryMetadata(at: item.fileURL) {
                    try await store.saveRecoverySource(
                        itemID: item.id,
                        provider: recovery.provider,
                        sourceURL: recovery.sourceURL,
                        downloadURL: recovery.downloadURL
                    )
                }
                try await store.replaceVisionLabels(itemID: item.id, labels: result.labels)
                if let semanticEmbedding = result.semanticEmbedding {
                    try await store.saveSemanticEmbedding(itemID: item.id, modelVersion: MobileCLIPEngine.modelVersion, embedding: semanticEmbedding)
                }
                try await store.saveFaceAnalysis(itemID: item.id, boxesJSON: result.faceBoxesJSON, count: result.faceCount)
                try await store.savePersonAnalysis(itemID: item.id, count: result.personCount)
                let referencePaths = try await store.referencePaths(itemID: item.id)
                let personSeed = result.faceCount == 1 ? TextAnalyzer.personSeed(paths: [item.path] + referencePaths) : nil
                try await store.replaceFaceFeatures(itemID: item.id, personKey: personSeed, features: result.faceFeatures)
            }
            return
        }

        if command == "analyze-accurate-text-batch" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 4, 16)) : 4
            let items = try await store.imagesMissingAccurateText(modelVersion: AccurateImageText.modelVersion, limit: limit)
            for item in items {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let result = AccurateImageText.analyze(url: item.fileURL)
                access.stop()
                try await store.saveAccurateText(itemID: item.id, modelVersion: AccurateImageText.modelVersion, result: result)
            }
            return
        }

        if command == "analyze-quality-batch" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 8, 24)) : 8
            for item in try await store.mediaMissingQualityAnalysis(
                modelVersion: QualityAnalyzer.modelVersion,
                limit: limit
            ) {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let result = await QualityAnalyzer.analyze(
                    url: item.fileURL,
                    mediaType: item.mediaType,
                    duration: item.durationSeconds
                )
                access.stop()
                try await store.saveQualityAnalysis(
                    itemID: item.id,
                    modelVersion: QualityAnalyzer.modelVersion,
                    meanLuma: result.meanLuma,
                    darkFraction: result.darkFraction,
                    lightFraction: result.lightFraction,
                    detailScore: result.detailScore,
                    motionScore: result.motionScore,
                    errorMessage: result.errorMessage
                )
            }
            return
        }

        if command == "discover-recovery-sources" {
            for item in try await store.unreadableMedia(limit: 100_000) {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let recovery = recoveryMetadata(at: item.fileURL)
                access.stop()
                if let recovery {
                    try await store.saveRecoverySource(
                        itemID: item.id,
                        provider: recovery.provider,
                        sourceURL: recovery.sourceURL,
                        downloadURL: recovery.downloadURL
                    )
                }
            }
            return
        }

        if command == "analyze-person-batch" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 24, 100)) : 24
            for item in try await store.imagesMissingPersonAnalysis(limit: limit) {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let count = PersonAnalyzer.count(url: item.fileURL)
                access.stop()
                try await store.savePersonAnalysis(itemID: item.id, count: count)
            }
            return
        }

        if command == "analyze-secondary-people-batch" {
            guard FlorencePeopleVerifier.isAvailable else { return }
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 1, 4)) : 1
            let items = try await store.imagesNeedingSecondaryPeopleAnalysis(
                modelVersion: FlorencePeopleVerifier.modelVersion,
                limit: limit
            )
            for item in items {
                do {
                    guard let library = try await store.library(id: item.libraryID) else {
                        throw ReaderError.libraryNotFound
                    }
                    let access = try beginLibraryAccess(for: library)
                    defer { access.stop() }
                    let result: FlorencePeopleVerifier.Result
                    result = try await FlorencePeopleVerifier.analyze(url: item.fileURL)
                    try await store.saveSecondaryPeopleAnalysis(
                        itemID: item.id,
                        modelVersion: FlorencePeopleVerifier.modelVersion,
                        personDetected: result.personDetected,
                        tokenCount: result.tokenCount
                    )
                } catch {
                    try await store.saveSecondaryPeopleAnalysis(
                        itemID: item.id,
                        modelVersion: FlorencePeopleVerifier.modelVersion,
                        personDetected: false,
                        tokenCount: 0,
                        errorMessage: String(describing: error)
                    )
                }
            }
            return
        }

        if command == "prewarm-thumbnail-batch" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 4, 20)) : 4
            let cache = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Caches/AnthoraService/Thumbnails", isDirectory: true)
            for item in try await store.itemsMissingThumbnail(limit: limit) {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let modified = Int(item.modifiedAt?.timeIntervalSince1970 ?? 0)
                let key = Data("\(item.id):600:\(modified)".utf8)
                let fingerprint = SHA256.hash(data: key).map { String(format: "%02x", $0) }.joined()
                let output = cache
                    .appendingPathComponent(String(fingerprint.prefix(2)), isDirectory: true)
                    .appendingPathComponent("\(fingerprint).jpg")
                if !FileManager.default.fileExists(atPath: output.path) {
                    try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try await writeThumbnail(source: item.fileURL, pixels: 600, output: output)
                }
                try await store.saveThumbnailPath(itemID: item.id, path: output.path)
                access.stop()
            }
            return
        }

        if command == "backfill-video-metadata" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 20, 500)) : 20
            for item in try await store.videosMissingMetadata(limit: limit) {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                let asset = AVURLAsset(url: item.fileURL)
                guard let track = try? await asset.loadTracks(withMediaType: .video).first,
                      let naturalSize = try? await track.load(.naturalSize),
                      let transform = try? await track.load(.preferredTransform) else {
                    access.stop()
                    continue
                }
                let displayedSize = naturalSize.applying(transform)
                let width = Int(abs(displayedSize.width).rounded())
                let height = Int(abs(displayedSize.height).rounded())
                let duration = try? await asset.load(.duration)
                let frameRate = try? await track.load(.nominalFrameRate)
                access.stop()
                guard width > 0, height > 0 else { continue }
                let seconds = duration.map(CMTimeGetSeconds).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
                try await store.saveVideoMetadata(
                    itemID: item.id,
                    width: width,
                    height: height,
                    durationSeconds: seconds,
                    frameRate: frameRate.map(Double.init)
                )
            }
            return
        }

        if command == "purge-item" {
            guard arguments.count >= 2, let itemID = Int64(arguments[1]),
                  let item = try await store.item(id: itemID),
                  let library = try await store.library(id: item.libraryID) else { throw ReaderError.itemNotFound }
            let access = try beginLibraryAccess(for: library)
            defer { access.stop() }
            let deleteNow = arguments.count > 2 && arguments[2] == "now"
            try await purge(item: item, store: store, deleteNow: deleteNow)
            return
        }

        if command == "recover-item" {
            guard arguments.count == 4, let itemID = Int64(arguments[1]),
                  let item = try await store.item(id: itemID),
                  let library = try await store.library(id: item.libraryID) else { throw ReaderError.itemNotFound }
            let jobID = arguments[3]
            let access = try beginLibraryAccess(for: library)
            defer { access.stop() }
            do {
                try await store.updateRecoveryJob(id: jobID, status: "running")
                try await recover(item: item, source: arguments[2], store: store)
                try await store.updateRecoveryJob(id: jobID, status: "completed")
            } catch {
                try? await store.updateRecoveryJob(
                    id: jobID,
                    status: "failed",
                    errorMessage: String(describing: error)
                )
                throw error
            }
            return
        }

        if command == "purge-expired" {
            let cutoff = Date().addingTimeInterval(-30 * 24 * 60 * 60)
            let items = try await store.expiredTrashItems(before: cutoff, limit: 20)
            for item in items {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                do { try await purge(item: item, store: store, deleteNow: false) } catch { }
                access.stop()
            }
            return
        }

        if command == "hash-duplicate-candidates" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 4, 20)) : 4
            let items = try await store.unhashedDuplicateCandidates(limit: limit)
            for item in items {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                if let digest = try? sha256(url: item.fileURL) {
                    try await store.saveContentHash(itemID: item.id, hash: digest)
                }
                access.stop()
            }
            return
        }
        if command == "hash-visual-batch" {
            let items = try await store.unhashedVisualImages(limit: 8)
            for item in items {
                guard let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                if let hash = differenceHash(url: item.fileURL) { try await store.saveVisualHash(itemID: item.id, hash: hash) }
                access.stop()
            }
            return
        }
        if command == "hash-video-visual-batch" {
            let limit = arguments.count > 1 ? max(1, min(Int(arguments[1]) ?? 1, 4)) : 1
            let items = try await store.videosMissingFingerprint(
                modelVersion: videoFingerprintModel,
                limit: limit
            )
            for item in items {
                guard let duration = item.durationSeconds, duration > 0,
                      let library = try await store.library(id: item.libraryID),
                      let access = try? beginLibraryAccess(for: library) else { continue }
                do {
                    let samples = try await videoFingerprintSamples(url: item.fileURL, duration: duration)
                    let data = try JSONEncoder().encode(samples)
                    try await store.saveVideoFingerprint(
                        itemID: item.id,
                        modelVersion: videoFingerprintModel,
                        durationSeconds: duration,
                        samplesJSON: String(decoding: data, as: UTF8.self),
                        errorMessage: samples.count >= 2 ? nil : "Too few frames could be decoded"
                    )
                } catch {
                    try? await store.saveVideoFingerprint(
                        itemID: item.id,
                        modelVersion: videoFingerprintModel,
                        durationSeconds: duration,
                        samplesJSON: "[]",
                        errorMessage: String(describing: error)
                    )
                }
                access.stop()
            }
            return
        }
        if command == "consolidate-exact" {
            guard arguments.count == 3, let keepID = Int64(arguments[1]), let removeID = Int64(arguments[2]),
                  keepID != removeID, try await store.areExactDuplicates(keepID, removeID),
                  let keep = try await store.item(id: keepID), let remove = try await store.item(id: removeID) else {
                throw ReaderError.itemNotFound
            }
            var scoped: [LibraryAccess] = []
            var libraryRoots: [Int64: URL] = [:]
            for libraryID in Set([keep.libraryID, remove.libraryID]) {
                guard let library = try await store.library(id: libraryID) else { throw ReaderError.authorizationMissing }
                let access = try beginLibraryAccess(for: library)
                scoped.append(access)
                libraryRoots[libraryID] = access.url
            }
            defer { scoped.forEach { $0.stop() } }
            let keeperAssociation = profileAssociationPath(for: keep.fileURL)
            let references = try await store.referenceLocations(itemID: removeID)
            let preserved = references.filter {
                profileAssociationPath(for: URL(fileURLWithPath: $0.path)) != keeperAssociation
            }
            let discarded = references.filter {
                profileAssociationPath(for: URL(fileURLWithPath: $0.path)) == keeperAssociation
            }
            let preserveRedundant = profileAssociationPath(for: remove.fileURL) != keeperAssociation
            try replaceWithReferences(
                keeper: keep.fileURL,
                redundant: remove.fileURL,
                references: preserved.map { URL(fileURLWithPath: $0.path) },
                discardedReferences: discarded.map { URL(fileURLWithPath: $0.path) },
                preserveRedundant: preserveRedundant,
                stagingRoot: libraryRoots[remove.libraryID]
            )
            var databaseReferences = preserved
            if preserveRedundant {
                databaseReferences.append((remove.path, remove.folderID))
            }
            try await store.consolidateExactDuplicate(
                keepID: keepID,
                removeID: removeID,
                preservedReferences: databaseReferences
            )
            return
        }
        if command == "match-face-batch" {
            let seeded = try await store.seededFaceFeatures(limit: 2_000).compactMap { record -> (String, [Float])? in
                guard let key = record.personKey, let vector = FaceEmbeddingEngine.decode(record.blob) else { return nil }
                return (key, vector)
            }
            let unassigned = try await store.unassignedFaceFeatures(limit: 20)
            for record in unassigned {
                guard let candidate = FaceEmbeddingEngine.decode(record.blob) else { continue }
                var bestByPerson: [String: Float] = [:]
                for (person, exemplar) in seeded {
                    let similarity = FaceEmbeddingEngine.cosine(candidate, exemplar)
                    bestByPerson[person] = max(bestByPerson[person] ?? -.greatestFiniteMagnitude, similarity)
                }
                let ranked = bestByPerson.sorted { $0.value > $1.value }
                guard let best = ranked.first else { continue }
                let second = ranked.count > 1 ? ranked[1].value : -.greatestFiniteMagnitude
                print("face-distance media=\(record.mediaID) face=\(record.faceIndex) best=\(best.value) second=\(second) person=\(best.key)")
                guard best.value >= 0.58, best.value - second >= 0.08 else { continue }
                try await store.assignFace(mediaID: record.mediaID, faceIndex: record.faceIndex, personKey: best.key, distance: Double(1 - best.value))
            }
            return
        }
        if command == "cluster-face-batch" {
            let requestedLimit = arguments.count > 1 ? Int(arguments[1]) ?? 80 : 80
            let requestedOffset = arguments.count > 2 ? Int(arguments[2]) ?? 0 : 0
            let total = try await store.unassignedFaceFeatureCount()
            guard total > 1 else { return }
            let offset = max(0, requestedOffset) % total
            let records = try await store.unassignedFaceFeatures(limit: min(max(requestedLimit, 20), 160), offset: offset)
            let decoded = records.compactMap { record -> (FaceFeatureRecord, [Float])? in
                guard let vector = FaceEmbeddingEngine.decode(record.blob) else { return nil }
                return (record, vector)
            }
            guard decoded.count > 1 else { return }

            let seeded = try await store.seededFaceFeatures(limit: 3_000).compactMap { record -> (String, [Float])? in
                guard let key = record.personKey, let vector = FaceEmbeddingEngine.decode(record.blob) else { return nil }
                return (key, vector)
            }
            var remaining: [(FaceFeatureRecord, [Float])] = []
            for (record, candidate) in decoded {
                var bestByPerson: [String: (score: Float, exemplar: [Float])] = [:]
                for (person, exemplar) in seeded {
                    let score = FaceEmbeddingEngine.cosine(candidate, exemplar)
                    if score > (bestByPerson[person]?.score ?? -.greatestFiniteMagnitude) {
                        bestByPerson[person] = (score, exemplar)
                    }
                }
                let ranked = bestByPerson.sorted { $0.value.score > $1.value.score }
                let best = ranked.first
                let second = ranked.count > 1 ? ranked[1] : nil
                if let best, best.value.score >= 0.64,
                   best.value.score - (second?.value.score ?? -.greatestFiniteMagnitude) >= 0.07 {
                    try await store.assignFace(
                        mediaID: record.mediaID,
                        faceIndex: record.faceIndex,
                        personKey: best.key,
                        distance: Double(1 - best.value.score)
                    )
                } else if let best, let second,
                          // A new face can bridge two clusters that Anthora
                          // previously split for the same person. Keep this
                          // deliberately stricter than ordinary assignment:
                          // both clusters and their exemplars must agree, then
                          // LibraryStore applies the manual-edit and same-photo
                          // safety gates before changing either identity.
                          best.value.score >= 0.80,
                          second.value.score >= 0.78,
                          FaceEmbeddingEngine.cosine(best.value.exemplar, second.value.exemplar) >= 0.80,
                          let consolidated = try await store.consolidateVisionPeople(best.key, second.key) {
                    try await store.assignFace(
                        mediaID: record.mediaID,
                        faceIndex: record.faceIndex,
                        personKey: consolidated,
                        distance: Double(1 - best.value.score)
                    )
                    print("face-groups-consolidated source=vision target=\(consolidated)")
                } else {
                    remaining.append((record, candidate))
                }
            }

            var nearest: [(index: Int, score: Float, margin: Float)?] = Array(repeating: nil, count: remaining.count)
            for left in remaining.indices {
                var bestIndex = -1
                var best = -Float.greatestFiniteMagnitude
                var second = -Float.greatestFiniteMagnitude
                for right in remaining.indices where left != right {
                    let score = FaceEmbeddingEngine.cosine(remaining[left].1, remaining[right].1)
                    if score > best {
                        second = best
                        best = score
                        bestIndex = right
                    } else if score > second {
                        second = score
                    }
                }
                if bestIndex >= 0 {
                    nearest[left] = (bestIndex, best, best - second)
                }
            }
            var assigned = Set<Int>()
            for left in remaining.indices where !assigned.contains(left) {
                guard let match = nearest[left], match.score >= 0.72, match.margin >= 0.04,
                      !assigned.contains(match.index), nearest[match.index]?.index == left else { continue }
                let pair = [remaining[left].0, remaining[match.index].0]
                let first = pair.min { lhs, rhs in
                    lhs.mediaID == rhs.mediaID ? lhs.faceIndex < rhs.faceIndex : lhs.mediaID < rhs.mediaID
                }!
                let personKey = "person_\(first.mediaID)_\(first.faceIndex)"
                try await store.assignFaces(pair, personKey: personKey, distance: Double(1 - match.score))
                assigned.insert(left)
                assigned.insert(match.index)
            }
            return
        }
        if command == "regroup-face-assignments" {
            let reopened = try await store.reopenMachineFaceGroupsForRegrouping()
            print("face-regroup-reopened=\(reopened)")
            return
        }
        if command == "calibrate-face-matching" {
            let seeded = try await store.seededFaceFeatures(limit: 2_000).compactMap { record -> (FaceFeatureRecord, [Float])? in
                guard let vector = FaceEmbeddingEngine.decode(record.blob) else { return nil }
                return (record, vector)
            }
            var sameDistances: [Float] = []
            var differentDistances: [Float] = []
            for (record, candidate) in seeded.prefix(300) {
                guard let person = record.personKey else { continue }
                var nearestSame = -Float.greatestFiniteMagnitude
                var nearestDifferent = -Float.greatestFiniteMagnitude
                for (other, exemplar) in seeded where other.mediaID != record.mediaID {
                    guard let otherPerson = other.personKey else { continue }
                    let distance = FaceEmbeddingEngine.cosine(candidate, exemplar)
                    if otherPerson == person {
                        nearestSame = max(nearestSame, distance)
                    } else {
                        nearestDifferent = max(nearestDifferent, distance)
                    }
                }
                let hasSame = nearestSame > -Float.greatestFiniteMagnitude
                let hasDifferent = nearestDifferent > -Float.greatestFiniteMagnitude
                if hasSame { sameDistances.append(nearestSame) }
                if hasDifferent { differentDistances.append(nearestDifferent) }
                if hasSame && hasDifferent {
                    print("face-calibration person=\(person) same=\(nearestSame) different=\(nearestDifferent) correct=\(nearestSame > nearestDifferent)")
                }
            }
            func percentile(_ values: [Float], _ fraction: Double) -> Float {
                let sorted = values.sorted()
                guard !sorted.isEmpty else { return .nan }
                return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * fraction))]
            }
            let correct = zip(sameDistances, differentDistances).filter { $0 > $1 }.count
            let accepted = zip(sameDistances, differentDistances).filter { max($0, $1) >= 0.58 && abs($0 - $1) >= 0.08 }
            let acceptedCorrect = accepted.filter { $0 > $1 }.count
            print("face-calibration-summary samples=\(min(sameDistances.count, differentDistances.count)) correct=\(correct) accepted=\(accepted.count) accepted-correct=\(acceptedCorrect) same-p50=\(percentile(sameDistances, 0.5)) same-p90=\(percentile(sameDistances, 0.9)) different-p10=\(percentile(differentDistances, 0.1)) different-p50=\(percentile(differentDistances, 0.5))")
            return
        }
        if command == "semantic-query" {
            guard arguments.count == 4 else { throw ReaderError.usage }
            let ranked = try await EmbeddingBackendRegistry.search(
                modelVersion: arguments[1],
                query: arguments[2],
                store: store,
                limit: 5_000
            )
            let payload = ranked.map { ["id": $0.0, "score": $0.1] as [String: Any] }
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: URL(fileURLWithPath: arguments[3]), options: .atomic)
            return
        }

        guard arguments.count >= 2, let itemID = Int64(arguments[1]),
              let item = try await store.item(id: itemID) else { throw ReaderError.itemNotFound }
        guard let library = try await store.library(id: item.libraryID) else { throw ReaderError.libraryNotFound }
        _ = try await LibraryAccessCache.shared.authorizedRoot(for: library)

        switch command {
        case "thumbnail":
            guard (arguments.count == 4 || arguments.count == 5),
                  let pixels = Int(arguments[2]), pixels >= 64 else { throw ReaderError.usage }
            let seconds = arguments.count == 5 ? Double(arguments[4]) : nil
            try await writeThumbnail(
                source: item.fileURL,
                pixels: min(pixels, 4800),
                output: URL(fileURLWithPath: arguments[3]),
                videoSeconds: seconds
            )
        case "read":
            guard arguments.count == 4,
                  let offset = UInt64(arguments[2]),
                  let length = Int(arguments[3]), length > 0 else { throw ReaderError.usage }
            try stream(source: item.fileURL, offset: offset, length: length)
        case "read-file":
            guard arguments.count == 5,
                  let offset = UInt64(arguments[2]),
                  let length = Int(arguments[3]), length > 0 else { throw ReaderError.usage }
            try copyRange(
                source: item.fileURL,
                offset: offset,
                length: length,
                output: URL(fileURLWithPath: arguments[4])
            )
        default:
            throw ReaderError.usage
        }
    }

    private static func reconcileReferences(root: URL) -> [MediaReferenceInput] {
        let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isDirectoryKey]
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles, .skipsPackageDescendants],
            errorHandler: { _, _ in true }
        ) else { return [] }
        var references: [MediaReferenceInput] = []
        for case let url as URL in enumerator {
            if ["_database", "_objects"].contains(url.lastPathComponent.lowercased()) {
                if (try? url.resourceValues(forKeys: Set(keys)).isDirectory) == true {
                    enumerator.skipDescendants()
                }
                continue
            }
            guard (try? url.resourceValues(forKeys: Set(keys)).isSymbolicLink) == true else { continue }
            let target = url.resolvingSymlinksInPath()
            if profileAssociationPath(for: url) == profileAssociationPath(for: target) {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            references.append(MediaReferenceInput(
                path: url.path,
                targetPath: target.path,
                folderPath: url.deletingLastPathComponent().path
            ))
        }
        return references
    }

    private static func purge(item: MediaItemRecord, store: LibraryStore, deleteNow: Bool) async throws {
        let contentHash: String?
        if let existingHash = item.contentHash {
            contentHash = existingHash
        } else if FileManager.default.fileExists(atPath: item.fileURL.path) {
            contentHash = try sha256(url: item.fileURL)
        } else {
            contentHash = nil
        }
        let identityItems: [MediaItemRecord]
        if contentHash != nil {
            if item.contentHash == nil {
                try await store.saveContentHash(itemID: item.id, hash: contentHash!)
            }
            identityItems = try await store.exactIdentityItems(itemID: item.id)
        } else {
            identityItems = [item]
        }
        var additionalScopes: [LibraryAccess] = []
        for libraryID in Set(identityItems.map(\.libraryID)) where libraryID != item.libraryID {
            guard let library = try await store.library(id: libraryID) else { throw ReaderError.authorizationMissing }
            additionalScopes.append(try beginLibraryAccess(for: library))
        }
        defer { additionalScopes.forEach { $0.stop() } }
        for identityItem in identityItems {
            let references = try await store.referencePaths(itemID: identityItem.id)
            if FileManager.default.fileExists(atPath: identityItem.fileURL.path)
                || (try? FileManager.default.destinationOfSymbolicLink(atPath: identityItem.fileURL.path)) != nil {
                if deleteNow {
                    try removeFileImmediately(at: identityItem.fileURL)
                } else {
                    try FileManager.default.trashItem(at: identityItem.fileURL, resultingItemURL: nil)
                }
            }
            for path in references where FileManager.default.fileExists(atPath: path)
                || (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) != nil {
                try? FileManager.default.removeItem(atPath: path)
            }
            if let contentHash {
                try await store.finalizeDeletedMedia(itemID: identityItem.id, contentHash: contentHash)
            } else {
                try await store.deleteMediaRecord(itemID: identityItem.id)
            }
        }
    }

    private static func removeFileImmediately(at url: URL) throws {
        let result = url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return Int32(-1) }
            return Darwin.unlink(path)
        }
        guard result == 0 || errno == ENOENT else { throw ReaderError.writeFailed }
    }

    private static func recover(item: MediaItemRecord, source: String, store: LibraryStore) async throws {
        guard let sourceURL = URL(string: source), sourceURL.scheme == "https",
              sourceURL.host != nil, sourceURL.user == nil, sourceURL.password == nil else {
            throw ReaderError.invalidRecoverySource
        }

        let (downloaded, response) = try await URLSession.shared.download(from: sourceURL)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              http.url?.scheme == "https",
              http.url?.user == nil,
              http.url?.password == nil else {
            throw ReaderError.recoveryDownloadFailed
        }
        let candidate = item.fileURL.deletingLastPathComponent().appendingPathComponent(
            ".anthora-recovery-\(UUID().uuidString)-\(item.filename)"
        )
        defer { try? FileManager.default.removeItem(at: candidate) }
        try FileManager.default.moveItem(at: downloaded, to: candidate)
        let values = try candidate.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        guard let size = values.fileSize, size > 0,
              await validatesMedia(at: candidate, mediaType: item.mediaType) else {
            throw ReaderError.recoveryDownloadFailed
        }

        var trashedOriginal: NSURL?
        if FileManager.default.fileExists(atPath: item.fileURL.path) {
            try FileManager.default.trashItem(at: item.fileURL, resultingItemURL: &trashedOriginal)
        }
        do {
            try FileManager.default.moveItem(at: candidate, to: item.fileURL)
        } catch {
            if let trashedOriginal {
                try? FileManager.default.moveItem(at: trashedOriginal as URL, to: item.fileURL)
            }
            throw error
        }
        let installed = try item.fileURL.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        try await store.completeRecoveredMedia(
            itemID: item.id,
            sizeBytes: Int64(installed.fileSize ?? size),
            modifiedAt: installed.contentModificationDate ?? Date()
        )
    }

    private static func recoveryMetadata(
        at url: URL
    ) -> (provider: String?, sourceURL: String?, downloadURL: String)? {
        let attribute = "com.apple.metadata:kMDItemWhereFroms"
        let length = url.path.withCString { path in
            attribute.withCString { name in
                getxattr(path, name, nil, 0, 0, 0)
            }
        }
        guard length > 0 else { return nil }
        var data = Data(count: length)
        let bytesRead = data.withUnsafeMutableBytes { buffer in
            url.path.withCString { path in
                attribute.withCString { name in
                    getxattr(path, name, buffer.baseAddress, length, 0, 0)
                }
            }
        }
        guard bytesRead == length,
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String]
        else { return nil }
        let urls = values.compactMap { value -> URL? in
            guard let candidate = URL(string: value), candidate.scheme == "https",
                  candidate.host != nil, candidate.user == nil, candidate.password == nil else {
                return nil
            }
            return candidate
        }
        guard let download = urls.first else { return nil }
        let source = urls.dropFirst().first ?? download
        return (download.host, source.absoluteString, download.absoluteString)
    }

    private static func validatesMedia(at url: URL, mediaType: MediaType) async -> Bool {
        if mediaType == .image {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return false }
            return CGImageSourceCreateImageAtIndex(source, 0, nil) != nil
        }
        let preview = FileManager.default.temporaryDirectory
            .appendingPathComponent("Anthora-Recovery-Validation-\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: preview) }
        return (try? await writeThumbnail(source: url, pixels: 256, output: preview)) != nil
    }

    private static func sha256(url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let data = try handle.read(upToCount: 4 * 1_024 * 1_024), !data.isEmpty { hasher.update(data: data) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func profileAssociationPath(for url: URL) -> String {
        let parent = url.standardizedFileURL.deletingLastPathComponent()
        let components = parent.pathComponents
        let markers = Set(["people", "profiles", "_profiles"])
        if let markerIndex = components.indices.last(where: {
            markers.contains(components[$0].lowercased())
        }), markerIndex + 1 < components.count {
            return NSString.path(withComponents: Array(components.prefix(markerIndex + 2)))
        }
        return parent.path
    }

    private static func replaceWithReferences(
        keeper: URL,
        redundant: URL,
        references: [URL],
        discardedReferences: [URL] = [],
        preserveRedundant: Bool,
        stagingRoot: URL? = nil
    ) throws {
        guard FileManager.default.isReadableFile(atPath: keeper.path) else {
            throw ReaderError.itemNotFound
        }
        for reference in discardedReferences {
            try? FileManager.default.removeItem(at: reference)
        }
        for reference in references {
            try? FileManager.default.removeItem(at: reference)
            try FileManager.default.createSymbolicLink(atPath: reference.path, withDestinationPath: keeper.path)
        }
        if FileManager.default.fileExists(atPath: redundant.path)
            || (try? FileManager.default.destinationOfSymbolicLink(atPath: redundant.path)) != nil {
            try removeThroughStaging(redundant, root: stagingRoot ?? redundant.deletingLastPathComponent())
        }
        if preserveRedundant {
            try FileManager.default.createSymbolicLink(atPath: redundant.path, withDestinationPath: keeper.path)
        }
    }

    /// Foundation removal can spend minutes unlinking a regular file from a
    /// directory containing tens of thousands of media entries. An atomic
    /// same-volume rename moves it into a tiny directory first, where removal
    /// is immediate. A failed final removal is rolled back to the original
    /// path so the database never loses track of the source file.
    private static func removeThroughStaging(_ source: URL, root: URL) throws {
        let staging = root.appendingPathComponent(".Anthora-Maintenance", isDirectory: true)
        let created = staging.path.withCString { Darwin.mkdir($0, S_IRWXU) }
        guard created == 0 || errno == EEXIST else { throw ReaderError.writeFailed }
        let staged = staging.appendingPathComponent(
            "\(UUID().uuidString)-\(source.lastPathComponent)"
        )
        let moved = source.path.withCString { sourcePath in
            staged.path.withCString { stagedPath in Darwin.rename(sourcePath, stagedPath) }
        }
        guard moved == 0 else { throw ReaderError.writeFailed }
        let removed = staged.path.withCString { Darwin.unlink($0) }
        if removed != 0 {
            _ = staged.path.withCString { stagedPath in
                source.path.withCString { sourcePath in Darwin.rename(stagedPath, sourcePath) }
            }
            throw ReaderError.writeFailed
        }
        _ = staging.path.withCString { Darwin.rmdir($0) }
    }

    private static func selfTestConsolidation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("anthology-consolidation-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let keeper = root.appendingPathComponent("People/alice/keeper.jpg")
        let redundant = root.appendingPathComponent("People/alice/redundant.jpg")
        let sameProfileReference = root.appendingPathComponent("People/alice/profile-reference.jpg")
        let otherProfileReference = root.appendingPathComponent("People/bob/profile-reference.jpg")
        let content = Data("controlled duplicate fixture".utf8)
        try FileManager.default.createDirectory(at: keeper.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: otherProfileReference.deletingLastPathComponent(), withIntermediateDirectories: true)
        try content.write(to: keeper)
        try content.write(to: redundant)
        try FileManager.default.createSymbolicLink(atPath: sameProfileReference.path, withDestinationPath: redundant.path)
        try FileManager.default.createSymbolicLink(atPath: otherProfileReference.path, withDestinationPath: redundant.path)
        try replaceWithReferences(
            keeper: keeper,
            redundant: redundant,
            references: [otherProfileReference],
            discardedReferences: [sameProfileReference],
            preserveRedundant: false
        )
        guard !FileManager.default.fileExists(atPath: redundant.path),
              !FileManager.default.fileExists(atPath: sameProfileReference.path),
              try Data(contentsOf: otherProfileReference) == content,
              try FileManager.default.destinationOfSymbolicLink(atPath: otherProfileReference.path) == keeper.path else {
            throw ReaderError.writeFailed
        }
        let alreadyMissing = root.appendingPathComponent("People/alice/already-missing.jpg")
        try replaceWithReferences(
            keeper: keeper,
            redundant: alreadyMissing,
            references: [],
            preserveRedundant: false
        )
    }

    private static func differenceHash(url: URL) -> String? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 64,
              ] as CFDictionary) else { return nil }
        return differenceHash(image: image)
    }

    private static func differenceHash(image: CGImage) -> String? {
        var pixels = [UInt8](repeating: 0, count: 9 * 8)
        guard let context = CGContext(data: &pixels, width: 9, height: 8, bitsPerComponent: 8, bytesPerRow: 9, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: 9, height: 8))
        var value: UInt64 = 0
        for y in 0..<8 { for x in 0..<8 { value = (value << 1) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? 1 : 0) } }
        return String(format: "%016llx", value)
    }

    private static func videoFingerprintSamples(url: URL, duration: Double) async throws -> [VideoFingerprintSample] {
        let sampleCount = max(3, min(40, Int(ceil(duration / 3))))
        let times = (1...sampleCount).map { duration * Double($0) / Double(sampleCount + 1) }
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 96, height: 96)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.35, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.35, preferredTimescale: 600)
        var samples: [VideoFingerprintSample] = []
        for seconds in times {
            let requested = CMTime(seconds: seconds, preferredTimescale: 600)
            let nativeImage = try? await generator.image(at: requested).image
            let image: CGImage?
            if let nativeImage {
                image = nativeImage
            } else {
                image = await bundledFFmpegFrame(url: url, maxPixelSize: 96, seconds: seconds)
            }
            if let image, let hash = differenceHash(image: image) {
                samples.append(VideoFingerprintSample(time: seconds, hash: hash))
            }
        }
        return samples
    }

    private static func writeThumbnail(source: URL, pixels: Int, output: URL, videoSeconds: Double? = nil) async throws {
        let image: CGImage
        if let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil),
           let decoded = CGImageSourceCreateThumbnailAtIndex(
                  imageSource,
                  0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: pixels,
                      kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary
           ) {
            image = decoded
        } else {
            let asset = AVURLAsset(url: source)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: pixels, height: pixels)
            let duration = (try? await asset.load(.duration)) ?? .zero
            let requested = CMTimeMinimum(
                duration,
                CMTime(seconds: max(0, videoSeconds ?? 1), preferredTimescale: 600)
            )
            if let native = try? await generator.image(at: requested).image {
                image = native
            } else if let fallback = await bundledFFmpegFrame(
                url: source,
                maxPixelSize: pixels,
                seconds: max(0, videoSeconds ?? 1)
            ) {
                image = fallback
            } else {
                throw ReaderError.decodeFailed
            }
        }
        guard let destination = CGImageDestinationCreateWithURL(
            output as CFURL,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { throw ReaderError.writeFailed }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.78] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw ReaderError.writeFailed }
    }

    private static func stream(source: URL, offset: UInt64, length: Int) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        try input.seek(toOffset: offset)
        var remaining = length
        while remaining > 0 {
            guard let data = try input.read(upToCount: min(1024 * 1024, remaining)), !data.isEmpty else {
                throw ReaderError.invalidRange
            }
            FileHandle.standardOutput.write(data)
            remaining -= data.count
        }
    }

    private static func copyRange(source: URL, offset: UInt64, length: Int, output: URL) throws {
        let input = try FileHandle(forReadingFrom: source)
        FileManager.default.createFile(atPath: output.path, contents: nil)
        let destination = try FileHandle(forWritingTo: output)
        defer {
            try? input.close()
            try? destination.close()
        }
        try input.seek(toOffset: offset)
        var remaining = length
        while remaining > 0 {
            guard let data = try input.read(upToCount: min(1024 * 1024, remaining)), !data.isEmpty else {
                throw ReaderError.invalidRange
            }
            try destination.write(contentsOf: data)
            remaining -= data.count
        }
    }

    private static func runWorker(queue: URL) async throws {
        try FileManager.default.createDirectory(at: queue, withIntermediateDirectories: true)
        let store = try LibraryStore(databaseURL: AppPaths.databaseURL())
        for library in try await store.allLibraries() {
            _ = try? await LibraryAccessCache.shared.authorizedRoot(for: library)
        }
        while parentProcessIsAlive() {
            _ = await processQueuedRequests(queue: queue, maxConcurrent: 6)
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    private static func runAnalysisWorker(queue: URL) async throws {
        try FileManager.default.createDirectory(at: queue, withIntermediateDirectories: true)
        var nextBackgroundAnalysis = ContinuousClock.now
        var nextAccurateText = ContinuousClock.now
        var nextTrashCleanup = ContinuousClock.now
        var nextHashBatch = ContinuousClock.now
        var nextVisualHashBatch = ContinuousClock.now
        var nextFaceMatchBatch = ContinuousClock.now
        var nextFaceClusterBatch = ContinuousClock.now
        var faceClusterOffset = 0
        var nextVideoMetadataBatch = ContinuousClock.now
        var nextVideoHashBatch = ContinuousClock.now
        var nextPersonBatch = ContinuousClock.now
        var nextSecondaryPeopleBatch = ContinuousClock.now
        var nextThumbnailBatch = ContinuousClock.now
        var nextQualityBatch = ContinuousClock.now
        while parentProcessIsAlive() {
            let processedRequest = await processQueuedRequests(queue: queue, maxConcurrent: 1)
            if !processedRequest && ContinuousClock.now >= nextBackgroundAnalysis {
                try? await run(["analyze-text-batch", "8"])
                nextBackgroundAnalysis = ContinuousClock.now.advanced(by: .seconds(2))
            }
            if !processedRequest && ContinuousClock.now >= nextAccurateText {
                try? await run(["analyze-accurate-text-batch", "4"])
                nextAccurateText = ContinuousClock.now.advanced(by: .seconds(1))
            }
            if !processedRequest && ContinuousClock.now >= nextTrashCleanup {
                try? await run(["purge-expired"])
                nextTrashCleanup = ContinuousClock.now.advanced(by: .seconds(3_600))
            }
            if !processedRequest && ContinuousClock.now >= nextHashBatch {
                try? await run(["hash-duplicate-candidates", "8"])
                nextHashBatch = ContinuousClock.now.advanced(by: .seconds(3))
            }
            if !processedRequest && ContinuousClock.now >= nextVisualHashBatch {
                try? await run(["hash-visual-batch"])
                nextVisualHashBatch = ContinuousClock.now.advanced(by: .seconds(2))
            }
            if !processedRequest && ContinuousClock.now >= nextFaceMatchBatch {
                try? await run(["match-face-batch"])
                nextFaceMatchBatch = ContinuousClock.now.advanced(by: .seconds(10))
            }
            if !processedRequest && ContinuousClock.now >= nextFaceClusterBatch {
                try? await run(["cluster-face-batch", "80", String(faceClusterOffset)])
                faceClusterOffset += 80
                nextFaceClusterBatch = ContinuousClock.now.advanced(by: .seconds(2))
            }
            if !processedRequest && ContinuousClock.now >= nextVideoMetadataBatch {
                try? await run(["backfill-video-metadata", "12"])
                nextVideoMetadataBatch = ContinuousClock.now.advanced(by: .seconds(2))
            }
            if !processedRequest && ContinuousClock.now >= nextVideoHashBatch {
                try? await run(["hash-video-visual-batch", "1"])
                nextVideoHashBatch = ContinuousClock.now.advanced(by: .seconds(1))
            }
            if !processedRequest && ContinuousClock.now >= nextPersonBatch {
                try? await run(["analyze-person-batch", "32"])
                nextPersonBatch = ContinuousClock.now.advanced(by: .milliseconds(250))
            }
            if !processedRequest && ContinuousClock.now >= nextSecondaryPeopleBatch {
                try? await run(["analyze-secondary-people-batch", "4"])
                nextSecondaryPeopleBatch = ContinuousClock.now.advanced(by: .seconds(1))
            }
            if !processedRequest && ContinuousClock.now >= nextThumbnailBatch {
                try? await run(["prewarm-thumbnail-batch", "4"])
                nextThumbnailBatch = ContinuousClock.now.advanced(by: .seconds(1))
            }
            if !processedRequest && ContinuousClock.now >= nextQualityBatch {
                try? await run(["analyze-quality-batch", "8"])
                nextQualityBatch = ContinuousClock.now.advanced(by: .milliseconds(500))
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private static func parentProcessIsAlive() -> Bool {
        guard let value = ProcessInfo.processInfo.environment["ANTHORA_PARENT_PID"],
              let parentPID = Int32(value),
              parentPID > 1 else {
            return true
        }
        return kill(parentPID, 0) == 0 || errno == EPERM
    }

    private static func processQueuedRequests(queue: URL, maxConcurrent: Int) async -> Bool {
        let requests = (try? FileManager.default.contentsOfDirectory(
            at: queue,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ))?.filter { $0.pathExtension == "req" }.sorted {
            func priority(_ request: URL) -> Int {
                guard let line = try? String(contentsOf: request, encoding: .utf8),
                      let command = line.split(separator: "\t", maxSplits: 1).first else { return 1 }
                switch command {
                case "read-file", "read", "check": return 0
                // Explicit maintenance was confirmed by the user and must not
                // sit behind a potentially hours-long source scan. Scans are
                // resumable and deliberately remain the lowest-priority write.
                case "consolidate-exact", "recover": return 1
                case "thumbnail": return 2
                case "scan-library": return 4
                default: return 3
                }
            }
            let leftPriority = priority($0)
            let rightPriority = priority($1)
            if leftPriority != rightPriority { return leftPriority < rightPriority }
            let left = try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            let right = try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if left != right { return (left ?? .distantPast) < (right ?? .distantPast) }
            return $0.lastPathComponent < $1.lastPathComponent
        } ?? []
        func isMutating(_ request: URL) -> Bool {
            guard let line = try? String(contentsOf: request, encoding: .utf8),
                  let command = line.split(separator: "\t", maxSplits: 1).first else { return true }
            return !["check", "read", "read-file", "thumbnail"].contains(String(command))
        }
        // SQLite writes are serialized; read and thumbnail work remains concurrent.
        let batch: [URL]
        if let mutation = requests.first(where: isMutating) {
            batch = [mutation]
        } else {
            // Preserve capacity for interactive file reads. A wall of slow
            // network-backed thumbnails must not prevent a selected photo or
            // video range from opening.
            let interactive = requests.filter { request in
                guard let line = try? String(contentsOf: request, encoding: .utf8),
                      let command = line.split(separator: "\t", maxSplits: 1).first else { return false }
                return ["read-file", "read", "check"].contains(String(command))
            }
            if !interactive.isEmpty {
                batch = Array(interactive.prefix(maxConcurrent))
            } else {
                batch = Array(requests.prefix(min(maxConcurrent, 3)))
            }
        }
        await withTaskGroup(of: Void.self) { group in
            for request in batch {
                group.addTask {
                    await processQueuedRequest(request)
                }
            }
        }
        return !batch.isEmpty
    }

    private static func processQueuedRequest(_ request: URL) async {
            let done = request.deletingPathExtension().appendingPathExtension("done")
            do {
                let line = try String(contentsOf: request, encoding: .utf8)
                let command = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                guard command.first != "worker", command.first != "analysis-worker" else { throw ReaderError.usage }
                if command.first == "scan-library" {
                    try await runIsolatedScan(command, request: request)
                } else {
                    try await run(command)
                }
                try "ok".write(to: done, atomically: true, encoding: .utf8)
            } catch {
                // Formatting or even bridging a Cocoa file error can synchronously query
                // the failed URL for its display name. An unavailable network volume can
                // therefore strand the entire queue while Foundation describes the error.
                // Keep this boundary deliberately generic so the worker always advances.
                try? "error\tNative media operation failed".write(
                    to: done,
                    atomically: true,
                    encoding: .utf8
                )
            }
            try? FileManager.default.removeItem(at: request)
    }

    /// A filesystem enumerator can remain blocked inside an unresponsive
    /// network mount and cannot be cancelled from Swift. Run scans in a child
    /// process so the queue worker remains healthy and can enforce a heartbeat.
    private static func runIsolatedScan(_ command: [String], request: URL) async throws {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0])
        let heartbeat = request.deletingPathExtension().appendingPathExtension("heartbeat")
        try? FileManager.default.removeItem(at: heartbeat)
        defer { try? FileManager.default.removeItem(at: heartbeat) }

        let process = Process()
        process.executableURL = executable
        process.arguments = command
        var environment = ProcessInfo.processInfo.environment
        environment["ANTHORA_SCAN_HEARTBEAT"] = heartbeat.path
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        let errorPipe = Pipe()
        process.standardError = errorPipe
        try process.run()

        let stallSeconds = max(
            30,
            Double(environment["ANTHORA_SCAN_STALL_SECONDS"] ?? "300") ?? 300
        )
        var lastHeartbeat = Date()
        while process.isRunning {
            if let modified = try? heartbeat.resourceValues(
                forKeys: [.contentModificationDateKey]
            ).contentModificationDate {
                lastHeartbeat = max(lastHeartbeat, modified)
            }
            if Date().timeIntervalSince(lastHeartbeat) > stallSeconds {
                process.terminate()
                process.waitUntilExit()
                throw ReaderError.scanStalled
            }
            try await Task.sleep(for: .milliseconds(250))
        }

        guard process.terminationStatus == 0 else {
            let data = try errorPipe.fileHandleForReading.readToEnd() ?? Data()
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw ReaderError.queuedCommandFailed(
                message?.isEmpty == false ? message! : "The library scan failed"
            )
        }
    }
}

private enum FaceEmbeddingEngine {
    nonisolated(unsafe) static let model: MLModel? = {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
        let candidates = [
            contents.appendingPathComponent("Resources/FaceEmbedding.mlpackage"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Models/FaceEmbedding.mlpackage"),
        ]
        guard let package = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }),
              let compiled = try? MLModel.compileModel(at: package) else { return nil }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        return try? MLModel(contentsOf: compiled, configuration: configuration)
    }()

    static func embedding(for image: CGImage) -> Data? {
        guard let model,
              let imageValue = try? MLFeatureValue(
                cgImage: image,
                pixelsWide: 112,
                pixelsHigh: 112,
                pixelFormatType: kCVPixelFormatType_32ARGB,
                options: nil
              ),
              let input = try? MLDictionaryFeatureProvider(dictionary: ["faceImage": imageValue]),
              let output = try? model.prediction(from: input),
              let array = output.featureValue(for: "embedding")?.multiArrayValue,
              array.count == 512 else { return nil }
        var vector = (0..<array.count).map { array[$0].floatValue }
        let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
        guard norm > 0 else { return nil }
        for index in vector.indices { vector[index] /= norm }
        return vector.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    static func decode(_ data: Data) -> [Float]? {
        guard data.count == 512 * MemoryLayout<Float>.size else { return nil }
        return data.withUnsafeBytes { raw in Array(raw.bindMemory(to: Float.self)) }
    }

    static func cosine(_ left: [Float], _ right: [Float]) -> Float {
        guard left.count == right.count else { return -1 }
        return zip(left, right).reduce(0) { $0 + $1.0 * $1.1 }
    }

    static func selfTest() -> Bool {
        guard let context = CGContext(
            data: nil,
            width: 112,
            height: 112,
            bitsPerComponent: 8,
            bytesPerRow: 112 * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 112, height: 112))
        guard let image = context.makeImage(), let data = embedding(for: image), let vector = decode(data) else { return false }
        return vector.count == 512 && abs(cosine(vector, vector) - 1) < 0.001
    }
}

enum MobileCLIPEngine: EmbeddingEngine, TextEmbeddingEngine {
    static let modelVersion = "mobileclip-s0-v1"

    private static let resources: URL? = {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
        let candidates = [
            contents.appendingPathComponent("Resources/MobileCLIP"),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Models/MobileCLIP"),
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }()

    nonisolated(unsafe) private static let imageModel = loadModel(named: "mobileclip_s0_image.mlpackage")
    nonisolated(unsafe) private static let textModel = loadModel(named: "mobileclip_s0_text.mlpackage")
    private static let tokenizer: CLIPTokenizer? = {
        guard let resources else { return nil }
        return try? CLIPTokenizer(
            mergesURL: resources.appendingPathComponent("clip-merges.txt"),
            vocabularyURL: resources.appendingPathComponent("clip-vocab.json")
        )
    }()

    private static func loadModel(named name: String) -> MLModel? {
        guard let package = resources?.appendingPathComponent(name),
              let compiled = try? MLModel.compileModel(at: package) else { return nil }
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        return try? MLModel(contentsOf: compiled, configuration: configuration)
    }

    static func imageEmbedding(_ image: CGImage) -> Data? {
        guard let imageModel,
              let imageValue = try? MLFeatureValue(cgImage: image, pixelsWide: 256, pixelsHigh: 256, pixelFormatType: kCVPixelFormatType_32ARGB, options: nil),
              let input = try? MLDictionaryFeatureProvider(dictionary: ["image": imageValue]),
              let output = try? imageModel.prediction(from: input),
              let array = output.featureValue(for: "final_emb_1")?.multiArrayValue else { return nil }
        return normalizedData(array)
    }

    static func textEmbedding(_ text: String) -> [Float]? {
        guard let textModel, let tokenizer,
              let array = try? MLMultiArray(shape: [1, 77], dataType: .int32) else { return nil }
        for (index, token) in tokenizer.tokens(for: text).enumerated() { array[index] = NSNumber(value: token) }
        guard let input = try? MLDictionaryFeatureProvider(dictionary: ["text": array]),
              let output = try? textModel.prediction(from: input),
              let embedding = output.featureValue(for: "final_emb_1")?.multiArrayValue else { return nil }
        return normalize((0..<embedding.count).map { embedding[$0].floatValue })
    }

    static func decode(_ data: Data) -> [Float]? {
        guard data.count == 512 * MemoryLayout<Float>.size else { return nil }
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    static func cosine(_ left: [Float], _ right: [Float]) -> Float {
        guard left.count == right.count else { return -1 }
        return zip(left, right).reduce(0) { $0 + $1.0 * $1.1 }
    }

    private static func normalizedData(_ array: MLMultiArray) -> Data? {
        guard array.count == 512 else { return nil }
        let vector = normalize((0..<array.count).map { array[$0].floatValue })
        return vector.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private static func normalize(_ vector: [Float]) -> [Float] {
        let norm = sqrt(vector.reduce(0) { $0 + $1 * $1 })
        guard norm > 0 else { return vector }
        return vector.map { $0 / norm }
    }

    static func selfTest() -> Bool {
        guard let context = CGContext(
            data: nil, width: 256, height: 256, bitsPerComponent: 8, bytesPerRow: 256 * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.setFillColor(red: 0.3, green: 0.5, blue: 0.7, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
        guard let image = context.makeImage(), let imageData = imageEmbedding(image),
              let imageVector = decode(imageData), let textVector = textEmbedding("a blue image") else { return false }
        return imageVector.count == 512 && textVector.count == 512
            && abs(cosine(imageVector, imageVector) - 1) < 0.001
            && abs(cosine(textVector, textVector) - 1) < 0.001
    }
}

private enum PersonAnalyzer {
    static func count(url: URL) -> Int {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1_024,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return -1 }
        let request = VNDetectHumanRectanglesRequest()
        request.upperBodyOnly = false
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
            return request.results?.count ?? 0
        } catch {
            return -1
        }
    }
}

private enum QualityAnalyzer {
    static let modelVersion = "quality-signals-v1"

    struct Result {
        let meanLuma: Double
        let darkFraction: Double
        let lightFraction: Double
        let detailScore: Double
        let motionScore: Double?
        let errorMessage: String?
    }

    private struct FrameMetrics {
        let meanLuma: Double
        let darkFraction: Double
        let lightFraction: Double
        let detailScore: Double
        let pixels: [UInt8]
    }

    static func analyze(url: URL, mediaType: MediaType, duration: Double?) async -> Result {
        let images: [CGImage]
        if mediaType == .video {
            images = await videoFrames(url: url, duration: duration ?? 0)
        } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 512,
                    kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary) {
            images = [image]
        } else {
            images = []
        }

        let frames = images.compactMap(metrics)
        guard !frames.isEmpty else {
            return Result(
                meanLuma: 0, darkFraction: 0, lightFraction: 0,
                detailScore: 0, motionScore: nil,
                errorMessage: "Quality preview could not be decoded"
            )
        }
        let count = Double(frames.count)
        let motion: Double?
        if frames.count > 1 {
            let differences = zip(frames, frames.dropFirst()).map { left, right in
                zip(left.pixels, right.pixels).reduce(0.0) {
                    $0 + abs(Double($1.0) - Double($1.1)) / 255
                } / Double(left.pixels.count)
            }
            motion = differences.reduce(0, +) / Double(differences.count)
        } else {
            motion = nil
        }
        return Result(
            meanLuma: frames.reduce(0) { $0 + $1.meanLuma } / count,
            darkFraction: frames.reduce(0) { $0 + $1.darkFraction } / count,
            lightFraction: frames.reduce(0) { $0 + $1.lightFraction } / count,
            detailScore: frames.reduce(0) { $0 + $1.detailScore } / count,
            motionScore: motion,
            errorMessage: nil
        )
    }

    private static func metrics(_ image: CGImage) -> FrameMetrics? {
        let width = 96
        let height = 96
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        var total = 0.0
        var dark = 0
        var light = 0
        var detail = 0.0
        var comparisons = 0
        for y in 0..<height {
            for x in 0..<width {
                let value = pixels[y * width + x]
                total += Double(value) / 255
                if value <= 8 { dark += 1 }
                if value >= 247 { light += 1 }
                if x > 0 {
                    detail += abs(Double(value) - Double(pixels[y * width + x - 1])) / 255
                    comparisons += 1
                }
                if y > 0 {
                    detail += abs(Double(value) - Double(pixels[(y - 1) * width + x])) / 255
                    comparisons += 1
                }
            }
        }
        let pixelCount = Double(pixels.count)
        return FrameMetrics(
            meanLuma: total / pixelCount,
            darkFraction: Double(dark) / pixelCount,
            lightFraction: Double(light) / pixelCount,
            detailScore: comparisons > 0 ? detail / Double(comparisons) : 0,
            pixels: pixels
        )
    }

    private static func videoFrames(url: URL, duration: Double) async -> [CGImage] {
        guard duration > 0 else { return [] }
        let seconds = [0.15, 0.5, 0.85].map { max(0, min(duration, duration * $0)) }
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 512, height: 512)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)
        var images: [CGImage] = []
        for second in seconds {
            let time = CMTime(seconds: second, preferredTimescale: 600)
            if let image = try? await generator.image(at: time).image {
                images.append(image)
            } else if let fallback = await bundledFFmpegFrame(
                url: url, maxPixelSize: 512, seconds: second
            ) {
                images.append(fallback)
            }
        }
        return images
    }
}

private enum TextAnalyzer {
    static let modelVersion = "vision-ocr-classify-arcface-mobileclip-v8"

    struct Result {
        let text: TextAnalysisResult
        let labels: [(name: String, confidence: Double)]
        let faceCount: Int
        let personCount: Int
        let faceBoxesJSON: String
        let faceFeatures: [Data]
        let semanticEmbedding: Data?
    }

    static func analyze(
        url: URL,
        mediaType: MediaType,
        includeSemanticEmbedding: Bool = true
    ) async -> Result {
        let image: CGImage?
        if mediaType == .video {
            image = await videoFrame(url: url)
        } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1_024,
                kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary)
        } else {
            image = nil
        }
        guard let image else {
            return Result(text: TextAnalysisResult(observationCount: 0, textAreaRatio: 0, isTextHeavy: false, errorMessage: "Image could not be decoded"), labels: [], faceCount: 0, personCount: -1, faceBoxesJSON: "[]", faceFeatures: [], semanticEmbedding: nil)
        }
        let textRequest = VNRecognizeTextRequest()
        textRequest.recognitionLevel = .fast
        textRequest.usesLanguageCorrection = false
        textRequest.minimumTextHeight = 0.015
        let classificationRequest = VNClassifyImageRequest()
        let faceRequest = VNDetectFaceLandmarksRequest()
        let personRequest = VNDetectHumanRectanglesRequest()
        personRequest.upperBodyOnly = false
        do {
            try VNImageRequestHandler(cgImage: image).perform([textRequest, classificationRequest, faceRequest, personRequest])
            let observations = textRequest.results ?? []
            let area = min(1, observations.reduce(0) { $0 + Double($1.boundingBox.width * $1.boundingBox.height) })
            let recognizedText = observations
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: "\n")
                .prefix(32_000)
            let labels = (classificationRequest.results ?? [])
                .filter { $0.confidence >= 0.1 }
                .prefix(12)
                .map { (name: $0.identifier.lowercased(), confidence: Double($0.confidence)) }
            let faceBoxes = (faceRequest.results ?? []).map {
                [Double($0.boundingBox.origin.x), Double($0.boundingBox.origin.y), Double($0.boundingBox.width), Double($0.boundingBox.height)]
            }
            let boxesData = try JSONSerialization.data(withJSONObject: faceBoxes)
            let features = (faceRequest.results ?? []).compactMap { observation -> Data? in
                guard let face = alignedFace(image: image, observation: observation) else { return nil }
                return FaceEmbeddingEngine.embedding(for: face)
            }
            return Result(
                text: TextAnalysisResult(
                    observationCount: observations.count,
                    textAreaRatio: area,
                    isTextHeavy: observations.count >= 8 || (observations.count >= 3 && area >= 0.12),
                    recognizedText: String(recognizedText)
                ),
                labels: labels,
                faceCount: faceBoxes.count,
                personCount: personRequest.results?.count ?? 0,
                faceBoxesJSON: String(decoding: boxesData, as: UTF8.self),
                faceFeatures: features,
                semanticEmbedding: includeSemanticEmbedding
                    ? MobileCLIPEngine.imageEmbedding(image)
                    : nil
            )
        } catch {
            return Result(text: TextAnalysisResult(observationCount: 0, textAreaRatio: 0, isTextHeavy: false, errorMessage: error.localizedDescription), labels: [], faceCount: 0, personCount: -1, faceBoxesJSON: "[]", faceFeatures: [], semanticEmbedding: nil)
        }
    }

    private static func videoFrame(url: URL) async -> CGImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1_024, height: 1_024)
        let duration = (try? await asset.load(.duration))?.seconds ?? 0
        let seconds = duration.isFinite && duration > 2 ? min(1, duration * 0.1) : 0
        if let native = try? await generator.image(
            at: CMTime(seconds: seconds, preferredTimescale: 600)
        ).image {
            return native
        }
        return await bundledFFmpegFrame(url: url, maxPixelSize: 1_024)
    }

    static func personSeed(paths: [String]) -> String? {
        for path in paths {
            let parts = URL(fileURLWithPath: path).pathComponents
            if let index = parts.firstIndex(of: "_Profiles"), parts.indices.contains(index + 1) { return normalize(parts[index + 1]) }
            for platform in ["instagram", "facebook", "threads", "tiktok"] {
                if let index = parts.firstIndex(of: platform), parts.indices.contains(index + 1) { return normalize(parts[index + 1]) }
            }
        }
        return nil
    }

    static func normalize(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    private static func alignedFace(image: CGImage, observation: VNFaceObservation) -> CGImage? {
        guard let leftPoints = observation.landmarks?.leftEye?.normalizedPoints,
              let rightPoints = observation.landmarks?.rightEye?.normalizedPoints,
              !leftPoints.isEmpty, !rightPoints.isEmpty else {
            let box = observation.boundingBox
            let padding = max(box.width, box.height) * 0.18
            let crop = CGRect(
                x: (box.midX - box.width / 2 - padding) * CGFloat(image.width),
                y: (1 - box.midY - box.height / 2 - padding) * CGFloat(image.height),
                width: (box.width + padding * 2) * CGFloat(image.width),
                height: (box.height + padding * 2) * CGFloat(image.height)
            ).intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height)).integral
            return image.cropping(to: crop)
        }
        func center(_ points: [CGPoint]) -> CGPoint {
            let total = points.reduce(CGPoint.zero) { CGPoint(x: $0.x + $1.x, y: $0.y + $1.y) }
            return CGPoint(x: total.x / CGFloat(points.count), y: total.y / CGFloat(points.count))
        }
        let box = observation.boundingBox
        func imagePoint(_ point: CGPoint) -> CGPoint {
            CGPoint(
                x: (box.minX + point.x * box.width) * CGFloat(image.width),
                y: (box.minY + point.y * box.height) * CGFloat(image.height)
            )
        }
        let detected = [imagePoint(center(leftPoints)), imagePoint(center(rightPoints))].sorted { $0.x < $1.x }
        let sourceLeft = detected[0], sourceRight = detected[1]
        let targetLeft = CGPoint(x: 38.2946, y: 112 - 51.6963)
        let targetRight = CGPoint(x: 73.5318, y: 112 - 51.5014)
        let sourceDX = sourceRight.x - sourceLeft.x, sourceDY = sourceRight.y - sourceLeft.y
        let targetDX = targetRight.x - targetLeft.x, targetDY = targetRight.y - targetLeft.y
        let sourceLength = hypot(sourceDX, sourceDY)
        guard sourceLength > 1 else { return nil }
        let scale = hypot(targetDX, targetDY) / sourceLength
        let angle = atan2(targetDY, targetDX) - atan2(sourceDY, sourceDX)
        let a = scale * cos(angle), b = scale * sin(angle)
        let c = -scale * sin(angle), d = scale * cos(angle)
        let transform = CGAffineTransform(
            a: a, b: b, c: c, d: d,
            tx: targetLeft.x - a * sourceLeft.x - c * sourceLeft.y,
            ty: targetLeft.y - b * sourceLeft.x - d * sourceLeft.y
        )
        let aligned = CIImage(cgImage: image).transformed(by: transform).cropped(to: CGRect(x: 0, y: 0, width: 112, height: 112))
        return CIContext(options: [.cacheIntermediates: false]).createCGImage(aligned, from: aligned.extent)
    }
}
