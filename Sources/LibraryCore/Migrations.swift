import Foundation

/// Versioned schema migrations driven by SQLite's `user_version` pragma.
/// New milestones append migrations; existing ones are never edited.
enum Migrations {
    static func migrate(_ db: Database) throws {
        let version = try db.query("PRAGMA user_version").first?.int("user_version") ?? 0
        if version < 1 {
            try db.transaction {
                try db.execute(schemaV1)
                try db.execute("PRAGMA user_version = 1")
            }
        }
        if version < 2 {
            try db.transaction {
                try db.execute(schemaV2)
                try db.execute("PRAGMA user_version = 2")
            }
        }
        if version < 3 {
            try db.transaction {
                try db.execute(schemaV3)
                try db.execute("PRAGMA user_version = 3")
            }
        }
        if version < 4 {
            try db.transaction {
                try db.execute(schemaV4)
                try db.execute("PRAGMA user_version = 4")
            }
        }
        if version < 5 {
            try db.transaction {
                try db.execute(schemaV5)
                try db.execute("PRAGMA user_version = 5")
            }
        }
        if version < 6 {
            try db.transaction {
                try db.execute(schemaV6)
                try db.execute("PRAGMA user_version = 6")
            }
        }
        if version < 7 {
            try db.transaction {
                try db.execute(schemaV7)
                try db.execute("PRAGMA user_version = 7")
            }
        }
        if version < 8 {
            try db.transaction {
                try db.execute(schemaV8)
                try db.execute("PRAGMA user_version = 8")
            }
        }
        if version < 9 {
            try db.transaction {
                try db.execute(schemaV9)
                try db.execute("PRAGMA user_version = 9")
            }
        }
        if version < 10 {
            try db.transaction {
                try db.execute(schemaV10)
                try db.execute("PRAGMA user_version = 10")
            }
        }
        if version < 11 {
            try db.transaction {
                try db.execute(schemaV11)
                try db.execute("PRAGMA user_version = 11")
            }
        }
        if version < 12 {
            try db.transaction {
                try db.execute(schemaV12)
                try db.execute("PRAGMA user_version = 12")
            }
        }
        if version < 13 {
            try db.transaction {
                try db.execute(schemaV13)
                try db.execute("PRAGMA user_version = 13")
            }
        }
        if version < 14 {
            try db.transaction {
                try db.execute(schemaV14)
                try db.execute("PRAGMA user_version = 14")
            }
        }
        if version < 15 {
            try db.transaction {
                try db.execute(schemaV15)
                try db.execute("PRAGMA user_version = 15")
            }
        }
        if version < 16 {
            try db.transaction {
                try db.execute(schemaV16)
                try db.execute("PRAGMA user_version = 16")
            }
        }
        if version < 17 {
            try db.transaction {
                try db.execute(schemaV17)
                try db.execute("PRAGMA user_version = 17")
            }
        }
        if version < 18 {
            try db.transaction {
                try db.execute(schemaV18)
                try db.execute("PRAGMA user_version = 18")
            }
        }
        if version < 19 {
            try db.transaction {
                try db.execute(schemaV19)
                try db.execute("PRAGMA user_version = 19")
            }
        }
        if version < 20 {
            try db.transaction {
                try db.execute(schemaV20)
                try db.execute("PRAGMA user_version = 20")
            }
        }
        if version < 21 {
            try db.transaction {
                try db.execute(schemaV21)
                try db.execute("PRAGMA user_version = 21")
            }
        }
        if version < 22 {
            try db.transaction {
                try db.execute(schemaV22)
                try db.execute("PRAGMA user_version = 22")
            }
        }
        if version < 23 {
            try db.transaction {
                try db.execute(schemaV23)
                try db.execute("PRAGMA user_version = 23")
            }
        }
        if version < 24 {
            try db.transaction {
                try db.execute(schemaV24)
                try db.execute("PRAGMA user_version = 24")
            }
        }
        if version < 25 {
            try db.transaction {
                try db.execute(schemaV25)
                try db.execute("PRAGMA user_version = 25")
            }
        }
        if version < 26 {
            try db.transaction {
                try db.execute(schemaV26)
                try db.execute("PRAGMA user_version = 26")
            }
        }
        if version < 27 {
            try db.transaction {
                try db.execute(schemaV27)
                try db.execute("PRAGMA user_version = 27")
            }
        }
        if version < 28 {
            try db.transaction {
                try db.execute(schemaV28)
                try db.execute("PRAGMA user_version = 28")
            }
        }
        if version < 29 {
            try db.transaction {
                try db.execute(schemaV29)
                try db.execute("PRAGMA user_version = 29")
            }
        }
    }

