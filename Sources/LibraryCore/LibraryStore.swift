import Foundation

/// The single owner of the SQLite connection. All reads and writes go through
/// this actor, which keeps the (non-Sendable) `Database` isolated.
public actor LibraryStore {
    private let db: Database

    public init(databaseURL: URL) throws {
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        db = try Database(path: databaseURL.path)
        try Migrations.migrate(db)
    }

    // MARK: - Libraries

    public func createLibrary(name: String, rootPath: String, bookmarkData: Data?) throws -> LibraryRecord {
        let now = Date()
        try db.run(
            """
            INSERT INTO libraries (name, root_path, bookmark_data, created_at, updated_at, scan_status)
            VALUES (?, ?, ?, ?, ?, 'idle')
            """,
            [.text(name), .text(rootPath), .blobOrNull(bookmarkData), .date(now), .date(now)]
        )
        return LibraryRecord(
            id: db.lastInsertRowID,
            name: name,
            rootPath: rootPath,
            bookmarkData: bookmarkData,
            createdAt: now,
            updatedAt: now,
            lastScannedAt: nil,
            scanStatus: "idle"
        )
    }

    public func allLibraries() throws -> [LibraryRecord] {
        try db.query("SELECT * FROM libraries ORDER BY name COLLATE NOCASE").compactMap(library(from:))
    }

    public func library(id: Int64) throws -> LibraryRecord? {
        try db.query("SELECT * FROM libraries WHERE id = ?", [.int(id)]).first.flatMap(library(from:))
    }

    public func library(rootPath: String) throws -> LibraryRecord? {
        try db.query("SELECT * FROM libraries WHERE root_path = ?", [.text(rootPath)]).first.flatMap(library(from:))
    }

    public func updateLibraryBookmark(id: Int64, bookmarkData: Data?) throws {
        try db.run(
            "UPDATE libraries SET bookmark_data = ?, updated_at = ? WHERE id = ?",
            [.blobOrNull(bookmarkData), .date(Date()), .int(id)]
        )
    }

    public func updateLibraryScanStatus(id: Int64, status: String, lastScannedAt: Date?) throws {
        if let lastScannedAt {
            try db.run(
                "UPDATE libraries SET scan_status = ?, last_scanned_at = ?, updated_at = ? WHERE id = ?",
                [.text(status), .date(lastScannedAt), .date(Date()), .int(id)]
            )
        } else {
            try db.run(
                "UPDATE libraries SET scan_status = ?, updated_at = ? WHERE id = ?",
                [.text(status), .date(Date()), .int(id)]
            )
        }
    }

    /// Removes the library row; folders, items, and scan jobs cascade.
    /// Never touches files on disk.
    public func removeLibrary(id: Int64) throws {
        try db.run("DELETE FROM libraries WHERE id = ?", [.int(id)])
    }

    // MARK: - Folders

    @discardableResult
    public func upsertFolder(libraryID: Int64, path: String, parentPath: String?, name: String) throws -> Int64 {
        let now = Date()
        try db.run(
            """
            INSERT INTO folders (library_id, path, parent_path, name, created_at, updated_at, last_scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (library_id, path) DO UPDATE SET
                parent_path = excluded.parent_path,
                name = excluded.name,
                updated_at = excluded.updated_at,
                last_scanned_at = excluded.last_scanned_at
            """,
            [.int(libraryID), .text(path), .textOrNull(parentPath), .text(name), .date(now), .date(now), .date(now)]
        )
        guard let id = try db.query(
            "SELECT id FROM folders WHERE library_id = ? AND path = ?",
            [.int(libraryID), .text(path)]
        ).first?.int("id") else {
            throw DatabaseError(message: "folder upsert failed for \(path)", code: -1)
        }
        return id
    }

    public func folders(libraryID: Int64) throws -> [FolderRecord] {
        try db.query(
            "SELECT * FROM folders WHERE library_id = ? ORDER BY path",
            [.int(libraryID)]
        ).compactMap(folder(from:))
    }

    public func childFolders(libraryID: Int64, parentPath: String) throws -> [FolderRecord] {
        try db.query(
            """
            SELECT * FROM folders
            WHERE library_id = ? AND parent_path = ?
            ORDER BY name COLLATE NOCASE
            """,
            [.int(libraryID), .text(parentPath)]
        ).compactMap(folder(from:))
    }

    public func folderCoverItem(folderID: Int64) throws -> MediaItemRecord? {
        let folderRow = try db.query("SELECT * FROM folders WHERE id = ?", [.int(folderID)]).first
        guard let folder = folderRow.flatMap(folder(from:)) else { return nil }
        let prefix = escapeLike(folder.path) + "/%"
        return try db.query(
            """
            SELECT m.* FROM media_items m
            LEFT JOIN folder_covers fc
              ON fc.folder_id = ? AND fc.media_item_id = m.id
            LEFT JOIN media_text_analysis a ON a.media_id = m.id
            WHERE m.library_id = ? AND m.missing = 0 AND m.media_type = 'image'
              AND m.path LIKE ? ESCAPE '\\'
            ORDER BY
                CASE WHEN fc.media_item_id IS NOT NULL THEN 0 ELSE 1 END,
                m.favorite DESC,
                CASE WHEN a.is_text_heavy = 0 THEN 0 WHEN a.is_text_heavy = 1 THEN 2 ELSE 1 END,
                COALESCE(m.width, 0) * COALESCE(m.height, 0) DESC,
                m.size_bytes DESC,
                m.id
            LIMIT 1
            """,
            [.int(folderID), .int(folder.libraryID), .text(prefix)]
        ).first.flatMap(mediaItem(from:))
    }

    public func folderSubtreeItemCount(folderID: Int64) throws -> Int {
        let folderRow = try db.query("SELECT * FROM folders WHERE id = ?", [.int(folderID)]).first
        guard let folder = folderRow.flatMap(folder(from:)) else { return 0 }
        let row = try db.query(
            """
            SELECT COUNT(*) AS n FROM media_items
            WHERE library_id = ? AND missing = 0
              AND path LIKE ? ESCAPE '\\'
            """,
            [.int(folder.libraryID), .text(escapeLike(folder.path) + "/%")]
        ).first
        return Int(row?.int("n") ?? 0)
    }

    public func setFolderCover(folderID: Int64, mediaItemID: Int64?) throws {
        if let mediaItemID {
            try db.run(
                """
                INSERT INTO folder_covers(folder_id, media_item_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(folder_id) DO UPDATE SET
                    media_item_id = excluded.media_item_id,
                    updated_at = excluded.updated_at
                """,
                [.int(folderID), .int(mediaItemID), .date(Date())]
            )
        } else {
            try db.run("DELETE FROM folder_covers WHERE folder_id = ?", [.int(folderID)])
        }
    }

    public func replaceMediaReferences(libraryID: Int64, references: [MediaReferenceInput]) throws {
        try db.transaction {
            try db.run(
                "DELETE FROM media_references WHERE folder_id IN (SELECT id FROM folders WHERE library_id = ?)",
                [.int(libraryID)]
            )
            for reference in references {
                try db.run(
                    """
                    INSERT OR REPLACE INTO media_references(path, media_item_id, folder_id)
                    SELECT ?, m.id, f.id FROM media_items m, folders f
                    WHERE m.library_id = ? AND m.path = ? AND m.missing = 0
                      AND f.library_id = ? AND f.path = ?
                    """,
                    [.text(reference.path), .int(libraryID), .text(reference.targetPath),
                     .int(libraryID), .text(reference.folderPath)]
                )
            }
        }
    }

    // MARK: - Media items

    /// Batched upsert inside a single transaction. Re-seen items are revived
    /// (missing = 0) and stamped with a fresh last_seen_at.
    public func upsertMediaItems(_ files: [ScannedMediaFile], libraryID: Int64) throws {
        guard !files.isEmpty else { return }
        let now = Date()
        try db.transaction {
            for file in files {
                let existing = try db.query(
                    "SELECT id,content_hash FROM media_items WHERE library_id=? AND path=?",
                    [.int(libraryID), .text(file.path)]
                ).first
                let existingID = existing?.int("id")
                let existingHash = existing?.string("content_hash")
                try db.run(
                    """
                    INSERT INTO media_items (
                        library_id, folder_id, path, filename, extension, media_type,
                        size_bytes, created_at, modified_at, imported_at, last_seen_at,
                        width, height, content_hash, missing
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                    ON CONFLICT (library_id, path) DO UPDATE SET
                        folder_id = excluded.folder_id,
                        size_bytes = excluded.size_bytes,
                        modified_at = excluded.modified_at,
                        last_seen_at = excluded.last_seen_at,
                        width = COALESCE(excluded.width, media_items.width),
                        height = COALESCE(excluded.height, media_items.height),
                        content_hash = CASE
                            WHEN media_items.size_bytes != excluded.size_bytes
                              OR media_items.modified_at IS NOT excluded.modified_at
                            THEN excluded.content_hash
                            ELSE COALESCE(media_items.content_hash, excluded.content_hash)
                        END,
                        missing = CASE WHEN EXISTS (
                            SELECT 1 FROM media_reentry_reviews review
                            WHERE review.media_id=media_items.id
                        ) THEN 1 ELSE 0 END
                    """,
                    [
                        .int(libraryID), .int(file.folderID), .text(file.path),
                        .text(file.filename), .text(file.ext), .text(file.mediaType.rawValue),
                        .int(file.sizeBytes), .date(file.createdAt), .date(file.modifiedAt),
                        .date(now), .date(now),
                        .intOrNull(file.width), .intOrNull(file.height),
                        .textOrNull(file.contentHash),
                    ]
                )
                guard let contentHash = file.contentHash,
                      existingID == nil || existingHash != contentHash,
                      let itemID = try db.query(
                          "SELECT id FROM media_items WHERE library_id=? AND path=?",
                          [.int(libraryID), .text(file.path)]
                      ).first?.int("id") else { continue }
                try db.run(
                    """
                    INSERT OR IGNORE INTO media_reentry_reviews(media_id,content_hash,detected_at)
                    SELECT ?,content_hash,? FROM deleted_media_fingerprints
                    WHERE content_hash=? AND size_bytes=?
                    """,
                    [.int(itemID), .date(now), .text(contentHash), .int(file.sizeBytes)]
                )
                try db.run(
                    "UPDATE media_items SET missing=1 WHERE id=? AND EXISTS (SELECT 1 FROM media_reentry_reviews WHERE media_id=?)",
                    [.int(itemID), .int(itemID)]
                )
            }
        }
    }

    public func mediaScanState(libraryID: Int64) throws -> [String: MediaScanState] {
        Dictionary(uniqueKeysWithValues: try db.query(
            "SELECT path,size_bytes,modified_at FROM media_items WHERE library_id=? AND missing=0",
            [.int(libraryID)]
        ).compactMap { row in
            guard let path = row.string("path"), let size = row.int("size_bytes") else { return nil }
            return (path, MediaScanState(sizeBytes: size, modifiedAt: row.date("modified_at")))
        })
    }

    /// Returns scan metadata only for the paths in the scanner's current
    /// batch. Keeping this lookup bounded prevents rescans from loading one
    /// dictionary entry for every item in a large library.
    public func mediaScanState(libraryID: Int64, paths: [String]) throws -> [String: MediaScanState] {
        guard !paths.isEmpty else { return [:] }
        let placeholders = Array(repeating: "?", count: paths.count).joined(separator: ",")
        let values: [SQLValue] = [.int(libraryID)] + paths.map { .text($0) }
        return Dictionary(uniqueKeysWithValues: try db.query(
            "SELECT path,size_bytes,modified_at FROM media_items WHERE library_id=? AND missing=0 AND path IN (\(placeholders))",
            values
        ).compactMap { row in
            guard let path = row.string("path"), let size = row.int("size_bytes") else { return nil }
            return (path, MediaScanState(sizeBytes: size, modifiedAt: row.date("modified_at")))
        })
    }

    public func deletedFingerprintSizes() throws -> Set<Int64> {
        Set(try db.query("SELECT DISTINCT size_bytes FROM deleted_media_fingerprints")
            .compactMap { $0.int("size_bytes") })
    }

    public func finalizeDeletedMedia(itemID: Int64, contentHash: String) throws {
        try db.transaction {
            guard let item = try db.query(
                "SELECT size_bytes,media_type,filename FROM media_items WHERE id=?",
                [.int(itemID)]
            ).first,
            let mediaType = item.string("media_type"),
            let filename = item.string("filename") else {
                throw DatabaseError(message: "media item not found", code: -1)
            }
            let now = Date()
            try db.run(
                """
                INSERT INTO deleted_media_fingerprints(
                    content_hash,size_bytes,media_type,last_filename,
                    first_deleted_at,last_deleted_at,deletion_count
                ) VALUES(?,?,?,?,?,?,1) ON CONFLICT(content_hash) DO UPDATE SET
                    size_bytes=excluded.size_bytes,
                    media_type=excluded.media_type,
                    last_filename=excluded.last_filename,
                    last_deleted_at=excluded.last_deleted_at,
                    deletion_count=deleted_media_fingerprints.deletion_count+1
                """,
                [
                    .text(contentHash), .int(item.int("size_bytes") ?? 0),
                    .text(mediaType), .text(filename), .date(now), .date(now),
                ]
            )
            try db.run("DELETE FROM media_items WHERE id=?", [.int(itemID)])
        }
    }

    public func updateRecoveryJob(id: String, status: String, errorMessage: String? = nil) throws {
        try db.run(
            "UPDATE media_recovery_jobs SET status=?,error_message=?,updated_at=? WHERE id=?",
            [.text(status), .textOrNull(errorMessage), .date(Date()), .text(id)]
        )
    }

    public func saveRecoverySource(
        itemID: Int64,
        provider: String?,
        sourceURL: String?,
        downloadURL: String?
    ) throws {
        try db.run(
            """
            INSERT INTO media_recovery_sources(media_id,provider,source_url,download_url,updated_at)
            VALUES(?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                provider=COALESCE(media_recovery_sources.provider,excluded.provider),
                source_url=COALESCE(media_recovery_sources.source_url,excluded.source_url),
                download_url=COALESCE(media_recovery_sources.download_url,excluded.download_url),
                updated_at=excluded.updated_at
            """,
            [
                .int(itemID), .textOrNull(provider), .textOrNull(sourceURL),
                .textOrNull(downloadURL), .date(Date()),
            ]
        )
    }

    public func completeRecoveredMedia(itemID: Int64, sizeBytes: Int64, modifiedAt: Date) throws {
        try db.transaction {
            try db.run(
                """
                UPDATE media_items SET size_bytes=?,modified_at=?,content_hash=NULL,
                    width=NULL,height=NULL,duration_seconds=NULL,frame_rate=NULL,thumbnail_path=NULL
                WHERE id=?
                """,
                [.int(sizeBytes), .date(modifiedAt), .int(itemID)]
            )
            for table in [
                "media_text_analysis", "media_semantic_embeddings", "media_visual_hashes",
                "media_face_analysis", "media_face_features", "media_person_analysis",
                "media_secondary_people_analysis", "media_video_fingerprints",
            ] {
                try db.run("DELETE FROM \(table) WHERE media_id=?", [.int(itemID)])
            }
            try db.run(
                "DELETE FROM media_tags WHERE media_item_id=? AND tag_id IN (SELECT id FROM tags WHERE source='vision')",
                [.int(itemID)]
            )
        }
    }

    public func pendingReentryCount() throws -> Int {
        Int(try db.query("SELECT COUNT(*) n FROM media_reentry_reviews").first?.int("n") ?? 0)
    }

    public func approveReentry(itemID: Int64) throws {
        try db.transaction {
            try db.run("UPDATE media_items SET missing=0 WHERE id=? AND EXISTS (SELECT 1 FROM media_reentry_reviews WHERE media_id=?)", [.int(itemID), .int(itemID)])
            try db.run("DELETE FROM media_reentry_reviews WHERE media_id=?", [.int(itemID)])
        }
    }

    public func items(matching query: MediaQuery) throws -> [MediaItemRecord] {
        let (whereSQL, args) = whereClause(for: query)
        let sql = """
            SELECT * FROM media_items WHERE \(whereSQL)
            ORDER BY \(query.sort.sql)
            LIMIT ? OFFSET ?
            """
        return try db.query(sql, args + [.int(Int64(query.limit)), .int(Int64(query.offset))])
            .compactMap(mediaItem(from:))
    }

    public func item(id: Int64) throws -> MediaItemRecord? {
        try db.query("SELECT * FROM media_items WHERE id = ?", [.int(id)]).first.flatMap(mediaItem(from:))
    }

    public func itemCount(matching query: MediaQuery) throws -> Int {
        let (whereSQL, args) = whereClause(for: query)
        let row = try db.query("SELECT COUNT(*) AS n FROM media_items WHERE \(whereSQL)", args).first
        return Int(row?.int("n") ?? 0)
    }

    public func setFavorite(itemID: Int64, isFavorite: Bool) throws {
        try db.run("UPDATE media_items SET favorite = ? WHERE id = ?", [.bool(isFavorite), .int(itemID)])
    }

    public func unanalyzedMedia(modelVersion: String, limit: Int) throws -> [MediaItemRecord] {
        try unanalyzedItems(
            modelVersion: modelVersion,
            limit: limit,
            mediaCondition: "m.media_type IN ('image','video')"
        )
    }

    public func unanalyzedImages(modelVersion: String, limit: Int) throws -> [MediaItemRecord] {
        try unanalyzedItems(
            modelVersion: modelVersion,
            limit: limit,
            mediaCondition: "m.media_type = 'image'"
        )
    }

    private func unanalyzedItems(modelVersion: String, limit: Int, mediaCondition: String) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m
            WHERE m.missing = 0 AND \(mediaCondition)
              AND NOT EXISTS (
                  SELECT 1 FROM media_text_analysis a
                  WHERE a.media_id = m.id AND a.model_version = ?
              )
            ORDER BY CASE WHEN EXISTS (
                SELECT 1 FROM media_face_analysis fa
                WHERE fa.media_id=m.id AND fa.face_count=1
            ) AND (
                m.path LIKE '%/_Profiles/%'
                OR m.path LIKE '%/instagram/%'
                OR m.path LIKE '%/facebook/%'
                OR m.path LIKE '%/threads/%'
                OR m.path LIKE '%/tiktok/%'
                OR EXISTS (
                    SELECT 1 FROM media_references r
                    JOIN folders f ON f.id=r.folder_id
                    WHERE r.media_item_id=m.id AND (
                        f.path LIKE '%/_Profiles/%'
                        OR f.path LIKE '%/instagram/%'
                        OR f.path LIKE '%/facebook/%'
                        OR f.path LIKE '%/threads/%'
                        OR f.path LIKE '%/tiktok/%'
                    )
                )
            ) THEN 0 ELSE 1 END, m.id
            LIMIT ?
            """,
            [.text(modelVersion), .int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func videosMissingMetadata(limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT * FROM media_items
            WHERE missing=0 AND media_type='video'
              AND (width IS NULL OR height IS NULL OR duration_seconds IS NULL OR frame_rate IS NULL)
            ORDER BY id DESC LIMIT ?
            """,
            [.int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func saveVideoMetadata(itemID: Int64, width: Int, height: Int, durationSeconds: Double?, frameRate: Double?) throws {
        try db.run(
            "UPDATE media_items SET width=?,height=?,duration_seconds=?,frame_rate=? WHERE id=?",
            [.int(Int64(width)), .int(Int64(height)), .realOrNull(durationSeconds), .realOrNull(frameRate), .int(itemID)]
        )
    }

    public func unanalyzedMediaCount(modelVersion: String) throws -> Int {
        try unanalyzedItemCount(
            modelVersion: modelVersion,
            mediaCondition: "m.media_type IN ('image','video')"
        )
    }

    public func unanalyzedImageCount(modelVersion: String) throws -> Int {
        try unanalyzedItemCount(
            modelVersion: modelVersion,
            mediaCondition: "m.media_type = 'image'"
        )
    }

    private func unanalyzedItemCount(modelVersion: String, mediaCondition: String) throws -> Int {
        let row = try db.query(
            """
            SELECT COUNT(*) AS n FROM media_items m
            WHERE m.missing = 0 AND \(mediaCondition)
              AND NOT EXISTS (
                  SELECT 1 FROM media_text_analysis a
                  WHERE a.media_id = m.id AND a.model_version = ?
              )
            """,
            [.text(modelVersion)]
        ).first
        return Int(row?.int("n") ?? 0)
    }

    public func imagesMissingPersonAnalysis(limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m
            WHERE m.missing=0 AND m.media_type='image'
              AND NOT EXISTS (SELECT 1 FROM media_person_analysis p WHERE p.media_id=m.id)
            ORDER BY m.id
            LIMIT ?
            """,
            [.int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func imagesNeedingSecondaryPeopleAnalysis(
        modelVersion: String,
        limit: Int
    ) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT DISTINCT m.* FROM media_items m
            JOIN media_person_analysis p ON p.media_id=m.id AND p.person_count=0
            JOIN media_face_analysis f ON f.media_id=m.id AND f.face_count=0
            JOIN media_tags mt ON mt.media_item_id=m.id AND COALESCE(mt.confidence,0)>=0.5
            JOIN tags t ON t.id=mt.tag_id AND t.name='people'
            WHERE m.missing=0 AND m.media_type='image'
              AND NOT EXISTS (
                  SELECT 1 FROM media_secondary_people_analysis s
                  WHERE s.media_id=m.id AND s.model_version=?
              )
            ORDER BY m.id
            LIMIT ?
            """,
            [.text(modelVersion), .int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func itemsMissingThumbnail(limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT * FROM media_items
            WHERE missing=0 AND thumbnail_path IS NULL
            ORDER BY CASE media_type WHEN 'image' THEN 0 ELSE 1 END,id DESC
            LIMIT ?
            """,
            [.int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func imagesMissingAccurateText(modelVersion: String, limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m
            JOIN media_text_analysis a ON a.media_id=m.id
            WHERE m.missing=0 AND m.media_type='image' AND m.size_bytes>0
              AND a.error_message IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM media_ocr_reanalysis r
                  WHERE r.media_id=m.id AND r.model_version=?
                    AND r.source_analyzed_at=a.analyzed_at
              )
            ORDER BY CASE WHEN a.recognized_text LIKE '%card%'
                            OR a.recognized_text LIKE '%visa%'
                            OR a.recognized_text LIKE '%member%' THEN 0
                          WHEN a.observation_count>0 THEN 1 ELSE 2 END,
                     a.is_text_heavy DESC,m.id DESC
            LIMIT ?
            """, [.text(modelVersion), .int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    /// Keep previously recognized lines and append newly recovered text. A failed
    /// upgrade is recorded without replacing the working index or other analyses.
    public func saveAccurateText(itemID: Int64, modelVersion: String, result: TextAnalysisResult) throws {
        try db.transaction {
            guard let previous = try db.query(
                "SELECT recognized_text,analyzed_at FROM media_text_analysis WHERE media_id=?",
                [.int(itemID)]
            ).first else { return }
            if result.errorMessage == nil {
                let oldText = previous.string("recognized_text") ?? ""
                var lines = Set(oldText.components(separatedBy: .newlines))
                let additions = result.recognizedText.components(separatedBy: .newlines)
                    .filter { !$0.isEmpty && lines.insert($0).inserted }
                let merged = ([oldText] + additions).filter { !$0.isEmpty }.joined(separator: "\n")
                try db.run("UPDATE media_text_analysis SET recognized_text=? WHERE media_id=?",
                    [.text(merged), .int(itemID)])
            }
            try db.run(
                """
                INSERT INTO media_ocr_reanalysis
                    (media_id,model_version,source_analyzed_at,analyzed_at,recognized_text,error_message)
                VALUES(?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                    model_version=excluded.model_version,source_analyzed_at=excluded.source_analyzed_at,
                    analyzed_at=excluded.analyzed_at,recognized_text=excluded.recognized_text,
                    error_message=excluded.error_message
                """, [.int(itemID), .text(modelVersion), .real(previous.double("analyzed_at") ?? 0),
                       .date(Date()), .text(result.recognizedText), .textOrNull(result.errorMessage)]
            )
        }
    }

    public func unreadableMedia(limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m
            JOIN media_text_analysis a ON a.media_id=m.id
            WHERE m.missing=0 AND a.error_message IS NOT NULL
            ORDER BY m.id
            LIMIT ?
            """,
            [.int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func saveThumbnailPath(itemID: Int64, path: String) throws {
        try db.run("UPDATE media_items SET thumbnail_path=? WHERE id=?", [.text(path), .int(itemID)])
    }

    public func saveTextAnalysis(
        itemID: Int64,
        modelVersion: String,
        result: TextAnalysisResult
    ) throws {
        try db.run(
            """
            INSERT INTO media_text_analysis (
                media_id, model_version, observation_count, text_area_ratio,
                is_text_heavy, recognized_text, analyzed_at, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                model_version = excluded.model_version,
                observation_count = excluded.observation_count,
                text_area_ratio = excluded.text_area_ratio,
                is_text_heavy = excluded.is_text_heavy,
                recognized_text = excluded.recognized_text,
                analyzed_at = excluded.analyzed_at,
                error_message = excluded.error_message
            """,
            [
                .int(itemID), .text(modelVersion), .int(Int64(result.observationCount)),
                .real(result.textAreaRatio), .bool(result.isTextHeavy),
                .text(result.recognizedText), .date(Date()),
                .textOrNull(result.errorMessage),
            ]
        )
    }

    public func replaceVisionLabels(itemID: Int64, labels: [(name: String, confidence: Double)]) throws {
        try db.transaction {
            try db.run(
                "DELETE FROM media_tags WHERE media_item_id=? AND tag_id IN (SELECT id FROM tags WHERE source='vision')",
                [.int(itemID)]
            )
            for label in labels {
                try db.run(
                    "INSERT INTO tags(name,source,created_at) VALUES(?, 'vision', ?) ON CONFLICT(name) DO NOTHING",
                    [.text(label.name), .date(Date())]
                )
                try db.run(
                    """
                    INSERT OR REPLACE INTO media_tags(media_item_id,tag_id,confidence,created_at)
                    SELECT ?,id,?,? FROM tags WHERE name=?
                    """,
                    [.int(itemID), .real(label.confidence), .date(Date()), .text(label.name)]
                )
            }
        }
    }

    public func saveFaceAnalysis(itemID: Int64, boxesJSON: String, count: Int) throws {
        try db.run(
            """
            INSERT INTO media_face_analysis(media_id,face_count,boxes_json,analyzed_at)
            VALUES(?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
            face_count=excluded.face_count,boxes_json=excluded.boxes_json,analyzed_at=excluded.analyzed_at
            """,
            [.int(itemID), .int(Int64(count)), .text(boxesJSON), .date(Date())]
        )
    }

    public func savePersonAnalysis(itemID: Int64, count: Int) throws {
        try db.run(
            """
            INSERT INTO media_person_analysis(media_id,person_count,analyzed_at)
            VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET
            person_count=excluded.person_count,analyzed_at=excluded.analyzed_at
            """,
            [.int(itemID), .int(Int64(count)), .date(Date())]
        )
    }

    public func mediaMissingQualityAnalysis(modelVersion: String, limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m
            WHERE m.missing=0
              AND (m.media_type='image' OR (
                  m.media_type='video' AND COALESCE(m.duration_seconds,0)>0
                  AND m.duration_seconds<=2.0
              ))
              AND NOT EXISTS (
                  SELECT 1 FROM media_quality_analysis q
                  WHERE q.media_id=m.id AND q.model_version=?
              )
            ORDER BY CASE m.media_type WHEN 'video' THEN 0 ELSE 1 END,m.id
            LIMIT ?
            """,
            [.text(modelVersion), .int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func saveQualityAnalysis(
        itemID: Int64,
        modelVersion: String,
        meanLuma: Double,
        darkFraction: Double,
        lightFraction: Double,
        detailScore: Double,
        motionScore: Double?,
        errorMessage: String? = nil
    ) throws {
        try db.run(
            """
            INSERT INTO media_quality_analysis(
                media_id,model_version,mean_luma,dark_fraction,light_fraction,
                detail_score,motion_score,analyzed_at,error_message
            ) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                model_version=excluded.model_version,
                mean_luma=excluded.mean_luma,
                dark_fraction=excluded.dark_fraction,
                light_fraction=excluded.light_fraction,
                detail_score=excluded.detail_score,
                motion_score=excluded.motion_score,
                analyzed_at=excluded.analyzed_at,
                error_message=excluded.error_message
            """,
            [
                .int(itemID), .text(modelVersion), .real(meanLuma),
                .real(darkFraction), .real(lightFraction), .real(detailScore),
                .realOrNull(motionScore), .date(Date()), .textOrNull(errorMessage),
            ]
        )
    }

    public func saveSecondaryPeopleAnalysis(
        itemID: Int64,
        modelVersion: String,
        personDetected: Bool,
        tokenCount: Int,
        errorMessage: String? = nil
    ) throws {
        try db.run(
            """
            INSERT INTO media_secondary_people_analysis(
                media_id,model_version,person_detected,token_count,analyzed_at,error_message
            ) VALUES(?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
            model_version=excluded.model_version,
            person_detected=excluded.person_detected,
            token_count=excluded.token_count,
            analyzed_at=excluded.analyzed_at,
            error_message=excluded.error_message
            """,
            [
                .int(itemID), .text(modelVersion), .bool(personDetected),
                .int(Int64(tokenCount)), .date(Date()), .textOrNull(errorMessage),
            ]
        )
    }

    public func saveSemanticEmbedding(itemID: Int64, modelVersion: String, embedding: Data) throws {
        try db.run(
            """
            INSERT INTO media_semantic_embeddings(media_id,model_version,embedding_blob,analyzed_at)
            VALUES(?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
            model_version=excluded.model_version,embedding_blob=excluded.embedding_blob,analyzed_at=excluded.analyzed_at
            """,
            [.int(itemID), .text(modelVersion), .blob(embedding), .date(Date())]
        )
    }

    public func hasSemanticEmbedding(itemID: Int64, modelVersion: String) throws -> Bool {
        try db.query(
            """
            SELECT 1 FROM media_semantic_embeddings
            WHERE media_id=? AND model_version=? LIMIT 1
            """,
            [.int(itemID), .text(modelVersion)]
        ).first != nil
    }

    public func semanticEmbeddings(modelVersion: String) throws -> [(mediaID: Int64, blob: Data)] {
        try db.query(
            "SELECT media_id,embedding_blob FROM media_semantic_embeddings WHERE model_version=? ORDER BY media_id",
            [.text(modelVersion)]
        ).compactMap { row in
            guard let mediaID = row.int("media_id"), let blob = row.data("embedding_blob") else { return nil }
            return (mediaID, blob)
        }
    }

    public func semanticEmbeddingSignature(modelVersion: String) throws -> (count: Int, latest: Double) {
        let row = try db.query(
            """
            SELECT COUNT(*) count,COALESCE(MAX(analyzed_at),0) latest
            FROM media_semantic_embeddings WHERE model_version=?
            """,
            [.text(modelVersion)]
        ).first
        return (Int(row?.int("count") ?? 0), row?.double("latest") ?? 0)
    }

    public func ocrMediaIDs(matching query: String, limit: Int = 1_000) throws -> [Int64] {
        try db.query(
            """
            SELECT rowid FROM media_ocr_fts
            WHERE media_ocr_fts MATCH ?
            ORDER BY bm25(media_ocr_fts) LIMIT ?
            """,
            [.text(query), .int(Int64(limit))]
        ).compactMap { $0.int("rowid") }
    }

    public func replaceFaceFeatures(itemID: Int64, personKey: String?, features: [Data]) throws {
        try db.transaction {
            let userAssignments = Dictionary(uniqueKeysWithValues: try db.query(
                "SELECT face_index,person_key FROM media_face_features WHERE media_id=? AND assignment_source='user' AND person_key IS NOT NULL",
                [.int(itemID)]
            ).compactMap { row -> (Int, String)? in
                guard let index = row.int("face_index"), let key = row.string("person_key") else { return nil }
                return (Int(index), key)
            })
            try db.run("DELETE FROM media_face_features WHERE media_id=?", [.int(itemID)])
            for (index, feature) in features.enumerated() {
                let assignedPerson = userAssignments[index] ?? personKey
                let source = userAssignments[index] == nil ? (personKey == nil ? nil : "folder") : "user"
                try db.run(
                    "INSERT INTO media_face_features(media_id,face_index,person_key,feature_blob,assignment_source) VALUES(?,?,?,?,?)",
                    [.int(itemID), .int(Int64(index)), .textOrNull(assignedPerson), .blob(feature), .textOrNull(source)]
                )
            }
        }
    }

    public func seededFaceFeatures(limit: Int) throws -> [FaceFeatureRecord] {
        try db.query(
            """
            WITH canonicalized AS (
                SELECT f.media_id,
                       f.face_index,
                       COALESCE(NULLIF(a.target_key,''),f.person_key) AS canonical_key,
                       f.feature_blob
                FROM media_face_features f
                LEFT JOIN people_aliases a ON a.source_key=f.person_key
                WHERE f.person_key IS NOT NULL AND f.person_key<>''
            ), ranked AS (
                SELECT media_id,face_index,canonical_key,feature_blob,
                       ROW_NUMBER() OVER (
                           PARTITION BY canonical_key
                           ORDER BY ((media_id * 1103515245 + face_index * 12345) & 2147483647)
                       ) AS exemplar_rank
                FROM canonicalized
            )
            SELECT media_id,face_index,canonical_key AS person_key,feature_blob
            FROM ranked
            ORDER BY exemplar_rank,media_id DESC
            LIMIT ?
            """,
            [.int(Int64(limit))]
        ).compactMap(faceFeature(from:))
    }

    public func unassignedFaceFeatureCount() throws -> Int {
        Int(try db.query(
            "SELECT COUNT(*) count FROM media_face_features WHERE person_key IS NULL"
        ).first?.int("count") ?? 0)
    }

    public func unassignedFaceFeatures(limit: Int, offset: Int = 0) throws -> [FaceFeatureRecord] {
        try db.query(
            "SELECT media_id,face_index,person_key,feature_blob FROM media_face_features WHERE person_key IS NULL ORDER BY media_id,face_index LIMIT ? OFFSET ?",
            [.int(Int64(limit)), .int(Int64(offset))]
        ).compactMap(faceFeature(from:))
    }

    /// Reopens only untouched vision-created groups for another clustering
    /// pass. Named people, manual merges, chosen covers, review decisions, and
    /// user-assigned faces remain anchored exactly where the user put them.
    public func reopenMachineFaceGroupsForRegrouping() throws -> Int {
        try db.run(
            """
            UPDATE media_face_features
               SET person_key=NULL,match_distance=NULL,assignment_source=NULL
             WHERE assignment_source='vision'
               AND person_key NOT IN (
                   SELECT source_key FROM people_aliases
                   UNION SELECT target_key FROM people_aliases
                   UNION SELECT person_key FROM people_preferences
                   UNION SELECT person_key FROM media_profile_decisions
               )
            """
        )
        return db.changes
    }

    public func assignFace(mediaID: Int64, faceIndex: Int, personKey: String, distance: Double) throws {
        try db.run(
            "UPDATE media_face_features SET person_key=?,match_distance=?,assignment_source='vision' WHERE media_id=? AND face_index=? AND person_key IS NULL",
            [.text(personKey), .real(distance), .int(mediaID), .int(Int64(faceIndex))]
        )
    }

    public func assignFaces(_ records: [FaceFeatureRecord], personKey: String, distance: Double) throws {
        try db.transaction {
            for record in records {
                try db.run(
                    "UPDATE media_face_features SET person_key=?,match_distance=?,assignment_source='vision' WHERE media_id=? AND face_index=? AND person_key IS NULL",
                    [.text(personKey), .real(distance), .int(record.mediaID), .int(Int64(record.faceIndex))]
                )
            }
        }
    }

    /// Consolidates two identities when vision has independently split the
    /// same person. An untouched machine-created fragment may be absorbed into
    /// one confirmed identity, but two manually managed identities are never
    /// combined automatically. Identities seen together can never be merged.
    public func consolidateVisionPeople(_ firstKey: String, _ secondKey: String) throws -> String? {
        guard firstKey != secondKey,
              firstKey.hasPrefix("person_"), secondKey.hasPrefix("person_") else { return nil }

        return try db.transaction {
            let keys: [SQLValue] = [.text(firstKey), .text(secondKey)]
            let counts = try db.query(
                """
                SELECT person_key,COUNT(*) count,
                       SUM(CASE WHEN assignment_source='vision' THEN 0 ELSE 1 END) protected
                FROM media_face_features
                WHERE person_key IN (?,?)
                GROUP BY person_key
                """,
                keys
            )
            guard counts.count == 2,
                  counts.allSatisfy({ ($0.int("count") ?? 0) >= 2 }) else {
                return nil
            }

            func hasManualState(_ key: String) throws -> Bool {
                try db.query(
                    """
                    SELECT 1 found FROM people_aliases WHERE source_key=? OR target_key=?
                    UNION ALL
                    SELECT 1 FROM people_preferences WHERE person_key=?
                    UNION ALL
                    SELECT 1 FROM media_profile_decisions WHERE person_key=?
                    LIMIT 1
                    """,
                    [.text(key), .text(key), .text(key), .text(key)]
                ).isEmpty == false
            }
            let firstHasManualState = try hasManualState(firstKey)
            let secondHasManualState = try hasManualState(secondKey)
            guard !(firstHasManualState && secondHasManualState) else { return nil }

            let cooccurs = try db.query(
                """
                SELECT 1 found
                FROM media_face_features a
                JOIN media_face_features b ON b.media_id=a.media_id
                WHERE a.person_key=? AND b.person_key=?
                LIMIT 1
                """,
                [.text(firstKey), .text(secondKey)]
            ).isEmpty == false
            guard !cooccurs else { return nil }

            let countByKey = Dictionary(uniqueKeysWithValues: counts.compactMap { row -> (String, Int64)? in
                guard let key = row.string("person_key"), let count = row.int("count") else { return nil }
                return (key, count)
            })
            let target: String
            let source: String
            if firstHasManualState {
                target = firstKey; source = secondKey
            } else if secondHasManualState {
                target = secondKey; source = firstKey
            } else if (countByKey[firstKey] ?? 0) >= (countByKey[secondKey] ?? 0) {
                target = firstKey; source = secondKey
            } else {
                target = secondKey; source = firstKey
            }
            let sourceIsMachineOnly = counts.first { $0.string("person_key") == source }
                .map { ($0.int("protected") ?? 0) == 0 } ?? false
            guard sourceIsMachineOnly else { return nil }
            try db.run(
                "UPDATE media_face_features SET person_key=? WHERE person_key=? AND assignment_source='vision'",
                [.text(target), .text(source)]
            )

            let hasPeopleMedia = try db.query(
                "SELECT 1 found FROM sqlite_master WHERE type='table' AND name='people_media' LIMIT 1"
            ).isEmpty == false
            if hasPeopleMedia {
                try db.run(
                    "INSERT OR IGNORE INTO people_media(person_key,media_id) SELECT ?,media_id FROM people_media WHERE person_key=?",
                    [.text(target), .text(source)]
                )
                try db.run("DELETE FROM people_media WHERE person_key=?", [.text(source)])
            }
            return target
        }
    }

    private func faceFeature(from row: Row) -> FaceFeatureRecord? {
        guard let mediaID = row.int("media_id"), let index = row.int("face_index"), let blob = row.data("feature_blob") else { return nil }
        return FaceFeatureRecord(mediaID: mediaID, faceIndex: Int(index), personKey: row.string("person_key"), blob: blob)
    }

    public func unhashedDuplicateCandidates(limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m
            WHERE m.missing=0 AND m.content_hash IS NULL AND m.size_bytes>0
              AND m.size_bytes IN (
                SELECT size_bytes FROM media_items WHERE missing=0 AND size_bytes>0
                GROUP BY size_bytes HAVING COUNT(*)>1
              )
            ORDER BY CASE WHEN EXISTS (
                SELECT 1 FROM media_items peer
                JOIN media_visual_hashes own_visual ON own_visual.media_id=m.id
                JOIN media_visual_hashes peer_visual ON peer_visual.media_id=peer.id
                WHERE peer.id<>m.id AND peer.missing=0
                  AND peer.size_bytes=m.size_bytes
                  AND COALESCE(peer.width,0)=COALESCE(m.width,0)
                  AND COALESCE(peer.height,0)=COALESCE(m.height,0)
                  AND peer_visual.dhash=own_visual.dhash
            ) THEN 0 ELSE 1 END,
            m.size_bytes,m.id LIMIT ?
            """,
            [.int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func saveContentHash(itemID: Int64, hash: String) throws {
        try db.run("UPDATE media_items SET content_hash=? WHERE id=?", [.text(hash), .int(itemID)])
    }

    public func unhashedVisualImages(limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m WHERE m.missing=0 AND m.media_type='image'
              AND NOT EXISTS (SELECT 1 FROM media_visual_hashes v WHERE v.media_id=m.id)
            ORDER BY m.id LIMIT ?
            """, [.int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func saveVisualHash(itemID: Int64, hash: String) throws {
        try db.run(
            "INSERT OR REPLACE INTO media_visual_hashes(media_id,dhash,analyzed_at) VALUES(?,?,?)",
            [.int(itemID), .text(hash), .date(Date())]
        )
    }

    public func videosMissingFingerprint(
        modelVersion: String,
        limit: Int,
        retryFailuresAfter retryInterval: TimeInterval = 6 * 60 * 60
    ) throws -> [MediaItemRecord] {
        let retryCutoff = Date().addingTimeInterval(-max(0, retryInterval))
        return try db.query(
            """
            SELECT m.* FROM media_items m
            WHERE m.missing=0 AND m.media_type='video'
              AND COALESCE(m.duration_seconds,0)>0
              AND NOT EXISTS (
                SELECT 1 FROM media_video_fingerprints f
                WHERE f.media_id=m.id AND f.model_version=?
                  AND (f.error_message IS NULL OR f.analyzed_at>?)
              )
            ORDER BY m.id LIMIT ?
            """,
            [.text(modelVersion), .date(retryCutoff), .int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func saveVideoFingerprint(
        itemID: Int64,
        modelVersion: String,
        durationSeconds: Double,
        samplesJSON: String,
        errorMessage: String? = nil
    ) throws {
        try db.run(
            """
            INSERT INTO media_video_fingerprints(
                media_id,model_version,duration_seconds,samples_json,analyzed_at,error_message
            ) VALUES(?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                model_version=excluded.model_version,
                duration_seconds=excluded.duration_seconds,
                samples_json=excluded.samples_json,
                analyzed_at=excluded.analyzed_at,
                error_message=excluded.error_message
            """,
            [
                .int(itemID), .text(modelVersion), .real(durationSeconds),
                .text(samplesJSON), .date(Date()), .textOrNull(errorMessage),
            ]
        )
    }

    public func areExactDuplicates(_ firstID: Int64, _ secondID: Int64) throws -> Bool {
        let rows = try db.query(
            "SELECT content_hash FROM media_items WHERE id IN (?,?) AND content_hash IS NOT NULL",
            [.int(firstID), .int(secondID)]
        )
        return rows.count == 2 && rows[0].string("content_hash") == rows[1].string("content_hash")
    }

    public func consolidateExactDuplicate(
        keepID: Int64,
        removeID: Int64,
        preservedReferences: [(path: String, folderID: Int64)]
    ) throws {
        try db.transaction {
            try db.run("DELETE FROM media_references WHERE media_item_id=?", [.int(removeID)])
            for reference in preservedReferences {
                try db.run(
                    "INSERT OR REPLACE INTO media_references(path,media_item_id,folder_id) VALUES(?,?,?)",
                    [.text(reference.path), .int(keepID), .int(reference.folderID)]
                )
            }
            try db.run("DELETE FROM media_items WHERE id=?", [.int(removeID)])
        }
    }

    public func expiredTrashItems(before cutoff: Date, limit: Int) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT m.* FROM media_items m JOIN media_curation c ON c.media_id=m.id
            WHERE m.missing=0 AND c.trashed_at IS NOT NULL AND c.trashed_at <= ?
            ORDER BY c.trashed_at LIMIT ?
            """,
            [.date(cutoff), .int(Int64(limit))]
        ).compactMap(mediaItem(from:))
    }

    public func referencePaths(itemID: Int64) throws -> [String] {
        try db.query("SELECT path FROM media_references WHERE media_item_id=?", [.int(itemID)])
            .compactMap { $0.string("path") }
    }

    public func referenceLocations(itemID: Int64) throws -> [(path: String, folderID: Int64)] {
        try db.query(
            "SELECT path,folder_id FROM media_references WHERE media_item_id=?",
            [.int(itemID)]
        ).compactMap { row in
            guard let path = row.string("path"), let folderID = row.int("folder_id") else { return nil }
            return (path, folderID)
        }
    }

    public func exactIdentityItems(itemID: Int64) throws -> [MediaItemRecord] {
        try db.query(
            """
            SELECT peer.* FROM media_items selected JOIN media_items peer
              ON peer.content_hash=selected.content_hash
            WHERE selected.id=? AND selected.content_hash IS NOT NULL
            ORDER BY peer.id
            """,
            [.int(itemID)]
        ).compactMap(mediaItem(from:))
    }

    public func deleteMediaRecord(itemID: Int64) throws {
        try db.run("DELETE FROM media_items WHERE id=?", [.int(itemID)])
    }

    /// Marks items not re-seen by the current scan as missing. Rows are kept
    /// so favorites/collections survive a temporarily unplugged drive.
    public func markItemsMissing(libraryID: Int64, notSeenSince cutoff: Date) throws -> Int {
        try db.run(
            """
            UPDATE media_items SET missing = 1
            WHERE library_id = ? AND missing = 0
              AND (last_seen_at IS NULL OR last_seen_at < ?)
            """,
            [.int(libraryID), .date(cutoff)]
        )
        return db.changes
    }

    public func recomputeFolderItemCounts(libraryID: Int64) throws {
        try db.run(
            """
            UPDATE folders SET item_count = (
                SELECT COUNT(*) FROM media_items
                WHERE media_items.folder_id = folders.id AND media_items.missing = 0
            )
            WHERE library_id = ?
            """,
            [.int(libraryID)]
        )
    }

    // MARK: - Collections

    public func createCollection(name: String) throws -> CollectionRecord {
        let now = Date()
        try db.run(
            "INSERT INTO collections (name, created_at, updated_at) VALUES (?, ?, ?)",
            [.text(name), .date(now), .date(now)]
        )
        return CollectionRecord(id: db.lastInsertRowID, name: name, createdAt: now, updatedAt: now)
    }

    public func allCollections() throws -> [CollectionRecord] {
        try db.query(
            """
            SELECT c.*,
                   (SELECT COUNT(*) FROM collection_items ci
                    JOIN media_items mi ON mi.id = ci.media_item_id
                    WHERE ci.collection_id = c.id AND mi.missing = 0) AS item_count
            FROM collections c
            ORDER BY c.name COLLATE NOCASE
            """
        ).compactMap(collection(from:))
    }

    public func renameCollection(id: Int64, name: String) throws {
        try db.run(
            "UPDATE collections SET name = ?, updated_at = ? WHERE id = ?",
            [.text(name), .date(Date()), .int(id)]
        )
    }

    /// Deletes the collection only; member media items are untouched.
    public func deleteCollection(id: Int64) throws {
        try db.run("DELETE FROM collections WHERE id = ?", [.int(id)])
    }

    public func addItems(_ itemIDs: [Int64], toCollection collectionID: Int64) throws {
        guard !itemIDs.isEmpty else { return }
        let now = Date()
        try db.transaction {
            for itemID in itemIDs {
                try db.run(
                    "INSERT OR IGNORE INTO collection_items (collection_id, media_item_id, added_at) VALUES (?, ?, ?)",
                    [.int(collectionID), .int(itemID), .date(now)]
                )
            }
            try db.run("UPDATE collections SET updated_at = ? WHERE id = ?", [.date(now), .int(collectionID)])
        }
    }

    public func removeItem(_ itemID: Int64, fromCollection collectionID: Int64) throws {
        try db.run(
            "DELETE FROM collection_items WHERE collection_id = ? AND media_item_id = ?",
            [.int(collectionID), .int(itemID)]
        )
    }

    // MARK: - Scan jobs

    public func createScanJob(libraryID: Int64) throws -> Int64 {
        try db.run(
            "INSERT INTO scan_jobs (library_id, status, started_at) VALUES (?, 'running', ?)",
            [.int(libraryID), .date(Date())]
        )
        return db.lastInsertRowID
    }

    public func updateScanJobProgress(id: Int64, progress: Double) throws {
        try db.run("UPDATE scan_jobs SET progress = ? WHERE id = ?", [.real(progress), .int(id)])
    }

    public func finishScanJob(id: Int64, status: String, errorMessage: String?) throws {
        try db.run(
            "UPDATE scan_jobs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?",
            [.text(status), .date(Date()), .textOrNull(errorMessage), .int(id)]
        )
    }

    // MARK: - Row mapping

    private func library(from row: Row) -> LibraryRecord? {
        guard let id = row.int("id"),
              let name = row.string("name"),
              let rootPath = row.string("root_path") else { return nil }
        return LibraryRecord(
            id: id,
            name: name,
            rootPath: rootPath,
            bookmarkData: row.data("bookmark_data"),
            createdAt: row.date("created_at") ?? Date(),
            updatedAt: row.date("updated_at") ?? Date(),
            lastScannedAt: row.date("last_scanned_at"),
            scanStatus: row.string("scan_status") ?? "idle"
        )
    }

    private func folder(from row: Row) -> FolderRecord? {
        guard let id = row.int("id"),
              let libraryID = row.int("library_id"),
              let path = row.string("path"),
              let name = row.string("name") else { return nil }
        return FolderRecord(
            id: id,
            libraryID: libraryID,
            path: path,
            parentPath: row.string("parent_path"),
            name: name,
            itemCount: Int(row.int("item_count") ?? 0)
        )
    }

    private func collection(from row: Row) -> CollectionRecord? {
        guard let id = row.int("id"), let name = row.string("name") else { return nil }
        return CollectionRecord(
            id: id,
            name: name,
            details: row.string("description"),
            coverItemID: row.int("cover_item_id"),
            createdAt: row.date("created_at") ?? Date(),
            updatedAt: row.date("updated_at") ?? Date(),
            itemCount: Int(row.int("item_count") ?? 0)
        )
    }

    private func mediaItem(from row: Row) -> MediaItemRecord? {
        guard let id = row.int("id"),
              let libraryID = row.int("library_id"),
              let folderID = row.int("folder_id"),
              let path = row.string("path"),
              let filename = row.string("filename"),
              let typeRaw = row.string("media_type"),
              let mediaType = MediaType(rawValue: typeRaw) else { return nil }
        return MediaItemRecord(
            id: id,
            libraryID: libraryID,
            folderID: folderID,
            path: path,
            filename: filename,
            ext: row.string("extension") ?? "",
            mediaType: mediaType,
            sizeBytes: row.int("size_bytes") ?? 0,
            createdAt: row.date("created_at"),
            modifiedAt: row.date("modified_at"),
            importedAt: row.date("imported_at") ?? Date(),
            width: row.int("width").map(Int.init),
            height: row.int("height").map(Int.init),
            durationSeconds: row.double("duration_seconds"),
            thumbnailPath: row.string("thumbnail_path"),
            favorite: row.bool("favorite"),
            missing: row.bool("missing"),
            contentHash: row.string("content_hash")
        )
    }

    private func whereClause(for query: MediaQuery) -> (String, [SQLValue]) {
        var conditions: [String] = []
        var args: [SQLValue] = []
        if !query.includeMissing {
            conditions.append("missing = 0")
        }
        if let libraryID = query.libraryID {
            conditions.append("library_id = ?")
            args.append(.int(libraryID))
        }
        if let folderID = query.folderID {
            conditions.append("folder_id = ?")
            args.append(.int(folderID))
        }
        if let subtreePath = query.folderSubtreePath {
            // Trailing separator keeps /a/b from matching /a/bc/x.
            conditions.append("path LIKE ? ESCAPE '\\'")
            args.append(.text(escapeLike(subtreePath) + "/%"))
        }
        if let collectionID = query.collectionID {
            conditions.append("id IN (SELECT media_item_id FROM collection_items WHERE collection_id = ?)")
            args.append(.int(collectionID))
        }
        if let mediaType = query.mediaType {
            conditions.append("media_type = ?")
            args.append(.text(mediaType.rawValue))
        }
        if query.favoritesOnly {
            conditions.append("favorite = 1")
        }
        switch query.aiContentFilter {
        case .all:
            break
        case .textHeavy:
            conditions.append("id IN (SELECT media_id FROM media_text_analysis WHERE is_text_heavy = 1)")
        case .other:
            conditions.append("id IN (SELECT media_id FROM media_text_analysis WHERE is_text_heavy = 0 AND error_message IS NULL)")
        case .unanalyzed:
            conditions.append("media_type = 'image' AND id NOT IN (SELECT media_id FROM media_text_analysis)")
        }
        if let search = query.searchText, !search.isEmpty {
            let pattern = "%" + escapeLike(search) + "%"
            conditions.append("(filename LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')")
            args.append(.text(pattern))
            args.append(.text(pattern))
        }
        let whereSQL = conditions.isEmpty ? "1 = 1" : conditions.joined(separator: " AND ")
        return (whereSQL, args)
    }

    private func escapeLike(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
    }
}

public struct MediaReferenceInput: Sendable {
    public let path: String
    public let targetPath: String
    public let folderPath: String

    public init(path: String, targetPath: String, folderPath: String) {
        self.path = path
        self.targetPath = targetPath
        self.folderPath = folderPath
    }
}
