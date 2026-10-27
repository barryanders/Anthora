import Foundation

/// Creation and resolution of folder bookmarks.
///
/// Security-scoped bookmarks are used when available (required under the App
/// Sandbox); plain bookmarks are a fallback so the app also works correctly
/// in unsandboxed development builds.
public enum FolderBookmark {
    public static func create(for url: URL) throws -> Data {
        do {
            return try url.bookmarkData(
                options: [.withSecurityScope],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
        } catch {
            return try url.bookmarkData(
                options: [],
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
        }
    }

    public static func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        var isStale = false
        do {
            let url = try URL(
                resolvingBookmarkData: data,
                options: [.withSecurityScope],
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            return (url, isStale)
        } catch {
            var plainStale = false
            let url = try URL(
                resolvingBookmarkData: data,
                options: [],
                relativeTo: nil,
                bookmarkDataIsStale: &plainStale
            )
            return (url, plainStale)
        }
    }
}