    /// v1: full MVP schema. Tables for later milestones (collections, tags)
    /// are created up front so those milestones are purely additive.
    private static let schemaV1 = """
    CREATE TABLE libraries (
        id              INTEGER PRIMARY KEY,
        name            TEXT NOT NULL,
        root_path       TEXT NOT NULL UNIQUE,
        bookmark_data   BLOB,
        created_at      REAL NOT NULL,
        updated_at      REAL NOT NULL,
        last_scanned_at REAL,
        scan_status     TEXT NOT NULL DEFAULT 'idle'
    );

    CREATE TABLE folders (
        id              INTEGER PRIMARY KEY,
        library_id      INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        path            TEXT NOT NULL,
        parent_path     TEXT,
        name            TEXT NOT NULL,
        item_count      INTEGER NOT NULL DEFAULT 0,
        created_at      REAL NOT NULL,
        updated_at      REAL NOT NULL,
        last_scanned_at REAL,
        UNIQUE (library_id, path)
    );

    CREATE TABLE media_items (
        id               INTEGER PRIMARY KEY,
        library_id       INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        folder_id        INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        path             TEXT NOT NULL,
        filename         TEXT NOT NULL,
        extension        TEXT NOT NULL,
        media_type       TEXT NOT NULL,
        size_bytes       INTEGER NOT NULL DEFAULT 0,
        created_at       REAL,
        modified_at      REAL,
        imported_at      REAL NOT NULL,
        last_seen_at     REAL,
        width            INTEGER,
        height           INTEGER,
        duration_seconds REAL,
        thumbnail_path   TEXT,
        content_hash     TEXT,
        favorite         INTEGER NOT NULL DEFAULT 0,
        missing          INTEGER NOT NULL DEFAULT 0,
        metadata_json    TEXT,
        UNIQUE (library_id, path)
    );

    CREATE TABLE collections (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        cover_item_id INTEGER REFERENCES media_items(id) ON DELETE SET NULL,
        created_at    REAL NOT NULL,
        updated_at    REAL NOT NULL
    );

    CREATE TABLE collection_items (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        added_at      REAL NOT NULL,
        PRIMARY KEY (collection_id, media_item_id)
    );

    CREATE TABLE tags (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        source     TEXT NOT NULL DEFAULT 'user',
        created_at REAL NOT NULL
    );

    CREATE TABLE media_tags (
        media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        confidence    REAL,
        created_at    REAL NOT NULL,
        PRIMARY KEY (media_item_id, tag_id)
    );

    CREATE TABLE scan_jobs (
        id            INTEGER PRIMARY KEY,
        library_id    INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        status        TEXT NOT NULL DEFAULT 'running',
        progress      REAL NOT NULL DEFAULT 0,
        started_at    REAL NOT NULL,
        finished_at   REAL,
        error_message TEXT
    );

    CREATE INDEX idx_media_library_missing ON media_items(library_id, missing);
    CREATE INDEX idx_media_folder          ON media_items(folder_id);
    CREATE INDEX idx_media_type            ON media_items(media_type);
    CREATE INDEX idx_media_favorite        ON media_items(favorite);
    CREATE INDEX idx_media_filename        ON media_items(filename COLLATE NOCASE);
    CREATE INDEX idx_media_added           ON media_items(imported_at DESC);
    CREATE INDEX idx_media_taken           ON media_items(created_at);
    CREATE INDEX idx_folders_library       ON folders(library_id);
    CREATE INDEX idx_folders_parent        ON folders(library_id, parent_path);
    CREATE INDEX idx_collection_items_item ON collection_items(media_item_id);
    CREATE INDEX idx_media_tags_tag        ON media_tags(tag_id);
    CREATE INDEX idx_scan_jobs_library     ON scan_jobs(library_id, status);
    """

