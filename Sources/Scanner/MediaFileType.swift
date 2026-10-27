import Foundation
import LibraryCore

/// Maps file extensions to media types. Centralized so support can expand
/// later (raw formats, webm, …) without touching scanner logic.
public enum MediaFileType {
    public static let imageExtensions: Set<String> = [
        "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "tiff", "tif",
    ]

    public static let videoExtensions: Set<String> = [
        "mov", "mp4", "m4v",
    ]

    /// - Parameter ext: a lowercase file extension without the dot.
    public static func mediaType(forExtension ext: String) -> MediaType? {
        if imageExtensions.contains(ext) { return .image }
        if videoExtensions.contains(ext) { return .video }
        return nil
    }
}
