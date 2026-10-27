import Foundation
import AppKit
import Photos

private struct BridgeAsset: Codable {
    let id: String
    let filename: String?
    let mediaType: String
    let width: Int
    let height: Int
    let duration: Double
    let createdAt: Date?
    let modifiedAt: Date?
    let favorite: Bool
    let hidden: Bool
}

private struct BridgeAlbum: Codable {
    let id: String
    let title: String
    let assetCount: Int
    let coverAssetId: String?
}

private struct AuthorizationPayload: Codable {
    let status: String
    let readable: Bool
}

private struct CatalogPayload: Codable {
    let assets: [BridgeAsset]
    let offset: Int
    let limit: Int
    let total: Int
}

private struct AlbumPayload: Codable {
    let albums: [BridgeAlbum]
}

private struct FilePayload: Codable {
    let output: String
    let bytes: Int
}

private enum BridgeFailure: LocalizedError {
    case authorizationRequired(String)
    case invalidArguments(String)
    case assetNotFound
    case mediaUnavailable(String)

    var errorDescription: String? {
        switch self {
        case let .authorizationRequired(status):
            "Photos access is required (current status: \(status)). Open Anthora and grant read access first."
        case let .invalidArguments(message): message
        case .assetNotFound: "The requested Photos asset no longer exists."
        case let .mediaUnavailable(message): message
        }
    }
}