    private static let schemaV2 = """
    CREATE TABLE media_text_analysis (
        media_id          INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        model_version     TEXT NOT NULL,
        observation_count INTEGER NOT NULL,
        text_area_ratio   REAL NOT NULL,
        is_text_heavy     INTEGER NOT NULL,
        analyzed_at       REAL NOT NULL,
        error_message     TEXT
    );
    CREATE INDEX idx_text_analysis_filter
        ON media_text_analysis(model_version, is_text_heavy, media_id);
    """

    private static let schemaV3 = """
    CREATE TABLE folder_covers (
        folder_id     INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
        media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        updated_at    REAL NOT NULL
    );
    CREATE INDEX idx_folder_covers_media ON folder_covers(media_item_id);
    CREATE INDEX idx_media_library_path ON media_items(library_id, path);
    """

    private static let schemaV4 = """
    CREATE TABLE IF NOT EXISTS media_references (
        path          TEXT PRIMARY KEY,
        media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        folder_id     INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_media_references_folder ON media_references(folder_id);
    CREATE INDEX IF NOT EXISTS idx_media_references_media ON media_references(media_item_id);
    """

    private static let schemaV5 = """
    CREATE TABLE IF NOT EXISTS media_curation (
        media_id    INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        disposition TEXT CHECK(disposition IN ('keep','remove')),
        trashed_at  REAL,
        updated_at  REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_curation_disposition
        ON media_curation(disposition,trashed_at);
    """

    private static let schemaV6 = """
    CREATE TABLE IF NOT EXISTS media_face_analysis (
        media_id    INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        face_count  INTEGER NOT NULL,
        boxes_json  TEXT NOT NULL,
        analyzed_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_face_count ON media_face_analysis(face_count,media_id);
    """

    private static let schemaV7 = """
    CREATE TABLE IF NOT EXISTS media_visual_hashes (
        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        dhash TEXT NOT NULL,
        analyzed_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visual_hash ON media_visual_hashes(dhash);
    """

    private static let schemaV8 = """
    CREATE TABLE IF NOT EXISTS media_face_features (
        media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        face_index INTEGER NOT NULL,
        person_key TEXT,
        feature_blob BLOB NOT NULL,
        PRIMARY KEY(media_id,face_index)
    );
    CREATE INDEX IF NOT EXISTS idx_face_features_person ON media_face_features(person_key);
    """

    private static let schemaV9 = """
    ALTER TABLE media_face_features ADD COLUMN match_distance REAL;
    ALTER TABLE media_face_features ADD COLUMN assignment_source TEXT;
    UPDATE media_face_features SET assignment_source='folder' WHERE person_key IS NOT NULL;
    """

    private static let schemaV10 = """
    UPDATE media_face_features
       SET person_key=NULL, match_distance=NULL, assignment_source=NULL
     WHERE assignment_source='folder'
       AND media_id IN (SELECT media_id FROM media_face_analysis WHERE face_count != 1);
    """

    private static let schemaV11 = """
    CREATE INDEX IF NOT EXISTS idx_media_dimensions
        ON media_items(media_type,missing,width,height,id);
    CREATE INDEX IF NOT EXISTS idx_face_features_person_media
        ON media_face_features(person_key,media_id);
    """

