import Foundation

public struct SocialIdentityProfile: Codable, Sendable {
    public let name: String
    public let platform: String
}

public struct SocialIdentityExport: Codable, Sendable {
    public let key: String
    public let name: String
    public let paths: [String]
    public let profiles: [SocialIdentityProfile]
}

public enum SocialArchiveIdentityReader {
    public static func latestReferenceID(databaseURL: URL) throws -> Int64 {
        let database = try Database(path: databaseURL.path, readOnly: true)
        return try database.query("SELECT COALESCE(MAX(id), 0) AS latest_ref_id FROM media_refs")
            .first?.int("latest_ref_id") ?? 0
    }

    public static func read(databaseURL: URL) throws -> [SocialIdentityExport] {
        let database = try Database(path: databaseURL.path, readOnly: true)
        let identities = try database.query(
            "SELECT id,display_name FROM identities ORDER BY display_name COLLATE NOCASE"
        )
        let sourceRows = try database.query(
            "SELECT identity_id,platform,username,profile_url FROM sources ORDER BY source_order,id"
        )
        let referenceRows = try database.query(
            "SELECT identity_id,local_symlink_path FROM media_refs WHERE identity_id IS NOT NULL AND local_symlink_path<>''"
        )
        var profiles: [Int64: [SocialIdentityProfile]] = [:]
        for row in sourceRows {
            guard let identityID = row.int("identity_id") else { continue }
            profiles[identityID, default: []].append(SocialIdentityProfile(
                name: row.string("username") ?? row.string("profile_url") ?? "Imported media",
                platform: row.string("platform") ?? "Source"
            ))
        }
        var paths: [Int64: Set<String>] = [:]
        for row in referenceRows {
            guard let identityID = row.int("identity_id"),
                  let symlink = row.string("local_symlink_path") else { continue }
            paths[identityID, default: []].insert(
                URL(fileURLWithPath: symlink).deletingLastPathComponent().path
            )
        }
        return identities.compactMap { row in
            guard let identityID = row.int("id"), let name = row.string("display_name") else { return nil }
            return SocialIdentityExport(
                key: name.lowercased().filter { $0.isLetter || $0.isNumber },
                name: name,
                paths: (paths[identityID] ?? []).sorted(),
                profiles: profiles[identityID] ?? []
            )
        }
    }
}
