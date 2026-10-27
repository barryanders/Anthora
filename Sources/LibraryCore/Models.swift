import Foundation

public enum MediaType: String, Sendable, Codable, CaseIterable, Hashable {
    case image
    case video
}

public enum AIContentFilter: String, Sendable, CaseIterable, Hashable {
    case all
    case textHeavy
    case other
    case unanalyzed
}

public struct TextAnalysisResult: Sendable, Hashable {
    public let observationCount: Int
    public let textAreaRatio: Double
    public let isTextHeavy: Bool
    public let recognizedText: String
    public let errorMessage: String?

    public init(
        observationCount: Int,
        textAreaRatio: Double,
        isTextHeavy: Bool,
        recognizedText: String = "",
        errorMessage: String? = nil
    ) {
        self.observationCount = observationCount
        self.textAreaRatio = textAreaRatio
        self.isTextHeavy = isTextHeavy
        self.recognizedText = recognizedText
        self.errorMessage = errorMessage
    }
}

public struct FaceFeatureRecord: Sendable {
    public let mediaID: Int64
    public let faceIndex: Int
    public let personKey: String?
    public let blob: Data

    public init(mediaID: Int64, faceIndex: Int, personKey: String?, blob: Data) {
        self.mediaID = mediaID
        self.faceIndex = faceIndex
        self.personKey = personKey
        self.blob = blob
    }
}

public struct LibraryRecord: Identifiable, Sendable, Hashable {
    public let id: Int64
    public var name: String
    public var rootPath: String
    public var bookmarkData: Data?
    public var createdAt: Date
    public var updatedAt: Date
    public var lastScannedAt: Date?
    public var scanStatus: String

    public var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }
}

public struct MediaScanState: Sendable {
    public let sizeBytes: Int64
    public let modifiedAt: Date?

    public init(sizeBytes: Int64, modifiedAt: Date?) {
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
    }
}

public struct FolderRecord: Identifiable, Sendable, Hashable {
    public let id: Int64
    public var libraryID: Int64
    public var path: String
    public var parentPath: String?
    public var name: String
    public var itemCount: Int
}

public struct MediaItemRecord: Identifiable, Sendable, Hashable {
    public let id: Int64
    public var libraryID: Int64
    public var folderID: Int64
    public var path: String
    public var filename: String
    public var ext: String
    public var mediaType: MediaType
    public var sizeBytes: Int64
    public var createdAt: Date?
    public var modifiedAt: Date?
    public var importedAt: Date
    public var width: Int?
    public var height: Int?
    public var durationSeconds: Double?
    public var thumbnailPath: String?
    public var favorite: Bool
    public var missing: Bool
    public var contentHash: String?

    public var fileURL: URL { URL(fileURLWithPath: path) }

    public init(
        id: Int64,
        libraryID: Int64,
        folderID: Int64,
        path: String,
        filename: String,
        ext: String,
        mediaType: MediaType,
        sizeBytes: Int64,
        createdAt: Date? = nil,
        modifiedAt: Date? = nil,
        importedAt: Date = Date(),
        width: Int? = nil,
        height: Int? = nil,
        durationSeconds: Double? = nil,
        thumbnailPath: String? = nil,
        favorite: Bool = false,
        missing: Bool = false,
        contentHash: String? = nil
    ) {
        self.id = id
        self.libraryID = libraryID
        self.folderID = folderID
        self.path = path
        self.filename = filename
        self.ext = ext
        self.mediaType = mediaType
        self.sizeBytes = sizeBytes
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.importedAt = importedAt
        self.width = width
        self.height = height
        self.durationSeconds = durationSeconds
        self.thumbnailPath = thumbnailPath
        self.favorite = favorite
        self.missing = missing
        self.contentHash = contentHash
    }
}

public struct CollectionRecord: Identifiable, Sendable, Hashable {
    public let id: Int64
    public var name: String
    public var details: String?
    public var coverItemID: Int64?
    public var createdAt: Date
    public var updatedAt: Date
    public var itemCount: Int

