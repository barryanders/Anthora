import AppKit
import Foundation

@MainActor
final class LocalServiceRuntime {
    enum RuntimeError: LocalizedError {
        case helperMissing(String)
        case helperFailed(String)
        case startTimedOut
        case invalidReadyFile
        case unhealthy

        var errorDescription: String? {
            switch self {
            case .helperMissing(let name):
                "The bundled \(name) helper is missing. Reinstall Anthora and try again."
            case .helperFailed(let name):
                "The \(name) helper could not start."
            case .startTimedOut:
                "Anthora took too long to start its local library."
            case .invalidReadyFile:
                "Anthora's local library returned an invalid address."
            case .unhealthy:
                "Anthora's local library started but did not pass its health check."
            }
        }
    }

    private var processes: [Process] = []
    private var logFiles: [FileHandle] = []
    private var terminationObserver: NSObjectProtocol?

    init() {
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    func start(databaseURL: URL, libraryID: String) async throws -> URL {
        stop()

        let paths = try RuntimePaths(databaseURL: databaseURL, libraryID: libraryID)
        try FileManager.default.createDirectory(
            at: paths.applicationSupport,
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(at: paths.cache, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: paths.queue, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: paths.analysisQueue, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: paths.logs, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: paths.readyFile)

        var environment = ProcessInfo.processInfo.environment
        environment["ANTHORA_DATABASE"] = paths.database.path
        environment["ANTHORA_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)

        try await runAndWait(
            executable: paths.reader,
            arguments: ["check"],
            environment: environment,
            name: "media"
        )

        processes.append(try launch(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: [
                paths.service.path,
                "--host", "127.0.0.1",
                "--port", "0",
                "--database", paths.database.path,
                "--cache", paths.cache.appendingPathComponent("Thumbnails").path,
                "--reader", paths.reader.path,
                "--photos-bridge", paths.photosBridge.path,
                "--queue", paths.queue.path,
                "--analysis-queue", paths.analysisQueue.path,
                "--web-root", paths.web.path,
                "--ready-file", paths.readyFile.path,
            ],
            environment: environment,
            logURL: paths.logs.appendingPathComponent("service.log")
        ))

        do {
            let serviceURL = try await waitForReadyFile(paths.readyFile)
            try await verifyHealth(serviceURL)
            processes.append(try launch(
                executable: paths.reader,
                arguments: ["worker", paths.queue.path],
                environment: environment,
                logURL: paths.logs.appendingPathComponent("media-reader.log")
            ))
            processes.append(try launch(
                executable: paths.reader,
                arguments: ["analysis-worker", paths.analysisQueue.path],
                environment: environment,
                logURL: paths.logs.appendingPathComponent("analysis.log")
            ))
            return serviceURL
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        for process in processes.reversed() where process.isRunning {
            process.terminate()
        }
        processes.removeAll()
        for log in logFiles {
            try? log.close()
        }
        logFiles.removeAll()
    }

    private func launch(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        logURL: URL
    ) throws -> Process {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw RuntimeError.helperMissing(executable.lastPathComponent)
        }
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = log
        process.standardError = log
        try process.run()
        logFiles.append(log)
        return process
    }

    private func runAndWait(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        name: String
    ) async throws {
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw RuntimeError.helperMissing(name)
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        await withCheckedContinuation { continuation in
            process.terminationHandler = { _ in continuation.resume() }
        }
        guard process.terminationStatus == 0 else { throw RuntimeError.helperFailed(name) }
    }

    private func waitForReadyFile(_ url: URL) async throws -> URL {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let data = try? Data(contentsOf: url),
               let payload = try? JSONDecoder().decode(ReadyPayload.self, from: data),
               let serviceURL = URL(string: payload.url) {
                return serviceURL
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw RuntimeError.startTimedOut
    }

    private func verifyHealth(_ serviceURL: URL) async throws {
        var request = URLRequest(url: serviceURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 5
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              let payload = try? JSONDecoder().decode(HealthPayload.self, from: data),
              payload.status == "ok" else {
            throw RuntimeError.unhealthy
        }
    }
}

private struct ReadyPayload: Decodable {
    let url: String
}

private struct HealthPayload: Decodable {
    let status: String
}

private struct RuntimePaths {
    let applicationSupport: URL
    let database: URL
    let cache: URL
    let queue: URL
    let analysisQueue: URL
    let logs: URL
    let readyFile: URL
    let reader: URL
    let photosBridge: URL
    let service: URL
    let web: URL

    init(databaseURL: URL, libraryID: String) throws {
        guard let applicationSupportRoot = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first,
        let cacheRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
        let logsRoot = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else {
            throw LocalServiceRuntime.RuntimeError.helperMissing("runtime")
        }

        let contents = Bundle.main.bundleURL.appendingPathComponent("Contents", isDirectory: true)
        let helpers = contents.appendingPathComponent("Helpers", isDirectory: true)
        applicationSupport = applicationSupportRoot.appendingPathComponent("Anthora", isDirectory: true)
        database = databaseURL
        cache = cacheRoot.appendingPathComponent("AnthoraService", isDirectory: true)
            .appendingPathComponent(libraryID, isDirectory: true)
        queue = cache.appendingPathComponent("Queue", isDirectory: true)
        analysisQueue = cache.appendingPathComponent("AnalysisQueue", isDirectory: true)
        logs = logsRoot.appendingPathComponent("Logs/Anthora", isDirectory: true)
        readyFile = cache.appendingPathComponent("local-service.json")
        reader = helpers.appendingPathComponent("AnthoraMediaReader")
        photosBridge = helpers.appendingPathComponent("AnthoraPhotosBridge")
        service = contents.appendingPathComponent("Resources/AnthoraService/AnthoraService.sh")
        web = contents.appendingPathComponent("Resources/Web", isDirectory: true)
    }
}
