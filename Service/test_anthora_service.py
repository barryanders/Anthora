import importlib.util
import json
import sqlite3
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location("anthora_service", Path(__file__).with_name("anthora_service.py"))
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class ServiceTests(unittest.TestCase):
    def test_paid_cleanup_routes_are_explicit(self):
        self.assertFalse(service.paid_action("/api/items/bulk"))
        self.assertTrue(service.paid_action("/api/books"))
        self.assertTrue(service.paid_action("/api/books/export-check"))
        self.assertFalse(service.paid_action("/api/items/42/restore"))
        self.assertTrue(service.paid_action("/api/items/42/delete-now"))
        self.assertTrue(service.paid_action("/api/duplicates/exact/bulk"))
        self.assertFalse(service.paid_action("/api/items/42/disposition"))
        self.assertFalse(service.paid_action("/api/people"))

    def test_merge_people_preserves_sources_and_person_photo(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE people_aliases(source_key TEXT PRIMARY KEY,target_key TEXT,display_name TEXT,updated_at REAL);
            CREATE TABLE people_preferences(person_key TEXT PRIMARY KEY,cover_media_id INTEGER,updated_at REAL);
            CREATE TABLE media_profile_decisions(media_id INTEGER,person_key TEXT,decision TEXT,updated_at REAL,PRIMARY KEY(media_id,person_key));
            INSERT INTO people_aliases VALUES('face_a_2','face_a','Person A',1);
            INSERT INTO people_preferences VALUES('face_b',42,2);
            INSERT INTO media_profile_decisions VALUES(9,'face_b','associated',3);
        """)
        self.assertEqual(service.merge_people(database, ["face_a", "face_b"], "face_a", "Barry"), 3)
        aliases = database.execute("SELECT source_key,target_key,display_name FROM people_aliases ORDER BY source_key").fetchall()
        self.assertEqual([tuple(row) for row in aliases], [
            ("face_a", "face_a", "Barry"),
            ("face_a_2", "face_a", "Barry"),
            ("face_b", "face_a", "Barry"),
        ])
        self.assertEqual(tuple(database.execute("SELECT person_key,cover_media_id FROM people_preferences").fetchone()), ("face_a", 42))
        self.assertEqual(database.execute("SELECT person_key FROM media_profile_decisions").fetchone()[0], "face_a")

    def test_post_handler_does_not_shadow_person_key_validator(self):
        self.assertNotIn("person_key", service.AnthoraHandler.do_POST.__code__.co_varnames)

    def test_person_photo_must_be_an_active_image_for_that_person(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,media_type TEXT,missing INTEGER,size_bytes INTEGER);
            CREATE TABLE media_curation(media_id INTEGER PRIMARY KEY,trashed_at REAL);
            CREATE TABLE people_media(person_key TEXT,media_id INTEGER);
            CREATE TABLE people_preferences(person_key TEXT PRIMARY KEY,cover_media_id INTEGER,updated_at REAL);
            INSERT INTO media_items VALUES(1,'image',0,100),(2,'video',0,100),(3,'image',0,100);
            INSERT INTO people_media VALUES('person_1',1),('person_1',2),('person_2',3);
        """)
        self.assertTrue(service.save_person_cover(database, "person_1", 1))
        self.assertEqual(
            database.execute("SELECT cover_media_id FROM people_preferences WHERE person_key='person_1'").fetchone()[0],
            1,
        )
        self.assertFalse(service.save_person_cover(database, "person_1", 2))
        self.assertFalse(service.save_person_cover(database, "person_1", 3))

    def test_person_key_preserves_face_group_separators(self):
        self.assertEqual(service.person_key("person_281_1"), "person_281_1")
        self.assertEqual(service.person_key("../../unsafe"), "")

    def test_legacy_face_alias_key_is_repaired_without_losing_name(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_face_features(person_key TEXT);
            CREATE TABLE people_aliases(source_key TEXT PRIMARY KEY,target_key TEXT NOT NULL,display_name TEXT NOT NULL,updated_at REAL NOT NULL);
            INSERT INTO media_face_features VALUES('person_281_1');
            INSERT INTO people_aliases VALUES('person2811','person2811','Barry',123);
        """)
        self.assertEqual(service.repair_legacy_face_alias_keys(database), 1)
        alias = database.execute("SELECT * FROM people_aliases").fetchone()
        self.assertEqual((alias["source_key"], alias["target_key"], alias["display_name"]), ("person_281_1", "person_281_1", "Barry"))

    def test_duplicate_group_sort_defaults_to_largest_potential_savings(self):
        groups = [
            {"hash": "small", "potentialBytes": 100, "items": [1, 2, 3]},
            {"hash": "large", "potentialBytes": 900, "items": [4, 5]},
            {"hash": "medium", "potentialBytes": 400, "items": [6, 7, 8, 9]},
        ]
        self.assertEqual(
            [group["hash"] for group in service.sort_duplicate_groups(groups)],
            ["large", "medium", "small"],
        )
        self.assertEqual(
            [group["hash"] for group in service.sort_duplicate_groups(groups, "items")],
            ["medium", "small", "large"],
        )

    def test_use_recommendation_reads_optional_trash_mode_in_its_own_handler(self):
        source = Path(service.__file__).read_text(encoding="utf-8")
        handler = source.split(
            'if parsed.path == "/api/duplicates/use-recommendation":', 1
        )[1].split('if parsed.path == "/api/people/alias":', 1)[0]
        self.assertIn('trash_others = body.get("trashOthers") is True', handler)
        self.assertIn('body.get("keepIds", [])', handler)
        self.assertIn('"keptIds": keep_ids', handler)

    def test_native_media_reader_is_short_lived_and_bounded(self):
        server = object.__new__(service.AnthoraServer)
        server.reader = Path("/tmp/AnthoraMediaReader")
        completed = SimpleNamespace(returncode=0)

        with mock.patch.object(service.subprocess, "run", return_value=completed) as run:
            server.run_native_media(["read-file", "42", "0", "1024", "/tmp/result"], timeout_seconds=20)

        run.assert_called_once_with(
            ["/tmp/AnthoraMediaReader", "read-file", "42", "0", "1024", "/tmp/result"],
            stdout=service.subprocess.DEVNULL,
            stderr=service.subprocess.DEVNULL,
            timeout=20,
            check=False,
        )

    def test_native_media_reader_failure_is_generic(self):
        server = object.__new__(service.AnthoraServer)
        server.reader = Path("/tmp/AnthoraMediaReader")
        with mock.patch.object(
            service.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=1),
        ):
            with self.assertRaisesRegex(RuntimeError, "Native media operation failed"):
                server.run_native_media(["thumbnail", "42", "600", "/tmp/result"])

    def test_open_database_closes_connection_after_context(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lifecycle.sqlite"
            with service.open_database(path) as database:
                database.execute("CREATE TABLE sample(value INTEGER)")
                database.execute("INSERT INTO sample VALUES(1)")

            with self.assertRaises(sqlite3.ProgrammingError):
                database.execute("SELECT 1")

            reopened = sqlite3.connect(path)
            self.assertEqual(reopened.execute("SELECT value FROM sample").fetchone(), (1,))
            reopened.close()

    def test_sips_thumbnail_uses_bounded_read_only_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.heic"
            output = root / "preview.jpg"
            source.write_bytes(b"source")

            def create_preview(command, **kwargs):
                self.assertEqual(command[0], "/usr/bin/sips")
                self.assertIn("600", command)
                self.assertEqual(kwargs["timeout"], 20)
                self.assertNotIn("PYTHONHOME", kwargs["env"])
                output.write_bytes(b"preview")
                return SimpleNamespace(returncode=0, stderr="")

            with mock.patch.object(service.subprocess, "run", side_effect=create_preview):
                service.generate_thumbnail_with_sips(source, output, 600)
            self.assertEqual(output.read_bytes(), b"preview")

    def test_quicklook_thumbnail_converts_generated_preview(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jpg"
            output = root / "preview.jpg"
            source.write_bytes(b"source")

            def create_preview(command, **kwargs):
                self.assertNotIn("PYTHONHOME", kwargs["env"])
                if command[0] == "/usr/bin/qlmanage":
                    preview_directory = Path(command[command.index("-o") + 1])
                    (preview_directory / "source.jpg.png").write_bytes(b"png-preview")
                else:
                    self.assertEqual(command[0], "/usr/bin/sips")
                    output.write_bytes(b"jpeg-preview")
                return SimpleNamespace(returncode=0, stderr="")

            with mock.patch.object(service.subprocess, "run", side_effect=create_preview):
                service.generate_thumbnail_with_quicklook(source, output, 600)
            self.assertEqual(output.read_bytes(), b"jpeg-preview")

    def test_thumbnail_reuses_existing_preview_from_another_instance_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "library.sqlite"
            previous_preview = root / "previous-cache.jpg"
            previous_preview.write_bytes(b"\xff\xd8\xffexisting-preview")
            database = sqlite3.connect(database_path)
            database.execute("CREATE TABLE media_items(id INTEGER PRIMARY KEY,thumbnail_path TEXT)")
            database.execute("INSERT INTO media_items VALUES(1,?)", (str(previous_preview),))
            database.commit()
            database.close()

            handler = object.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(cache=root / "new-cache", database=database_path)
            handler.queue_request = mock.Mock(side_effect=AssertionError("native decode should not run"))

            generated = handler.thumbnail(1, 600, 123)

            self.assertTrue(generated.is_file())
            self.assertEqual(generated.read_bytes(), previous_preview.read_bytes())
            handler.queue_request.assert_not_called()

    def test_smart_search_normalization_keeps_only_supported_filters(self):
        name, params = service.normalize_saved_search(
            "  Summer   favorites  ",
            {
                "q": "summer",
                "favorite": 1,
                "sort": "newest",
                "folderId": "private-internal-id",
                "defaultSortApplied": "1",
            },
        )
        self.assertEqual(name, "Summer favorites")
        self.assertEqual(
            params,
            {"q": "summer", "favorite": "1", "sort": "newest"},
        )

    def test_smart_search_can_save_a_confirmed_person(self):
        name, params = service.normalize_saved_search(
            "Israel",
            {"peopleKey": "israel", "sort": "newest"},
        )
        self.assertEqual(name, "Israel")
        self.assertEqual(params, {"peopleKey": "israel", "sort": "newest"})

    def test_recheck_unreadable_reconciles_missing_and_retries_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "existing.jpg"
            existing.write_bytes(b"still here")
            database = sqlite3.connect(":memory:")
            database.row_factory = sqlite3.Row
            database.executescript("""
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,path TEXT,missing INTEGER);
                CREATE TABLE media_text_analysis(media_id INTEGER,error_message TEXT);
                CREATE TABLE media_curation(media_id INTEGER,trashed_at REAL);
                CREATE TABLE media_references(path TEXT,media_item_id INTEGER);
            """)
            database.execute("INSERT INTO media_items VALUES(1,?,0)", (str(existing),))
            database.execute("INSERT INTO media_items VALUES(2,?,0)", (str(root / "gone.jpg"),))
            database.execute("INSERT INTO media_text_analysis VALUES(1,'decode failed')")
            database.execute("INSERT INTO media_text_analysis VALUES(2,'decode failed')")
            result = service.recheck_unreadable_media(database)
            self.assertEqual(result, {"checked": 2, "stale": 1, "retrying": 1})
            self.assertEqual(database.execute("SELECT missing FROM media_items WHERE id=2").fetchone()[0], 1)
            self.assertIsNone(database.execute("SELECT 1 FROM media_text_analysis WHERE media_id=1").fetchone())

    def test_smart_search_requires_a_real_filter(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            service.normalize_saved_search("Newest", {"sort": "newest"})
        with self.assertRaisesRegex(ValueError, "Enter a name"):
            service.normalize_saved_search("  ", {"q": "summer"})

    def test_smart_search_table_persists_query_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.sqlite"
            database = sqlite3.connect(path)
            service.ensure_saved_searches_table(database)
            database.execute(
                "INSERT INTO saved_searches VALUES(?,?,?,?,?)",
                ("abc", "Receipts", '{"q":"receipts"}', 1, 1),
            )
            database.commit()
            database.close()

            reopened = sqlite3.connect(path)
            row = reopened.execute(
                "SELECT name,params_json FROM saved_searches WHERE id='abc'"
            ).fetchone()
            reopened.close()
            self.assertEqual(row, ("Receipts", '{"q":"receipts"}'))

    def test_smart_search_defaults_seed_once_and_stay_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.sqlite"
            database = sqlite3.connect(path)
            service.ensure_saved_searches_table(database)
            names = [row[0] for row in database.execute(
                "SELECT name FROM saved_searches ORDER BY name"
            )]
            self.assertEqual(names, ["Group Photos", "Recent Videos", "Screenshots"])
            database.execute("DELETE FROM saved_searches")
            service.ensure_saved_searches_table(database)
            self.assertEqual(
                database.execute("SELECT COUNT(*) FROM saved_searches").fetchone()[0],
                0,
            )
            database.close()

    def test_smart_search_defaults_do_not_mix_with_existing_searches(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "saved.sqlite"
            database = sqlite3.connect(path)
            database.execute("""
                CREATE TABLE saved_searches (
                    id TEXT PRIMARY KEY,name TEXT NOT NULL,params_json TEXT NOT NULL,
                    created_at REAL NOT NULL,updated_at REAL NOT NULL
                )
            """)
            database.execute(
                "INSERT INTO saved_searches VALUES(?,?,?,?,?)",
                ("custom", "Receipts", '{"q":"receipts"}', 1, 1),
            )
            service.ensure_saved_searches_table(database)
            self.assertEqual(
                database.execute("SELECT name FROM saved_searches").fetchall(),
                [("Receipts",)],
            )
            database.close()

    def test_library_payload_exposes_root_folder_and_counts_only_nested_folders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "library.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(
                    id INTEGER PRIMARY KEY,name TEXT,root_path TEXT,scan_status TEXT,
                    last_scanned_at REAL
                );
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,path TEXT);
                CREATE TABLE scan_jobs(
                    id INTEGER PRIMARY KEY,library_id INTEGER,status TEXT,progress REAL,
                    started_at REAL,finished_at REAL,error_message TEXT
                );
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,
                    missing INTEGER,media_type TEXT,size_bytes INTEGER,favorite INTEGER,
                    width INTEGER,height INTEGER,path TEXT
                );
                CREATE TABLE folder_covers(folder_id INTEGER PRIMARY KEY,media_item_id INTEGER);
                CREATE TABLE media_text_analysis(media_id INTEGER,is_text_heavy INTEGER);
            """)
            database.execute(
                "INSERT INTO libraries VALUES(1,'Photos',?,'idle',NULL)",
                (str(root),),
            )
            database.execute("INSERT INTO folders VALUES(10,1,?)", (str(root),))
            database.execute(
                "INSERT INTO folders VALUES(11,1,?)", (str(root / "Trips"),)
            )
            database.commit()
            database.close()

            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path)
            payloads = []
            handler.send_json = lambda payload, status=200: payloads.append(payload)
            handler.libraries()

            self.assertEqual(payloads[0]["libraries"][0]["rootFolderId"], 10)
            self.assertEqual(payloads[0]["libraries"][0]["folderCount"], 1)
            self.assertEqual(payloads[0]["libraries"][0]["scanItemsIndexed"], 0)

    def test_library_payload_can_skip_blocking_remote_volume_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "library.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(
                    id INTEGER PRIMARY KEY,name TEXT,root_path TEXT,scan_status TEXT,
                    last_scanned_at REAL
                );
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,path TEXT);
                CREATE TABLE scan_jobs(
                    id INTEGER PRIMARY KEY,library_id INTEGER,status TEXT,progress REAL,
                    started_at REAL,finished_at REAL,error_message TEXT
                );
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,
                    missing INTEGER,media_type TEXT,size_bytes INTEGER,favorite INTEGER,
                    width INTEGER,height INTEGER,path TEXT
                );
                CREATE TABLE folder_covers(folder_id INTEGER PRIMARY KEY,media_item_id INTEGER);
                CREATE TABLE media_text_analysis(media_id INTEGER,is_text_heavy INTEGER);
            """)
            database.execute(
                "INSERT INTO libraries VALUES(1,'Remote',?,'idle',NULL)",
                ("/Volumes/Sleeping Share/Photos",),
            )
            database.commit()
            database.close()

            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path)
            payloads = []
            handler.send_json = lambda payload, status=200: payloads.append(payload)

            with mock.patch.dict(
                service.os.environ, {"ANTHORA_ASSUME_LIBRARY_AVAILABLE": "1"}
            ), mock.patch.object(
                service.Path, "is_dir", side_effect=AssertionError("filesystem probe")
            ):
                handler.libraries()

            self.assertTrue(payloads[0]["libraries"][0]["available"])

    def test_library_payload_uses_selected_root_folder_cover(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "library.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(
                    id INTEGER PRIMARY KEY,name TEXT,root_path TEXT,scan_status TEXT,
                    last_scanned_at REAL
                );
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,path TEXT);
                CREATE TABLE scan_jobs(
                    id INTEGER PRIMARY KEY,library_id INTEGER,status TEXT,progress REAL,
                    started_at REAL,finished_at REAL,error_message TEXT
                );
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,
                    missing INTEGER,media_type TEXT,size_bytes INTEGER,favorite INTEGER,
                    width INTEGER,height INTEGER,path TEXT
                );
                CREATE TABLE folder_covers(folder_id INTEGER PRIMARY KEY,media_item_id INTEGER);
                CREATE TABLE media_text_analysis(media_id INTEGER,is_text_heavy INTEGER);
            """)
            database.execute(
                "INSERT INTO libraries VALUES(1,'Photos',?,'idle',NULL)",
                (str(root),),
            )
            database.execute("INSERT INTO folders VALUES(10,1,?)", (str(root),))
            database.execute(
                "INSERT INTO media_items VALUES(20,1,10,0,'image',100,0,100,100,?)",
                (str(root / "default.jpg"),),
            )
            database.execute(
                "INSERT INTO media_items VALUES(21,1,10,0,'image',50,0,100,100,?)",
                (str(root / "selected.jpg"),),
            )
            database.execute("INSERT INTO folder_covers VALUES(10,21)")
            database.commit()
            database.close()

            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path)
            payloads = []
            handler.send_json = lambda payload, status=200: payloads.append(payload)
            handler.libraries()

            library = payloads[0]["libraries"][0]
            self.assertEqual(library["coverItemId"], 21)
            self.assertEqual(library["coverUrl"], "/api/items/21/thumbnail?size=700")

    def test_interrupted_scans_become_retryable_after_restart(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE libraries(id INTEGER PRIMARY KEY,scan_status TEXT,updated_at REAL);
            CREATE TABLE scan_jobs(
                id INTEGER PRIMARY KEY,library_id INTEGER,status TEXT,progress REAL,
                started_at REAL,finished_at REAL,error_message TEXT
            );
            INSERT INTO libraries VALUES(1,'scanning',1),(2,'queued',1),(3,'idle',1);
            INSERT INTO scan_jobs VALUES(10,1,'running',400,1,NULL,NULL);
        """)
        changed = service.recover_interrupted_scans(database, now=42)
        self.assertEqual(changed, 2)
        self.assertEqual(
            database.execute("SELECT scan_status FROM libraries ORDER BY id").fetchall(),
            [("error",), ("error",), ("idle",)],
        )
        job = database.execute(
            "SELECT status,finished_at,error_message FROM scan_jobs WHERE id=10"
        ).fetchone()
        self.assertEqual(job[0:2], ("failed", 42))
        self.assertIn("restarted", job[2])

    def test_cancel_scan_creates_cooperative_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "library.sqlite"
            database = sqlite3.connect(database_path)
            database.execute("CREATE TABLE libraries(id INTEGER PRIMARY KEY,scan_status TEXT)")
            database.execute("INSERT INTO libraries VALUES(7,'scanning')")
            database.commit()
            database.close()
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path, cache=root / "Cache")
            payloads = []
            handler.send_json = lambda payload, status=200: payloads.append((payload, status))

            handler.cancel_library_scan(7)

            self.assertTrue((root / "scan-7.cancel").exists())
            self.assertEqual(payloads[0][0]["scanStatus"], "cancelling")

    def test_social_archive_connector_is_opt_in(self):
        source = Path(service.__file__).read_text(encoding="utf-8")
        self.assertIn('social_archive_sync: bool = False', source)
        self.assertIn('if self.social_archive_sync:', source)

    def test_social_archive_sync_runs_only_for_new_references(self):
        with tempfile.TemporaryDirectory() as directory:
            database = sqlite3.connect(":memory:")
            database.row_factory = sqlite3.Row
            database.execute("CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT,scan_status TEXT)")
            database.execute("INSERT INTO libraries VALUES(7,'Social Archive','idle')")
            state = Path(directory) / "sync-state.json"

            self.assertEqual(
                service.social_archive_sync_candidate(database, state, 3),
                {"libraryId": 7, "targetRefId": 3},
            )
            service.save_social_archive_sync_state(state, 3)
            self.assertIsNone(service.social_archive_sync_candidate(database, state, 3))
            self.assertEqual(
                service.social_archive_sync_candidate(database, state, 4),
                {"libraryId": 7, "targetRefId": 4},
            )
            service.save_social_archive_sync_state(state, 4)
            self.assertEqual(
                service.social_archive_sync_candidate(database, state, 1),
                {"libraryId": 7, "targetRefId": 1},
            )

    def test_social_archive_identity_export_requires_connector_library(self):
        database = sqlite3.connect(":memory:")
        database.execute("CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT)")
        self.assertFalse(service.has_social_archive_library(database))
        database.execute("INSERT INTO libraries VALUES(1,'Photos')")
        self.assertFalse(service.has_social_archive_library(database))
        database.execute("INSERT INTO libraries VALUES(2,'Social Archive')")
        self.assertTrue(service.has_social_archive_library(database))

    def test_social_archive_sync_does_not_overlap_active_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            database = sqlite3.connect(":memory:")
            database.row_factory = sqlite3.Row
            database.execute("CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT,scan_status TEXT)")
            database.execute("INSERT INTO libraries VALUES(1,'Social Archive','scanning')")
            self.assertIsNone(
                service.social_archive_sync_candidate(
                    database, Path(directory) / "missing-state.json", 1
                )
            )

    def test_batch_queue_collects_native_worker_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory)
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(queue=queue)
            outcomes = iter(("ok", "error\tpermission denied"))

            def enqueue(command, target_queue):
                identifier = f"request-{command[0]}"
                (target_queue / f"{identifier}.done").write_text(next(outcomes), encoding="utf-8")
                return identifier

            handler.enqueue_request = enqueue
            failures = handler.queue_requests(([name] for name in ("one", "two")), timeout_seconds=1)
            self.assertEqual(failures, [(["two"], "permission denied")])

    def test_server_suppresses_only_client_disconnect_errors(self):
        server = service.AnthoraServer.__new__(service.AnthoraServer)
        suppressed = (
            ConnectionResetError(),
            ConnectionAbortedError(),
            BrokenPipeError(),
        )
        for error in suppressed:
            try:
                raise error
            except type(error):
                server.handle_error(None, ("127.0.0.1", 0))

    def test_request_logger_preserves_numeric_format_arguments(self):
        handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
        handler.address_string = lambda: "127.0.0.1"
        handler.log_message("code %d, message %s", 400, "bad?access_token=secret")

    def test_token_auth_accepts_bearer_or_cookie(self):
        token = "a" * 48
        session = service.session_cookie_value(token, expires_at=2_000_000_000)
        self.assertTrue(service.request_is_authorized(None))
        self.assertTrue(service.request_is_authorized(token, f"Bearer {token}"))
        self.assertTrue(service.request_is_authorized(token, cookie_header=f"anthora_access={session}"))
        self.assertFalse(service.request_is_authorized(token, "Bearer wrong"))
        self.assertFalse(service.request_is_authorized(token, cookie_header="anthora_access=wrong"))

    def test_browser_session_rejects_expired_or_tampered_cookie(self):
        token = "a" * 48
        current = service.session_cookie_value(token, expires_at=2_000_000_000)
        expired = service.session_cookie_value(token, expires_at=1_000)
        self.assertTrue(service.session_cookie_is_valid(token, current, now=1_900_000_000))
        self.assertFalse(service.session_cookie_is_valid(token, expired, now=2_000))
        self.assertFalse(service.session_cookie_is_valid(token, current + "0", now=1_900_000_000))
        self.assertFalse(service.session_cookie_is_valid("b" * 48, current, now=1_900_000_000))

    def test_bootstrap_redirect_removes_only_access_token(self):
        self.assertEqual(
            service.path_without_access_token("/?view=favorites&access_token=secret&sort=size"),
            "/?view=favorites&sort=size",
        )

    def test_bootstrap_cookie_is_secure_for_https_private_links(self):
        header = service.auth_cookie_header("a" * 48)
        self.assertIn("HttpOnly", header)
        self.assertIn("Secure", header)
        self.assertIn("SameSite=Strict", header)
        self.assertNotIn("a" * 48, header)

    def test_recovery_urls_must_be_https_without_credentials(self):
        self.assertEqual(
            service.valid_recovery_url("https://media.example/file.mp4"),
            "https://media.example/file.mp4",
        )
        self.assertIsNone(service.valid_recovery_url("http://media.example/file.mp4"))
        self.assertIsNone(service.valid_recovery_url("https://user:secret@media.example/file.mp4"))
        self.assertIsNone(service.valid_recovery_url("file:///tmp/file.mp4"))

    def test_recently_deleted_includes_empty_unreadable_files(self):
        self.assertEqual(service.media_size_condition(trash=True), "1")
        self.assertEqual(service.media_size_condition(invalid=True), "1")
        self.assertEqual(service.media_size_condition(), "size_bytes > 0")

    def test_recently_deleted_defaults_to_latest_deletion_first(self):
        self.assertEqual(
            service.default_media_order(trash=True),
            "COALESCE(c.trashed_at,0) DESC,id DESC",
        )
        self.assertEqual(
            service.default_media_order(),
            "COALESCE(created_at,modified_at,imported_at,0) DESC,id DESC",
        )

    def test_active_anthologies_hide_items_marked_for_removal(self):
        condition = service.active_curation_condition()
        self.assertIn("disposition='remove'", condition)
        self.assertIsNone(service.active_curation_condition("remove"))
        self.assertIsNone(service.active_curation_condition("keep"))
        self.assertIsNone(service.active_curation_condition(trash=True))

    def test_explicit_dislikes_are_separate_from_cleanup_removals(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY);
            CREATE TABLE media_curation(media_id INTEGER PRIMARY KEY,disposition TEXT,trashed_at REAL);
            CREATE TABLE media_reactions(media_id INTEGER PRIMARY KEY,reaction TEXT,updated_at REAL);
            INSERT INTO media_items VALUES(1),(2);
            INSERT INTO media_curation VALUES(1,'remove',NULL),(2,'remove',NULL);
            INSERT INTO media_reactions VALUES(2,'dislike',10);
        """)
        rows = database.execute(
            """SELECT id FROM media_items
               WHERE id IN (SELECT media_id FROM media_reactions WHERE reaction='dislike')
               ORDER BY id"""
        ).fetchall()
        self.assertEqual([row[0] for row in rows], [2])

    def test_care_undo_restores_prior_curation_without_overwriting_newer_choices(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.execute(
            """CREATE TABLE media_curation(
                   media_id INTEGER PRIMARY KEY,disposition TEXT,
                   trashed_at REAL,updated_at REAL
               )"""
        )
        database.execute("INSERT INTO media_curation VALUES(1,'keep',NULL,10)")
        previous = service.curation_snapshot(database, [1, 2])
        database.execute("UPDATE media_curation SET disposition='remove',updated_at=20 WHERE media_id=1")
        database.execute("INSERT INTO media_curation VALUES(2,'keep',NULL,21)")
        action = {
            "kind": "curation",
            "payload": {"items": previous},
            "changedAt": 20,
        }

        restored = service.apply_care_undo(database, action)

        self.assertEqual(restored, 1)
        self.assertEqual(
            tuple(database.execute(
                "SELECT disposition,updated_at FROM media_curation WHERE media_id=1"
            ).fetchone()),
            ("keep", 10),
        )
        self.assertEqual(
            database.execute(
                "SELECT disposition FROM media_curation WHERE media_id=2"
            ).fetchone()[0],
            "keep",
        )

    def test_care_undo_removes_new_similarity_dismissal(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.execute(
            """CREATE TABLE media_similarity_reviews(
                   left_media_id INTEGER,right_media_id INTEGER,
                   decision TEXT,updated_at REAL,
                   PRIMARY KEY(left_media_id,right_media_id)
               )"""
        )
        database.execute(
            "INSERT INTO media_similarity_reviews VALUES(1,2,'not_duplicate',30)"
        )
        action = {
            "kind": "similarity",
            "payload": {
                "pairs": [{
                    "left": 1,
                    "right": 2,
                    "existed": False,
                    "decision": None,
                    "updatedAt": None,
                }]
            },
            "changedAt": 30,
        }

        self.assertEqual(service.apply_care_undo(database, action), 1)
        self.assertIsNone(
            database.execute("SELECT 1 FROM media_similarity_reviews").fetchone()
        )

    def test_natural_search_planner_combines_semantics_metadata_people_and_ocr(self):
        plan = service.parse_natural_language_query(
            "Favorite videos of Dad and Emma containing happy birthday after:2024",
            (("dad", "Dad"), ("emma", "Emma")),
            now=1_800_000_000,
        )
        self.assertEqual(plan["mediaType"], "video")
        self.assertTrue(plan["favorite"])
        self.assertEqual([person["key"] for person in plan["people"]], ["emma", "dad"])
        self.assertEqual(plan["ocrTerms"], ["happy birthday"])
        self.assertEqual(plan["after"], service.year_bounds(2024)[1])
        self.assertIn("person", plan["semanticQuery"])

    def test_confirmed_person_search_does_not_require_a_semantic_score(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "people-search.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE people_media(person_key TEXT,media_id INTEGER);
                CREATE TABLE media_face_features(person_key TEXT,media_id INTEGER);
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,missing INTEGER,favorite INTEGER,
                    created_at REAL,modified_at REAL,imported_at REAL
                );
                CREATE TABLE media_curation(media_id INTEGER,disposition TEXT);
                CREATE TABLE media_tags(media_item_id INTEGER,tag_id INTEGER,confidence REAL);
                CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT);
                INSERT INTO media_items VALUES(7,0,0,1,1,1);
                INSERT INTO people_media VALUES('israel',7);
            """)
            database.commit()
            database.close()
            handler = object.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path)
            handler.semantic_results = mock.Mock(return_value=[])
            plan = service.parse_natural_language_query(
                "Israel", (("israel", "Israel"),)
            )
            results = handler.fused_search_results(plan)
            self.assertEqual([result["id"] for result in results], [7])

    def test_natural_search_planner_keeps_visual_concepts_semantic(self):
        plan = service.parse_natural_language_query("all pictures of a black truck in the driveway")
        self.assertEqual(plan["mediaType"], "image")
        self.assertEqual(plan["semanticQuery"], "black truck driveway")
        self.assertEqual(plan["ocrTerms"], [])

    def test_natural_search_planner_understands_document_source_text(self):
        plan = service.parse_natural_language_query("receipt from Costco")
        self.assertEqual(plan["semanticQuery"], "receipt")
        self.assertEqual(plan["ocrTerms"], ["Costco"])
        self.assertEqual(service.fts_query("Costco #123"), '"Costco" AND "123"')

    def test_items_search_includes_ocr_with_filters_paging_and_semantic_results(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "text-search.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,filename TEXT,path TEXT,missing INTEGER,
                    size_bytes INTEGER,media_type TEXT,favorite INTEGER,
                    created_at REAL,modified_at REAL,imported_at REAL
                );
                CREATE TABLE media_text_analysis(media_id INTEGER,recognized_text TEXT,error_message TEXT);
                CREATE TABLE media_curation(media_id INTEGER,disposition TEXT,trashed_at REAL);
                CREATE TABLE media_reentry_reviews(media_id INTEGER);
                CREATE TABLE media_tags(media_item_id INTEGER,tag_id INTEGER);
                CREATE TABLE tags(id INTEGER,name TEXT);
                CREATE TABLE media_recovery_sources(media_id INTEGER,provider TEXT,source_url TEXT,download_url TEXT);
                CREATE TABLE media_recovery_jobs(media_id INTEGER,status TEXT,error_message TEXT,updated_at REAL);
                CREATE TABLE media_screenshot_categories(media_id INTEGER,category TEXT);
            """)
            rows = [
                (1, "photo.jpg", "Member 1239965789", "image", 0, 1),
                (2, "photo.jpg", "MEMBER benefits", "image", 0, 0),
                (3, "9965.jpg", "", "image", 0, 0),
                (4, "photo.jpg", "Member 9965", "image", 1, 0),
                (5, "photo.jpg", "Member 9965", "image", 0, 0),
                (6, "clip.mov", "Member 9965", "video", 0, 0),
                (7, "photo.jpg", "Save 50% on A_B at C:\\Cards", "image", 0, 0),
                (8, "photo.jpg", "Save 500 on AXB at C:Cards", "image", 0, 0),
            ]
            for identifier, filename, text, media_type, missing, favorite in rows:
                database.execute("INSERT INTO media_items VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (identifier, filename, "/photos/" + filename, missing, 100, media_type, favorite, identifier, identifier, identifier))
                database.execute("INSERT INTO media_text_analysis VALUES(?,?,NULL)", (identifier, text))
            database.execute("INSERT INTO media_curation VALUES(5,NULL,10)")
            database.commit()
            database.close()
            handler = object.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path)
            handler.natural_search_plan = service.parse_natural_language_query
            handler.fused_search_results = mock.Mock(return_value=[])
            handler.send_json = mock.Mock()

            def search(term, **filters):
                with mock.patch.object(service, "item_payload", side_effect=lambda row: {"id": row["id"]}):
                    handler.items({"q": [term], **{key: [value] for key, value in filters.items()}})
                result = handler.send_json.call_args.args[0]
                return [item["id"] for item in result["items"]], result

            ids, result = search("9965")
            self.assertEqual(ids, [6, 3, 1])
            self.assertEqual(result["total"], 3)
            self.assertEqual(search("member", type="image")[0], [2, 1])
            self.assertEqual(search("9965", favorite="1")[0], [1])
            for term in ("50%", "A_B", "C:\\Cards"):
                self.assertEqual(search(term)[0], [7])
            ids, first = search("9965", limit="1")
            self.assertEqual(ids, [6])
            self.assertEqual(search("9965", limit="1", cursor=first["nextCursor"])[0], [3])
            handler.fused_search_results.return_value = [{"id": 8, "score": 0.9}]
            ids, first = search("9965", limit="1")
            self.assertEqual(ids, [8])
            self.assertEqual(first["total"], 3)
            self.assertEqual(search("9965", cursor=first["nextCursor"])[0], [6, 1])

    def test_default_media_cursor_preserves_date_and_id_boundary(self):
        cursor = service.default_media_cursor(
            {"id": 42, "created_at": None, "modified_at": 123.25, "imported_at": 120}
        )
        self.assertEqual(cursor, "d:123.25:42")
        self.assertEqual(service.parse_default_media_cursor(cursor), (123.25, 42))

    def test_library_paths_require_a_readable_media_folder_and_cannot_overlap(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            root = Path(directory)
            child = root / "Photos"
            child.mkdir()
            self.assertEqual(service.normalized_library_path(str(child)), child.resolve())
            self.assertTrue(service.library_paths_overlap(root.resolve(), child.resolve()))
            self.assertFalse(service.library_paths_overlap(root.resolve(), Path("/Volumes/Other")))
            with self.assertRaises(ValueError):
                service.normalized_library_path("relative/folder")
            with self.assertRaises(ValueError):
                service.normalized_library_path(str(root / "Missing"))
            with self.assertRaises(ValueError):
                service.normalized_library_path("/")

    def test_short_auth_token_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("too-short", encoding="utf-8")
            with self.assertRaises(ValueError):
                service.load_auth_token(token_file)

    def test_item_payload_never_exposes_source_path(self):
        with tempfile.TemporaryDirectory() as directory:
            database = sqlite3.connect(Path(directory) / "test.sqlite")
            database.row_factory = sqlite3.Row
            database.execute("CREATE TABLE media_items(id,library_id,folder_id,path,filename,media_type,width,height,size_bytes,created_at,modified_at,duration_seconds,favorite)")
            database.execute("INSERT INTO media_items VALUES(1,2,3,'/secret/file.jpg','file.jpg','image',800,600,42,1,2,NULL,1)")
            row = database.execute("SELECT * FROM media_items").fetchone()
            payload = service.item_payload(row)
            self.assertNotIn("path", payload)
            self.assertEqual(payload["thumbnailUrl"], "/api/items/1/thumbnail")
            self.assertTrue(payload["favorite"])

    def test_item_payload_marks_previously_deleted_review(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.execute("CREATE TABLE media_items(id,library_id,folder_id,filename,media_type,width,height,size_bytes,created_at,modified_at,duration_seconds,favorite)")
        database.execute("INSERT INTO media_items VALUES(1,2,3,'file.jpg','image',800,600,42,1,2,NULL,0)")
        row = database.execute("SELECT *,1 reentry_pending FROM media_items").fetchone()
        self.assertTrue(service.item_payload(row)["reentryPending"])

    def test_page_size_has_hard_limit(self):
        self.assertEqual(service.MAX_PAGE_SIZE, 200)

    def test_existing_media_ids_chunks_large_postcondition_checks(self):
        database = sqlite3.connect(":memory:")
        database.execute("CREATE TABLE media_items(id INTEGER PRIMARY KEY)")
        database.executemany("INSERT INTO media_items VALUES(?)", ((1,), (501,), (1001,)))
        self.assertEqual(
            service.existing_media_ids(database, range(1, 1200), chunk_size=200),
            {1, 501, 1001},
        )

    def test_people_newest_dates_ignore_missing_and_empty_media(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE people_media(person_key TEXT,media_id INTEGER);
            CREATE TABLE media_items(
                id INTEGER PRIMARY KEY,created_at REAL,modified_at REAL,
                imported_at REAL,missing INTEGER,size_bytes INTEGER
            );
            INSERT INTO people_media VALUES
                ('alex',1),('alex',2),('blair',3),('blair',4),('casey',5);
            INSERT INTO media_items VALUES
                (1,100,90,80,0,10),(2,200,190,180,1,10),
                (3,NULL,150,140,0,10),(4,300,290,280,0,0),
                (5,NULL,NULL,125,0,10);
        """)
        self.assertEqual(
            service.people_newest_dates(database),
            {"alex": 100, "blair": 150, "casey": 125},
        )

    def test_people_hide_empty_sources_and_exclude_recently_deleted_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,folder_id INTEGER,path TEXT,size_bytes INTEGER,
                    created_at REAL,modified_at REAL,imported_at REAL,missing INTEGER
                );
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT);
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                CREATE TABLE media_references(path TEXT,media_item_id INTEGER,folder_id INTEGER);
                INSERT INTO libraries VALUES (1,'Social Archive');
                INSERT INTO folders VALUES
                    (1,1,'/archive/u','/archive/u/active'),
                    (2,1,'/archive/u','/archive/u/empty'),
                    (3,1,'/canonical','/canonical/source'),
                    (4,1,'/archive/u/inferred','/archive/u/inferred/Posts');
                INSERT INTO media_items VALUES
                    (1,1,'/archive/u/active/one.jpg',100,10,10,10,0),
                    (2,1,'/archive/u/active/two.jpg',100,20,20,20,0),
                    (3,3,'/canonical/three.jpg',100,30,30,30,0),
                    (4,4,'/archive/u/inferred/Posts/four.jpg',100,40,40,40,0);
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                initialized.executemany(
                    "INSERT INTO media_references(path,media_item_id,folder_id) VALUES(?,?,?)",
                    (("one.jpg", 1, 1), ("two.jpg", 2, 1), ("three.jpg", 3, 1)),
                )
                initialized.execute(
                    "INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at) VALUES(2,'remove',100,100)"
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path, cache=root / "Thumbnails")
            handler.server.cache.mkdir()
            handler.social_identities = lambda: [
                {"key": "person", "name": "Person", "paths": ["/archive/u/active"], "profiles": ["active"]},
                {"key": "empty", "name": "Empty", "paths": ["/archive/u/empty"], "profiles": ["empty"]},
                {"key": "inferred", "name": "Inferred", "paths": [], "profiles": []},
            ]
            captured = {}
            handler.send_json = lambda payload, status=None: captured.update(payload)
            handler.people({"scope": ["social"]})
            self.assertEqual(
                {person["key"]: person["itemCount"] for person in captured["people"]},
                {"person": 2, "inferred": 1},
            )
            with service.open_database(database_path) as verified:
                alias = verified.execute(
                    "SELECT source_key,target_key FROM people_aliases WHERE source_key='active'"
                ).fetchone()
                self.assertEqual(tuple(alias), ("active", "person"))
                self.assertIsNone(
                    verified.execute("SELECT 1 FROM people_aliases WHERE source_key='u'").fetchone()
                )

    def test_organization_suggestions_only_include_recognized_media_outside_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT,root_path TEXT);
                CREATE TABLE folders(
                    id INTEGER PRIMARY KEY,library_id INTEGER,name TEXT,
                    parent_path TEXT,path TEXT
                );
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,path TEXT,
                    filename TEXT,media_type TEXT,width INTEGER,height INTEGER,size_bytes INTEGER,
                    created_at REAL,modified_at REAL,imported_at REAL,duration_seconds REAL,
                    frame_rate REAL,favorite INTEGER,missing INTEGER
                );
                INSERT INTO media_items VALUES
                    (1,1,1,'/other/one.jpg','one.jpg','image',100,100,100,10,10,10,NULL,NULL,0,0),
                    (2,1,2,'/people/alex/two.jpg','two.jpg','image',100,100,100,20,20,20,NULL,NULL,0,0);
                INSERT INTO libraries VALUES(1,'Media','/media');
                INSERT INTO folders VALUES
                    (1,1,'Other','/','/other'),
                    (2,1,'Alex','/people','/people/alex');
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                initialized.execute("ALTER TABLE media_face_features ADD COLUMN match_distance REAL")
                initialized.execute("ALTER TABLE media_face_features ADD COLUMN assignment_source TEXT")
                initialized.execute(
                    "INSERT INTO media_face_features(media_id,face_index,person_key,feature_blob,assignment_source) VALUES(1,0,'alex',X'00','user')"
                )
                initialized.execute(
                    "INSERT INTO media_face_features(media_id,face_index,person_key,feature_blob,assignment_source) VALUES(2,0,'alex',X'00','vision')"
                )
                initialized.execute("INSERT INTO people_media(person_key,media_id) VALUES('alex',2)")
                initialized.execute(
                    "INSERT INTO people_aliases VALUES('alex','alex','Alex Example',1)"
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path)
            captured = {}
            handler.send_json = lambda payload, status=None: captured.update(payload)
            handler.organization_suggestions()
            self.assertEqual(captured["total"], 1)
            self.assertEqual(captured["suggestions"][0]["id"], 1)
            self.assertEqual(captured["suggestions"][0]["personName"], "Alex Example")
            self.assertTrue(captured["suggestions"][0]["canOrganize"])
            self.assertEqual(captured["suggestions"][0]["organizationMode"], "association")

    def test_organization_decision_is_durable_and_never_changes_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT,root_path TEXT);
                CREATE TABLE folders(
                    id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT
                );
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,path TEXT,
                    media_type TEXT,size_bytes INTEGER,missing INTEGER
                );
                INSERT INTO libraries VALUES(1,'Media','/media');
                INSERT INTO folders VALUES(1,1,'/media','/media/source');
                INSERT INTO media_items VALUES(1,1,1,'/media/one.jpg','image',100,0);
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                initialized.execute("ALTER TABLE media_face_features ADD COLUMN match_distance REAL")
                initialized.execute("ALTER TABLE media_face_features ADD COLUMN assignment_source TEXT")
                initialized.execute(
                    "INSERT INTO media_face_features(media_id,face_index,person_key,feature_blob,assignment_source) VALUES(1,0,'alex',X'00','vision')"
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path, cache=root / "Thumbnails")
            handler.server.cache.mkdir()
            captured = {}
            handler.send_json = lambda payload, status=None: captured.update(payload)

            handler.organization_decision(1, "Alex", "associate")

            self.assertTrue(captured["ok"])
            self.assertFalse(captured["filesChanged"])
            with service.open_database(database_path) as verified:
                self.assertEqual(
                    tuple(verified.execute(
                        "SELECT decision FROM media_profile_decisions WHERE media_id=1 AND person_key='alex'"
                    ).fetchone()),
                    ("associated",),
                )
                self.assertIsNotNone(
                    verified.execute(
                        "SELECT 1 FROM people_media WHERE media_id=1 AND person_key='alex'"
                    ).fetchone()
                )
            self.assertTrue(Path("/media/one.jpg").as_posix() not in captured)

    def test_organization_decision_rejects_unrecognized_association(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,name TEXT,root_path TEXT);
                CREATE TABLE folders(
                    id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT
                );
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,path TEXT,
                    media_type TEXT,size_bytes INTEGER,missing INTEGER
                );
                INSERT INTO libraries VALUES(1,'Media','/media');
                INSERT INTO folders VALUES(1,1,'/media','/media/source');
                INSERT INTO media_items VALUES(1,1,1,'/media/one.jpg','image',100,0);
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                initialized.execute("ALTER TABLE media_face_features ADD COLUMN match_distance REAL")
                initialized.execute("ALTER TABLE media_face_features ADD COLUMN assignment_source TEXT")
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path, cache=root / "Thumbnails")
            handler.server.cache.mkdir()
            captured = {}
            handler.send_json = lambda payload, status=None: captured.update(
                payload, _status=status
            )

            handler.organization_decision(1, "alex", "associate")

            self.assertEqual(captured["_status"], service.HTTPStatus.CONFLICT)
            with service.open_database(database_path) as verified:
                self.assertIsNone(
                    verified.execute("SELECT 1 FROM media_profile_decisions").fetchone()
                )

    def test_similarity_pairs_separate_resized_and_cropped_variants(self):
        value = 1 / (512 ** 0.5)
        embedding = struct.pack("<512f", *([value] * 512))
        rows = [
            {"id": 1, "folder_id": 1, "filename": "IMG_1001.jpg", "width": 1200, "height": 800, "content_hash": "a", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": embedding},
            {"id": 2, "folder_id": 1, "filename": "IMG_1002.jpg", "width": 600, "height": 400, "content_hash": "b", "created_at": 100, "modified_at": 100, "dhash": "0000000000000001", "embedding_blob": embedding},
            {"id": 3, "folder_id": 1, "filename": "IMG_1003.jpg", "width": 600, "height": 600, "content_hash": "c", "created_at": 100, "modified_at": 100, "dhash": "0000000000000003", "embedding_blob": embedding},
        ]
        pairs = service.build_similarity_pairs(rows)
        kinds = {(pair["left"], pair["right"]): pair["kind"] for pair in pairs}
        self.assertEqual(kinds[(1, 2)], "resized")
        self.assertEqual(kinds[(1, 3)], "cropped")
        self.assertEqual(kinds[(2, 3)], "cropped")

    def test_resized_matching_rejects_loose_low_detail_hashes(self):
        rows = [
            {"id": 1, "folder_id": 1, "filename": "screen-a.png", "width": 1200, "height": 800, "content_hash": "a", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": None},
            {"id": 2, "folder_id": 1, "filename": "screen-b.png", "width": 600, "height": 400, "content_hash": "b", "created_at": 100, "modified_at": 100, "dhash": "0000000000000007", "embedding_blob": None},
        ]
        self.assertEqual(service.build_similarity_pairs(rows), [])

    def test_unhashed_likely_exact_pair_is_not_presented_as_resized(self):
        value = 1 / (512 ** 0.5)
        embedding = struct.pack("<512f", *([value] * 512))
        rows = [
            {"id": 1, "folder_id": 1, "filename": "IMG_5650.PNG", "width": 1290, "height": 2796, "size_bytes": 3046607, "content_hash": None, "created_at": 100, "modified_at": 100, "dhash": "0102030405060708", "embedding_blob": embedding},
            {"id": 2, "folder_id": 1, "filename": "IMG_5650 (1).PNG", "width": 1290, "height": 2796, "size_bytes": 3046607, "content_hash": None, "created_at": 100, "modified_at": 100, "dhash": "0102030405060708", "embedding_blob": embedding},
        ]
        self.assertEqual(service.build_similarity_pairs(rows), [])

    def test_hashed_distinct_encoding_can_still_be_presented_as_resized(self):
        rows = [
            {"id": 1, "folder_id": 1, "filename": "IMG_5650.PNG", "width": 1290, "height": 2796, "size_bytes": 3046607, "content_hash": "left", "created_at": 100, "modified_at": 100, "dhash": "0102030405060708", "embedding_blob": None},
            {"id": 2, "folder_id": 1, "filename": "IMG_5650 (1).PNG", "width": 1290, "height": 2796, "size_bytes": 3046607, "content_hash": "right", "created_at": 100, "modified_at": 100, "dhash": "0102030405060708", "embedding_blob": None},
        ]
        self.assertEqual(service.build_similarity_pairs(rows)[0]["kind"], "resized")

    def test_visual_hash_matching_can_identify_a_crop_without_semantic_weights(self):
        rows = [
            {"id": 1, "folder_id": 1, "filename": "original.jpg", "width": 1200, "height": 800, "content_hash": "a", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": None},
            {"id": 2, "folder_id": 1, "filename": "original-cropped.jpg", "width": 800, "height": 800, "content_hash": "b", "created_at": 100, "modified_at": 100, "dhash": "0000000000000003", "embedding_blob": None},
        ]
        self.assertEqual(service.build_similarity_pairs(rows)[0]["kind"], "cropped")

    def test_visual_hash_collision_does_not_group_different_screen_photos(self):
        rows = [
            {"id": 1, "folder_id": 1, "filename": "screen-a.png", "width": 1200, "height": 800, "content_hash": "a", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": None},
            {"id": 2, "folder_id": 1, "filename": "screen-b.png", "width": 600, "height": 400, "content_hash": "b", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": None},
        ]
        self.assertEqual(service.build_similarity_pairs(rows), [])

    def test_visual_hash_matching_accepts_numbered_copy_name(self):
        rows = [
            {"id": 1, "folder_id": 1, "filename": "IMG_1001.JPG", "width": 1200, "height": 800, "content_hash": "a", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": None},
            {"id": 2, "folder_id": 1, "filename": "IMG_1001(1).JPG", "width": 600, "height": 400, "content_hash": "b", "created_at": 100, "modified_at": 100, "dhash": "0000000000000001", "embedding_blob": None},
        ]
        self.assertEqual(service.build_similarity_pairs(rows)[0]["kind"], "resized")

    def test_similarity_pairs_collapse_exact_copies_and_drop_trashed_items(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(
                id INTEGER PRIMARY KEY,content_hash TEXT,favorite INTEGER,missing INTEGER
            );
            CREATE TABLE media_curation(media_id INTEGER,disposition TEXT,trashed_at REAL);
            CREATE TABLE media_references(media_item_id INTEGER);
            INSERT INTO media_items VALUES
                (1,'same',0,0),(2,'same',1,0),(3,'variant',0,0),(4,'trashed',0,0);
            INSERT INTO media_curation VALUES(4,NULL,100);
        """)
        pairs = [
            {"left": 1, "right": 2, "kind": "resized", "confidence": 1.0},
            {"left": 1, "right": 3, "kind": "resized", "confidence": 0.99},
            {"left": 2, "right": 3, "kind": "cropped", "confidence": 0.98},
            {"left": 3, "right": 4, "kind": "cropped", "confidence": 0.99},
        ]
        self.assertEqual(
            service.reconcile_similarity_pairs(database, pairs),
            [{"left": 2, "right": 3, "kind": "cropped", "confidence": 0.98}],
        )

    def test_best_shot_pairs_require_same_folder_and_close_capture_time(self):
        value = 1 / (512 ** 0.5)
        embedding = struct.pack("<512f", *([value] * 512))
        base = {
            "width": 1200, "height": 800, "modified_at": 100,
            "embedding_blob": embedding,
        }
        rows = [
            {**base, "id": 1, "folder_id": 7, "filename": "Proposal Photo-45.jpg", "content_hash": "a", "created_at": 100, "dhash": "0000000000000000"},
            {**base, "id": 2, "folder_id": 7, "filename": "Proposal Photo-46.jpg", "content_hash": "b", "created_at": 112, "dhash": "ffff000000000000"},
            {**base, "id": 3, "folder_id": 8, "filename": "Proposal Photo-47.jpg", "content_hash": "c", "created_at": 112, "dhash": "00ffff0000000000"},
            {**base, "id": 4, "folder_id": 7, "filename": "Proposal Photo-48.jpg", "content_hash": "d", "created_at": 200, "dhash": "0000ffff00000000"},
            {**base, "id": 5, "folder_id": 7, "filename": "2025-05-09_post.jpg", "content_hash": "e", "created_at": 112, "dhash": "00000000ffff0000"},
        ]
        best_pairs = [
            pair for pair in service.build_similarity_pairs(rows)
            if pair["kind"] == "bestShot"
        ]
        self.assertEqual(
            [(pair["left"], pair["right"]) for pair in best_pairs],
            [(1, 2)],
        )

    def test_same_moment_takes_priority_over_generic_crop_classification(self):
        value = 1 / (512 ** 0.5)
        embedding = struct.pack("<512f", *([value] * 512))
        rows = [
            {"id": 1, "folder_id": 7, "filename": "Proposal Photo-45.jpg", "width": 1200, "height": 800, "content_hash": "a", "created_at": 100, "modified_at": 100, "dhash": "0000000000000000", "embedding_blob": embedding},
            {"id": 2, "folder_id": 7, "filename": "Proposal Photo-46.jpg", "width": 1200, "height": 800, "content_hash": "b", "created_at": 112, "modified_at": 112, "dhash": "00000000000007ff", "embedding_blob": embedding},
        ]
        self.assertEqual(service.build_similarity_pairs(rows)[0]["kind"], "bestShot")

    def test_capture_sequences_reject_batch_download_names(self):
        self.assertTrue(service.adjacent_capture_sequence("IMG_1042.HEIC", "IMG_1043.HEIC"))
        self.assertTrue(service.adjacent_capture_sequence("Proposal Photo-45.jpg", "Proposal Photo-46.jpg"))
        self.assertFalse(service.adjacent_capture_sequence("2025-05-09_post.jpg", "2025-05-12_post.jpg"))
        self.assertFalse(service.adjacent_capture_sequence("file 384x392_229899.jpg", "file 393x404_229982.jpg"))

    def test_similarity_review_schema_is_initialized(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,folder_id INTEGER,missing INTEGER);
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                table = initialized.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='media_similarity_reviews'"
                ).fetchone()
                self.assertIsNotNone(table)

    def test_exact_duplicate_keeper_prefers_explicit_and_stable_associations(self):
        rows = [
            {"id": 4, "disposition": "remove", "favorite": 0, "reference_count": 5},
            {"id": 3, "disposition": None, "favorite": 0, "reference_count": 2},
            {"id": 2, "disposition": None, "favorite": 1, "reference_count": 0},
            {"id": 1, "disposition": "keep", "favorite": 0, "reference_count": 0},
        ]
        self.assertEqual(service.exact_duplicate_keeper(rows)["id"], 1)
        self.assertEqual(service.exact_duplicate_keeper(rows[:2])["id"], 3)

    def test_exact_duplicate_payload_recommends_keeper_and_excludes_trash(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(
                id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,
                path TEXT,filename TEXT,media_type TEXT,width INTEGER,height INTEGER,
                size_bytes INTEGER,created_at REAL,modified_at REAL,
                duration_seconds REAL,favorite INTEGER,missing INTEGER,content_hash TEXT
            );
            CREATE TABLE media_curation(media_id INTEGER,disposition TEXT,trashed_at REAL);
            CREATE TABLE media_references(path TEXT,media_item_id INTEGER,folder_id INTEGER);
            INSERT INTO media_items VALUES
                (1,1,1,'old.jpg','old.jpg','image',100,100,50,1,1,NULL,0,0,'same'),
                (2,1,1,'linked.jpg','linked.jpg','image',100,100,50,2,2,NULL,0,0,'same'),
                (3,1,1,'favorite.jpg','favorite.jpg','image',100,100,50,3,3,NULL,1,0,'same'),
                (4,1,1,'trashed.jpg','trashed.jpg','image',100,100,50,4,4,NULL,0,0,'same');
            INSERT INTO media_curation VALUES(4,NULL,100);
            INSERT INTO media_references VALUES('one',2,1),('two',2,1);
        """)
        payload = service.exact_duplicate_payload(database, limit=10)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["groups"][0]["recommendedId"], 3)
        self.assertEqual([item["id"] for item in payload["groups"][0]["items"]], [1, 2, 3])
        action_groups = service.exact_duplicate_action_groups(database, ["same"])
        self.assertEqual(len(action_groups), 1)
        self.assertEqual(action_groups[0]["keeper"]["id"], 3)
        self.assertEqual(service.exact_duplicate_hashes(database, limit=None), ["same"])
        self.assertEqual(service.exact_duplicate_action_groups(database, ["missing"]), [])

    def test_exact_duplicate_groups_ignore_symlink_references(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "canonical.jpg"
            duplicate = root / "duplicate.jpg"
            reference = root / "reference.jpg"
            canonical.write_bytes(b"same bytes")
            duplicate.write_bytes(b"same bytes")
            reference.symlink_to(canonical)
            database = sqlite3.connect(":memory:")
            database.row_factory = sqlite3.Row
            database.executescript("""
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,path TEXT,size_bytes INTEGER,favorite INTEGER,
                    missing INTEGER,content_hash TEXT
                );
                CREATE TABLE media_curation(media_id INTEGER,disposition TEXT,trashed_at REAL);
                CREATE TABLE media_references(media_item_id INTEGER);
            """)
            database.executemany(
                "INSERT INTO media_items VALUES(?,?,10,0,0,'same')",
                ((1, str(canonical)), (2, str(duplicate)), (3, str(reference))),
            )
            groups = service.physical_exact_duplicate_groups(database)
            self.assertEqual([[item["id"] for item in group["items"]] for group in groups], [[1, 2]])

    def test_exact_consolidation_requires_removed_rows_and_references(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,missing INTEGER);
            CREATE TABLE media_references(path TEXT,media_item_id INTEGER);
            INSERT INTO media_items VALUES(1,0),(2,0);
            INSERT INTO media_references VALUES('duplicate.jpg',2);
        """)
        self.assertFalse(service.exact_consolidation_completed(database, 1, [2]))
        database.execute("UPDATE media_references SET media_item_id=1 WHERE media_item_id=2")
        database.execute("DELETE FROM media_items WHERE id=2")
        self.assertTrue(service.exact_consolidation_completed(database, 1, [2]))

    def test_exact_group_reconciliation_marks_only_stale_siblings_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            present = root / "present.jpg"
            present.write_bytes(b"same")
            database = sqlite3.connect(":memory:")
            database.row_factory = sqlite3.Row
            database.execute(
                "CREATE TABLE media_items(id INTEGER PRIMARY KEY,content_hash TEXT,path TEXT,missing INTEGER)"
            )
            database.executemany(
                "INSERT INTO media_items VALUES(?,?,?,0)",
                (
                    (1, "same", str(present)),
                    (2, "same", str(root / "gone.jpg")),
                    (3, "offline", str(root / "offline-one.jpg")),
                    (4, "offline", str(root / "offline-two.jpg")),
                ),
            )
            changed = service.reconcile_missing_exact_group_items(database, ["same", "offline"])
            states = dict(database.execute("SELECT id,missing FROM media_items"))
            self.assertEqual(changed, 1)
            self.assertEqual(states, {1: 0, 2: 1, 3: 0, 4: 0})

    def test_exact_duplicate_job_persists_progress_without_request_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,path TEXT,
                    filename TEXT,media_type TEXT,width INTEGER,height INTEGER,size_bytes INTEGER,
                    created_at REAL,modified_at REAL,imported_at REAL,duration_seconds REAL,
                    favorite INTEGER DEFAULT 0,missing INTEGER DEFAULT 0,content_hash TEXT
                );
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                CREATE TABLE media_curation(
                    media_id INTEGER PRIMARY KEY,disposition TEXT,trashed_at REAL,updated_at REAL
                );
                CREATE TABLE media_references(path TEXT,media_item_id INTEGER,folder_id INTEGER);
                INSERT INTO media_items VALUES
                    (1,1,1,'/one.jpg','one.jpg','image',100,100,50,1,1,1,NULL,0,0,'same'),
                    (2,1,1,'/two.jpg','two.jpg','image',100,100,50,2,2,2,NULL,0,0,'same');
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                now = time.time()
                initialized.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("job", "exactDuplicates", "queued", 1, 0, 0, 0, 0,
                     json.dumps({"action": "trash", "hashes": ["same"]}), "Queued", now, now),
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(
                database=database_path,
                cache=root / "Thumbnails",
                duplicate_lock=threading.Lock(),
            )
            handler.server.cache.mkdir()
            handler.pause_active_scans_for_maintenance = lambda _job_id: []
            handler.run_exact_duplicate_job("job")
            with service.open_database(database_path) as checked:
                operation = checked.execute(
                    "SELECT status,completed_units,failed_units,processed_items FROM media_operations WHERE id='job'"
                ).fetchone()
                trashed = checked.execute(
                    "SELECT COUNT(*) FROM media_curation WHERE trashed_at IS NOT NULL"
                ).fetchone()[0]
            self.assertEqual(tuple(operation), ("completed", 1, 0, 2))
            self.assertEqual(trashed, 2)

    def test_exact_duplicate_job_stops_after_native_worker_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,scan_status TEXT);
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,folder_id INTEGER,missing INTEGER);
            """)
            database.close()
            with service.open_database(database_path, initialize=True) as database:
                now = time.time()
                database.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("job", "exactDuplicates", "queued", 2, 0, 0, 0, 0,
                     json.dumps({"action": "consolidate", "hashes": ["one", "two"]}),
                     "Queued", now, now),
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(
                database=database_path,
                cache=root / "Thumbnails",
                duplicate_lock=threading.Lock(),
            )
            handler.server.cache.mkdir()
            handler.pause_active_scans_for_maintenance = lambda _job_id: []
            calls = []

            def fail_once(_action, hashes):
                calls.append(hashes)
                return {
                    "failedGroups": 1,
                    "items": 0,
                    "estimatedBytes": 0,
                    "failureMessage": "Native media reader timed out",
                }

            handler.exact_duplicate_action_result = fail_once
            handler.run_exact_duplicate_job("job")
            with service.open_database(database_path) as checked:
                operation = checked.execute(
                    "SELECT status,completed_units,failed_units,processed_items,message "
                    "FROM media_operations WHERE id='job'"
                ).fetchone()
            self.assertEqual(calls, [["one"]])
            self.assertEqual(tuple(operation[:4]), ("failed", 0, 0, 0))
            self.assertIn("Native media reader timed out", operation[4])

    def test_exact_duplicate_job_continues_after_group_level_native_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(id INTEGER PRIMARY KEY,scan_status TEXT);
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,folder_id INTEGER,missing INTEGER);
            """)
            database.close()
            with service.open_database(database_path, initialize=True) as database:
                now = time.time()
                database.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("job", "exactDuplicates", "queued", 2, 0, 0, 0, 0,
                     json.dumps({"action": "consolidate", "hashes": ["one", "two"]}),
                     "Queued", now, now),
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(
                database=database_path,
                cache=root / "Thumbnails",
                duplicate_lock=threading.Lock(),
            )
            handler.server.cache.mkdir()
            handler.pause_active_scans_for_maintenance = lambda _job_id: []
            calls = []

            def fail_then_succeed(_action, hashes):
                calls.append(hashes)
                if hashes == ["one"]:
                    return {
                        "failedGroups": 1,
                        "items": 0,
                        "estimatedBytes": 0,
                        "failureMessage": "Native media operation failed",
                    }
                return {
                    "failedGroups": 0,
                    "items": 1,
                    "estimatedBytes": 50,
                    "failureMessage": None,
                }

            handler.exact_duplicate_action_result = fail_then_succeed
            handler.run_exact_duplicate_job("job")
            with service.open_database(database_path) as checked:
                operation = checked.execute(
                    "SELECT status,completed_units,failed_units,processed_items,message "
                    "FROM media_operations WHERE id='job'"
                ).fetchone()
            self.assertEqual(calls, [["one"], ["two"]])
            self.assertEqual(tuple(operation[:4]), ("completed_with_errors", 1, 1, 1))
            self.assertIn("1 groups needing review", operation[4])

    def test_exact_duplicate_job_pauses_active_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE libraries(
                    id INTEGER PRIMARY KEY,name TEXT,root_path TEXT,created_at REAL,
                    updated_at REAL,scan_status TEXT
                );
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,folder_id INTEGER,missing INTEGER);
            """)
            database.close()
            with service.open_database(database_path, initialize=True) as database:
                database.execute(
                    "INSERT INTO libraries(name,root_path,created_at,updated_at,scan_status) "
                    "VALUES('Family','/photos',?,?, 'scanning')",
                    (time.time(), time.time()),
                )
                now = time.time()
                database.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("job", "exactDuplicates", "queued", 1, 0, 0, 0, 0,
                     json.dumps({"action": "trash", "hashes": ["same"]}),
                     "Queued", now, now),
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(database=database_path, cache=root / "Thumbnails")
            handler.server.cache.mkdir()

            def finish_scan():
                deadline = time.monotonic() + 1
                cancellation = root / "scan-1.cancel"
                while not cancellation.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                with service.open_database(database_path) as database:
                    database.execute("UPDATE libraries SET scan_status='idle' WHERE id=1")

            worker = threading.Thread(target=finish_scan)
            worker.start()
            paused = handler.pause_active_scans_for_maintenance("job", timeout_seconds=1)
            worker.join()
            self.assertEqual(paused, [1])
            self.assertTrue((root / "scan-1.cancel").exists())
            with service.open_database(database_path) as database:
                message = database.execute(
                    "SELECT message FROM media_operations WHERE id='job'"
                ).fetchone()[0]
            self.assertIn("Pausing", message)

    def test_purge_trash_job_persists_progress_without_request_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(
                    id INTEGER PRIMARY KEY,library_id INTEGER,folder_id INTEGER,path TEXT,
                    filename TEXT,media_type TEXT,width INTEGER,height INTEGER,size_bytes INTEGER,
                    created_at REAL,modified_at REAL,imported_at REAL,duration_seconds REAL,
                    favorite INTEGER DEFAULT 0,missing INTEGER DEFAULT 0,content_hash TEXT
                );
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                CREATE TABLE media_curation(
                    media_id INTEGER PRIMARY KEY,disposition TEXT,trashed_at REAL,updated_at REAL
                );
                CREATE TABLE media_references(path TEXT,media_item_id INTEGER,folder_id INTEGER);
                INSERT INTO media_items VALUES
                    (1,1,1,'/one.jpg','one.jpg','image',100,100,40,1,1,1,NULL,0,0,'one'),
                    (2,1,1,'/two.jpg','two.jpg','image',100,100,60,2,2,2,NULL,0,0,'two');
                INSERT INTO media_curation VALUES
                    (1,'remove',10,10),(2,'remove',20,20);
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                now = time.time()
                initialized.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("purge", "purgeTrash", "queued", 2, 0, 0, 0, 0,
                     "{}", "Queued", now, now),
                )
            handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
            handler.server = SimpleNamespace(
                database=database_path,
                cache=root / "Thumbnails",
                purge_lock=threading.Lock(),
            )
            handler.server.cache.mkdir()

            def finish_requests(item_ids):
                with service.open_database(database_path) as working:
                    working.executemany("DELETE FROM media_curation WHERE media_id=?", ((item_id,) for item_id in item_ids))
                    working.executemany("DELETE FROM media_items WHERE id=?", ((item_id,) for item_id in item_ids))
                return []

            handler.purge_items_immediately = finish_requests
            handler.run_purge_trash_job("purge")
            with service.open_database(database_path) as checked:
                operation = checked.execute(
                    """SELECT status,completed_units,failed_units,processed_items,estimated_bytes
                       FROM media_operations WHERE id='purge'"""
                ).fetchone()
                event = checked.execute(
                    "SELECT event_type,group_kind,item_count,estimated_bytes FROM media_cleanup_events"
                ).fetchone()
            self.assertEqual(tuple(operation), ("completed", 2, 0, 2, 100))
            self.assertEqual(tuple(event), ("deleted", "recentlyDeleted", 2, 100))

    def test_purge_items_bypasses_background_worker_queue(self):
        handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
        calls = []
        handler.server = SimpleNamespace(
            run_native_media=lambda command, timeout_seconds: calls.append((command, timeout_seconds))
        )
        handler.queue_requests = lambda *_args, **_kwargs: self.fail(
            "Permanent deletion must not wait behind the background worker queue"
        )

        failures = handler.purge_items_immediately([12, 34])

        self.assertEqual(failures, [])
        self.assertEqual(calls, [
            (["purge-item", "12", "now"], 90),
            (["purge-item", "34", "now"], 90),
        ])

    def test_viewer_thumbnail_can_request_larger_browser_preview(self):
        handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
        handler.server = SimpleNamespace(mark_interactive_activity=lambda: None)
        requested = []
        handler.thumbnail = lambda item_id, size, modified_at: requested.append(size) or Path("/tmp/preview.jpg")
        handler.send_file = lambda *_args, **_kwargs: None
        database = mock.MagicMock()
        database.execute.return_value.fetchone.return_value = {
            "id": 1,
            "media_type": "image",
            "modified_at": 1,
        }
        handler.server.database = Path("/tmp/test.sqlite")

        with mock.patch.object(service, "open_database") as open_database:
            open_database.return_value.__enter__.return_value = database
            handler.media(1, "thumbnail", {"size": ["1200"]})

        self.assertEqual(requested, [1200])

    def test_cleanup_tracking_and_video_fingerprint_schema_are_initialized(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,folder_id INTEGER,missing INTEGER);
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
            """)
            database.commit()
            database.close()
            with service.open_database(database_path, initialize=True) as initialized:
                tables = {
                    row[0] for row in initialized.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
                self.assertIn("media_cleanup_events", tables)
                self.assertIn("media_operations", tables)
                self.assertIn("media_video_fingerprints", tables)

    def test_video_overlap_finds_shifted_shared_footage(self):
        hashes = [
            "0000000000000000",
            "ffffffffffffffff",
            "aaaaaaaaaaaaaaaa",
            "5555555555555555",
        ]
        rows = [
            {
                "id": 1,
                "content_hash": "one",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": index * 4 + 2, "hash": value}
                    for index, value in enumerate(hashes)
                ]),
            },
            {
                "id": 2,
                "content_hash": "two",
                "duration_seconds": 24,
                "samples_json": json.dumps([
                    {"time": index * 4 + 5, "hash": value}
                    for index, value in enumerate(hashes)
                ]),
            },
        ]
        pairs = service.build_video_overlap_pairs(rows)
        self.assertEqual(len(pairs), 1)
        self.assertEqual((pairs[0]["left"], pairs[0]["right"]), (1, 2))
        self.assertGreaterEqual(pairs[0]["sharedPercent"], 75)
        self.assertEqual(pairs[0]["matchedFrames"], 4)

    def test_video_overlap_rejects_unrelated_sequences(self):
        rows = [
            {
                "id": 1,
                "content_hash": "one",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": 2, "hash": "0000000000000000"},
                    {"time": 6, "hash": "ffffffffffffffff"},
                    {"time": 10, "hash": "aaaaaaaaaaaaaaaa"},
                ]),
            },
            {
                "id": 2,
                "content_hash": "two",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": 2, "hash": "0f0f0f0f0f0f0f0f"},
                    {"time": 6, "hash": "f0f0f0f0f0f0f0f0"},
                    {"time": 10, "hash": "3333333333333333"},
                ]),
            },
        ]
        self.assertEqual(service.build_video_overlap_pairs(rows), [])

    def test_video_overlap_rejects_repetitive_low_diversity_frames(self):
        rows = [
            {
                "id": 1,
                "content_hash": "one",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": 2, "hash": "0000000000000000"},
                    {"time": 6, "hash": "0000000000000001"},
                    {"time": 10, "hash": "0000000000000003"},
                ]),
            },
            {
                "id": 2,
                "content_hash": "two",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": 3, "hash": "0000000000000000"},
                    {"time": 7, "hash": "0000000000000001"},
                    {"time": 11, "hash": "0000000000000003"},
                ]),
            },
        ]
        self.assertEqual(service.build_video_overlap_pairs(rows), [])

    def test_video_overlap_rejects_inconsistent_temporal_alignment(self):
        hashes = ["0000000000000000", "ffffffffffffffff", "aaaaaaaaaaaaaaaa"]
        rows = [
            {
                "id": 1,
                "content_hash": "one",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": value, "hash": hash_value}
                    for value, hash_value in zip((2, 6, 10), hashes)
                ]),
            },
            {
                "id": 2,
                "content_hash": "two",
                "duration_seconds": 20,
                "samples_json": json.dumps([
                    {"time": value, "hash": hash_value}
                    for value, hash_value in zip((2, 8, 15), hashes)
                ]),
            },
        ]
        self.assertEqual(service.build_video_overlap_pairs(rows), [])

    def test_video_overlap_collapses_near_complete_cliques_and_counts_unique_savings(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(
                id INTEGER PRIMARY KEY,duration_seconds REAL,width INTEGER,height INTEGER,
                size_bytes INTEGER,favorite INTEGER,missing INTEGER
            );
            CREATE TABLE media_curation(media_id INTEGER,disposition TEXT,trashed_at REAL);
            INSERT INTO media_items VALUES
                (1,30,1920,1080,1000,0,0),
                (2,20,1280,720,400,0,0),
                (3,20,1280,720,300,0,0);
        """)
        pairs = [
            {"left": 1, "right": 2, "kind": "video", "sharedSeconds": 20, "sharedPercent": 95, "confidence": 100, "matchedFrames": 5},
            {"left": 1, "right": 3, "kind": "video", "sharedSeconds": 20, "sharedPercent": 95, "confidence": 100, "matchedFrames": 5},
            {"left": 2, "right": 3, "kind": "video", "sharedSeconds": 20, "sharedPercent": 95, "confidence": 100, "matchedFrames": 5},
        ]
        payload = service.video_overlap_payload(database, pairs, limit=0)
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["potentialBytes"], 700)

    def test_presentation_ranking_rejects_ambiguous_and_weak_results(self):
        positive = [
            {"id": 1, "score": 0.25},
            {"id": 2, "score": 0.24},
            {"id": 3, "score": 0.20},
        ]
        negative = [{"id": 2, "score": 0.26}] + [
            {"id": value, "score": 0.2} for value in range(10, 90)
        ]
        self.assertEqual(service.conservative_presentation_ids(positive, negative), [1])

    def test_health_check_does_not_run_an_integrity_scan(self):
        source = Path(service.__file__).read_text(encoding="utf-8")
        health = source.split("    def health(self):", 1)[1].split("    def cleanup_stats(self):", 1)[0]
        self.assertNotIn("quick_check", health)
        self.assertIn('"database": "reachable"', health)

    def test_cleanup_stats_separate_finalized_and_pending_removals(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE deleted_media_fingerprints(
                content_hash TEXT PRIMARY KEY,size_bytes INTEGER,
                first_deleted_at REAL,last_deleted_at REAL,deletion_count INTEGER
            );
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,size_bytes INTEGER,missing INTEGER,favorite INTEGER);
            CREATE TABLE media_curation(media_id INTEGER,trashed_at REAL,disposition TEXT);
            CREATE TABLE media_text_analysis(media_id INTEGER,error_message TEXT);
            CREATE TABLE media_recovery_sources(media_id INTEGER,download_url TEXT);
            CREATE TABLE media_cleanup_events(
                id TEXT PRIMARY KEY,event_type TEXT,group_kind TEXT,
                item_count INTEGER,estimated_bytes INTEGER,created_at REAL
            );
            INSERT INTO deleted_media_fingerprints VALUES
                ('a',100,1,3,2),('b',250,2,2,1);
            INSERT INTO media_items VALUES
                (1,900,0,0),(2,400,0,0),(3,100,0,0),(4,50,0,0),(5,25,0,1);
            INSERT INTO media_curation VALUES(1,4,NULL),(2,NULL,NULL);
            INSERT INTO media_text_analysis VALUES
                (3,'decode failed'),(4,'decode failed'),(5,'decode failed');
            INSERT INTO media_recovery_sources VALUES(3,'https://media.example/fresh');
            INSERT INTO media_cleanup_events VALUES
                ('one','consolidated','exact',4,1000,10),
                ('two','deleted','recentlyDeleted',2,2500,20),
                ('three','used_recommendation','resized',3,9000,30);
        """)
        stats = service.cleanup_stats(database)
        self.assertEqual(stats["finalizedItems"], 3)
        self.assertEqual(stats["uniqueFinalizedItems"], 2)
        self.assertEqual(stats["finalizedBytes"], 450)
        self.assertEqual(stats["pendingItems"], 1)
        self.assertEqual(stats["pendingBytes"], 900)
        self.assertEqual(stats["invalidItems"], 3)
        self.assertEqual(stats["recoverableItems"], 1)
        self.assertEqual(stats["unrecoverableItems"], 1)
        self.assertEqual(stats["protectedUnreadableItems"], 1)
        self.assertEqual(stats["reclaimedBytes"], 3500)
        self.assertEqual(stats["reclaimedItems"], 6)
        self.assertEqual(stats["cleanupActions"], 2)
        self.assertEqual(stats["cleanupActiveDays"], 1)
        self.assertEqual(stats["firstCleanupAt"], 10)
        self.assertEqual(stats["lastCleanupAt"], 20)
        self.assertEqual(stats["reclaimedBreakdown"]["duplicates"], {"bytes": 1000, "items": 4})
        self.assertEqual(stats["reclaimedBreakdown"]["deleted"], {"bytes": 2500, "items": 2})

    def test_trash_reviewed_items_moves_every_pending_removal(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,content_hash TEXT,missing INTEGER);
            CREATE TABLE media_curation(
                media_id INTEGER PRIMARY KEY,disposition TEXT,trashed_at REAL,updated_at REAL
            );
            INSERT INTO media_items VALUES(1,NULL,0),(2,NULL,0),(3,NULL,0),(4,NULL,0);
            INSERT INTO media_curation VALUES
                (1,'remove',NULL,1),(2,'remove',NULL,1),(3,'keep',NULL,1),(4,'remove',50,50);
        """)
        trashed, remaining = service.trash_reviewed_items(database, 100)
        self.assertEqual((trashed, remaining), (2, 0))
        self.assertEqual(
            database.execute("SELECT COUNT(*) FROM media_curation WHERE trashed_at=100").fetchone()[0],
            2,
        )

    def test_cleanup_profiles_are_conservative_and_space_impact_protects_keeps(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(
                id INTEGER PRIMARY KEY,path TEXT,filename TEXT,media_type TEXT,size_bytes INTEGER,
                duration_seconds REAL,missing INTEGER,favorite INTEGER,content_hash TEXT
            );
            CREATE TABLE media_curation(media_id INTEGER,trashed_at REAL,disposition TEXT);
            CREATE TABLE media_references(path TEXT,media_item_id INTEGER,folder_id INTEGER);
            CREATE TABLE media_quality_analysis(
                media_id INTEGER,model_version TEXT,mean_luma REAL,dark_fraction REAL,
                light_fraction REAL,detail_score REAL,motion_score REAL,error_message TEXT
            );
            CREATE TABLE media_text_analysis(media_id INTEGER,is_text_heavy INTEGER,error_message TEXT);
            CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT);
            CREATE TABLE media_tags(media_item_id INTEGER,tag_id INTEGER,confidence REAL);
            INSERT INTO media_items VALUES
                (1,'dark.jpg','dark.jpg','image',100,NULL,0,0,'a'),
                (2,'kept-dark.jpg','kept-dark.jpg','image',200,NULL,0,0,'b'),
                (3,'Screenshot 1.png','Screenshot 1.png','image',300,NULL,0,0,'c'),
                (4,'clip.mov','clip.mov','video',400,0.7,0,0,'d'),
                (5,'normal.jpg','normal.jpg','image',500,NULL,0,0,'e'),
                (6,'copy-a.jpg','copy-a.jpg','image',100,NULL,0,0,'x'),
                (7,'copy-b.jpg','copy-b.jpg','image',100,NULL,0,0,'x'),
                (8,'trashed-copy.jpg','trashed-copy.jpg','image',100,NULL,0,0,'x'),
                (9,'favorite-copy.jpg','favorite-copy.jpg','image',100,NULL,0,1,'y'),
                (10,'kept-copy.jpg','kept-copy.jpg','image',100,NULL,0,0,'y');
            INSERT INTO media_curation VALUES
                (2,NULL,'keep'),(8,500,NULL),(10,NULL,'keep');
            INSERT INTO media_quality_analysis VALUES
                (1,'quality-signals-v1',0.01,0.99,0,0.001,NULL,NULL),
                (2,'quality-signals-v1',0.01,0.99,0,0.001,NULL,NULL),
                (3,'quality-signals-v1',0.5,0,0,0.08,NULL,NULL),
                (4,'quality-signals-v1',0.5,0,0,0.08,0.2,NULL),
                (5,'quality-signals-v1',0.5,0,0,0.08,NULL,NULL);
            INSERT INTO media_text_analysis VALUES(3,1,NULL);
        """)
        impact = service.cleanup_impact(database)
        self.assertEqual(impact["profiles"]["lowQuality"], {"items": 1, "bytes": 100})
        self.assertEqual(impact["profiles"]["accidentalVideo"], {"items": 1, "bytes": 400})
        self.assertEqual(impact["profiles"]["downloadedClutter"], {"items": 1, "bytes": 300})
        self.assertEqual(impact["profiles"]["exactDuplicates"], {"items": 1, "bytes": 100})
        self.assertEqual(impact["qualityAnalyzed"], 5)
        self.assertEqual(impact["qualityTotal"], 10)

    def test_face_index_status_counts_only_current_images(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,media_type TEXT,missing INTEGER);
            CREATE TABLE media_face_analysis(media_id INTEGER,face_count INTEGER,analyzed_at REAL);
            INSERT INTO media_items VALUES
                (1,'image',0),(2,'image',0),(3,'video',0),(4,'image',1);
            INSERT INTO media_face_analysis VALUES
                (1,2,10),(3,1,20),(4,4,30);
        """)
        self.assertEqual(service.face_index_status(database), {
            "total": 2,
            "analyzed": 1,
            "remaining": 1,
            "detected": 2,
            "latestAt": 10.0,
        })

    def test_care_index_status_counts_current_media_and_active_models(self):
        database = sqlite3.connect(":memory:")
        database.row_factory = sqlite3.Row
        database.executescript("""
            CREATE TABLE media_items(
                id INTEGER PRIMARY KEY,media_type TEXT,missing INTEGER,size_bytes INTEGER,
                duration_seconds REAL,content_hash TEXT
            );
            CREATE TABLE media_visual_hashes(media_id INTEGER,dhash TEXT);
            CREATE TABLE media_semantic_embeddings(media_id INTEGER,model_version TEXT,embedding_blob BLOB);
            CREATE TABLE media_video_fingerprints(media_id INTEGER,model_version TEXT,error_message TEXT);
            CREATE TABLE media_quality_analysis(media_id INTEGER,model_version TEXT);
            INSERT INTO media_items VALUES
                (1,'image',0,100,NULL,'hash-a'),
                (2,'image',0,100,NULL,NULL),
                (3,'image',0,200,NULL,'hash-c'),
                (4,'video',0,300,10,NULL),
                (5,'video',0,400,1,NULL),
                (6,'image',1,100,NULL,'stale');
            INSERT INTO media_visual_hashes VALUES (1,'one'),(6,'stale');
            INSERT INTO media_semantic_embeddings VALUES
                (1,'mobileclip-s0-v1',X'01'),(2,'old-model',X'02'),(6,'mobileclip-s0-v1',X'03');
            INSERT INTO media_video_fingerprints VALUES
                (4,'video-dhash-samples-v1',NULL),(5,'video-dhash-samples-v1','unreadable');
            INSERT INTO media_quality_analysis VALUES
                (1,'quality-signals-v1'),(2,'old-model'),(5,'quality-signals-v1'),(6,'quality-signals-v1');
        """)
        self.assertEqual(service.care_index_status(database), {
            "semanticAvailable": True,
            "checks": {
                "exact": {"total": 2, "analyzed": 1, "remaining": 1},
                "visual": {"total": 3, "analyzed": 1, "remaining": 2},
                "semantic": {"total": 3, "analyzed": 1, "remaining": 2},
                "video": {"total": 2, "analyzed": 2, "remaining": 0, "failed": 1},
                "quality": {"total": 4, "analyzed": 2, "remaining": 2},
            },
            "duplicates": {"total": 10, "analyzed": 5, "remaining": 5, "current": False},
            "care": {"total": 14, "analyzed": 7, "remaining": 7, "current": False},
        })
        self.assertEqual(service.care_index_status(database, semantic_enabled=False), {
            "semanticAvailable": False,
            "checks": {
                "exact": {"total": 2, "analyzed": 1, "remaining": 1},
                "visual": {"total": 3, "analyzed": 1, "remaining": 2},
                "video": {"total": 2, "analyzed": 2, "remaining": 0, "failed": 1},
                "quality": {"total": 4, "analyzed": 2, "remaining": 2},
            },
            "duplicates": {"total": 7, "analyzed": 4, "remaining": 3, "current": False},
            "care": {"total": 11, "analyzed": 6, "remaining": 5, "current": False},
        })

    def test_direct_media_path_requires_a_readable_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip.mp4"
            path.write_bytes(b"video")
            self.assertEqual(
                service.directly_readable_media_path({"path": str(path)}), path
            )
            self.assertIsNone(
                service.directly_readable_media_path({"path": str(path) + ".missing"})
            )

    def test_graphic_posts_combine_text_heavy_and_confident_screenshots(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY, media_type TEXT);
            CREATE TABLE media_text_analysis(media_id INTEGER, is_text_heavy INTEGER, error_message TEXT);
            CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE media_tags(media_item_id INTEGER, tag_id INTEGER, confidence REAL);
            INSERT INTO media_items VALUES(1, 'image'), (2, 'image'), (3, 'image'), (4, 'image');
            INSERT INTO media_text_analysis VALUES(1, 1, NULL), (2, 0, NULL), (3, 0, NULL), (4, 1, 'failed');
            INSERT INTO tags VALUES(1, 'screenshot');
            INSERT INTO media_tags VALUES(2, 1, 0.82), (3, 1, 0.24);
        """)
        condition = service.ai_filter_condition("graphicPost")
        rows = database.execute(
            f"SELECT id FROM media_items WHERE {condition} ORDER BY id"
        ).fetchall()
        self.assertEqual([row[0] for row in rows], [1, 2])

    def test_text_heavy_filter_remains_narrow(self):
        self.assertNotIn("media_tags", service.ai_filter_condition("textHeavy"))

    def test_screenshot_filter_is_separate_from_text_heavy_images(self):
        condition = service.ai_filter_condition("screenshot")
        self.assertIn("media_tags", condition)
        self.assertNotIn("media_text_analysis", condition)

    def test_screenshot_categories_match_ocr_without_implying_deletion(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY);
            CREATE TABLE media_text_analysis(media_id INTEGER, recognized_text TEXT, error_message TEXT);
            CREATE TABLE media_screenshot_categories(media_id INTEGER PRIMARY KEY, category TEXT);
            INSERT INTO media_items VALUES(1), (2), (3), (4);
            INSERT INTO media_text_analysis VALUES
                (1, 'Tomorrow weather forecast and humidity', NULL),
                (2, 'Order receipt and tracking number', NULL),
                (3, 'Ordinary family event note', NULL),
                (4, 'Instagram recipe ingredients: 2 tablespoons butter', NULL);
        """)
        weather = service.screenshot_category_condition("weather")
        orders = service.screenshot_category_condition("orders")
        calendar = service.screenshot_category_condition("calendar")
        recipes = service.screenshot_category_condition("recipes")
        social = service.screenshot_category_condition("social")
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {weather}")],
            [1],
        )
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {orders}")],
            [2],
        )
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {calendar}")],
            [],
        )
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {recipes}")],
            [4],
        )
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {social}")],
            [],
        )
        database.execute("INSERT INTO media_screenshot_categories VALUES(1, 'orders')")
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {weather}")],
            [],
        )
        self.assertEqual(
            [row[0] for row in database.execute(f"SELECT id FROM media_items WHERE {orders}")],
            [1, 2],
        )
        self.assertIsNone(service.screenshot_category_condition("unknown"))

    def test_saved_screenshot_category_includes_favorites_and_keep_decisions(self):
        condition = service.screenshot_category_condition("saved")
        self.assertIn("favorite=1", condition)
        self.assertIn("disposition='keep'", condition)

    def test_screenshot_category_schema_migrates_to_recipes(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "test.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript("""
                CREATE TABLE media_items(id INTEGER PRIMARY KEY,folder_id INTEGER,missing INTEGER);
                CREATE TABLE folders(id INTEGER PRIMARY KEY,library_id INTEGER,parent_path TEXT,path TEXT);
                INSERT INTO media_items VALUES(1,1,0);
                CREATE TABLE media_screenshot_categories(
                    media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
                    category TEXT NOT NULL CHECK(category IN ('conversations','orders','weather','travel','social','calendar','other')),
                    updated_at REAL NOT NULL
                );
                CREATE INDEX media_screenshot_category ON media_screenshot_categories(category,media_id);
                INSERT INTO media_screenshot_categories VALUES(1,'weather',100);
            """)
            database.close()
            with service.open_database(database_path, initialize=True) as migrated:
                self.assertEqual(
                    tuple(migrated.execute(
                        "SELECT media_id,category,updated_at FROM media_screenshot_categories"
                    ).fetchone()),
                    (1, "weather", 100.0),
                )
                migrated.execute(
                    "UPDATE media_screenshot_categories SET category='recipes',updated_at=200 WHERE media_id=1"
                )

    def test_people_filters_keep_secondary_analysis_fail_closed(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY);
            CREATE TABLE media_person_analysis(media_id INTEGER, person_count INTEGER);
            CREATE TABLE media_face_analysis(media_id INTEGER, face_count INTEGER);
            CREATE TABLE media_secondary_people_analysis(media_id INTEGER, model_version TEXT, person_detected INTEGER, error_message TEXT);
            CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE media_tags(media_item_id INTEGER, tag_id INTEGER, confidence REAL);
            INSERT INTO media_items VALUES(1), (2), (3), (4), (5), (6);
            INSERT INTO media_person_analysis VALUES(1, 1), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0);
            INSERT INTO media_face_analysis VALUES(1, 0), (2, 1), (3, 0), (4, 0), (5, 0), (6, 0);
            INSERT INTO tags VALUES(1, 'people');
            INSERT INTO media_tags VALUES(3, 1, 0.91), (4, 1, 0.49), (5, 1, 0.91);
            INSERT INTO media_secondary_people_analysis VALUES
                (5, 'florence-2-base-ft-coreml-f6c1a258-v1', 0, NULL),
                (6, 'florence-2-base-ft-coreml-f6c1a258-v1', 1, NULL);
        """)
        people = database.execute(
            f"SELECT id FROM media_items WHERE {service.people_filter_condition('1')} ORDER BY id"
        ).fetchall()
        no_people = database.execute(
            f"SELECT id FROM media_items WHERE {service.people_filter_condition('0')} ORDER BY id"
        ).fetchall()
        self.assertEqual([row[0] for row in people], [1, 2, 3, 6])
        self.assertEqual([row[0] for row in no_people], [4, 5])

    def test_identity_expansion_includes_all_active_exact_copies(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,content_hash TEXT,missing INTEGER);
            INSERT INTO media_items VALUES
                (1,'same',0),(2,'same',0),(3,'same',1),(4,'other',0),(5,NULL,0);
        """)
        self.assertEqual(service.expanded_identity_media_ids(database, [1]), [1, 2])
        self.assertEqual(service.expanded_identity_media_ids(database, [5]), [5])

    def test_trashing_reviewed_item_trashes_its_exact_identity(self):
        database = sqlite3.connect(":memory:")
        database.executescript("""
            CREATE TABLE media_items(id INTEGER PRIMARY KEY,content_hash TEXT,missing INTEGER);
            CREATE TABLE media_curation(
                media_id INTEGER PRIMARY KEY,disposition TEXT,trashed_at REAL,updated_at REAL
            );
            INSERT INTO media_items VALUES(1,'same',0),(2,'same',0),(3,'other',0);
            INSERT INTO media_curation VALUES(1,'remove',NULL,1);
        """)
        moved, remaining = service.trash_reviewed_items(database, 10)
        self.assertEqual((moved, remaining), (2, 0))
        rows = database.execute(
            "SELECT media_id FROM media_curation WHERE trashed_at=10 ORDER BY media_id"
        ).fetchall()
        self.assertEqual([row[0] for row in rows], [1, 2])


if __name__ == "__main__":
    unittest.main()
