import Foundation

/// Locations for the app's own data (never the user's media).
public enum AppPaths {
    public static func applicationSupportDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appendingPathComponent("Anthora", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    public static func databaseURL() throws -> URL {
        if let override = ProcessInfo.processInfo.environment["ANTHORA_DATABASE"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return try applicationSupportDirectory().appendingPathComponent("anthora.sqlite")
    }

    public static func thumbnailsDirectory() throws -> URL {
        let directory = try applicationSupportDirectory().appendingPathComponent("Thumbnails", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