    private static let schemaV12 = """
    DELETE FROM media_face_features WHERE assignment_source IS NULL OR assignment_source != 'user';
    """

    private static let schemaV13 = """
    DELETE FROM media_face_features WHERE assignment_source IS NULL OR assignment_source != 'user';
    """

    private static let schemaV14 = """
    CREATE TABLE IF NOT EXISTS media_semantic_embeddings (
        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        model_version TEXT NOT NULL,
        embedding_blob BLOB NOT NULL,
        analyzed_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_model ON media_semantic_embeddings(model_version,media_id);
    """

    private static let schemaV15 = """
    CREATE TABLE IF NOT EXISTS media_person_analysis (
        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        person_count INTEGER NOT NULL,
        analyzed_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_person_count
        ON media_person_analysis(person_count,media_id);
    """

    private static let schemaV16 = """
    ALTER TABLE media_items ADD COLUMN frame_rate REAL;
    CREATE INDEX IF NOT EXISTS idx_media_video_frame_rate
        ON media_items(media_type,missing,frame_rate,id);
    """

    private static let schemaV17 = """
    CREATE TABLE IF NOT EXISTS media_secondary_people_analysis (
        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        model_version TEXT NOT NULL,
        person_detected INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        analyzed_at REAL NOT NULL,
        error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_secondary_people_result
        ON media_secondary_people_analysis(model_version,person_detected,media_id);
    """

    private static let schemaV18 = """
    CREATE TABLE IF NOT EXISTS deleted_media_fingerprints (
        content_hash TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        last_filename TEXT NOT NULL,
        first_deleted_at REAL NOT NULL,
        last_deleted_at REAL NOT NULL,
        deletion_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_media_size
        ON deleted_media_fingerprints(size_bytes,content_hash);
    CREATE TABLE IF NOT EXISTS media_reentry_reviews (
        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL REFERENCES deleted_media_fingerprints(content_hash),
        detected_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_reentry_detected
        ON media_reentry_reviews(detected_at,media_id);
    """

    private static let schemaV19 = """
    CREATE TABLE IF NOT EXISTS media_recovery_sources (
        media_id     INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        provider     TEXT,
        source_url   TEXT,
        download_url TEXT,
        updated_at   REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_recovery_jobs (
        id            TEXT PRIMARY KEY,
        media_id      INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        status        TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        error_message TEXT,
        created_at    REAL NOT NULL,
        updated_at    REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_recovery_jobs_item
        ON media_recovery_jobs(media_id,updated_at DESC);
    """

    private static let schemaV20 = """
    CREATE TABLE IF NOT EXISTS media_similarity_reviews (
        left_media_id  INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        right_media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        decision       TEXT NOT NULL CHECK(decision='not_duplicate'),
        updated_at     REAL NOT NULL,
        PRIMARY KEY(left_media_id,right_media_id),
        CHECK(left_media_id<right_media_id)
    );
    """

    private static let schemaV21 = """
    CREATE TABLE IF NOT EXISTS media_cleanup_events (
        id              TEXT PRIMARY KEY,
        event_type      TEXT NOT NULL,
        group_kind      TEXT NOT NULL,
        item_count      INTEGER NOT NULL,
        estimated_bytes INTEGER NOT NULL,
        created_at      REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_cleanup_events_created
        ON media_cleanup_events(created_at);
    CREATE TABLE IF NOT EXISTS media_video_fingerprints (
        media_id         INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        model_version    TEXT NOT NULL,
        duration_seconds REAL NOT NULL,
        samples_json     TEXT NOT NULL,
        analyzed_at      REAL NOT NULL,
        error_message    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_video_fingerprint_model
        ON media_video_fingerprints(model_version,media_id);
    """

