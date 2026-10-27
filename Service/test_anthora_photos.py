import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from Service import anthora_service as service


FAKE_BRIDGE = r'''#!/usr/bin/env python3
import json
import pathlib
import sys

arguments = sys.argv[1:]
command = arguments[0]
if "--output" in arguments:
    output = pathlib.Path(arguments[arguments.index("--output") + 1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"fake-media")
    print(json.dumps({"output": str(output), "bytes": output.stat().st_size}))
elif command in ("status", "request-access"):
    print(json.dumps({"status": "authorized", "readable": True}))
elif command == "catalog":
    print(json.dumps({
        "assets": [{
            "id": "asset/one/L0/001",
            "filename": "IMG 0001.HEIC",
            "mediaType": "image",
            "width": 4032,
            "height": 3024,
            "duration": 0,
            "createdAt": "2026-10-18T12:30:00Z",
            "modifiedAt": None,
            "favorite": True,
            "hidden": False
        }],
        "offset": 0,
        "limit": 1,
        "total": 2
    }))
elif command == "albums":
    print(json.dumps({"albums": [{
        "id": "album/one/L0/040",
        "title": "Family",
        "assetCount": 12,
        "coverAssetId": "asset/one/L0/001"
    }]}))
else:
    print("unexpected command", file=sys.stderr)
    raise SystemExit(2)
'''


class PhotosBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.executable = self.root / "fake-photos-bridge"
        self.executable.write_text(FAKE_BRIDGE, encoding="utf-8")
        self.executable.chmod(self.executable.stat().st_mode | stat.S_IXUSR)
        self.client = service.PhotosBridgeClient(self.executable)

    def tearDown(self):
        self.temporary.cleanup()

    def handler(self):
        handler = service.AnthoraHandler.__new__(service.AnthoraHandler)
        handler.server = SimpleNamespace(
            photos=self.client,
            cache=self.root / "cache",
            mark_interactive_activity=mock.Mock(),
        )
        handler.send_json = mock.Mock()
        handler.send_file = mock.Mock()
        return handler

    def test_identifier_round_trip_and_validation(self):
        original = "A1B2C3/L0/001"
        encoded = service.encode_photo_identifier(original)
        self.assertNotIn("/", encoded)
        self.assertEqual(service.decode_photo_identifier(encoded), original)
        with self.assertRaises(ValueError):
            service.decode_photo_identifier("../private")

    def test_bridge_status_and_atomic_media_write(self):
        self.assertEqual(self.client.run(["status"])["status"], "authorized")
        output = self.root / "cache" / "preview.jpg"
        self.client.write(["thumbnail", "--id", "asset"], output)
        self.assertEqual(output.read_bytes(), b"fake-media")
        self.assertEqual(list(output.parent.glob(".*.tmp")), [])

    def test_items_map_photo_assets_and_page_with_opaque_ids(self):
        handler = self.handler()
        handler.photos_items({"limit": ["1"], "album": [service.encode_photo_identifier("album/one/L0/040")]})
        payload = handler.send_json.call_args.args[0]
        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["nextCursor"], "o:1")
        self.assertEqual(payload["items"][0]["name"], "IMG 0001.HEIC")
        self.assertIn("filename=IMG+0001.HEIC", payload["items"][0]["contentUrl"])
        self.assertIn("v=2026-10-18T12%3A30%3A00Z", payload["items"][0]["contentUrl"])
        self.assertEqual(service.decode_photo_identifier(payload["items"][0]["id"]), "asset/one/L0/001")

    def test_albums_include_remote_cover_and_asset_count(self):
        handler = self.handler()
        handler.photos_albums()
        album = handler.send_json.call_args.args[0]["folders"][0]
        self.assertEqual(album["name"], "Family")
        self.assertEqual(album["itemCount"], 12)
        self.assertIn("/api/photos/assets/", album["coverUrl"])

    def test_request_access_calls_bridge_and_closes_connection(self):
        handler = self.handler()
        handler.path = "/api/photos/request-access"
        handler.authorize = mock.Mock(return_value=True)
        handler.close_connection = False
        handler.do_POST()
        payload = handler.send_json.call_args.args[0]
        self.assertEqual(payload["status"], "authorized")
        self.assertTrue(payload["configured"])
        self.assertTrue(handler.close_connection)

    def test_thumbnail_and_original_are_generated_outside_photos_library(self):
        handler = self.handler()
        encoded = service.encode_photo_identifier("asset/one/L0/001")
        handler.photos_media(encoded, "thumbnail", {"size": ["480"]})
        thumbnail_call = handler.send_file.call_args
        self.assertEqual(thumbnail_call.kwargs["content_type"], "image/jpeg")
        self.assertTrue(thumbnail_call.args[0].is_relative_to(self.root / "cache"))

        handler.send_file.reset_mock()
        handler.photos_media(encoded, "content", {"filename": ["clip.mov"]})
        content_call = handler.send_file.call_args
        self.assertEqual(content_call.kwargs["content_type"], "video/quicktime")
        self.assertTrue(content_call.kwargs["allow_ranges"])
        self.assertTrue(content_call.args[0].is_relative_to(self.root / "cache"))


if __name__ == "__main__":
    unittest.main()
