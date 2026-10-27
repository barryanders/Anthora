import Foundation
import ImageIO
import Vision

/// A separate OCR pass so improving text never reruns face or semantic analysis.
public enum AccurateImageText {
    public static let modelVersion = "vision-accurate-3072-v1"

    public static func analyze(url: URL) -> TextAnalysisResult {
        autoreleasepool {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 3_072,
                    kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary) else {
                return TextAnalysisResult(observationCount: 0, textAreaRatio: 0,
                    isTextHeavy: false, errorMessage: "Image could not be decoded")
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            request.minimumTextHeight = 0.003
            do {
                try VNImageRequestHandler(cgImage: image).perform([request])
                let observations = request.results ?? []
                let area = min(1, observations.reduce(0) {
                    $0 + Double($1.boundingBox.width * $1.boundingBox.height)
                })
                let text = observations.compactMap { $0.topCandidates(1).first?.string }
                    .joined(separator: "\n")
                return TextAnalysisResult(observationCount: observations.count,
                    textAreaRatio: area,
                    isTextHeavy: observations.count >= 8 || (observations.count >= 3 && area >= 0.12),
                    recognizedText: String(text.prefix(64_000)))
            } catch {
                return TextAnalysisResult(observationCount: 0, textAreaRatio: 0,
                    isTextHeavy: false, errorMessage: error.localizedDescription)
            }
        }
    }
}
