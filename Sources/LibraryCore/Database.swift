import Foundation
import SQLite3

/// SQLite binds text/blob with a destructor; TRANSIENT tells it to copy the buffer.
private nonisolated(unsafe) let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public struct DatabaseError: Error, CustomStringConvertible, Sendable {
    public let message: String
    public let code: Int32
    public var description: String { "SQLite error \(code): \(message)" }
}

/// A value that can be bound to or read from a SQLite statement.
public enum SQLValue: Sendable, Equatable {
    case null
    case int(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    static func date(_ date: Date?) -> SQLValue {
        date.map { .real($0.timeIntervalSince1970) } ?? .null
    }

    static func bool(_ value: Bool) -> SQLValue { .int(value ? 1 : 0) }

    static func intOrNull(_ value: Int64?) -> SQLValue { value.map { .int($0) } ?? .null }
    static func intOrNull(_ value: Int?) -> SQLValue { value.map { .int(Int64($0)) } ?? .null }
    static func textOrNull(_ value: String?) -> SQLValue { value.map { .text($0) } ?? .null }
    static func realOrNull(_ value: Double?) -> SQLValue { value.map { .real($0) } ?? .null }
    static func blobOrNull(_ value: Data?) -> SQLValue { value.map { .blob($0) } ?? .null }
}

/// One result row, addressable by column name.
public struct Row: Sendable {
    private let columns: [String: SQLValue]

    init(columns: [String: SQLValue]) {
        self.columns = columns
    }

    public func int(_ name: String) -> Int64? {
        if case .int(let value)? = columns[name] { return value }
        return nil
    }

    public func double(_ name: String) -> Double? {
        switch columns[name] {
        case .real(let value)?: return value
        case .int(let value)?: return Double(value)
        default: return nil
        }
    }

    public func string(_ name: String) -> String? {
        if case .text(let value)? = columns[name] { return value }
        return nil
    }

    public func data(_ name: String) -> Data? {
        if case .blob(let value)? = columns[name] { return value }
        return nil
    }

    public func date(_ name: String) -> Date? {
        double(name).map(Date.init(timeIntervalSince1970:))
    }

    public func bool(_ name: String) -> Bool {
        (int(name) ?? 0) != 0
    }
}

/// Thin wrapper over a single SQLite connection. Not thread-safe by itself;
/// it must be owned by exactly one actor (`LibraryStore`).
final class Database {
    private var handle: OpaquePointer?

    init(path: String, readOnly: Bool = false) throws {
        var db: OpaquePointer?
        let flags = (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unable to open database"
            sqlite3_close_v2(db)
            throw DatabaseError(message: message, code: SQLITE_CANTOPEN)
        }
        handle = db
        try execute("PRAGMA busy_timeout=5000")
        if readOnly {
            try execute("PRAGMA query_only=ON")
            return
        }
        try execute("PRAGMA journal_mode=WAL")
        try execute("PRAGMA synchronous=NORMAL")
        try execute("PRAGMA foreign_keys=ON")
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    /// Runs one or more semicolon-separated statements with no bindings.
    func execute(_ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(handle, sql, nil, nil, &errorMessage) == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) } ?? "unknown error"
            sqlite3_free(errorMessage)
            throw DatabaseError(message: message, code: sqlite3_errcode(handle))
        }
    }

    func run(_ sql: String, _ args: [SQLValue] = []) throws {
        let statement = try prepare(sql, args)
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        guard result == SQLITE_DONE || result == SQLITE_ROW else {
            throw currentError()
        }
    }

    func query(_ sql: String, _ args: [SQLValue] = []) throws -> [Row] {
        let statement = try prepare(sql, args)
        defer { sqlite3_finalize(statement) }
        var rows: [Row] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_ROW {
                rows.append(row(from: statement))
            } else if result == SQLITE_DONE {
                break
            } else {
                throw currentError()
            }
        }
        return rows
    }

    var lastInsertRowID: Int64 {
        sqlite3_last_insert_rowid(handle)
    }

    var changes: Int {
        Int(sqlite3_changes(handle))
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    // MARK: - Internals

    private func prepare(_ sql: String, _ args: [SQLValue]) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw currentError()
        }
        for (index, arg) in args.enumerated() {
            let position = Int32(index + 1)
            let result: Int32
            switch arg {
            case .null:
                result = sqlite3_bind_null(statement, position)
            case .int(let value):
                result = sqlite3_bind_int64(statement, position, value)
            case .real(let value):
                result = sqlite3_bind_double(statement, position, value)
            case .text(let value):
                result = sqlite3_bind_text(statement, position, value, -1, SQLITE_TRANSIENT)
            case .blob(let value):
                result = value.withUnsafeBytes { buffer in
                    sqlite3_bind_blob(statement, position, buffer.baseAddress, Int32(value.count), SQLITE_TRANSIENT)
                }
            }
            guard result == SQLITE_OK else {
                sqlite3_finalize(statement)
                throw currentError()
            }
        }
        return statement
    }

    private func row(from statement: OpaquePointer) -> Row {
        var columns: [String: SQLValue] = [:]
        for index in 0..<sqlite3_column_count(statement) {
            let name = String(cString: sqlite3_column_name(statement, index))
            switch sqlite3_column_type(statement, index) {
            case SQLITE_INTEGER:
                columns[name] = .int(sqlite3_column_int64(statement, index))
            case SQLITE_FLOAT:
                columns[name] = .real(sqlite3_column_double(statement, index))
            case SQLITE_TEXT:
                columns[name] = .text(String(cString: sqlite3_column_text(statement, index)))
            case SQLITE_BLOB:
                if let bytes = sqlite3_column_blob(statement, index) {
                    columns[name] = .blob(Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, index))))
                } else {
                    columns[name] = .blob(Data())
                }
            default:
                columns[name] = .null
            }
        }
        return Row(columns: columns)
    }

    private func currentError() -> DatabaseError {
        DatabaseError(
            message: String(cString: sqlite3_errmsg(handle)),
            code: sqlite3_errcode(handle)
        )
    }
}
