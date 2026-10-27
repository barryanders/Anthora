import CoreGraphics
import CoreML
import Foundation
import ImageIO

enum FlorencePeopleVerifier {
    static let modelVersion = "florence-2-base-ft-coreml-f6c1a258-v1"

    struct Result {
        let personDetected: Bool
        let tokenCount: Int
    }

    static var isAvailable: Bool {
        guard #available(macOS 15.0, *) else { return false }
        return FlorenceRuntime.shared != nil
    }

    static func analyze(url: URL) async throws -> Result {
        guard #available(macOS 15.0, *), let runtime = FlorenceRuntime.shared else {
            throw FlorenceError.unavailable
        }
        return try await runtime.analyze(url: url)
    }
}

private enum FlorenceError: Error {
    case unavailable
    case invalidConfiguration
    case imageDecodeFailed
    case modelOutputMissing
}

@available(macOS 15.0, *)
private final class FlorenceRuntime: @unchecked Sendable {
    struct Configuration: Decodable {
        let modelVersion: String
        let decoderStartTokenId: Int32
        let eosTokenId: Int32
        let maxTokens: Int
        let promptInputIds: [Int32]
        let promptAttentionMask: [Int32]
        let peopleTokenIds: [Int32]
    }

    static let shared: FlorenceRuntime? = try? FlorenceRuntime()

    private let encoder: MLModel
    private let decoder: MLModel
    private let configuration: Configuration
    private let peopleTokenIds: Set<Int32>

    private init() throws {
        let directory = Self.resourceDirectory()
        let configURL = directory.appendingPathComponent("FlorenceVerifierConfig.json")
        configuration = try JSONDecoder().decode(
            Configuration.self,
            from: Data(contentsOf: configURL)
        )
        guard configuration.modelVersion == FlorencePeopleVerifier.modelVersion,
              configuration.promptInputIds.count == configuration.promptAttentionMask.count,
              !configuration.peopleTokenIds.isEmpty else {
            throw FlorenceError.invalidConfiguration
        }
        peopleTokenIds = Set(configuration.peopleTokenIds)
        let modelConfiguration = MLModelConfiguration()
        modelConfiguration.computeUnits = .cpuAndGPU
        encoder = try Self.loadModel(
            directory.appendingPathComponent("FlorenceDetectionEncoder.mlpackage"),
            configuration: modelConfiguration
        )
        decoder = try Self.loadModel(
            directory.appendingPathComponent("FlorenceStatefulDecoder.mlpackage"),
            configuration: modelConfiguration
        )
    }

    func analyze(url: URL) async throws -> FlorencePeopleVerifier.Result {
        let pixels = try Self.pixelValues(url: url)
        let promptIDs = try Self.intArray(configuration.promptInputIds)
        let promptMask = try Self.intArray(configuration.promptAttentionMask)
        let encoderInput = try MLDictionaryFeatureProvider(dictionary: [
            "pixel_values": MLFeatureValue(multiArray: pixels),
            "input_ids": MLFeatureValue(multiArray: promptIDs),
            "attention_mask": MLFeatureValue(multiArray: promptMask),
        ])
        let encoded = try await encoder.prediction(from: encoderInput)
        guard let hiddenStates = encoded.featureValue(for: "encoder_hidden_states")?.multiArrayValue,
              let attentionMask = encoded.featureValue(for: "encoder_attention_mask")?.multiArrayValue else {
            throw FlorenceError.modelOutputMissing
        }

        let state = decoder.makeState()
        var token = configuration.decoderStartTokenId
        var tokenCount = 0
        for position in 0..<configuration.maxTokens {
            let tokenArray = try Self.intArray([token])
            let positionArray = try Self.intArray([Int32(position)], batched: false)
            let decoderInput = try MLDictionaryFeatureProvider(dictionary: [
                "encoder_hidden_states": MLFeatureValue(multiArray: hiddenStates),
                "encoder_attention_mask": MLFeatureValue(multiArray: attentionMask),
                "decoder_input_id": MLFeatureValue(multiArray: tokenArray),
                "cache_position": MLFeatureValue(multiArray: positionArray),
            ])
            let prediction = try await decoder.prediction(from: decoderInput, using: state)
            guard let logits = prediction.featureValue(for: "logits")?.multiArrayValue else {
                throw FlorenceError.modelOutputMissing
            }
            token = Self.argmax(logits)
            tokenCount += 1
            if peopleTokenIds.contains(token) {
                return FlorencePeopleVerifier.Result(
                    personDetected: true,
                    tokenCount: tokenCount
                )
            }
            if token == configuration.eosTokenId {
                break
            }
        }
        return FlorencePeopleVerifier.Result(
            personDetected: false,
            tokenCount: tokenCount
        )
    }

    private static func resourceDirectory() -> URL {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
        let bundled = contents.appendingPathComponent("Resources/Florence", isDirectory: true)
        if FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Models/Florence", isDirectory: true)
    }

    private static func loadModel(_ package: URL, configuration: MLModelConfiguration) throws -> MLModel {
        guard FileManager.default.fileExists(atPath: package.path) else {
            throw FlorenceError.unavailable
        }
        let compiled = try MLModel.compileModel(at: package)
        return try MLModel(contentsOf: compiled, configuration: configuration)
    }

    private static func intArray(_ values: [Int32], batched: Bool = true) throws -> MLMultiArray {
        let shape = batched ? [1, NSNumber(value: values.count)] : [NSNumber(value: values.count)]
        let array = try MLMultiArray(shape: shape, dataType: .int32)
        let pointer = array.dataPointer.bindMemory(to: Int32.self, capacity: values.count)
        for (index, value) in values.enumerated() {
            pointer[index] = value
        }
        return array
    }

    private static func pixelValues(url: URL) throws -> MLMultiArray {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1_536,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else {
            throw FlorenceError.imageDecodeFailed
        }
        let width = 768
        let height = 768
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = rgba.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(
                data: bytes.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                    | CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else { throw FlorenceError.imageDecodeFailed }

        let array = try MLMultiArray(shape: [1, 3, 768, 768], dataType: .float32)
        let output = array.dataPointer.bindMemory(
            to: Float32.self,
            capacity: 3 * width * height
        )
        let plane = width * height
        let means: [Float32] = [0.485, 0.456, 0.406]
        let deviations: [Float32] = [0.229, 0.224, 0.225]
        for pixel in 0..<plane {
            let offset = pixel * 4
            for channel in 0..<3 {
                let value = Float32(rgba[offset + channel]) / 255.0
                output[channel * plane + pixel] = (value - means[channel]) / deviations[channel]
            }
        }
        return array
    }

    private static func argmax(_ logits: MLMultiArray) -> Int32 {
        var bestIndex = 0
        var bestValue = -Double.infinity
        for index in 0..<logits.count {
            let value = logits[index].doubleValue
            if value > bestValue {
                bestValue = value
                bestIndex = index
            }
        }
        return Int32(bestIndex)
    }
}
