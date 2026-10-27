import Foundation
import ImageIO

public enum ImageMetadataReader {
    /// Reads pixel dimensions from the image header without decoding the
    /// bitmap, so it stays cheap even for very large files.
    public static func pixelDimensions(of url: URL) -> (width: Int, height: Int)? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, options),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
              var width = properties[kCGImagePropertyPixelWidth] as? Int,
              var height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }

        if let rawOrientation = properties[kCGImagePropertyOrientation] as? UInt32,
           let orientation = CGImagePropertyOrientation(rawValue: rawOrientation),
           [.left, .leftMirrored, .right, .rightMirrored].contains(orientation) {
            swap(&width, &height)
        }
        return (width, height)
    }
}