    public init(
        id: Int64,
        name: String,
        details: String? = nil,
        coverItemID: Int64? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        itemCount: Int = 0
    ) {
        self.id = id
        self.name = name
        self.details = details
        self.coverItemID = coverItemID
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.itemCount = itemCount
    }
}

/// A file discovered by the scanner, ready to be upserted into the database.
public struct ScannedMediaFile: Sendable {
    public var folderID: Int64
    public var path: String
    public var filename: String
    public var ext: String
    public var mediaType: MediaType
    public var sizeBytes: Int64
    public var createdAt: Date?
    public var modifiedAt: Date?
    public var width: Int?
    public var height: Int?
    public var contentHash: String?

    public init(
        folderID: Int64,
        path: String,
        filename: String,
        ext: String,
        mediaType: MediaType,
        sizeBytes: Int64,
        createdAt: Date? = nil,
        modifiedAt: Date? = nil,
        width: Int? = nil,
        height: Int? = nil,
        contentHash: String? = nil
    ) {
        self.folderID = folderID
        self.path = path
        self.filename = filename
        self.ext = ext
        self.mediaType = mediaType
        self.sizeBytes = sizeBytes
        self.createdAt = createdAt
        self.modifiedAt = modifiedAt
        self.width = width
        self.height = height
        self.contentHash = contentHash
    }
}

public enum MediaSort: String, Sendable, CaseIterable {
    case newestFirst
    case oldestFirst
    case nameAscending
    case recentlyAdded

    var sql: String {
        switch self {
        case .newestFirst:
            return "COALESCE(created_at, modified_at, imported_at) DESC, id DESC"
        case .oldestFirst:
            return "COALESCE(created_at, modified_at, imported_at) ASC, id ASC"
        case .nameAscending:
            return "filename COLLATE NOCASE ASC, id ASC"
        case .recentlyAdded:
            return "imported_at DESC, id DESC"
        }
    }
}

/// A paged, filtered query over media items. This is the seed of the future
/// smart-collection engine: a smart collection is just a saved MediaQuery.
public struct MediaQuery: Sendable, Hashable {
    public var libraryID: Int64?
    public var folderID: Int64?
    /// Matches items anywhere under this folder path (the folder itself and
    /// all descendants), unlike `folderID` which matches direct children only.
    public var folderSubtreePath: String?
    public var collectionID: Int64?
    public var mediaType: MediaType?
    public var favoritesOnly: Bool
    public var aiContentFilter: AIContentFilter
    public var searchText: String?
    public var includeMissing: Bool
    public var sort: MediaSort
    public var limit: Int
    public var offset: Int

    public init(
        libraryID: Int64? = nil,
        folderID: Int64? = nil,
        folderSubtreePath: String? = nil,
        collectionID: Int64? = nil,
        mediaType: MediaType? = nil,
        favoritesOnly: Bool = false,
        aiContentFilter: AIContentFilter = .all,
        searchText: String? = nil,
        includeMissing: Bool = false,
        sort: MediaSort = .newestFirst,
        limit: Int = 400,
        offset: Int = 0
    ) {
        self.libraryID = libraryID
        self.folderID = folderID
        self.folderSubtreePath = folderSubtreePath
        self.collectionID = collectionID
        self.mediaType = mediaType
        self.favoritesOnly = favoritesOnly
        self.aiContentFilter = aiContentFilter
        self.searchText = searchText
        self.includeMissing = includeMissing
        self.sort = sort
        self.limit = limit
        self.offset = offset
    }
}

public struct ScanSummary: Sendable {
    public let itemsIndexed: Int
    public let foldersSeen: Int
    public let markedMissing: Int
    public let cancelled: Bool
    public let limitReached: Bool

    public init(
        itemsIndexed: Int,
        foldersSeen: Int,
        markedMissing: Int,
        cancelled: Bool,
        limitReached: Bool = false
    ) {
        self.itemsIndexed = itemsIndexed
        self.foldersSeen = foldersSeen
        self.markedMissing = markedMissing
        self.cancelled = cancelled
        self.limitReached = limitReached
    }
}
