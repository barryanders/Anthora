import Accelerate
import CoreGraphics
import Foundation
import LibraryCore

protocol EmbeddingEngine: Sendable {
    static var modelVersion: String { get }
    static func imageEmbedding(_ image: CGImage) -> Data?
    static func decode(_ data: Data) -> [Float]?
}

protocol TextEmbeddingEngine: Sendable {
    static func textEmbedding(_ text: String) -> [Float]?
}

protocol VectorIndex: Sendable {
    func nearest(to query: [Float], limit: Int) -> [(mediaID: Int64, score: Float)]
}

struct AccelerateVectorIndex: VectorIndex {
    let vectors: [(mediaID: Int64, values: [Float])]

    func nearest(to query: [Float], limit: Int) -> [(mediaID: Int64, score: Float)] {
        guard !query.isEmpty, limit > 0 else { return [] }
        return vectors.compactMap { record in
            guard record.values.count == query.count else { return nil }
            var score: Float = 0
            query.withUnsafeBufferPointer { queryBuffer in
                record.values.withUnsafeBufferPointer { vectorBuffer in
                    guard let queryBase = queryBuffer.baseAddress,
                          let vectorBase = vectorBuffer.baseAddress else { return }
                    vDSP_dotpr(
                        queryBase, 1,
                        vectorBase, 1,
                        &score,
                        vDSP_Length(query.count)
                    )
                }
            }
            return (record.mediaID, score)
        }
        .sorted { $0.score > $1.score }
        .prefix(limit)
        .map { $0 }
    }
}

actor SemanticVectorIndexCache {
    static let shared = SemanticVectorIndexCache()

    private var modelVersion = ""
    private var count = -1
    private var latest = -1.0
    private var index = AccelerateVectorIndex(vectors: [])

    func vectorIndex<Engine: EmbeddingEngine>(
        store: LibraryStore,
        engine: Engine.Type
    ) async throws -> AccelerateVectorIndex {
        let signature = try await store.semanticEmbeddingSignature(
            modelVersion: engine.modelVersion
        )
        if modelVersion == engine.modelVersion,
           count == signature.count,
           latest == signature.latest {
            return index
        }
        let vectors = try await store.semanticEmbeddings(
            modelVersion: engine.modelVersion
        ).compactMap { record -> (Int64, [Float])? in
            guard let values = engine.decode(record.blob) else { return nil }
            return (record.mediaID, values)
        }
        let rebuilt = AccelerateVectorIndex(vectors: vectors)
        modelVersion = engine.modelVersion
        count = signature.count
        latest = signature.latest
        index = rebuilt
        return rebuilt
    }
}

struct SemanticSearchPipeline<Engine>
where Engine: EmbeddingEngine & TextEmbeddingEngine {
    let engine: Engine.Type
    let cache: SemanticVectorIndexCache

    init(
        engine: Engine.Type,
        cache: SemanticVectorIndexCache = .shared
    ) {
        self.engine = engine
        self.cache = cache
    }

    func search(
        query: String,
        store: LibraryStore,
        limit: Int
    ) async throws -> [(mediaID: Int64, score: Float)] {
        guard let queryVector = engine.textEmbedding(query) else { return [] }
        let index = try await cache.vectorIndex(store: store, engine: engine)
        return index.nearest(to: queryVector, limit: limit)
    }
}

enum EmbeddingBackendRegistry {
    static func search(
        modelVersion: String,
        query: String,
        store: LibraryStore,
        limit: Int
    ) async throws -> [(mediaID: Int64, score: Float)] {
        switch modelVersion {
        case MobileCLIPEngine.modelVersion:
            return try await SemanticSearchPipeline(engine: MobileCLIPEngine.self)
                .search(query: query, store: store, limit: limit)
        default:
            throw EmbeddingBackendError.unsupportedModel(modelVersion)
        }
    }
}

enum EmbeddingBackendError: LocalizedError {
    case unsupportedModel(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedModel(let model):
            return "No embedding backend is registered for \(model)"
        }
    }
}