@main
private enum AnthoraPhotosBridge {
    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            let command = arguments.first ?? "status"
            switch command {
            case "status":
                try printJSON(authorizationPayload())
            case "request-access":
                NSApplication.shared.setActivationPolicy(.regular)
                NSApplication.shared.activate(ignoringOtherApps: true)
                let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
                try printJSON(payload(for: status))
            case "catalog":
                try requireReadableLibrary()
                let offset = integerOption("--offset", in: arguments, default: 0)
                let limit = min(max(integerOption("--limit", in: arguments, default: 250), 1), 1_000)
                let albumId = optionalOption("--album-id", in: arguments)
                let query = optionalOption("--query", in: arguments) ?? ""
                try printJSON(catalog(offset: max(offset, 0), limit: limit, albumId: albumId, query: query))
            case "albums":
                try requireReadableLibrary()
                try printJSON(albums())
            case "thumbnail":
                try requireReadableLibrary()
                let id = try requiredOption("--id", in: arguments)
                let output = URL(fileURLWithPath: try requiredOption("--output", in: arguments))
                let size = min(max(integerOption("--size", in: arguments, default: 1_200), 64), 4_096)
                try await writeThumbnail(asset: try asset(with: id), size: size, output: output)
                try printJSON(FilePayload(output: output.path, bytes: try fileSize(output)))
            case "export":
                try requireReadableLibrary()
                let id = try requiredOption("--id", in: arguments)
                let output = URL(fileURLWithPath: try requiredOption("--output", in: arguments))
                try await export(asset: try asset(with: id), output: output)
                try printJSON(FilePayload(output: output.path, bytes: try fileSize(output)))
            default:
                throw BridgeFailure.invalidArguments("Unknown command \(command). Use status, request-access, catalog, albums, thumbnail, or export.")
            }
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }

    private static func authorizationPayload() -> AuthorizationPayload {
        payload(for: PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    private static func payload(for status: PHAuthorizationStatus) -> AuthorizationPayload {
        let name: String
        switch status {
        case .authorized: name = "authorized"
        case .limited: name = "limited"
        case .denied: name = "denied"
        case .restricted: name = "restricted"
        case .notDetermined: name = "notDetermined"
        @unknown default: name = "unknown"
        }
        return AuthorizationPayload(status: name, readable: status == .authorized || status == .limited)
    }

    private static func requireReadableLibrary() throws {
        let authorization = authorizationPayload()
        guard authorization.readable else { throw BridgeFailure.authorizationRequired(authorization.status) }
    }

    private static func catalog(offset: Int, limit: Int, albumId: String?, query: String) -> CatalogPayload {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.includeHiddenAssets = false
        let result: PHFetchResult<PHAsset>
        if let albumId {
            guard let album = PHAssetCollection.fetchAssetCollections(
                withLocalIdentifiers: [albumId],
                options: nil
            ).firstObject else {
                return CatalogPayload(assets: [], offset: offset, limit: limit, total: 0)
            }
            result = PHAsset.fetchAssets(in: album, options: options)
        } else {
            result = PHAsset.fetchAssets(with: options)
        }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matchingIndexes: [Int]
        if normalizedQuery.isEmpty {
            matchingIndexes = Array(0..<result.count)
        } else {
            matchingIndexes = (0..<result.count).filter { index in
                let asset = result.object(at: index)
                return PHAssetResource.assetResources(for: asset).contains { resource in
                    resource.originalFilename.localizedCaseInsensitiveContains(normalizedQuery)
                }
            }
        }
        let upperBound = min(offset + limit, matchingIndexes.count)
        guard offset < upperBound else {
            return CatalogPayload(assets: [], offset: offset, limit: limit, total: matchingIndexes.count)
        }
        let assets = matchingIndexes[offset..<upperBound].map { index in
            let asset = result.object(at: index)
            let filename = PHAssetResource.assetResources(for: asset).first?.originalFilename
            return BridgeAsset(
                id: asset.localIdentifier,
                filename: filename,
                mediaType: mediaTypeName(asset.mediaType),
                width: asset.pixelWidth,
                height: asset.pixelHeight,
                duration: asset.duration,
                createdAt: asset.creationDate,
                modifiedAt: asset.modificationDate,
                favorite: asset.isFavorite,
                hidden: asset.isHidden
            )
        }
        return CatalogPayload(assets: assets, offset: offset, limit: limit, total: matchingIndexes.count)
    }

    private static func albums() -> AlbumPayload {
        let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        var albums: [BridgeAlbum] = []
        collections.enumerateObjects { collection, _, _ in
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.includeHiddenAssets = false
            let assets = PHAsset.fetchAssets(in: collection, options: options)
            albums.append(BridgeAlbum(
                id: collection.localIdentifier,
                title: collection.localizedTitle ?? "Untitled Album",
                assetCount: assets.count,
                coverAssetId: assets.firstObject?.localIdentifier
            ))
        }
        albums.sort { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        return AlbumPayload(albums: albums)
    }

    private static func mediaTypeName(_ type: PHAssetMediaType) -> String {
        switch type {
        case .image: "image"
        case .video: "video"
        case .audio: "audio"
        case .unknown: "unknown"
        @unknown default: "unknown"
        }
    }

    private static func asset(with id: String) throws -> PHAsset {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            throw BridgeFailure.assetNotFound
        }
        return asset
    }

    private static func writeThumbnail(asset: PHAsset, size: Int, output: URL) async throws {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = false
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: NSSize(width: size, height: size),
                contentMode: .aspectFit,
                options: options
            ) { image, information in
                if let image { continuation.resume(returning: image); return }
                let message = (information?[PHImageErrorKey] as? Error)?.localizedDescription
                    ?? "The thumbnail is not available on this Mac."
                continuation.resume(throwing: BridgeFailure.mediaUnavailable(message))
            }
        }
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let data = representation.representation(using: .jpeg, properties: [.compressionFactor: 0.86]) else {
            throw BridgeFailure.mediaUnavailable("The thumbnail could not be encoded.")
        }
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: output, options: .atomic)
    }

    private static func export(asset: PHAsset, output: URL) async throws {
        let resources = PHAssetResource.assetResources(for: asset)
        let preferredTypes: [PHAssetResourceType] = asset.mediaType == .video
            ? [.fullSizeVideo, .video]
            : [.fullSizePhoto, .photo]
        guard let resource = preferredTypes.lazy.compactMap({ type in resources.first { $0.type == type } }).first
                ?? resources.first else {
            throw BridgeFailure.mediaUnavailable("The original resource is unavailable.")
        }
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = false
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: output, options: options) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private static func integerOption(_ name: String, in arguments: [String], default defaultValue: Int) -> Int {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return defaultValue }
        return Int(arguments[index + 1]) ?? defaultValue
    }

    private static func requiredOption(_ name: String, in arguments: [String]) throws -> String {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
            throw BridgeFailure.invalidArguments("Missing required option \(name).")
        }
        return arguments[index + 1]
    }

    private static func optionalOption(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private static func fileSize(_ url: URL) throws -> Int {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        return values.fileSize ?? 0
    }

    private static func printJSON<Value: Encodable>(_ value: Value) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        FileHandle.standardOutput.write(try encoder.encode(value))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