    private static let schemaV22 = """
    CREATE TABLE IF NOT EXISTS media_quality_analysis (
        media_id       INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        model_version  TEXT NOT NULL,
        mean_luma      REAL NOT NULL,
        dark_fraction  REAL NOT NULL,
        light_fraction REAL NOT NULL,
        detail_score   REAL NOT NULL,
        motion_score   REAL,
        analyzed_at    REAL NOT NULL,
        error_message  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_media_quality_model
        ON media_quality_analysis(model_version,media_id);
    CREATE INDEX IF NOT EXISTS idx_media_quality_signals
        ON media_quality_analysis(dark_fraction,light_fraction,detail_score,media_id);
    """

    private static let schemaV23 = """
    ALTER TABLE media_text_analysis
        ADD COLUMN recognized_text TEXT NOT NULL DEFAULT '';
    CREATE VIRTUAL TABLE media_ocr_fts USING fts5(
        recognized_text,
        content='media_text_analysis',
        content_rowid='media_id',
        tokenize='unicode61 remove_diacritics 2'
    );
    INSERT INTO media_ocr_fts(rowid,recognized_text)
        SELECT media_id,recognized_text FROM media_text_analysis;
    CREATE TRIGGER media_ocr_fts_insert AFTER INSERT ON media_text_analysis BEGIN
        INSERT INTO media_ocr_fts(rowid,recognized_text)
        VALUES(new.media_id,new.recognized_text);
    END;
    CREATE TRIGGER media_ocr_fts_delete AFTER DELETE ON media_text_analysis BEGIN
        INSERT INTO media_ocr_fts(media_ocr_fts,rowid,recognized_text)
        VALUES('delete',old.media_id,old.recognized_text);
    END;
    CREATE TRIGGER media_ocr_fts_update AFTER UPDATE OF recognized_text ON media_text_analysis BEGIN
        INSERT INTO media_ocr_fts(media_ocr_fts,rowid,recognized_text)
        VALUES('delete',old.media_id,old.recognized_text);
        INSERT INTO media_ocr_fts(rowid,recognized_text)
        VALUES(new.media_id,new.recognized_text);
    END;
    """

    private static let schemaV24 = """
    CREATE INDEX IF NOT EXISTS idx_semantic_embedding_model_updated
        ON media_semantic_embeddings(model_version,analyzed_at DESC);
    """

    private static let schemaV25 = """
    CREATE TABLE IF NOT EXISTS media_profile_decisions (
        media_id   INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
        person_key TEXT NOT NULL,
        decision   TEXT NOT NULL CHECK(decision IN ('associated','dismissed')),
        updated_at REAL NOT NULL,
        PRIMARY KEY(media_id,person_key)
    );
    CREATE INDEX IF NOT EXISTS idx_media_profile_decisions_person
        ON media_profile_decisions(person_key,decision,media_id);
    """

    private static let schemaV26 = """
    CREATE TABLE IF NOT EXISTS people_preferences (
        person_key     TEXT PRIMARY KEY,
        cover_media_id INTEGER REFERENCES media_items(id) ON DELETE SET NULL,
        updated_at     REAL NOT NULL
    );
    """

    private static let schemaV27 = """
    CREATE TABLE IF NOT EXISTS people_aliases (
        source_key  TEXT PRIMARY KEY,
        target_key  TEXT NOT NULL,
        display_name TEXT NOT NULL,
        updated_at  REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_people_aliases_target
        ON people_aliases(target_key,source_key);
    """

    private static let schemaV29 = """
    CREATE TABLE media_ocr_reanalysis (
        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        model_version TEXT NOT NULL,
        source_analyzed_at REAL NOT NULL,
        analyzed_at REAL NOT NULL,
        recognized_text TEXT NOT NULL,
        error_message TEXT
    );
    """

    private static let schemaV28 = """
    CREATE TABLE IF NOT EXISTS media_reactions (
        media_id   INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
        reaction   TEXT NOT NULL CHECK(reaction IN ('like','dislike')),
        updated_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_reactions_reaction
        ON media_reactions(reaction,media_id);
    """
}
