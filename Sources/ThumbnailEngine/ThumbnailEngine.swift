import AVFoundation
import Foundation
import ImageIO
import LibraryCore
import UniformTypeIdentifiers

/// An immutable decoded image, safe to pass between tasks.
public struct ThumbnailImage: @unchecked Sendable, Equatable {
    public let cgImage: CGImage

    public init(cgImage: CGImage) {
        self.cgImage = cgImage
    }

    public static func == (lhs: ThumbnailImage, rhs: ThumbnailImage) -> Bool {
        lhs.cgImage === rhs.cgImage
    }
}

private final class ImageBox {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}

/// Counting semaphore for async tasks, so a fast-scrolling grid can't pile up
/// hundreds of concurrent decodes.
actor AsyncLimiter {
    private let limit: Int
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int) {
        self.limit = limit
    }

    func acquire() async {
        if running < limit {
            running += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        if waiters.isEmpty {
            running -= 1
        } else {
            // Hand the slot directly to the next waiter.
            waiters.removeFirst().resume()
        }
    }
}

/// Generates and caches thumbnails for media items.
///
/// Layers: in-memory cache (NSCache) → persistent JPEG cache on disk →
/// generation (ImageIO for images, AVFoundation for videos). Generation is
/// limited to a few concurrent jobs; requests arrive only from visible grid
/// cells, so visible items are inherently first. Disk entries are invalidated
/// when the source file is newer than the cached thumbnail.
public final class ThumbnailEngine: @unchecked Sendable {
    private let cacheDirectory: URL
    private let maxPixelSize: Int
    private let memoryCache = NSCache<NSNumber, ImageBox>()
    private let fullImageCache = NSCache<NSNumber, ImageBox>()
    private let limiter: AsyncLimiter

    public init(cacheDirectory: URL, maxPixelSize: Int = 512, maxConcurrentGenerations: Int = 6) {
        self.cacheDirectory = cacheDirectory
        self.maxPixelSize = maxPixelSize
        self.limiter = AsyncLimiter(limit: maxConcurrentGenerations)
        memoryCache.countLimit = 600
        fullImageCache.countLimit = 6
    }

    // MARK: - Thumbnails

    public func thumbnail(for item: MediaItemRecord) async -> ThumbnailImage? {
        let key = NSNumber(value: item.id)
        if let boxed = memoryCache.object(forKey: key) {
            return ThumbnailImage(cgImage: boxed.image)
        }

        let cacheURL = cacheFileURL(for: item)
        if isCacheValid(cacheURL, sourceModifiedAt: item.modifiedAt),
           let cached = Self.decodeDownsampled(url: cacheURL, maxPixelSize: maxPixelSize) {
            memoryCache.setObject(ImageBox(cached), forKey: key)
            return ThumbnailImage(cgImage: cached)
        }

        await limiter.acquire()
        var generated: CGImage?
        if !Task.isCancelled {
            switch item.mediaType {
            case .image:
                generated = Self.decodeDownsampled(url: item.fileURL, maxPixelSize: maxPixelSize)
            case .video:
                generated = await Self.videoFrame(url: item.fileURL, maxPixelSize: maxPixelSize)
            }
        }
        await limiter.release()

        guard let generated else { return nil }
        memoryCache.setObject(ImageBox(generated), forKey: key)
        writeJPEG(generated, to: cacheURL)
        return ThumbnailImage(cgImage: generated)
    }

    /// Full-resolution (capped) decode for the viewer. Memory-cached only —
    /// the source file itself is the persistent copy.
    public func fullImage(for item: MediaItemRecord, maxPixelSize: Int = 4096) async -> ThumbnailImage? {
        let key = NSNumber(value: item.id)
        if let boxed = fullImageCache.object(forKey: key) {
            return ThumbnailImage(cgImage: boxed.image)
        }
        await limiter.acquire()
        let image = Task.isCancelled ? nil : Self.decodeDownsampled(url: item.fileURL, maxPixelSize: maxPixelSize)
        await limiter.release()
        guard let image else { return nil }
        fullImageCache.setObject(ImageBox(image), forKey: key)
        return ThumbnailImage(cgImage: image)
    }

    // MARK: - Disk cache

    /// Two-level fan-out keeps any single directory small even at 1M items.
    private func cacheFileURL(for item: MediaItemRecord) -> URL {
        let bucket = String(format: "%02x", item.id & 0xff)
        return cacheDirectory
            .appendingPathComponent(bucket, isDirectory: true)
            .appendingPathComponent("\(item.id).jpg")
    }

    private func isCacheValid(_ cacheURL: URL, sourceModifiedAt: Date?) -> Bool {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: cacheURL.path),
              let cacheDate = attributes[.modificationDate] as? Date else { return false }
        guard let sourceModifiedAt else { return true }
        return cacheDate >= sourceModifiedAt
    }

    private func writeJPEG(_ image: CGImage, to url: URL) {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        CGImageDestinationFinalize(destination)
    }

    // MARK: - Generation

    /// Header-driven downsampled decode; never materializes the full bitmap
    /// for large sources, and applies EXIF orientation.
    private static func decodeDownsampled(url: URL, maxPixelSize: Int) -> CGImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else { return nil }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary)
    }

    private static func videoFrame(url: URL, maxPixelSize: Int) async -> CGImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxPixelSize, height: maxPixelSize)
        // Grab a frame slightly into the clip; first frames are often black.
        let duration = (try? await asset.load(.duration))?.seconds ?? 0
        let seconds = duration.isFinite && duration > 2 ? min(1.0, duration * 0.1) : 0
        let time = CMTime(seconds: seconds, preferredTimescale: 600)
        return try? await generator.image(at: time).image
    }
}
