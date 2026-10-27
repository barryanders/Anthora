import CoreGraphics
import Foundation
import ImageIO
import LibraryCore
import Vision

enum TextAnalysisEngine {
    static let modelVersion = "vision-ocr-text-heavy-v1"

    static func analyze(url: URL) -> TextAnalysisResult {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(
                  source,
                  0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: 1_024,
                      kCGImageSourceShouldCacheImmediately: true,
                  ] as CFDictionary
              ) else {
            return TextAnalysisResult(
                observationCount: 0,
                textAreaRatio: 0,
                isTextHeavy: false,
                errorMessage: "Image could not be decoded"
            )
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.minimumTextHeight = 0.015

        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
            let observations = request.results ?? []
            let area = min(1, observations.reduce(0) { partial, observation in
                partial + Double(observation.boundingBox.width * observation.boundingBox.height)
            })
            let textHeavy = observations.count >= 8 || (observations.count >= 3 && area >= 0.12)
            let recognizedText = observations
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: "\n")
                .prefix(32_000)
            return TextAnalysisResult(
                observationCount: observations.count,
                textAreaRatio: area,
                isTextHeavy: textHeavy,
                recognizedText: String(recognizedText)
            )
        } catch {
            return TextAnalysisResult(
                observationCount: 0,
                textAreaRatio: 0,
                isTextHeavy: false,
                errorMessage: error.localizedDescription
            )
        }
    }
}
