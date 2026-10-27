import AVFoundation
import CoreGraphics
import Foundation
import LibraryCore
import Testing
@testable import ThumbnailEngine

/// A real, valid 1×1 PNG so ImageIO can decode it.
private let onePixelPNG = Data(base64Encoded:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)!

@Suite struct ThumbnailEngineTests {
    // Ported from the original XCTest version: equality follows the identity
    // of the underlying CGImage instance.
    @Test func thumbnailImageEqualityUsesUnderlyingImageIdentity() throws {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(
            data: nil,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
        let image = try #require(context?.makeImage())

        #expect(ThumbnailImage(cgImage: image) == ThumbnailImage(cgImage: image))
    }

    private func makeFixture() throws -> (engine: ThumbnailEngine, item: MediaItemRecord, cacheDir: URL) {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraThumbs-\(UUID().uuidString)", isDirectory: true)
        let cacheDir = base.appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        let sourceURL = base.appendingPathComponent("pixel.png")
        try onePixelPNG.write(to: sourceURL)

        let item = MediaItemRecord(
            id: 42,
            libraryID: 1,
            folderID: 1,
            path: sourceURL.path,
            filename: "pixel.png",
            ext: "png",
            mediaType: .image,
            sizeBytes: Int64(onePixelPNG.count),
            modifiedAt: Date(timeIntervalSinceNow: -60)
        )
        return (ThumbnailEngine(cacheDirectory: cacheDir), item, cacheDir)
    }

    @Test func generatesThumbnailAndWritesDiskCache() async throws {
        let (engine, item, cacheDir) = try makeFixture()

        let thumbnail = await engine.thumbnail(for: item)
        #expect(thumbnail != nil)
        #expect(thumbnail?.cgImage.width == 1)

        let cached = cacheDir
            .appendingPathComponent(String(format: "%02x", item.id & 0xff), isDirectory: true)
            .appendingPathComponent("\(item.id).jpg")
        #expect(FileManager.default.fileExists(atPath: cached.path))

        // Second request is served from the memory cache (same instance).
        let again = await engine.thumbnail(for: item)
        #expect(again == thumbnail)
    }

    @Test func diskCacheSurvivesNewEngineInstance() async throws {
        let (engine, item, cacheDir) = try makeFixture()
        _ = await engine.thumbnail(for: item)

        // A fresh engine (new launch) with an empty memory cache must load
        // from disk — even if the original file has vanished.
        try FileManager.default.removeItem(at: item.fileURL)
        let rebornEngine = ThumbnailEngine(cacheDirectory: cacheDir)
        let thumbnail = await rebornEngine.thumbnail(for: item)
        #expect(thumbnail != nil)
    }

    @Test func generatesVideoThumbnail() async throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("AnthoraVideoThumb-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let videoURL = base.appendingPathComponent("clip.mp4")
        try await Self.writeTestVideo(to: videoURL)

        let item = MediaItemRecord(
            id: 7,
            libraryID: 1,
            folderID: 1,
            path: videoURL.path,
            filename: "clip.mp4",
            ext: "mp4",
            mediaType: .video,
            sizeBytes: 1,
            modifiedAt: Date(timeIntervalSinceNow: -60)
        )
        let engine = ThumbnailEngine(cacheDirectory: base.appendingPathComponent("cache", isDirectory: true))
        let thumbnail = await engine.thumbnail(for: item)
        #expect(thumbnail != nil)
        #expect(thumbnail?.cgImage.width == 64)
    }

    /// Writes a 1-second 64×64 H.264 clip of solid frames.
    private static func writeTestVideo(to url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: 64,
            AVVideoHeightKey: 64,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                kCVPixelBufferWidthKey as String: 64,
                kCVPixelBufferHeightKey as String: 64,
            ]
        )
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        var pixelBuffer: CVPixelBuffer?
        let pool = try #require(adaptor.pixelBufferPool)
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
        let buffer = try #require(pixelBuffer)
        CVPixelBufferLockBaseAddress(buffer, [])
        if let baseAddress = CVPixelBufferGetBaseAddress(buffer) {
            memset(baseAddress, 0xCC, CVPixelBufferGetDataSize(buffer))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])

        for frame in 0..<10 {
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(for: .milliseconds(10))
            }
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 10))
        }
        input.markAsFinished()
        await writer.finishWriting()
        #expect(writer.status == .completed)
    }

    @Test func unreadableSourceReturnsNil() async throws {
        let (engine, item, _) = try makeFixture()
        var ghost = item
        ghost.path = "/tmp/anthora-no-such-file-\(UUID().uuidString).png"
        let thumbnail = await engine.thumbnail(for: ghost)
        #expect(thumbnail == nil)
    }
}
