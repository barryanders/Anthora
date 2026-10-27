import Foundation

/// Finder drops connect existing folders; they never import or move their contents.
public enum SourceFolderSelection {
    public static func paths(from urls: [URL]) throws -> [String] {
        guard !urls.isEmpty else { throw SelectionError("Drag folders from Finder, or use Add folder.") }
        var paths: [String] = []
        for input in urls {
            guard input.isFileURL else { throw SelectionError("Drop folders from this Mac, not web links.") }
            let url = input.resolvingSymlinksInPath().standardizedFileURL
            let values: URLResourceValues
            do { values = try url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey]) }
            catch { throw SelectionError("\(input.lastPathComponent) is unavailable. Reconnect its drive and try again.") }
            guard values.isDirectory == true, values.isPackage != true,
                  !["app", "photoslibrary", "anthora"].contains(url.pathExtension.lowercased()) else {
                throw SelectionError("Drop ordinary folders, not individual files, apps, or photo library packages.")
            }
            guard FileManager.default.isReadableFile(atPath: url.path) else {
                throw SelectionError("Anthora cannot read \(url.lastPathComponent). Check the folder's permissions.")
            }
            if !paths.contains(url.path) { paths.append(url.path) }
        }
        return paths
    }

    private struct SelectionError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}
