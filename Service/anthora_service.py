#!/usr/bin/env python3
"""Dependency-free Anthora HTTP service for local and private-network access."""

import argparse
import base64
import datetime
import fcntl
import hashlib
import hmac
import html
import json
import math
import mimetypes
import os
import re
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
import urllib.error
import urllib.request
from contextlib import contextmanager
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator, Optional
from urllib.parse import parse_qs, parse_qsl, quote, urlencode, urlparse

DEFAULT_DB = Path.home() / "Library/Application Support/Anthora/anthora.sqlite"
DEFAULT_CACHE = Path.home() / "Library/Caches/AnthoraService/Thumbnails"
DEFAULT_READER = Path("/Applications/Anthora.app/Contents/Helpers/AnthoraMediaReader")
DEFAULT_QUEUE = Path.home() / "Library/Caches/AnthoraService/Queue"
DEFAULT_ANALYSIS_QUEUE = Path.home() / "Library/Caches/AnthoraService/AnalysisQueue"
DEFAULT_WEB_ROOT = Path.home() / "Library/Application Support/Anthora/Web"
DEFAULT_PHOTOS_BRIDGE = Path("/Applications/Anthora.app/Contents/Helpers/AnthoraPhotosBridge")
SOCIAL_ARCHIVE_SYNC_INTERVAL_SECONDS = max(
    60, int(os.environ.get("ANTHORA_SOCIAL_SYNC_INTERVAL_SECONDS", "900"))
)
MAX_PAGE_SIZE = 200
VIDEO_RANGE_CHUNK_BYTES = 4 * 1024 * 1024
REFERENCE_REFRESH_SECONDS = 300
SECONDARY_PEOPLE_MODEL = "florence-2-base-ft-coreml-f6c1a258-v1"
reference_refreshes = {}
reference_lock = threading.Lock()
FOLDER_CACHE_SECONDS = 120
folder_response_cache = {}
folder_cache_lock = threading.Lock()
thumbnail_locks = {}
thumbnail_locks_guard = threading.Lock()
# ImageIO-backed `sips` conversions become unreliable when a large gallery
# starts too many at once. A small shared pool keeps lazy thumbnail generation
# responsive without producing intermittent blank cards.
sips_thumbnail_slots = threading.BoundedSemaphore(2)
# Network-backed APFS volumes can leave a long-running ImageIO process blocked
# in open(2) after enough random preview reads. Short-lived reader processes do
# not inherit that wedged file state. Keep their concurrency deliberately small
# so deep scrolling cannot turn into a burst of random disk reads.
native_media_slots = threading.BoundedSemaphore(3)
interactive_activity_lock = threading.Lock()
interactive_activity_updated_at = 0.0
analysis_process_lock = threading.Lock()
analysis_suspended = False
duplicate_similarity_lock = threading.Lock()
search_fusion_cache_lock = threading.Lock()
search_fusion_cache = {}
care_undo_lock = threading.Lock()
care_undo_actions = {}
CARE_UNDO_SECONDS = 600
PEOPLE_CACHE_NAMES = ("people-index-v7.json", "people-social-v7.json")
AUTH_COOKIE_NAME = "anthora_access"
AUTH_SESSION_SECONDS = 30 * 24 * 60 * 60
EMBEDDING_MODEL = os.environ.get("ANTHORA_EMBEDDING_MODEL", "mobileclip-s0-v1")
SEMANTIC_DUPLICATE_MODEL = EMBEDDING_MODEL
SEMANTIC_ENABLED = os.environ.get("ANTHORA_SEMANTIC_ENABLED", "1").lower() not in {
    "0", "false", "no", "off"
}
MANAGE_ANALYSIS_WORKER = os.environ.get("ANTHORA_MANAGE_ANALYSIS_WORKER", "1").lower() not in {
    "0", "false", "no", "off"
}
TEXT_ANALYSIS_MODEL = "vision-ocr-classify-arcface-mobileclip-v8"
SEMANTIC_CROP_THRESHOLD = 0.985
SEMANTIC_EDIT_THRESHOLD = 0.992
VISUAL_RESIZED_HASH_THRESHOLD = 2
VISUAL_CROP_HASH_THRESHOLD = 4
VIDEO_FINGERPRINT_MODEL = "video-dhash-samples-v1"
QUALITY_MODEL = "quality-signals-v1"
BEST_SHOT_THRESHOLD = 0.97
PRESENTATION_PROMPTS = {
    "feminine": "a photo of a woman",
    "masculine": "a photo of a man",
}
SEARCH_MEDIA_WORDS = {
    "video": "video", "videos": "video", "clip": "video", "clips": "video",
    "photo": "image", "photos": "image", "picture": "image", "pictures": "image",
    "image": "image", "images": "image",
}
SEARCH_FILLER_WORDS = {
    "all", "find", "show", "me", "my", "the", "a", "an", "of", "every",
    "media", "that", "look", "looks", "where",
}
OCR_INTENT_WORDS = {
    "receipt", "receipts", "menu", "menus", "invitation", "invitations",
    "sign", "signs", "license plate", "screenshot", "screenshots", "document",
    "documents",
}
SAVED_SEARCH_PARAM_KEYS = {
    "q", "type", "sort", "favorite", "ai", "aspect", "resolution",
    "faces", "people", "peopleKey", "presentation", "screenshotCategory",
}
SCREENSHOT_CATEGORY_TERMS = {
    "conversations": ("message", "messages", "imessage", "delivered", "reply", "replied", "chat"),
    "orders": ("receipt", "order", "subtotal", "checkout", "tracking number", "purchase", "invoice"),
    "weather": ("weather", "forecast", "humidity", "precipitation", "temperature", "wind advisory"),
    "travel": ("directions", "flight", "boarding pass", "hotel", "maps", "route guidance"),
    "social": ("instagram", "facebook", "tiktok", "reddit", "followers", "repost", "retweet", "meme"),
    "calendar": ("calendar", "appointment", "schedule", "reminder"),
    "recipes": ("recipe", "ingredients", "tablespoon", "teaspoon", "preheat", "servings", "bake for"),
}
SCREENSHOT_CATEGORY_KEYS = (*SCREENSHOT_CATEGORY_TERMS.keys(), "other")
SCREENSHOT_CATEGORY_PRIORITY = (
    "recipes", "weather", "orders", "travel", "conversations", "calendar", "social",
)
DEFAULT_SAVED_SEARCHES = (
    ("default-recent-videos", "Recent Videos", {"type": "video", "sort": "newest"}),
    ("default-screenshots", "Screenshots", {"ai": "screenshot", "sort": "newest"}),
    ("default-group-photos", "Group Photos", {"type": "image", "faces": "many", "sort": "newest"}),
)


def commercial_build() -> bool:
    return os.environ.get("ANTHORA_COMMERCIAL_BUILD", "0").lower() in {
        "1", "true", "yes", "on"
    }


def license_state_path(database_path: Path) -> Path:
    shared_path = os.environ.get("ANTHORA_LICENSE_PATH")
    if shared_path:
        return Path(shared_path)
    return database_path.parent / "license.json"


def read_license_state(database_path: Path) -> dict:
    # All features are free, including previously installed commercial builds.
    # Do not read license keys or contact the retired licensing provider.
    return {"licensed": True, "edition": "free"}


def activate_license(database_path: Path, license_key: str, opener=None) -> dict:
    # Compatibility for an older UI connected to this service; no network call.
    return read_license_state(database_path)


def license_status(database_path: Path) -> dict:
    state = read_license_state(database_path)
    with open_database(database_path) as database:
        indexed = int(database.execute(
            "SELECT COUNT(*) FROM media_items WHERE missing=0"
        ).fetchone()[0])
    return {
        **state,
        "freeMediaLimit": None,
        "unlimitedLibrary": True,
        "features": {"books": state["licensed"], "cleanup": state["licensed"]},
        "indexedItems": indexed,
        "remainingFreeItems": None,
        "atFreeLimit": False,
        "purchaseUrl": None,
    }


def paid_action(path: str) -> bool:
    return bool(
        path in {
            "/api/books",
            "/api/books/export-check",
            "/api/curation/trash-removed",
            "/api/curation/purge-trash",
            "/api/curation/purge-trash/job",
            "/api/duplicates/exact/bulk",
            "/api/duplicates/exact/job",
            "/api/duplicates/consolidate",
            "/api/duplicates/use-recommendation",
            "/api/cleanup/unreadable/redownload",
            "/api/cleanup/unreadable/trash-unrecoverable",
        }
        or re.fullmatch(r"/api/items/\d+/(delete-now|redownload)", path)
    )


def generate_thumbnail_with_sips(source: Path, output: Path, pixels: int) -> None:
    """Create a read-only image preview with macOS's native image converter."""
    native_environment = os.environ.copy()
    for variable in ("PYTHONHOME", "PYTHONPATH", "PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE"):
        native_environment.pop(variable, None)
    with sips_thumbnail_slots:
        result = subprocess.run(
            [
                "/usr/bin/sips", "-s", "format", "jpeg", "-Z", str(pixels),
                str(source), "--out", str(output),
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            env=native_environment,
        )
    if result.returncode != 0 or not output.exists() or output.stat().st_size == 0:
        raise RuntimeError(result.stderr.strip() or "macOS could not create an image preview")


def generate_thumbnail_with_quicklook(source: Path, output: Path, pixels: int) -> None:
    """Create a preview through Quick Look, which handles older JPEGs reliably."""
    native_environment = os.environ.copy()
    for variable in ("PYTHONHOME", "PYTHONPATH", "PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE"):
        native_environment.pop(variable, None)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="anthora-quicklook-", dir=output.parent) as directory:
        preview_directory = Path(directory)
        with sips_thumbnail_slots:
            quicklook = subprocess.run(
                [
                    "/usr/bin/qlmanage", "-t", "-s", str(pixels),
                    "-o", str(preview_directory), str(source),
                ],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                env=native_environment,
            )
            previews = list(preview_directory.glob("*.png"))
            if quicklook.returncode != 0 or not previews:
                raise RuntimeError(quicklook.stderr.strip() or "Quick Look could not create an image preview")
            converted = subprocess.run(
                [
                    "/usr/bin/sips", "-s", "format", "jpeg",
                    str(previews[0]), "--out", str(output),
                ],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                env=native_environment,
            )
        if converted.returncode != 0 or not output.exists() or output.stat().st_size == 0:
            raise RuntimeError(converted.stderr.strip() or "Quick Look preview conversion failed")


def ensure_saved_searches_table(database: sqlite3.Connection) -> None:
    database.execute("""
        CREATE TABLE IF NOT EXISTS saved_searches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            params_json TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    """)
    database.execute("""
        CREATE TABLE IF NOT EXISTS saved_search_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    seeded = database.execute(
        "SELECT 1 FROM saved_search_state WHERE key='defaults_seeded'"
    ).fetchone()
    if seeded:
        return
    now = time.time()
    if database.execute("SELECT COUNT(*) FROM saved_searches").fetchone()[0] == 0:
        database.executemany(
            "INSERT INTO saved_searches(id,name,params_json,created_at,updated_at) VALUES(?,?,?,?,?)",
            (
                (identifier, name, json.dumps(params, sort_keys=True), now, now)
                for identifier, name, params in DEFAULT_SAVED_SEARCHES
            ),
        )
    database.execute(
        "INSERT INTO saved_search_state(key,value) VALUES('defaults_seeded','1')"
    )


def normalize_saved_search(name, params) -> tuple[str, dict]:
    normalized_name = " ".join(str(name or "").split())
    if not normalized_name:
        raise ValueError("Enter a name for this Smart Search")
    if len(normalized_name) > 80:
        raise ValueError("Smart Search names must be 80 characters or fewer")
    if not isinstance(params, dict):
        raise ValueError("Smart Search filters must be an object")
    normalized_params = {
        key: str(value).strip()
        for key, value in params.items()
        if key in SAVED_SEARCH_PARAM_KEYS
        and value is not None
        and str(value).strip()
    }
    if not any(key != "sort" for key in normalized_params):
        raise ValueError("Choose at least one search term or filter")
    normalized_params.setdefault("sort", "relevance")
    return normalized_name, normalized_params


def curation_snapshot(database: sqlite3.Connection, item_ids) -> list[dict]:
    ids = sorted(set(int(item_id) for item_id in item_ids))
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    existing = {
        int(row["media_id"]): row
        for row in database.execute(
            f"""SELECT media_id,disposition,trashed_at,updated_at
                FROM media_curation WHERE media_id IN ({placeholders})""",
            ids,
        )
    }
    return [
        {
            "mediaId": item_id,
            "existed": item_id in existing,
            "disposition": existing[item_id]["disposition"] if item_id in existing else None,
            "trashedAt": existing[item_id]["trashed_at"] if item_id in existing else None,
            "updatedAt": existing[item_id]["updated_at"] if item_id in existing else None,
        }
        for item_id in ids
    ]


def remember_care_undo(kind: str, payload: dict, changed_at: float) -> str:
    token = uuid.uuid4().hex
    now = time.time()
    with care_undo_lock:
        expired = [
            key for key, action in care_undo_actions.items()
            if now - action["createdAt"] > CARE_UNDO_SECONDS
        ]
        for key in expired:
            care_undo_actions.pop(key, None)
        care_undo_actions[token] = {
            "kind": kind,
            "payload": payload,
            "changedAt": changed_at,
            "createdAt": now,
        }
    return token


def apply_care_undo(database: sqlite3.Connection, action: dict) -> int:
    restored = 0
    if action["kind"] == "curation":
        for previous in action["payload"]["items"]:
            item_id = int(previous["mediaId"])
            current = database.execute(
                "SELECT updated_at FROM media_curation WHERE media_id=?",
                (item_id,),
            ).fetchone()
            if not current or abs(float(current["updated_at"]) - action["changedAt"]) > 0.000001:
                continue
            if previous["existed"]:
                database.execute(
                    """UPDATE media_curation
                       SET disposition=?,trashed_at=?,updated_at=?
                       WHERE media_id=?""",
                    (
                        previous["disposition"],
                        previous["trashedAt"],
                        previous["updatedAt"],
                        item_id,
                    ),
                )
            else:
                database.execute(
                    "DELETE FROM media_curation WHERE media_id=?",
                    (item_id,),
                )
            restored += 1
    elif action["kind"] == "similarity":
        for previous in action["payload"]["pairs"]:
            left_id = int(previous["left"])
            right_id = int(previous["right"])
            current = database.execute(
                """SELECT updated_at FROM media_similarity_reviews
                   WHERE left_media_id=? AND right_media_id=?""",
                (left_id, right_id),
            ).fetchone()
            if not current or abs(float(current["updated_at"]) - action["changedAt"]) > 0.000001:
                continue
            if previous["existed"]:
                database.execute(
                    """UPDATE media_similarity_reviews
                       SET decision=?,updated_at=?
                       WHERE left_media_id=? AND right_media_id=?""",
                    (
                        previous["decision"],
                        previous["updatedAt"],
                        left_id,
                        right_id,
                    ),
                )
            else:
                database.execute(
                    """DELETE FROM media_similarity_reviews
                       WHERE left_media_id=? AND right_media_id=?""",
                    (left_id, right_id),
                )
            restored += 1
    return restored


def year_bounds(year: int) -> tuple[float, float]:
    start = datetime.datetime(year, 1, 1, tzinfo=datetime.timezone.utc)
    end = datetime.datetime(year + 1, 1, 1, tzinfo=datetime.timezone.utc)
    return start.timestamp(), end.timestamp()


def fts_query(value: str) -> str:
    words = re.findall(r"[\w'-]+", value, flags=re.UNICODE)
    return " AND ".join(f'"{word.replace(chr(34), chr(34) * 2)}"' for word in words[:12])


def parse_natural_language_query(
    value: str,
    known_people: tuple[tuple[str, str], ...] = (),
    now: Optional[float] = None,
) -> dict:
    original = re.sub(r"\s+", " ", value).strip()[:300]
    lowered = original.lower()
    semantic = lowered
    filters = []
    media_type = ""
    favorite = bool(re.search(r"\bfavou?rites?\b", lowered))
    if favorite:
        semantic = re.sub(r"\bfavou?rites?\b", " ", semantic)
        filters.append("Favorites")
    for word, candidate_type in SEARCH_MEDIA_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", lowered):
            media_type = candidate_type
            semantic = re.sub(rf"\b{re.escape(word)}\b", " ", semantic)
    if media_type:
        filters.append("Videos" if media_type == "video" else "Photos")

    after = before = None
    explicit_year = re.search(
        r"\b(?:in|from|during)\s+(20\d{2}|19\d{2})\b|\b(20\d{2}|19\d{2})\b",
        lowered,
    )
    after_match = re.search(r"\bafter:?\s*(20\d{2}|19\d{2})\b", lowered)
    before_match = re.search(r"\bbefore:?\s*(20\d{2}|19\d{2})\b", lowered)
    if after_match:
        after = year_bounds(int(after_match.group(1)))[1]
        semantic = semantic.replace(after_match.group(0), " ")
        filters.append(f"After {after_match.group(1)}")
    if before_match:
        before = year_bounds(int(before_match.group(1)))[0]
        semantic = semantic.replace(before_match.group(0), " ")
        filters.append(f"Before {before_match.group(1)}")
    if explicit_year and not after_match and not before_match:
        year = int(explicit_year.group(1) or explicit_year.group(2))
        after, before = year_bounds(year)
        semantic = semantic.replace(explicit_year.group(0), " ")
        filters.append(str(year))
    if re.search(r"\brecent(?:ly)?\b", lowered):
        after = (now if now is not None else time.time()) - 90 * 86_400
        semantic = re.sub(r"\brecent(?:ly)?\b", " ", semantic)
        filters.append("Last 90 days")

    people = []
    for person_key, display_name in sorted(
        known_people, key=lambda person: len(person[1]), reverse=True
    ):
        name = display_name.strip().lower()
        if len(name) < 2 or not re.search(rf"(?<!\w){re.escape(name)}(?!\w)", lowered):
            continue
        people.append({"key": person_key, "name": display_name})
        semantic = re.sub(rf"(?<!\w){re.escape(name)}(?!\w)", " person ", semantic)
        filters.append(display_name)

    ai_filter = "screenshot" if re.search(r"\bscreenshots?\b", lowered) else ""
    ocr_terms = []
    ocr_match = re.search(
        r"\b(?:containing|contains|with\s+the\s+word|with\s+text|says?|reading)\s+[\"']?([^\"']+?)[\"']?(?:$|\s+(?:after|before|from|in)\b)",
        original,
        flags=re.IGNORECASE,
    )
    if ocr_match:
        ocr_terms.append(ocr_match.group(1).strip())
        semantic = re.sub(re.escape(ocr_match.group(0).lower()), " ", semantic)
    elif any(intent in lowered for intent in OCR_INTENT_WORDS):
        source_match = re.search(r"\bfrom\s+([a-z0-9][\w .'-]{1,60})$", original, re.IGNORECASE)
        if source_match and not re.fullmatch(r"(?:19|20)\d{2}", source_match.group(1).strip()):
            ocr_terms.append(source_match.group(1).strip())
            semantic = re.sub(
                rf"\bfrom\s+{re.escape(source_match.group(1).lower())}$", " ", semantic
            )
    if ocr_terms:
        filters.append("Text: " + ", ".join(ocr_terms))

    semantic = re.sub(r"\b(?:after|before|in|from|during):?\b", " ", semantic)
    words = [
        word for word in re.findall(r"[\w'-]+", semantic, flags=re.UNICODE)
        if word not in SEARCH_FILLER_WORDS
    ]
    semantic_query = " ".join(words).strip() or original
    return {
        "original": original,
        "semanticQuery": semantic_query,
        "mediaType": media_type,
        "favorite": favorite,
        "after": after,
        "before": before,
        "people": people,
        "ocrTerms": ocr_terms,
        "aiFilter": ai_filter,
        "filters": filters,
    }


def load_auth_token(path: Optional[Path]) -> Optional[str]:
    if path is None:
        return None
    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise ValueError("The Anthora access token must contain at least 32 characters")
    return token


def session_cookie_value(token: str, expires_at: Optional[int] = None) -> str:
    expiry = int(expires_at if expires_at is not None else time.time() + AUTH_SESSION_SECONDS)
    payload = f"v1.{expiry}"
    signature = hmac.new(token.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def session_cookie_is_valid(token: str, value: str, now: Optional[int] = None) -> bool:
    try:
        version, expiry_text, supplied_signature = value.split(".", 2)
        expiry = int(expiry_text)
    except (TypeError, ValueError):
        return False
    if version != "v1" or expiry < int(now if now is not None else time.time()):
        return False
    payload = f"{version}.{expiry}"
    expected_signature = hmac.new(
        token.encode("utf-8"), payload.encode("ascii"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(supplied_signature, expected_signature)


def request_is_authorized(token: Optional[str], authorization: str = "", cookie_header: str = "") -> bool:
    if token is None:
        return True
    if authorization.startswith("Bearer ") and hmac.compare_digest(authorization[7:], token):
        return True
    try:
        cookies = SimpleCookie()
        cookies.load(cookie_header)
        supplied = cookies.get(AUTH_COOKIE_NAME)
        return supplied is not None and session_cookie_is_valid(token, supplied.value)
    except (KeyError, TypeError):
        return False


def path_without_access_token(path: str) -> str:
    parsed = urlparse(path)
    query = urlencode([
        (key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != "access_token"
    ])
    return parsed.path + (f"?{query}" if query else "")


def auth_cookie_header(token: str) -> str:
    # Private remote libraries are reached through an HTTPS reverse proxy.
    # Marking the bootstrap cookie Secure keeps browsers from discarding it
    # when the service itself listens on loopback HTTP behind that proxy.
    return (
        f"{AUTH_COOKIE_NAME}={session_cookie_value(token)}; Path=/; HttpOnly; Secure; "
        f"SameSite=Strict; Max-Age={AUTH_SESSION_SECONDS}"
    )


def people_newest_dates(database) -> dict:
    return {
        row["person_key"]: row["newest_at"] or 0
        for row in database.execute(
            """SELECT pm.person_key,
                      MAX(COALESCE(m.created_at,m.modified_at,m.imported_at,0)) newest_at
               FROM people_media pm
               JOIN media_items m ON m.id=pm.media_id
               WHERE m.missing=0 AND m.size_bytes>0
               GROUP BY pm.person_key"""
        )
    }


def valid_recovery_url(value) -> Optional[str]:
    if value is None or str(value).strip() == "":
        return None
    candidate = str(value).strip()
    if len(candidate) > 4096 or any(ord(character) < 32 for character in candidate):
        return None
    parsed = urlparse(candidate)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return None
    return candidate


def media_size_condition(invalid: bool = False, trash: bool = False) -> str:
    return "1" if invalid or trash else "size_bytes > 0"


def active_curation_condition(disposition: str = "", trash: bool = False) -> Optional[str]:
    if trash or disposition in ("keep", "remove"):
        return None
    return """id NOT IN (
        SELECT media_id FROM media_curation
        WHERE disposition='remove' AND trashed_at IS NULL
    )"""


def default_media_order(trash: bool = False) -> str:
    return (
        "COALESCE(c.trashed_at,0) DESC,id DESC"
        if trash
        else "COALESCE(created_at,modified_at,imported_at,0) DESC,id DESC"
    )


def default_media_cursor(row) -> str:
    timestamp = next(
        (float(row[key]) for key in ("created_at", "modified_at", "imported_at") if row[key] is not None),
        0.0,
    )
    return f"d:{timestamp:.17g}:{int(row['id'])}"


def parse_default_media_cursor(cursor: str) -> tuple[float, int]:
    marker, timestamp, item_id = cursor.split(":", 2)
    if marker != "d":
        raise ValueError("Not a default media cursor")
    return float(timestamp), int(item_id)


def normalized_library_path(value: str) -> Path:
    candidate = Path(str(value or "").strip()).expanduser()
    if not candidate.is_absolute():
        raise ValueError("Enter an absolute folder path on the Anthora server")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise ValueError("That folder is not currently available on the Anthora server") from error
    blocked = ("/System", "/Library", "/Applications", "/private", "/usr", "/bin", "/sbin", "/dev")
    if not resolved.is_dir() or resolved == Path("/") or any(
        resolved == Path(root) or Path(root) in resolved.parents for root in blocked
    ):
        raise ValueError("Choose a media folder, mounted volume, or network share")
    if not os.access(resolved, os.R_OK | os.X_OK):
        raise ValueError("Anthora cannot read that folder")
    return resolved


def library_paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def ai_filter_condition(ai_filter: str) -> Optional[str]:
    if ai_filter == "graphicPost":
        return """(
            id IN (
                SELECT media_id FROM media_text_analysis
                WHERE is_text_heavy=1 AND error_message IS NULL
            ) OR id IN (
                SELECT mt.media_item_id FROM media_tags mt
                JOIN tags t ON t.id=mt.tag_id
                WHERE t.name='screenshot' AND COALESCE(mt.confidence,0)>=0.25
            )
        )"""
    if ai_filter == "textHeavy":
        return "id IN (SELECT media_id FROM media_text_analysis WHERE is_text_heavy=1 AND error_message IS NULL)"
    if ai_filter == "screenshot":
        return """id IN (
            SELECT mt.media_item_id FROM media_tags mt
            JOIN tags t ON t.id=mt.tag_id
            WHERE t.name='screenshot' AND COALESCE(mt.confidence,0)>=0.25
        )"""
    if ai_filter == "other":
        return "id IN (SELECT media_id FROM media_text_analysis WHERE is_text_heavy=0 AND error_message IS NULL)"
    if ai_filter == "unanalyzed":
        return "media_type='image' AND id NOT IN (SELECT media_id FROM media_text_analysis)"
    if ai_filter in ("lowQuality", "accidentalVideo", "downloadedClutter"):
        return cleanup_profile_condition(ai_filter)
    return None


def cleanup_profile_condition(profile: str) -> Optional[str]:
    if profile == "lowQuality":
        return f"""media_type='image' AND id IN (
            SELECT media_id FROM media_quality_analysis
            WHERE model_version='{QUALITY_MODEL}' AND error_message IS NULL AND (
                dark_fraction>=0.985 OR light_fraction>=0.985 OR (
                    detail_score<=0.006 AND mean_luma BETWEEN 0.08 AND 0.92
                )
            )
        )"""
    if profile == "accidentalVideo":
        return f"""media_type='video' AND COALESCE(duration_seconds,0)>0
            AND duration_seconds<=2.0 AND (
                duration_seconds<=1.0 OR id IN (
                    SELECT media_id FROM media_quality_analysis
                    WHERE model_version='{QUALITY_MODEL}' AND error_message IS NULL AND (
                        dark_fraction>=0.95 OR light_fraction>=0.95
                        OR COALESCE(motion_score,1)<=0.008
                    )
                )
            )"""
    if profile == "downloadedClutter":
        return """media_type='image' AND (
            lower(filename) LIKE '%screenshot%' OR lower(filename) LIKE '%screen shot%'
            OR id IN (
                SELECT mt.media_item_id FROM media_tags mt
                JOIN tags t ON t.id=mt.tag_id
                WHERE t.name='screenshot' AND COALESCE(mt.confidence,0)>=0.75
            )
        )"""
    return None


def screenshot_category_condition(category: str) -> Optional[str]:
    if category == "saved":
        return """(
            favorite=1 OR id IN (
                SELECT media_id FROM media_curation
                WHERE disposition='keep' AND trashed_at IS NULL
            )
        )"""
    terms = SCREENSHOT_CATEGORY_TERMS.get(category)
    if category == "other":
        return "id IN (SELECT media_id FROM media_screenshot_categories WHERE category='other')"
    if not terms:
        return None
    category_cases = []
    for candidate in SCREENSHOT_CATEGORY_PRIORITY:
        clauses = " OR ".join(
            f"lower(COALESCE(recognized_text,'')) LIKE '%{term}%'"
            for term in SCREENSHOT_CATEGORY_TERMS[candidate]
        )
        category_cases.append(f"WHEN ({clauses}) THEN '{candidate}'")
    automatic_category = "CASE " + " ".join(category_cases) + " END"
    return f"""(
        id IN (SELECT media_id FROM media_screenshot_categories WHERE category='{category}')
        OR (
            id NOT IN (SELECT media_id FROM media_screenshot_categories)
            AND id IN (
                SELECT media_id FROM media_text_analysis
                WHERE error_message IS NULL AND ({automatic_category})='{category}'
            )
        )
    )
    """


def people_filter_condition(people: str) -> Optional[str]:
    classified_people = """id IN (
        SELECT mt.media_item_id FROM media_tags mt
        JOIN tags t ON t.id=mt.tag_id
        WHERE t.name='people' AND COALESCE(mt.confidence,0)>=0.5
    )"""
    secondary_people = f"""id IN (
        SELECT media_id FROM media_secondary_people_analysis
        WHERE model_version='{SECONDARY_PEOPLE_MODEL}'
          AND person_detected=1 AND error_message IS NULL
    )"""
    secondary_no_people = f"""id IN (
        SELECT media_id FROM media_secondary_people_analysis
        WHERE model_version='{SECONDARY_PEOPLE_MODEL}'
          AND person_detected=0 AND error_message IS NULL
    )"""
    if people == "1":
        return f"""(
            id IN (SELECT media_id FROM media_person_analysis WHERE person_count>0)
            OR id IN (SELECT media_id FROM media_face_analysis WHERE face_count>0)
            OR {secondary_people}
            OR ({classified_people} AND NOT {secondary_no_people})
        )"""
    if people == "0":
        return f"""(
            id IN (SELECT media_id FROM media_person_analysis WHERE person_count=0)
            AND id IN (SELECT media_id FROM media_face_analysis WHERE face_count=0)
            AND NOT {secondary_people}
            AND (NOT {classified_people} OR {secondary_no_people})
        )"""
    return None


@contextmanager
def open_database(
    path: Path, initialize: bool = False
) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(str(path), timeout=30)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        if initialize:
            connection.executescript("""
        CREATE TABLE IF NOT EXISTS media_curation (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            disposition TEXT CHECK(disposition IN ('keep','remove')),
            trashed_at REAL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_curation_disposition ON media_curation(disposition,trashed_at);
        CREATE TABLE IF NOT EXISTS media_reactions (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            reaction TEXT NOT NULL CHECK(reaction IN ('like','dislike')),
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_reactions_reaction ON media_reactions(reaction,media_id);
        CREATE TABLE IF NOT EXISTS media_screenshot_categories (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            category TEXT NOT NULL CHECK(category IN ('conversations','orders','weather','travel','social','calendar','recipes','other')),
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_screenshot_category ON media_screenshot_categories(category,media_id);
        CREATE TABLE IF NOT EXISTS media_face_analysis (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            face_count INTEGER NOT NULL, boxes_json TEXT NOT NULL, analyzed_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_face_count ON media_face_analysis(face_count,media_id);
        CREATE TABLE IF NOT EXISTS media_person_analysis (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            person_count INTEGER NOT NULL,
            analyzed_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_person_count ON media_person_analysis(person_count,media_id);
        CREATE TABLE IF NOT EXISTS media_secondary_people_analysis (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            model_version TEXT NOT NULL,
            person_detected INTEGER NOT NULL,
            token_count INTEGER NOT NULL,
            analyzed_at REAL NOT NULL,
            error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS secondary_people_result ON media_secondary_people_analysis(model_version,person_detected,media_id);
        CREATE TABLE IF NOT EXISTS deleted_media_fingerprints (
            content_hash TEXT PRIMARY KEY,
            size_bytes INTEGER NOT NULL,
            media_type TEXT NOT NULL,
            last_filename TEXT NOT NULL,
            first_deleted_at REAL NOT NULL,
            last_deleted_at REAL NOT NULL,
            deletion_count INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS deleted_media_size ON deleted_media_fingerprints(size_bytes,content_hash);
        CREATE TABLE IF NOT EXISTS media_reentry_reviews (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            content_hash TEXT NOT NULL REFERENCES deleted_media_fingerprints(content_hash),
            detected_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_reentry_detected ON media_reentry_reviews(detected_at,media_id);
        CREATE TABLE IF NOT EXISTS media_recovery_sources (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            provider TEXT,source_url TEXT,download_url TEXT,updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_recovery_jobs (
            id TEXT PRIMARY KEY,
            media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
            error_message TEXT,created_at REAL NOT NULL,updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_recovery_jobs_item ON media_recovery_jobs(media_id,updated_at DESC);
        CREATE TABLE IF NOT EXISTS media_visual_hashes (media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,dhash TEXT NOT NULL,analyzed_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS media_visual_hash ON media_visual_hashes(dhash);
        CREATE TABLE IF NOT EXISTS media_face_features (media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,face_index INTEGER NOT NULL,person_key TEXT,feature_blob BLOB NOT NULL,PRIMARY KEY(media_id,face_index));
        CREATE INDEX IF NOT EXISTS media_face_features_person ON media_face_features(person_key);
        CREATE TABLE IF NOT EXISTS media_semantic_embeddings (media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,model_version TEXT NOT NULL,embedding_blob BLOB NOT NULL,analyzed_at REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS media_semantic_model ON media_semantic_embeddings(model_version,media_id);
        CREATE TABLE IF NOT EXISTS media_similarity_reviews (
            left_media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
            right_media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
            decision TEXT NOT NULL CHECK(decision='not_duplicate'),
            updated_at REAL NOT NULL,
            PRIMARY KEY(left_media_id,right_media_id),
            CHECK(left_media_id<right_media_id)
        );
        CREATE TABLE IF NOT EXISTS media_cleanup_events (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            group_kind TEXT NOT NULL,
            item_count INTEGER NOT NULL,
            estimated_bytes INTEGER NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_cleanup_events_created ON media_cleanup_events(created_at);
        CREATE TABLE IF NOT EXISTS media_operations (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            total_units INTEGER NOT NULL,
            completed_units INTEGER NOT NULL DEFAULT 0,
            failed_units INTEGER NOT NULL DEFAULT 0,
            processed_items INTEGER NOT NULL DEFAULT 0,
            estimated_bytes INTEGER NOT NULL DEFAULT 0,
            payload_json TEXT NOT NULL,
            message TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS media_operations_updated ON media_operations(updated_at DESC);
        CREATE TABLE IF NOT EXISTS media_video_fingerprints (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            model_version TEXT NOT NULL,
            duration_seconds REAL NOT NULL,
            samples_json TEXT NOT NULL,
            analyzed_at REAL NOT NULL,
            error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS media_video_fingerprint_model ON media_video_fingerprints(model_version,media_id);
        CREATE TABLE IF NOT EXISTS media_quality_analysis (
            media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
            model_version TEXT NOT NULL,
            mean_luma REAL NOT NULL,
            dark_fraction REAL NOT NULL,
            light_fraction REAL NOT NULL,
            detail_score REAL NOT NULL,
            motion_score REAL,
            analyzed_at REAL NOT NULL,
            error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS media_quality_model ON media_quality_analysis(model_version,media_id);
        CREATE INDEX IF NOT EXISTS media_quality_signals ON media_quality_analysis(dark_fraction,light_fraction,detail_score,media_id);
        CREATE TABLE IF NOT EXISTS people_aliases (source_key TEXT PRIMARY KEY,target_key TEXT NOT NULL,display_name TEXT NOT NULL,updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS people_media (
            person_key TEXT NOT NULL,
            media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
            PRIMARY KEY(person_key,media_id)
        );
        CREATE INDEX IF NOT EXISTS people_media_media ON people_media(media_id,person_key);
        CREATE TABLE IF NOT EXISTS people_preferences (
            person_key TEXT PRIMARY KEY,
            cover_media_id INTEGER REFERENCES media_items(id) ON DELETE SET NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_profile_decisions (
            media_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
            person_key TEXT NOT NULL,
            decision TEXT NOT NULL CHECK(decision IN ('associated','dismissed')),
            updated_at REAL NOT NULL,
            PRIMARY KEY(media_id,person_key)
        );
        CREATE INDEX IF NOT EXISTS media_profile_decisions_person
            ON media_profile_decisions(person_key,decision,media_id);
        CREATE TABLE IF NOT EXISTS saved_searches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            params_json TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS folders_library_parent ON folders(library_id,parent_path);
        CREATE INDEX IF NOT EXISTS folders_path ON folders(path);
        CREATE INDEX IF NOT EXISTS media_items_folder_missing ON media_items(folder_id,missing,id);
            """)
            screenshot_category_schema = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='media_screenshot_categories'"
            ).fetchone()
            if screenshot_category_schema and "recipes" not in screenshot_category_schema["sql"]:
                connection.executescript("""
                    ALTER TABLE media_screenshot_categories RENAME TO media_screenshot_categories_legacy;
                    CREATE TABLE media_screenshot_categories (
                        media_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
                        category TEXT NOT NULL CHECK(category IN ('conversations','orders','weather','travel','social','calendar','recipes','other')),
                        updated_at REAL NOT NULL
                    );
                    INSERT INTO media_screenshot_categories(media_id,category,updated_at)
                        SELECT media_id,category,updated_at FROM media_screenshot_categories_legacy;
                    DROP TABLE media_screenshot_categories_legacy;
                    CREATE INDEX media_screenshot_category ON media_screenshot_categories(category,media_id);
                """)
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def open_read_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def social_archive_database(database: sqlite3.Connection) -> Optional[Path]:
    library = database.execute("SELECT root_path FROM libraries WHERE name='Social Archive' LIMIT 1").fetchone()
    if not library:
        return None
    path = Path(library["root_path"]) / "_database/archive.sqlite3"
    return path if path.exists() else None


def has_social_archive_library(database: sqlite3.Connection) -> bool:
    return database.execute(
        "SELECT 1 FROM libraries WHERE name='Social Archive' LIMIT 1"
    ).fetchone() is not None


def social_archive_sync_candidate(
    database: sqlite3.Connection, state_path: Path, latest_ref_id: int
) -> Optional[dict]:
    library = database.execute(
        "SELECT id,scan_status FROM libraries WHERE name='Social Archive' LIMIT 1"
    ).fetchone()
    if not library or library["scan_status"] not in ("idle", "error"):
        return None
    latest_ref_id = int(latest_ref_id)
    indexed_ref_id = 0
    try:
        indexed_ref_id = int(json.loads(state_path.read_text(encoding="utf-8"))["indexedRefId"])
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        pass
    # A restored or replaced Social Archive database can move the sequence
    # backwards; any change in either direction requires a fresh reconciliation.
    if latest_ref_id == indexed_ref_id:
        return None
    return {"libraryId": int(library["id"]), "targetRefId": latest_ref_id}


def recover_interrupted_scans(database: sqlite3.Connection, now: Optional[float] = None) -> int:
    """Make scans interrupted by an app or server restart safely retryable."""
    cursor = database.execute(
        "UPDATE libraries SET scan_status='error',updated_at=? WHERE scan_status IN ('queued','scanning')",
        (time.time() if now is None else now,),
    )
    database.execute(
        """UPDATE scan_jobs SET status='failed',finished_at=?,error_message=?
           WHERE status='running'""",
        (
            time.time() if now is None else now,
            "The Anthora service restarted before this scan finished",
        ),
    )
    return cursor.rowcount


def save_social_archive_sync_state(state_path: Path, target_ref_id: int):
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_path.with_name(f".{state_path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps({"indexedRefId": int(target_ref_id), "updatedAt": time.time()}, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, state_path)


def identity_folder_paths(archive_path: Path, identity_id: int) -> list[str]:
    with open_read_database(archive_path) as archive:
        rows = archive.execute(
            "SELECT DISTINCT local_symlink_path FROM media_refs WHERE identity_id=? AND local_symlink_path<>''",
            (identity_id,),
        ).fetchall()
    return sorted({str(Path(row["local_symlink_path"]).parent) for row in rows})


def book_crop_percent(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        return 50
    return max(0, min(100, value))


def normalize_book(body):
    if not isinstance(body, dict):
        raise ValueError("Invalid book")
    if not re.fullmatch(r"[0-9a-f-]{36}", str(body.get("id", ""))):
        raise ValueError("Invalid book ID")
    if body.get("template") not in ("album", "travel", "wedding", "valentine", "baby", "yearbook", "birthday", "portfolio", "coast", "vows", "journal", "monograph"):
        raise ValueError("Choose a book template")
    color = body.get("color")
    if color is not None and (not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color)):
        raise ValueError("Choose a valid book color")
    book_format = body.get("format", "square")
    cover_style = body.get("coverStyle", "classic")
    if book_format not in ("square", "portrait", "landscape", "panorama", "pocket", "magazine"):
        raise ValueError("Choose a valid book size")
    if cover_style not in ("classic", "editorial", "band", "full", "inset"):
        raise ValueError("Choose a valid cover style")
    title = str(body.get("title", "")).strip()
    if not title or len(title) > 80:
        raise ValueError("Use a book title of 1 to 80 characters")
    pages = body.get("pages")
    if not isinstance(pages, list) or not 1 <= len(pages) <= 200:
        raise ValueError("A book needs 1 to 200 pages")
    normalized = []
    for page in pages:
        if not isinstance(page, dict):
            raise ValueError("Invalid page")
        layout = page.get("layout")
        count = {"single": 1, "portrait": 1, "wide": 1, "pair": 2, "stacked": 2, "triptych": 3, "feature": 3, "grid": 4, "mosaic": 6, "story": 0, "offset": 2, "columns": 3, "hero": 4, "contact": 9}.get(layout)
        photos = page.get("photos")
        if count is None or not isinstance(photos, list) or len(photos) != count:
            raise ValueError("Invalid page layout")
        heading = str(page.get("heading", ""))
        if len(heading) > 60:
            raise ValueError("Page headings must be 60 characters or shorter")
        text = str(page.get("text", ""))
        if len(text) > 1500:
            raise ValueError("Page text must be 1500 characters or shorter")
        caption = str(page.get("caption", ""))
        if len(caption) > 120:
            raise ValueError("Captions must be 120 characters or shorter")
        cleaned = []
        for photo in photos:
            if photo is None:
                cleaned.append(None)
                continue
            if not isinstance(photo, dict) or type(photo.get("id")) is not int or photo["id"] < 1:
                raise ValueError("Invalid photo")
            cleaned.append({"id": photo["id"], "name": str(photo.get("name", "Photo"))[:255],
                            "mediaType": "image", "fit": "fill" if photo.get("fit") == "fill" else "fit",
                            "cropX": book_crop_percent(photo.get("cropX")), "cropY": book_crop_percent(photo.get("cropY"))})
        normalized.append({"id": str(page.get("id", ""))[:80], "layout": layout, "photos": cleaned, "caption": caption, "heading": heading, "text": text})
    return {"id": body["id"], "version": 2, "color": color, "format": book_format, "coverStyle": cover_style, "template": body["template"], "title": title, "pages": normalized}


def book_table(database):
    database.execute("CREATE TABLE IF NOT EXISTS anthora_books (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at REAL NOT NULL)")


def item_payload(row: sqlite3.Row) -> dict:
    item_id = int(row["id"])
    keys = row.keys()
    analysis_error = row["analysis_error"] if "analysis_error" in keys else None
    return {
        "id": item_id,
        "libraryId": int(row["library_id"]),
        "folderId": int(row["folder_id"]),
        "name": row["filename"],
        "mediaType": row["media_type"],
        "width": row["width"],
        "height": row["height"],
        "sizeBytes": int(row["size_bytes"] or 0),
        "takenAt": row["created_at"] or row["modified_at"],
        "durationSeconds": row["duration_seconds"],
        "frameRate": row["frame_rate"] if "frame_rate" in keys else None,
        "favorite": bool(row["favorite"]),
        "disposition": row["disposition"] if "disposition" in keys else None,
        "trashedAt": row["trashed_at"] if "trashed_at" in keys else None,
        "reentryPending": bool(row["reentry_pending"]) if "reentry_pending" in keys else False,
        "analysisError": analysis_error,
        "recoveryProvider": row["recovery_provider"] if "recovery_provider" in keys else None,
        "sourceUrl": row["source_url"] if "source_url" in keys else None,
        "downloadUrlAvailable": bool(row["download_url_available"]) if "download_url_available" in keys else False,
        "recoveryStatus": row["recovery_status"] if "recovery_status" in keys else None,
        "recoveryError": row["recovery_error"] if "recovery_error" in keys else None,
        "screenshotCategory": row["screenshot_category"] if "screenshot_category" in keys else None,
        "thumbnailUrl": f"/api/items/{item_id}/thumbnail",
        "contentUrl": f"/api/items/{item_id}/content",
    }


class PhotosBridgeFailure(RuntimeError):
    pass


def encode_photo_identifier(identifier: str) -> str:
    return base64.urlsafe_b64encode(identifier.encode("utf-8")).decode("ascii").rstrip("=")


def decode_photo_identifier(encoded: str) -> str:
    if not encoded or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
        raise ValueError("Invalid Photos identifier")
    try:
        value = base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True
        ).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("Invalid Photos identifier") from error
    if encode_photo_identifier(value) != encoded:
        raise ValueError("Invalid Photos identifier")
    return value


def photo_timestamp(value) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def photo_item_payload(asset: dict) -> dict:
    identifier = encode_photo_identifier(str(asset["id"]))
    safe_name = Path(str(asset.get("filename") or "Photo")).name
    version = str(asset.get("modifiedAt") or asset.get("createdAt") or "")
    return {
        "id": identifier,
        "libraryId": 0,
        "folderId": None,
        "name": safe_name,
        "mediaType": asset.get("mediaType", "unknown"),
        "width": asset.get("width"),
        "height": asset.get("height"),
        "sizeBytes": None,
        "takenAt": photo_timestamp(asset.get("createdAt") or asset.get("modifiedAt")),
        "durationSeconds": asset.get("duration"),
        "favorite": bool(asset.get("favorite")),
        "thumbnailUrl": f"/api/photos/assets/{identifier}/thumbnail?{urlencode({'v': version})}",
        "contentUrl": f"/api/photos/assets/{identifier}/content?{urlencode({'filename': safe_name, 'v': version})}",
    }


class PhotosBridgeClient:
    def __init__(self, executable: Optional[Path]):
        self.executable = executable

    @property
    def configured(self) -> bool:
        return self.executable is not None and self.executable.is_file()

    def run(self, arguments, timeout_seconds=30):
        if not self.configured:
            raise PhotosBridgeFailure("The Anthora Photos bridge is not installed on this Mac.")
        try:
            result = subprocess.run(
                [str(self.executable), *map(str, arguments)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PhotosBridgeFailure(f"The Photos bridge could not run: {error}") from error
        if result.returncode != 0:
            message = result.stderr.decode("utf-8", errors="replace").strip()
            raise PhotosBridgeFailure(message or "The Photos bridge failed.")
        try:
            return json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PhotosBridgeFailure("The Photos bridge returned an unreadable response.") from error

    def write(self, arguments, output: Path, timeout_seconds=60):
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
        try:
            self.run([*arguments, "--output", str(temporary)], timeout_seconds=timeout_seconds)
            if not temporary.is_file() or temporary.stat().st_size == 0:
                raise PhotosBridgeFailure("The Photos bridge did not produce a media file.")
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
        return output


def visual_hash_distance(left: Optional[str], right: Optional[str]) -> Optional[int]:
    if not left or not right:
        return None
    try:
        return bin(int(left, 16) ^ int(right, 16)).count("1")
    except ValueError:
        return None


def media_aspect_delta(left, right) -> float:
    left_width, left_height = float(left["width"] or 0), float(left["height"] or 0)
    right_width, right_height = float(right["width"] or 0), float(right["height"] or 0)
    if min(left_width, left_height, right_width, right_height) <= 0:
        return 0
    return abs(math.log((left_width / left_height) / (right_width / right_height)))


def unresolved_exact_pair(left, right, distance) -> bool:
    def numeric(item, key):
        try:
            return int(item[key] or 0)
        except (KeyError, IndexError, TypeError, ValueError):
            return 0

    return bool(
        distance == 0
        and numeric(left, "size_bytes") > 0
        and numeric(left, "size_bytes") == numeric(right, "size_bytes")
        and numeric(left, "width") == numeric(right, "width")
        and numeric(left, "height") == numeric(right, "height")
        and (not left["content_hash"] or not right["content_hash"])
    )


def semantic_sign_bands(blob: bytes) -> tuple:
    if not blob or len(blob) != 512 * 4:
        return ()
    values = memoryview(blob).cast("f")
    bits = 0
    for index, value in enumerate(values):
        if value >= 0:
            bits |= 1 << index
    keys = []
    for offset in (0, 16):
        for band in range(16):
            shift = band * 32 + offset
            if shift <= 480:
                value = (bits >> shift) & 0xFFFFFFFF
            else:
                overflow = shift - 480
                value = ((bits >> shift) | ((bits & ((1 << overflow) - 1)) << (512 - shift))) & 0xFFFFFFFF
            keys.append((offset, band, value))
    return tuple(keys)


def semantic_cosine(left: bytes, right: bytes) -> float:
    if not left or not right or len(left) != len(right) or len(left) != 512 * 4:
        return -1
    return max(-1.0, min(1.0, sum(
        left_value * right_value
        for left_value, right_value in zip(memoryview(left).cast("f"), memoryview(right).cast("f"))
    )))


def capture_sequence(filename: str) -> Optional[tuple[str, int]]:
    stem = Path(filename or "").stem.lower().strip()
    match = re.match(r"^(.*?)(\d{1,8})(?:[-_ ](?:edit|edited|copy))?$", stem)
    if not match:
        return None
    prefix = re.sub(r"\s+", " ", match.group(1)).strip()
    camera_prefix = re.fullmatch(r"(?:img|dsc|dscn|pxl|mvimg|cimg|sam)[-_ ]?", prefix)
    if len(prefix) < 8 and not camera_prefix:
        return None
    return prefix, int(match.group(2))


def adjacent_capture_sequence(left: str, right: str) -> bool:
    left_sequence = capture_sequence(left)
    right_sequence = capture_sequence(right)
    return bool(
        left_sequence and right_sequence
        and left_sequence[0] == right_sequence[0]
        and 0 < abs(left_sequence[1] - right_sequence[1]) <= 12
    )


def derivative_filename_key(filename: str) -> str:
    """Return a conservative key shared by common exported/edit-copy names."""
    stem = unicodedata.normalize("NFKC", Path(filename or "").stem).casefold().strip()
    previous = None
    while stem and stem != previous:
        previous = stem
        stem = re.sub(r"\s*\(\d+\)$", "", stem)
        stem = re.sub(r"(?:[-_ .]+(?:copy|edited|edit|cropped|crop|resized|small|large))$", "", stem)
        stem = stem.strip("-_. ")
    return stem


def person_key(value: object) -> str:
    """Preserve opaque face-group separators while rejecting unsafe input."""
    normalized = str(value or "").strip().casefold()
    return normalized if re.fullmatch(r"[a-z0-9_.:-]{1,160}", normalized) else ""


def save_person_cover(database, key: str, media_id: int) -> bool:
    """Persist a person's chosen photo only when it belongs to that person."""
    eligible = database.execute(
        """SELECT 1 FROM people_media pm
           JOIN media_items m ON m.id=pm.media_id
           LEFT JOIN media_curation c ON c.media_id=m.id
           WHERE pm.person_key=? AND pm.media_id=?
             AND m.media_type='image' AND m.missing=0 AND m.size_bytes>0
             AND c.trashed_at IS NULL""",
        (key, media_id),
    ).fetchone()
    if not eligible:
        return False
    database.execute(
        """INSERT INTO people_preferences(person_key,cover_media_id,updated_at)
           VALUES(?,?,?) ON CONFLICT(person_key) DO UPDATE SET
           cover_media_id=excluded.cover_media_id,updated_at=excluded.updated_at""",
        (key, media_id, time.time()),
    )
    return True


def merge_people(database, keys: list[str], target: str, display_name: str) -> int:
    """Merge current people groups under one stable key without changing media."""
    keys = list(dict.fromkeys(key for key in keys if person_key(key)))
    target = person_key(target)
    display_name = str(display_name or "").strip()
    if len(keys) < 2 or target not in keys or not display_name:
        return 0
    placeholders = ",".join("?" for _ in keys)
    sources = set(keys)
    sources.update(
        row[0]
        for row in database.execute(
            f"SELECT source_key FROM people_aliases WHERE target_key IN ({placeholders})",
            keys,
        )
    )
    now = time.time()
    database.executemany(
        """INSERT INTO people_aliases(source_key,target_key,display_name,updated_at)
           VALUES(?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
           target_key=excluded.target_key,display_name=excluded.display_name,updated_at=excluded.updated_at""",
        ((source, target, display_name, now) for source in sources),
    )
    preference = database.execute(
        f"""SELECT cover_media_id FROM people_preferences
            WHERE person_key IN ({placeholders}) AND cover_media_id IS NOT NULL
            ORDER BY CASE WHEN person_key=? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1""",
        (*keys, target),
    ).fetchone()
    database.execute(f"DELETE FROM people_preferences WHERE person_key IN ({placeholders})", keys)
    if preference:
        database.execute(
            "INSERT INTO people_preferences(person_key,cover_media_id,updated_at) VALUES(?,?,?)",
            (target, int(preference[0]), now),
        )
    decisions = database.execute(
        f"""SELECT media_id,decision,MAX(updated_at) updated_at
            FROM media_profile_decisions WHERE person_key IN ({placeholders}) GROUP BY media_id""",
        keys,
    ).fetchall()
    database.execute(f"DELETE FROM media_profile_decisions WHERE person_key IN ({placeholders})", keys)
    database.executemany(
        """INSERT INTO media_profile_decisions(media_id,person_key,decision,updated_at)
           VALUES(?,?,?,?) ON CONFLICT(media_id,person_key) DO UPDATE SET
           decision=excluded.decision,updated_at=excluded.updated_at""",
        ((row["media_id"], target, row["decision"], row["updated_at"]) for row in decisions),
    )
    return len(sources)


def repair_legacy_face_alias_keys(database) -> int:
    """Recover aliases written by the old endpoint that stripped underscores."""
    face_keys = {
        row["person_key"]
        for row in database.execute(
            "SELECT DISTINCT person_key FROM media_face_features WHERE person_key IS NOT NULL AND person_key<>''"
        )
    }
    compact = {}
    for key in face_keys:
        compact.setdefault(re.sub(r"[^a-z0-9]+", "", key.casefold()), []).append(key)
    repaired = 0
    for alias in database.execute("SELECT * FROM people_aliases").fetchall():
        source = alias["source_key"]
        candidates = compact.get(re.sub(r"[^a-z0-9]+", "", source.casefold()), [])
        if source in face_keys or len(candidates) != 1:
            continue
        corrected = candidates[0]
        target_candidates = compact.get(re.sub(r"[^a-z0-9]+", "", alias["target_key"].casefold()), [])
        corrected_target = target_candidates[0] if len(target_candidates) == 1 else corrected
        database.execute(
            """INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)
               ON CONFLICT(source_key) DO UPDATE SET target_key=excluded.target_key,
               display_name=excluded.display_name,updated_at=excluded.updated_at""",
            (corrected, corrected_target, alias["display_name"], alias["updated_at"]),
        )
        database.execute("DELETE FROM people_aliases WHERE source_key=?", (source,))
        repaired += 1
    return repaired


def plausible_named_derivatives(left: str, right: str) -> bool:
    left_key = derivative_filename_key(left)
    right_key = derivative_filename_key(right)
    return bool(left_key and left_key == right_key)


def conservative_presentation_ids(positive, negative, limit: int = 400, rank_margin: int = 75) -> list[int]:
    if not positive:
        return []
    negative_ranks = {int(item["id"]): rank for rank, item in enumerate(negative)}
    top_score = float(positive[0]["score"])
    selected = []
    for rank, item in enumerate(positive[:limit]):
        if float(item["score"]) < top_score - 0.035:
            continue
        negative_rank = negative_ranks.get(int(item["id"]))
        if negative_rank is not None and negative_rank < rank + rank_margin:
            continue
        selected.append(int(item["id"]))
    return selected


def build_similarity_pairs(rows) -> list[dict]:
    metadata = {int(row["id"]): row for row in rows}
    pairs = {}

    visual_buckets = {}
    for row in rows:
        visual_hash = row["dhash"]
        if not visual_hash:
            continue
        try:
            value = int(visual_hash, 16)
        except ValueError:
            continue
        candidates = set()
        for shift in (0, 16, 32, 48):
            candidates.update(visual_buckets.get((shift, (value >> shift) & 0xFFFF), ()))
        for other_id in candidates:
            other = metadata[other_id]
            if row["content_hash"] and row["content_hash"] == other["content_hash"]:
                continue
            distance = visual_hash_distance(visual_hash, other["dhash"])
            if distance is None or distance > VISUAL_CROP_HASH_THRESHOLD:
                continue
            # Identical visual hashes, dimensions, and byte sizes are strong
            # exact-copy candidates. Do not mislabel them as resized while the
            # background SHA-256 pass is still pending; once hashed, true byte
            # copies move to Exact and distinct encodings may return here.
            if unresolved_exact_pair(row, other, distance):
                continue
            # A 64-bit difference hash is useful as a fast candidate filter, but
            # sparse screenshots and slides can collide even when their content
            # is unrelated. Without the optional semantic model, require the
            # names to identify the files as derivatives of the same original.
            if not plausible_named_derivatives(row["filename"], other["filename"]):
                continue
            aspect_delta = media_aspect_delta(row, other)
            if aspect_delta < 0.04 and distance <= VISUAL_RESIZED_HASH_THRESHOLD:
                kind = "resized"
            elif 0.04 <= aspect_delta <= 0.70:
                kind = "cropped"
            else:
                continue
            pair_key = tuple(sorted((int(row["id"]), other_id)))
            pairs[pair_key] = {
                "left": pair_key[0], "right": pair_key[1], "kind": kind,
                "confidence": 1 - distance / 64, "distance": distance,
            }
        for shift in (0, 16, 32, 48):
            visual_buckets.setdefault((shift, (value >> shift) & 0xFFFF), []).append(int(row["id"]))

    semantic_buckets = {}
    embeddings = {}
    for row in rows:
        blob = row["embedding_blob"]
        keys = semantic_sign_bands(blob)
        if not keys:
            continue
        candidates = set()
        for key in keys:
            bucket = semantic_buckets.get(key, ())
            if len(bucket) <= 500:
                candidates.update(bucket)
        for other_id in candidates:
            other = metadata[other_id]
            if row["content_hash"] and row["content_hash"] == other["content_hash"]:
                continue
            similarity = semantic_cosine(blob, embeddings[other_id])
            aspect_delta = media_aspect_delta(row, other)
            distance = visual_hash_distance(row["dhash"], other["dhash"])
            if unresolved_exact_pair(row, other, distance):
                continue
            left_time = float(row["created_at"] or row["modified_at"] or 0)
            right_time = float(other["created_at"] or other["modified_at"] or 0)
            same_moment = (
                row["folder_id"] == other["folder_id"]
                and left_time > 0 and right_time > 0
                and abs(left_time - right_time) <= 30
                and aspect_delta < 0.04
                and similarity >= BEST_SHOT_THRESHOLD
                and (distance is None or distance > 10)
                and adjacent_capture_sequence(row["filename"], other["filename"])
            )
            if same_moment:
                kind = "bestShot"
            elif aspect_delta >= 0.04 and similarity >= SEMANTIC_CROP_THRESHOLD:
                kind = "cropped"
            elif similarity >= SEMANTIC_CROP_THRESHOLD and distance is not None and distance <= VISUAL_CROP_HASH_THRESHOLD:
                kind = "resized"
            elif similarity >= SEMANTIC_EDIT_THRESHOLD and (distance is None or distance <= 12):
                kind = "cropped"
            else:
                continue
            pair_key = tuple(sorted((int(row["id"]), other_id)))
            candidate = {
                "left": pair_key[0], "right": pair_key[1], "kind": kind,
                "confidence": similarity, "distance": distance,
            }
            existing = pairs.get(pair_key)
            if existing is None or candidate["confidence"] > existing["confidence"] or kind == "cropped":
                pairs[pair_key] = candidate
        embeddings[int(row["id"])] = blob
        for key in keys:
            semantic_buckets.setdefault(key, []).append(int(row["id"]))
    return list(pairs.values())


def reconcile_similarity_pairs(database, pairs) -> list[dict]:
    """Collapse current exact copies and discard stale or trashed pair members."""
    item_ids = sorted({int(item_id) for pair in pairs for item_id in (pair["left"], pair["right"])})
    if not item_ids:
        return []
    placeholders = ",".join("?" for _ in item_ids)
    rows = database.execute(
        f"""SELECT m.id,m.content_hash,m.favorite,c.disposition,
                   (SELECT COUNT(*) FROM media_references r WHERE r.media_item_id=m.id) reference_count
            FROM media_items m LEFT JOIN media_curation c ON c.media_id=m.id
            WHERE m.id IN ({placeholders}) AND m.missing=0 AND c.trashed_at IS NULL""",
        tuple(item_ids),
    ).fetchall()
    active_ids = {int(row["id"]) for row in rows}
    rows_by_hash = {}
    for row in rows:
        if row["content_hash"]:
            rows_by_hash.setdefault(row["content_hash"], []).append(row)
    canonical_ids = {item_id: item_id for item_id in active_ids}
    for hash_rows in rows_by_hash.values():
        keeper_id = int(exact_duplicate_keeper(hash_rows)["id"])
        for row in hash_rows:
            canonical_ids[int(row["id"])] = keeper_id

    kind_priority = {"resized": 1, "cropped": 2, "bestShot": 3}
    reconciled = {}
    for pair in pairs:
        original_left, original_right = int(pair["left"]), int(pair["right"])
        if original_left not in active_ids or original_right not in active_ids:
            continue
        left, right = sorted((canonical_ids[original_left], canonical_ids[original_right]))
        if left == right:
            continue
        candidate = {**pair, "left": left, "right": right}
        key = (left, right)
        existing = reconciled.get(key)
        if existing is None or (
            kind_priority.get(candidate["kind"], 0), float(candidate.get("confidence", 0))
        ) > (
            kind_priority.get(existing["kind"], 0), float(existing.get("confidence", 0))
        ):
            reconciled[key] = candidate
    return list(reconciled.values())


def sort_duplicate_groups(groups, order="largest"):
    def item_count(group):
        return len(group.get("items", group.get("itemIds", [])))

    def stable_key(group):
        return str(group.get("hash") or group.get("itemIds") or group.get("recommendedId") or "")

    if order == "items":
        key = lambda group: (-item_count(group), -int(group.get("potentialBytes", 0)), stable_key(group))
    elif order == "confidence":
        key = lambda group: (-float(group.get("confidence", 0)), -int(group.get("potentialBytes", 0)), stable_key(group))
    else:
        key = lambda group: (-int(group.get("potentialBytes", 0)), -item_count(group), stable_key(group))
    return sorted(groups, key=key)


def grouped_similarity_payload(database, pairs, kind: str, offset: int = 0, limit: int = 100, order: str = "largest") -> dict:
    selected = [pair for pair in pairs if pair["kind"] == kind]
    parents = {}

    def find(item_id):
        parents.setdefault(item_id, item_id)
        while parents[item_id] != item_id:
            parents[item_id] = parents[parents[item_id]]
            item_id = parents[item_id]
        return item_id

    for pair in selected:
        left_root, right_root = find(pair["left"]), find(pair["right"])
        if left_root != right_root:
            parents[right_root] = left_root
    components = {}
    for item_id in parents:
        components.setdefault(find(item_id), set()).add(item_id)
    edges_by_component = {root: [] for root in components}
    for pair in selected:
        edges_by_component[find(pair["left"])].append(pair)
    ranked_components = sorted(
        components.items(),
        key=lambda entry: max(pair["confidence"] for pair in edges_by_component[entry[0]]),
        reverse=True,
    )
    ranked_item_ids = sorted({
        item_id for _, item_ids in ranked_components for item_id in item_ids
    })
    if not ranked_item_ids:
        return {"groups": [], "total": 0, "potentialBytes": 0}
    placeholders = ",".join("?" for _ in ranked_item_ids)
    payload_rows = database.execute(
        f"""SELECT m.*,c.disposition,c.trashed_at,
                   q.mean_luma quality_mean_luma,q.dark_fraction quality_dark_fraction,
                   q.light_fraction quality_light_fraction,q.detail_score quality_detail_score
            FROM media_items m LEFT JOIN media_curation c ON c.media_id=m.id
            LEFT JOIN media_quality_analysis q ON q.media_id=m.id AND q.model_version=?
            WHERE m.missing=0 AND c.trashed_at IS NULL AND m.id IN ({placeholders})""",
        (QUALITY_MODEL, *ranked_item_ids),
    ).fetchall()
    rows_by_id = {int(row["id"]): row for row in payload_rows}
    descriptors = []
    for root, item_ids in ranked_components:
        rows = [rows_by_id[item_id] for item_id in item_ids if item_id in rows_by_id]
        if len(rows) < 2:
            continue
        if all(bool(row["favorite"]) or row["disposition"] in ("keep", "remove") for row in rows):
            continue
        edges = edges_by_component[root]
        def quality_rank(row):
            detail = float(row["quality_detail_score"] or 0)
            mean = float(row["quality_mean_luma"] or 0.5)
            clipping = float(row["quality_dark_fraction"] or 0) + float(row["quality_light_fraction"] or 0)
            exposure = max(0.2, 1 - abs(mean - 0.5) * 1.4)
            return detail * exposure * max(0.1, 1 - clipping)

        recommended = max(
            rows,
            key=lambda row: (
                bool(row["favorite"]) or row["disposition"] == "keep",
                quality_rank(row) if kind == "bestShot" else 0,
                int(row["width"] or 0) * int(row["height"] or 0),
                int(row["size_bytes"] or 0),
            ),
        )
        descriptors.append({
            "kind": kind,
            "confidence": round(max(pair["confidence"] for pair in edges) * 100, 1),
            "distance": min((pair["distance"] for pair in edges if pair["distance"] is not None), default=None),
            "recommendedId": int(recommended["id"]),
            "potentialBytes": sum(
                int(row["size_bytes"] or 0) for row in rows
                if int(row["id"]) != int(recommended["id"])
                and not bool(row["favorite"]) and row["disposition"] != "keep"
            ),
            "qualityAnalyzed": sum(row["quality_detail_score"] is not None for row in rows),
            "items": [item_payload(row) for row in sorted(rows, key=lambda row: int(row["id"]))],
        })
    descriptors = sort_duplicate_groups(descriptors, order)
    page = descriptors[offset:offset + limit] if limit > 0 else []
    return {
        "groups": page,
        "total": len(descriptors),
        "potentialBytes": sum(group["potentialBytes"] for group in descriptors),
    }


def physical_exact_duplicate_groups(database, requested_hashes=None) -> list[dict]:
    arguments = []
    hash_filter = ""
    if requested_hashes is not None:
        if not requested_hashes:
            return []
        placeholders = ",".join("?" for _ in requested_hashes)
        hash_filter = f"AND m.content_hash IN ({placeholders})"
        arguments.extend(requested_hashes)
    rows = database.execute(
        f"""SELECT m.*,c.disposition,c.trashed_at,
                   (SELECT COUNT(*) FROM media_references r WHERE r.media_item_id=m.id) reference_count
            FROM media_items m LEFT JOIN media_curation c ON c.media_id=m.id
            WHERE m.missing=0 AND m.content_hash IS NOT NULL AND c.trashed_at IS NULL
              {hash_filter}
            ORDER BY m.content_hash,m.id""",
        tuple(arguments),
    ).fetchall()
    grouped = {}
    for row in rows:
        if Path(row["path"]).is_symlink():
            continue
        grouped.setdefault(row["content_hash"], []).append(row)
    groups = []
    for content_hash, items in grouped.items():
        if len(items) < 2:
            continue
        removable_bytes = sum(
            int(item["size_bytes"] or 0) for item in items
            if not bool(item["favorite"]) and item["disposition"] != "keep"
        )
        protected = any(bool(item["favorite"]) or item["disposition"] == "keep" for item in items)
        potential_bytes = removable_bytes - (0 if protected else min(int(item["size_bytes"] or 0) for item in items))
        if potential_bytes <= 0:
            continue
        groups.append({
            "hash": content_hash,
            "items": items,
            "keeper": exact_duplicate_keeper(items),
            "potentialBytes": potential_bytes,
        })
    groups.sort(key=lambda group: (-len(group["items"]), group["hash"]))
    return groups


def exact_duplicate_payload(database, offset: int = 0, limit: int = 100, order: str = "largest") -> dict:
    groups = sort_duplicate_groups(physical_exact_duplicate_groups(database), order)
    selected = groups[offset:offset + limit] if limit > 0 else []
    return {
        "groups": [
            {
                "hash": group["hash"],
                "kind": "exact",
                "potentialBytes": int(group["potentialBytes"]),
                "recommendedId": int(group["keeper"]["id"]),
                "items": [item_payload(item) for item in group["items"]],
            }
            for group in selected
        ],
        "total": len(groups),
        "potentialBytes": sum(int(group["potentialBytes"]) for group in groups),
    }


def exact_duplicate_keeper(rows):
    def readable_file(row):
        try:
            return Path(row["path"]).is_file()
        except (KeyError, IndexError):
            return False

    return max(
        rows,
        key=lambda row: (
            readable_file(row),
            row["disposition"] == "keep",
            bool(row["favorite"]),
            row["disposition"] != "remove",
            int(row["reference_count"] or 0),
            -int(row["id"]),
        ),
    )


def exact_duplicate_hashes(database, requested_hashes=None, limit=250):
    groups = physical_exact_duplicate_groups(database, requested_hashes)
    selected = groups[:int(limit)] if limit is not None else groups
    return [group["hash"] for group in selected]


def exact_duplicate_action_groups(database, requested_hashes=None, limit=250):
    groups = physical_exact_duplicate_groups(database, requested_hashes)
    selected = groups[:int(limit)] if limit is not None else groups
    return [
        {
            "hash": group["hash"],
            "items": group["items"],
            "keeper": group["keeper"],
        }
        for group in selected
    ]


def reconcile_missing_exact_group_items(database, requested_hashes):
    """Mark stale duplicate rows missing when a sibling copy is verifiably present.

    Requiring a readable sibling prevents a disconnected or privacy-blocked
    volume from making an entire duplicate group disappear from the index.
    Existing symlinks are references rather than physical copies and are left
    alone for the normal duplicate query to ignore.
    """
    if not requested_hashes:
        return 0
    placeholders = ",".join("?" for _ in requested_hashes)
    rows = database.execute(
        f"SELECT id,content_hash,path FROM media_items "
        f"WHERE missing=0 AND content_hash IN ({placeholders})",
        tuple(requested_hashes),
    ).fetchall()
    grouped = {}
    for row in rows:
        grouped.setdefault(row["content_hash"], []).append(row)
    stale_ids = []
    for items in grouped.values():
        states = [
            (row, Path(row["path"]).is_file(), Path(row["path"]).is_symlink())
            for row in items
        ]
        if not any(is_file and not is_symlink for _, is_file, is_symlink in states):
            continue
        stale_ids.extend(
            int(row["id"])
            for row, is_file, is_symlink in states
            if not is_file and not is_symlink
        )
    if stale_ids:
        database.executemany(
            "UPDATE media_items SET missing=1 WHERE id=?",
            ((item_id,) for item_id in stale_ids),
        )
    return len(stale_ids)


def exact_consolidation_completed(database, keep_id, remove_ids):
    placeholders = ",".join("?" for _ in remove_ids)
    remaining_items = database.execute(
        f"SELECT COUNT(*) FROM media_items WHERE id IN ({placeholders})",
        tuple(remove_ids),
    ).fetchone()[0]
    stale_references = database.execute(
        f"SELECT COUNT(*) FROM media_references WHERE media_item_id IN ({placeholders})",
        tuple(remove_ids),
    ).fetchone()[0]
    keeper_exists = database.execute(
        "SELECT 1 FROM media_items WHERE id=? AND missing=0",
        (keep_id,),
    ).fetchone()
    return bool(keeper_exists) and remaining_items == 0 and stale_references == 0


def existing_media_ids(database, item_ids, chunk_size=500):
    values = list(item_ids)
    existing = set()
    for index in range(0, len(values), chunk_size):
        chunk = values[index:index + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        existing.update(
            int(row[0]) for row in database.execute(
                f"SELECT id FROM media_items WHERE id IN ({placeholders})",
                tuple(chunk),
            )
        )
    return existing


def build_video_overlap_pairs(rows) -> list[dict]:
    frame_buckets = {}
    metadata = {}
    pairs = []
    for row in rows:
        try:
            samples = [
                {"time": float(sample["time"]), "hash": str(sample["hash"])}
                for sample in json.loads(row["samples_json"] or "[]")
                if sample.get("hash")
            ]
        except (ValueError, TypeError, KeyError):
            samples = []
        if len(samples) < 2:
            metadata[int(row["id"])] = (row, samples)
            continue
        matches_by_video = {}
        for sample in samples:
            try:
                value = int(sample["hash"], 16)
            except ValueError:
                continue
            candidates = set()
            for shift in (0, 16, 32, 48):
                bucket = frame_buckets.get((shift, (value >> shift) & 0xFFFF), ())
                if len(bucket) <= 500:
                    candidates.update(bucket)
            for other_id, other_time, other_hash in candidates:
                other_row, _ = metadata[other_id]
                if row["content_hash"] and row["content_hash"] == other_row["content_hash"]:
                    continue
                distance = visual_hash_distance(sample["hash"], other_hash)
                if distance is not None and distance <= 6:
                    matches_by_video.setdefault(other_id, []).append(
                        (sample["time"], other_time, distance, sample["hash"], other_hash)
                    )
        duration = float(row["duration_seconds"] or 0)
        spacing = duration / (len(samples) + 1)
        for other_id, matches in matches_by_video.items():
            other_row, other_samples = metadata[other_id]
            other_duration = float(other_row["duration_seconds"] or 0)
            if other_duration <= 0 or not other_samples:
                continue
            other_spacing = other_duration / (len(other_samples) + 1)
            tolerance = max(0.6, min(1.8, min(spacing, other_spacing) * 0.35))
            aligned = []
            centers = {
                round((match[0] - match[1]) / tolerance) * tolerance
                for match in matches
            }
            for center in centers:
                candidate_matches = [
                    match for match in matches
                    if abs((match[0] - match[1]) - center) <= tolerance
                ]
                best_by_left = {}
                for match in candidate_matches:
                    current = best_by_left.get(match[0])
                    if current is None or (match[2], abs((match[0] - match[1]) - center)) < (
                        current[2], abs((current[0] - current[1]) - center)
                    ):
                        best_by_left[match[0]] = match
                ordered = sorted(best_by_left.values(), key=lambda match: (match[0], match[1], match[2]))
                sequence, last_left, last_right = [], -1.0, -1.0
                for match in ordered:
                    if match[0] > last_left and match[1] > last_right:
                        sequence.append(match)
                        last_left, last_right = match[0], match[1]
                if len(sequence) > len(aligned) or (
                    len(sequence) == len(aligned)
                    and sum(match[2] for match in sequence) < sum(match[2] for match in aligned)
                ):
                    aligned = sequence
            shorter_duration = min(duration, other_duration)
            required = 2 if shorter_duration < 10 else 3
            if len(aligned) < required:
                continue
            distances = [match[2] for match in aligned]
            if sum(distances) / len(distances) > 2 or sum(distance <= 2 for distance in distances) < required:
                continue
            diverse_hashes = []
            for match in aligned:
                if all((visual_hash_distance(match[3], value) or 0) > 6 for value in diverse_hashes):
                    diverse_hashes.append(match[3])
            if len(diverse_hashes) < required:
                continue
            shared_seconds = min(shorter_duration, len(aligned) * min(spacing, other_spacing))
            shared_percent = 100 * shared_seconds / shorter_duration if shorter_duration else 0
            if shared_percent < 20:
                continue
            pair_ids = tuple(sorted((int(row["id"]), other_id)))
            pairs.append({
                "left": pair_ids[0],
                "right": pair_ids[1],
                "kind": "video",
                "sharedSeconds": round(shared_seconds, 1),
                "sharedPercent": round(min(100, shared_percent), 1),
                "confidence": round(max(0, 100 * (1 - sum(distances) / len(distances) / 8)), 1),
                "matchedFrames": len(aligned),
                "diverseFrames": len(diverse_hashes),
            })
        metadata[int(row["id"])] = (row, samples)
        for sample in samples:
            try:
                value = int(sample["hash"], 16)
            except ValueError:
                continue
            for shift in (0, 16, 32, 48):
                frame_buckets.setdefault((shift, (value >> shift) & 0xFFFF), []).append(
                    (int(row["id"]), sample["time"], sample["hash"])
                )
    pairs.sort(key=lambda pair: (-pair["sharedPercent"], -pair["confidence"], pair["left"], pair["right"]))
    return pairs


def video_overlap_payload(database, pairs, offset: int = 0, limit: int = 12, order: str = "largest") -> dict:
    item_ids = sorted({item_id for pair in pairs for item_id in (pair["left"], pair["right"])})
    if not item_ids:
        return {"groups": [], "total": 0, "potentialBytes": 0}
    parents = {item_id: item_id for item_id in item_ids}

    def find(item_id):
        while parents[item_id] != item_id:
            parents[item_id] = parents[parents[item_id]]
            item_id = parents[item_id]
        return item_id

    def union(left, right):
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    for pair in pairs:
        if pair["sharedPercent"] >= 90:
            union(pair["left"], pair["right"])
    component_items = {}
    for item_id in item_ids:
        component_items.setdefault(find(item_id), []).append(item_id)
    high_groups = []
    for root, members in component_items.items():
        if len(members) < 2:
            continue
        member_set = set(members)
        edges = [
            pair for pair in pairs
            if pair["sharedPercent"] >= 90
            and pair["left"] in member_set and pair["right"] in member_set
        ]
        high_groups.append({
            "kind": "video",
            "sharedSeconds": min(pair["sharedSeconds"] for pair in edges),
            "sharedPercent": min(pair["sharedPercent"] for pair in edges),
            "confidence": min(pair["confidence"] for pair in edges),
            "matchedFrames": min(pair["matchedFrames"] for pair in edges),
            "diverseFrames": min(pair.get("diverseFrames", pair["matchedFrames"]) for pair in edges),
            "itemIds": sorted(members),
        })
    group_specs = high_groups + [
        {**pair, "itemIds": [pair["left"], pair["right"]]}
        for pair in pairs
        if pair["sharedPercent"] < 90
        and find(pair["left"]) != find(pair["right"])
    ]
    group_specs.sort(key=lambda group: (-group["sharedPercent"], -group["confidence"], group["itemIds"]))
    placeholders = ",".join("?" for _ in item_ids)
    rows = database.execute(
        f"""SELECT m.id,m.duration_seconds,m.width,m.height,m.size_bytes,m.favorite,
                   c.disposition,c.trashed_at
            FROM media_items m LEFT JOIN media_curation c ON c.media_id=m.id
            WHERE m.missing=0 AND c.trashed_at IS NULL AND m.id IN ({placeholders})""",
        tuple(item_ids),
    ).fetchall()
    rows_by_id = {int(row["id"]): row for row in rows}
    descriptors = []
    for group in group_specs:
        pair_rows = [rows_by_id[item_id] for item_id in group["itemIds"] if item_id in rows_by_id]
        if len(pair_rows) != len(group["itemIds"]):
            continue
        if all(bool(row["favorite"]) or row["disposition"] in ("keep", "remove") for row in pair_rows):
            continue
        recommended = max(
            pair_rows,
            key=lambda row: (
                float(row["duration_seconds"] or 0),
                int(row["width"] or 0) * int(row["height"] or 0),
                int(row["size_bytes"] or 0),
            ),
        )
        potential_bytes = (
            sum(
                int(row["size_bytes"] or 0)
                for row in pair_rows if int(row["id"]) != int(recommended["id"])
            )
            if group["sharedPercent"] >= 90 else 0
        )
        descriptors.append({
            **{key: value for key, value in group.items() if key != "itemIds"},
            "recommendedId": int(recommended["id"]),
            "potentialBytes": potential_bytes,
            "itemIds": [int(row["id"]) for row in pair_rows],
        })
    recommended_ids = {group["recommendedId"] for group in descriptors}
    removable_sizes = {}
    for group in descriptors:
        if group["sharedPercent"] < 90:
            continue
        for item_id in group["itemIds"]:
            if item_id != group["recommendedId"] and item_id not in recommended_ids:
                removable_sizes[item_id] = int(rows_by_id[item_id]["size_bytes"] or 0)
    descriptors = sort_duplicate_groups(descriptors, order)
    page_descriptors = descriptors[offset:offset + limit] if limit > 0 else []
    page_ids = sorted({item_id for group in page_descriptors for item_id in group["itemIds"]})
    payload_rows = {}
    if page_ids:
        page_placeholders = ",".join("?" for _ in page_ids)
        payload_rows = {
            int(row["id"]): row for row in database.execute(
                f"""SELECT m.*,c.disposition,c.trashed_at
                    FROM media_items m LEFT JOIN media_curation c ON c.media_id=m.id
                    WHERE m.missing=0 AND c.trashed_at IS NULL AND m.id IN ({page_placeholders})""",
                tuple(page_ids),
            ).fetchall()
        }
    groups = [
        {
            **{key: value for key, value in descriptor.items() if key != "itemIds"},
            "items": [item_payload(payload_rows[item_id]) for item_id in descriptor["itemIds"]],
        }
        for descriptor in page_descriptors
        if all(item_id in payload_rows for item_id in descriptor["itemIds"])
    ]
    return {
        "groups": groups,
        "total": len(descriptors),
        "potentialBytes": sum(removable_sizes.values()),
    }


def cleanup_stats(database: sqlite3.Connection) -> dict:
    finalized = database.execute(
        """SELECT COALESCE(SUM(deletion_count),0) items,
                  COUNT(*) unique_items,
                  COALESCE(SUM(size_bytes * deletion_count),0) bytes,
                  MIN(first_deleted_at) first_deleted_at,
                  MAX(last_deleted_at) last_deleted_at
           FROM deleted_media_fingerprints"""
    ).fetchone()
    pending = database.execute(
        """SELECT COUNT(*) items,COALESCE(SUM(m.size_bytes),0) bytes
           FROM media_curation c JOIN media_items m ON m.id=c.media_id
           WHERE c.trashed_at IS NOT NULL"""
    ).fetchone()
    invalid = database.execute(
        """SELECT COUNT(*) items,
                  COALESCE(SUM(CASE WHEN s.download_url IS NOT NULL THEN 1 ELSE 0 END),0) recoverable,
                  COALESCE(SUM(CASE WHEN s.download_url IS NULL AND m.favorite=0 AND
                       NOT EXISTS(SELECT 1 FROM media_curation c WHERE c.media_id=m.id AND c.disposition='keep')
                       THEN 1 ELSE 0 END),0) unrecoverable,
                  COALESCE(SUM(CASE WHEN s.download_url IS NULL AND (m.favorite=1 OR
                       EXISTS(SELECT 1 FROM media_curation c WHERE c.media_id=m.id AND c.disposition='keep'))
                       THEN 1 ELSE 0 END),0) protected
           FROM media_text_analysis a
           JOIN media_items m ON m.id=a.media_id
           LEFT JOIN media_recovery_sources s ON s.media_id=m.id
           WHERE m.missing=0 AND a.error_message IS NOT NULL AND
                 NOT EXISTS(SELECT 1 FROM media_curation c WHERE c.media_id=m.id AND c.trashed_at IS NOT NULL)"""
    ).fetchone()
    reclaimed = database.execute(
        """SELECT
                  COALESCE(SUM(CASE WHEN event_type IN ('consolidated','deleted')
                                    THEN estimated_bytes ELSE 0 END),0) bytes,
                  COALESCE(SUM(CASE WHEN event_type IN ('consolidated','deleted')
                                    THEN item_count ELSE 0 END),0) items,
                  COUNT(CASE WHEN event_type IN ('consolidated','deleted') THEN 1 END) actions,
                  COALESCE(SUM(CASE WHEN event_type='consolidated' THEN estimated_bytes ELSE 0 END),0) duplicate_bytes,
                  COALESCE(SUM(CASE WHEN event_type='deleted' THEN estimated_bytes ELSE 0 END),0) deleted_bytes,
                  COALESCE(SUM(CASE WHEN event_type='consolidated' THEN item_count ELSE 0 END),0) duplicate_items,
                  COALESCE(SUM(CASE WHEN event_type='deleted' THEN item_count ELSE 0 END),0) deleted_items,
                  MIN(CASE WHEN event_type IN ('consolidated','deleted') THEN created_at END) first_at,
                  MAX(CASE WHEN event_type IN ('consolidated','deleted') THEN created_at END) last_at,
                  COUNT(DISTINCT CASE WHEN event_type IN ('consolidated','deleted')
                                      THEN date(created_at,'unixepoch','localtime') END) active_days
           FROM media_cleanup_events"""
    ).fetchone()
    return {
        "finalizedItems": int(finalized["items"] or 0),
        "uniqueFinalizedItems": int(finalized["unique_items"] or 0),
        "finalizedBytes": int(finalized["bytes"] or 0),
        "pendingItems": int(pending["items"] or 0),
        "pendingBytes": int(pending["bytes"] or 0),
        "invalidItems": int(invalid["items"] or 0),
        "recoverableItems": int(invalid["recoverable"] or 0),
        "unrecoverableItems": int(invalid["unrecoverable"] or 0),
        "protectedUnreadableItems": int(invalid["protected"] or 0),
        "firstDeletedAt": finalized["first_deleted_at"],
        "lastDeletedAt": finalized["last_deleted_at"],
        "reclaimedBytes": int(reclaimed["bytes"] or 0),
        "reclaimedItems": int(reclaimed["items"] or 0),
        "cleanupActions": int(reclaimed["actions"] or 0),
        "cleanupActiveDays": int(reclaimed["active_days"] or 0),
        "firstCleanupAt": reclaimed["first_at"],
        "lastCleanupAt": reclaimed["last_at"],
        "reclaimedBreakdown": {
            "duplicates": {
                "bytes": int(reclaimed["duplicate_bytes"] or 0),
                "items": int(reclaimed["duplicate_items"] or 0),
            },
            "deleted": {
                "bytes": int(reclaimed["deleted_bytes"] or 0),
                "items": int(reclaimed["deleted_items"] or 0),
            },
        },
    }


def recheck_unreadable_media(database: sqlite3.Connection) -> dict:
    """Reconcile stale paths and retry analysis for files still on disk."""
    rows = database.execute(
        """SELECT m.id,m.path FROM media_text_analysis a
           JOIN media_items m ON m.id=a.media_id
           WHERE m.missing=0 AND a.error_message IS NOT NULL AND
             NOT EXISTS(SELECT 1 FROM media_curation c
                        WHERE c.media_id=m.id AND c.trashed_at IS NOT NULL)"""
    ).fetchall()
    item_ids = [int(row["id"]) for row in rows]
    references = {item_id: [] for item_id in item_ids}
    if item_ids:
        for start in range(0, len(item_ids), 800):
            chunk = item_ids[start:start + 800]
            placeholders = ",".join("?" for _ in chunk)
            for reference in database.execute(
                f"SELECT media_item_id,path FROM media_references "
                f"WHERE media_item_id IN ({placeholders})",
                chunk,
            ).fetchall():
                references[int(reference["media_item_id"])].append(reference["path"])
    stale_ids = []
    retry_ids = []
    for row in rows:
        item_id = int(row["id"])
        paths = [row["path"], *references.get(item_id, [])]
        if any(Path(path).is_file() for path in paths if path):
            retry_ids.append(item_id)
        else:
            stale_ids.append(item_id)
    if stale_ids:
        database.executemany(
            "UPDATE media_items SET missing=1 WHERE id=?",
            ((item_id,) for item_id in stale_ids),
        )
    if retry_ids:
        database.executemany(
            "DELETE FROM media_text_analysis WHERE media_id=?",
            ((item_id,) for item_id in retry_ids),
        )
    return {
        "checked": len(rows),
        "stale": len(stale_ids),
        "retrying": len(retry_ids),
    }


def cleanup_impact(database: sqlite3.Connection) -> dict:
    protected = """missing=0 AND size_bytes>0 AND favorite=0
        AND id NOT IN (SELECT media_id FROM media_curation WHERE trashed_at IS NOT NULL)
        AND id NOT IN (SELECT media_id FROM media_curation WHERE disposition='keep')"""
    profiles = {}
    for profile in ("lowQuality", "accidentalVideo", "downloadedClutter"):
        condition = cleanup_profile_condition(profile)
        row = database.execute(
            f"SELECT COUNT(*) items,COALESCE(SUM(size_bytes),0) bytes FROM media_items WHERE {protected} AND ({condition})"
        ).fetchone()
        profiles[profile] = {"items": int(row["items"]), "bytes": int(row["bytes"])}
    removals = database.execute(
        """SELECT COUNT(*) items,COALESCE(SUM(m.size_bytes),0) bytes
           FROM media_curation c JOIN media_items m ON m.id=c.media_id
           WHERE m.missing=0 AND c.disposition='remove' AND c.trashed_at IS NULL"""
    ).fetchone()
    pending = database.execute(
        """SELECT COUNT(*) items,COALESCE(SUM(m.size_bytes),0) bytes
           FROM media_curation c JOIN media_items m ON m.id=c.media_id
           WHERE c.trashed_at IS NOT NULL"""
    ).fetchone()
    # Keep this overview consistent with duplicate review. In particular, linked
    # profile associations are references, not extra physical copies.
    exact_groups = physical_exact_duplicate_groups(database)
    quality = database.execute(
        f"""SELECT
               (SELECT COUNT(*) FROM media_quality_analysis q JOIN media_items m ON m.id=q.media_id
                WHERE m.missing=0 AND q.model_version='{QUALITY_MODEL}') analyzed,
               (SELECT COUNT(*) FROM media_items WHERE missing=0 AND (
                    media_type='image' OR (media_type='video' AND COALESCE(duration_seconds,0)>0 AND duration_seconds<=2.0)
                )) total"""
    ).fetchone()
    profiles.update({
        "exactDuplicates": {
            "items": len(exact_groups),
            "bytes": sum(int(group["potentialBytes"]) for group in exact_groups),
        },
        "reviewRemovals": {"items": int(removals["items"]), "bytes": int(removals["bytes"])},
        "recentlyDeleted": {"items": int(pending["items"]), "bytes": int(pending["bytes"])},
    })
    return {
        "profiles": profiles,
        "qualityAnalyzed": int(quality["analyzed"]),
        "qualityTotal": int(quality["total"]),
        "overlapWarning": "Review queues can overlap; their byte estimates must not be added together.",
    }


def face_index_status(database: sqlite3.Connection) -> dict:
    row = database.execute(
        """SELECT
               (SELECT COUNT(*) FROM media_items
                WHERE missing=0 AND media_type='image') total,
               (SELECT COUNT(*) FROM media_face_analysis f
                JOIN media_items m ON m.id=f.media_id
                WHERE m.missing=0 AND m.media_type='image') analyzed,
               (SELECT COALESCE(SUM(f.face_count),0) FROM media_face_analysis f
                JOIN media_items m ON m.id=f.media_id
                WHERE m.missing=0 AND m.media_type='image') detected,
               (SELECT COALESCE(MAX(f.analyzed_at),0) FROM media_face_analysis f
                JOIN media_items m ON m.id=f.media_id
                WHERE m.missing=0 AND m.media_type='image') latest"""
    ).fetchone()
    total = int(row["total"] or 0)
    analyzed = min(total, int(row["analyzed"] or 0))
    return {
        "total": total,
        "analyzed": analyzed,
        "remaining": max(0, total - analyzed),
        "detected": int(row["detected"] or 0),
        "latestAt": float(row["latest"] or 0),
    }


def care_index_status(
    database: sqlite3.Connection, semantic_enabled: bool = SEMANTIC_ENABLED
) -> dict:
    exact = database.execute(
        """SELECT
               COUNT(*) total,
               COALESCE(SUM(CASE WHEN m.content_hash IS NOT NULL THEN 1 ELSE 0 END),0) analyzed
           FROM media_items m
           WHERE m.missing=0 AND m.size_bytes>0
             AND m.size_bytes IN (
                 SELECT size_bytes FROM media_items
                 WHERE missing=0 AND size_bytes>0
                 GROUP BY size_bytes HAVING COUNT(*)>1
             )"""
    ).fetchone()
    image = database.execute(
        """SELECT
               COUNT(*) total,
               COUNT(DISTINCT CASE WHEN v.dhash IS NOT NULL THEN m.id END) visual_analyzed,
               COUNT(DISTINCT CASE WHEN e.embedding_blob IS NOT NULL THEN m.id END) semantic_analyzed
           FROM media_items m
           LEFT JOIN media_visual_hashes v ON v.media_id=m.id
           LEFT JOIN media_semantic_embeddings e
             ON e.media_id=m.id AND e.model_version=?
           WHERE m.missing=0 AND m.media_type='image'""",
        (SEMANTIC_DUPLICATE_MODEL,),
    ).fetchone()
    video = database.execute(
        """SELECT
               COUNT(*) total,
               COUNT(DISTINCT CASE WHEN f.media_id IS NOT NULL THEN m.id END) analyzed,
               COUNT(DISTINCT CASE WHEN f.error_message IS NOT NULL THEN m.id END) failed
           FROM media_items m
           LEFT JOIN media_video_fingerprints f
             ON f.media_id=m.id AND f.model_version=?
           WHERE m.missing=0 AND m.media_type='video'
             AND COALESCE(m.duration_seconds,0)>0""",
        (VIDEO_FINGERPRINT_MODEL,),
    ).fetchone()
    quality = database.execute(
        """SELECT
               COUNT(*) total,
               COUNT(DISTINCT CASE WHEN q.media_id IS NOT NULL THEN m.id END) analyzed
           FROM media_items m
           LEFT JOIN media_quality_analysis q
             ON q.media_id=m.id AND q.model_version=?
           WHERE m.missing=0 AND (
               m.media_type='image' OR
               (m.media_type='video' AND COALESCE(m.duration_seconds,0)>0 AND m.duration_seconds<=2.0)
           )""",
        (QUALITY_MODEL,),
    ).fetchone()

    def progress(total, analyzed, **extra):
        total = int(total or 0)
        analyzed = min(total, int(analyzed or 0))
        return {
            "total": total,
            "analyzed": analyzed,
            "remaining": max(0, total - analyzed),
            **extra,
        }

    checks = {
        "exact": progress(exact["total"], exact["analyzed"]),
        "visual": progress(image["total"], image["visual_analyzed"]),
        "video": progress(video["total"], video["analyzed"], failed=int(video["failed"] or 0)),
        "quality": progress(quality["total"], quality["analyzed"]),
    }
    if semantic_enabled:
        checks["semantic"] = progress(image["total"], image["semantic_analyzed"])
    duplicate_checks = [
        checks[key] for key in ("exact", "visual", "semantic", "video") if key in checks
    ]
    all_checks = [*duplicate_checks, checks["quality"]]

    def combined(items):
        total = sum(item["total"] for item in items)
        analyzed = sum(item["analyzed"] for item in items)
        return {
            "total": total,
            "analyzed": analyzed,
            "remaining": max(0, total - analyzed),
            "current": all(item["remaining"] == 0 for item in items),
        }

    return {
        "semanticAvailable": semantic_enabled,
        "checks": checks,
        "duplicates": combined(duplicate_checks),
        "care": combined(all_checks),
    }


def trash_reviewed_items(database: sqlite3.Connection, now: float) -> tuple[int, int]:
    reviewed_ids = [
        int(row[0]) for row in database.execute(
            "SELECT media_id FROM media_curation WHERE disposition='remove' AND trashed_at IS NULL"
        )
    ]
    identity_ids = expanded_identity_media_ids(database, reviewed_ids)
    database.executemany(
        """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
           VALUES(?,'remove',NULL,?) ON CONFLICT(media_id) DO UPDATE SET
           disposition='remove',updated_at=excluded.updated_at""",
        ((item_id, now) for item_id in identity_ids),
    )
    cursor = database.execute(
        "UPDATE media_curation SET trashed_at=?,updated_at=? WHERE disposition='remove' AND trashed_at IS NULL",
        (now, now),
    )
    remaining = database.execute(
        "SELECT COUNT(*) FROM media_curation WHERE disposition='remove' AND trashed_at IS NULL"
    ).fetchone()[0]
    return cursor.rowcount, int(remaining)


def expanded_identity_media_ids(database: sqlite3.Connection, item_ids) -> list[int]:
    values = sorted({int(item_id) for item_id in item_ids})
    if not values:
        return []
    placeholders = ",".join("?" for _ in values)
    hashes = [
        row[0] for row in database.execute(
            f"SELECT DISTINCT content_hash FROM media_items WHERE id IN ({placeholders}) AND content_hash IS NOT NULL",
            tuple(values),
        )
    ]
    expanded = set(values)
    if hashes:
        hash_placeholders = ",".join("?" for _ in hashes)
        expanded.update(
            int(row[0]) for row in database.execute(
                f"SELECT id FROM media_items WHERE missing=0 AND content_hash IN ({hash_placeholders})",
                tuple(hashes),
            )
        )
    return sorted(expanded)


def directly_readable_media_path(row) -> Optional[Path]:
    path = Path(row["path"])
    try:
        with path.open("rb"):
            return path if path.is_file() else None
    except OSError:
        return None


def representative_item(database: sqlite3.Connection, library_id: int, folder_path=None):
    conditions = ["m.library_id = ?", "m.missing = 0", "m.media_type = 'image'"]
    arguments = [library_id]
    if folder_path:
        escaped = folder_path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append("m.path LIKE ? ESCAPE '\\'")
        arguments.append(escaped + "/%")
    return database.execute(
        f"""
        SELECT m.id FROM media_items m
        LEFT JOIN media_text_analysis a ON a.media_id=m.id
        WHERE {' AND '.join(conditions)}
        ORDER BY m.favorite DESC,
                 CASE WHEN a.is_text_heavy=0 THEN 0 WHEN a.is_text_heavy=1 THEN 2 ELSE 1 END,
                 COALESCE(m.width,0)*COALESCE(m.height,0) DESC,
                 m.size_bytes DESC, m.id DESC
        LIMIT 1
        """,
        arguments,
    ).fetchone()


def refresh_symlink_references(database: sqlite3.Connection, library_id: int):
    """Return true when the security-scoped native worker should reconcile references."""
    with reference_lock:
        now = time.monotonic()
        database.executescript("""
            CREATE TABLE IF NOT EXISTS media_references (
                path TEXT PRIMARY KEY,
                media_item_id INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
                folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS media_references_folder ON media_references(folder_id);
            CREATE INDEX IF NOT EXISTS media_references_media ON media_references(media_item_id);
        """)
        existing = database.execute(
            """SELECT COUNT(*) FROM media_references r
               JOIN folders f ON f.id=r.folder_id WHERE f.library_id=?""", (library_id,)
        ).fetchone()[0]
        if existing and now - reference_refreshes.get(library_id, 0) < REFERENCE_REFRESH_SECONDS:
            return False
        library = database.execute("SELECT root_path FROM libraries WHERE id=?", (library_id,)).fetchone()
        if not library or Path(library["root_path"]).name != "Social Archive":
            reference_refreshes[library_id] = now
            return False
        reference_refreshes[library_id] = now
        return True


class AnthoraServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)

    def __init__(
        self,
        address,
        handler,
        database: Path,
        cache: Path,
        reader: Path,
        queue: Path,
        analysis_queue: Path,
        web_root: Path,
        auth_token: Optional[str] = None,
        social_archive_sync: bool = False,
        photos_bridge: Optional[Path] = None,
    ):
        super().__init__(address, handler)
        self.database = database
        self.cache = cache
        self.reader = reader
        self.queue = queue
        self.analysis_queue = analysis_queue
        self.web_root = web_root
        self.auth_token = auth_token
        self.social_archive_sync = social_archive_sync
        self.photos = PhotosBridgeClient(photos_bridge)
        self.interactive_activity = cache.parent / "InteractiveActivity"
        self.purge_lock = threading.Lock()
        self.duplicate_lock = threading.Lock()
        with open_database(database) as operation_database:
            recover_interrupted_scans(operation_database)
            operation_database.execute(
                """UPDATE media_operations SET status='failed',message=?,updated_at=?
                   WHERE status IN ('queued','running')""",
                ("The Anthora service restarted before this operation finished", time.time()),
            )
        # Cold preview generation can occupy many request threads; keep room for
        # navigation and API calls instead of letting thumbnails freeze the app.
        self.request_slots = threading.BoundedSemaphore(160)
        cache.mkdir(parents=True, exist_ok=True)
        queue.mkdir(parents=True, exist_ok=True)
        analysis_queue.mkdir(parents=True, exist_ok=True)
        response_directory = cache.parent / "Responses"
        response_directory.mkdir(parents=True, exist_ok=True)
        cutoff = time.time() - 3_600
        for response in response_directory.glob("*.bin"):
            try:
                if response.stat().st_mtime < cutoff:
                    response.unlink()
            except OSError:
                pass
        photos_content_cutoff = time.time() - 7 * 24 * 60 * 60
        photos_content = cache / "Photos" / "Content"
        if photos_content.is_dir():
            for response in photos_content.rglob("*"):
                try:
                    if response.is_file() and response.stat().st_mtime < photos_content_cutoff:
                        response.unlink()
                except OSError:
                    pass
        threading.Thread(target=self.resume_analysis_when_idle, daemon=True).start()
        if self.social_archive_sync:
            threading.Thread(target=self.auto_sync_social_archive, daemon=True).start()

    def run_native_media(self, command, timeout_seconds=30):
        with native_media_slots:
            result = subprocess.run(
                [str(self.reader), *command],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout_seconds,
                check=False,
            )
        if result.returncode != 0:
            raise RuntimeError("Native media operation failed")

    def queue_worker_request(self, command, timeout_seconds=86_400):
        identifier = uuid.uuid4().hex
        request = self.queue / f"{identifier}.req"
        temporary = self.queue / f".{identifier}.tmp"
        done = self.queue / f"{identifier}.done"
        temporary.write_text("\t".join(command), encoding="utf-8")
        os.replace(temporary, request)
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if done.exists():
                result = done.read_text(encoding="utf-8")
                done.unlink(missing_ok=True)
                if result != "ok":
                    raise RuntimeError(result.partition("\t")[2] or "Native media reader failed")
                return
            time.sleep(0.25)
        request.unlink(missing_ok=True)
        raise TimeoutError("Native media reader timed out during automatic Social Archive sync")

    def auto_sync_social_archive(self):
        state_path = self.cache.parent / "social-archive-sync-state.json"
        # Let the HTTP service and native worker finish launching first.
        time.sleep(5)
        while True:
            candidate = None
            try:
                latest_ref_id = self.social_archive_latest_ref_id()
                with open_database(self.database) as database:
                    candidate = social_archive_sync_candidate(database, state_path, latest_ref_id)
                    if candidate:
                        database.execute(
                            "UPDATE libraries SET scan_status='queued',updated_at=? WHERE id=?",
                            (time.time(), candidate["libraryId"]),
                        )
                if candidate:
                    print(
                        f"[auto-sync] Social Archive changed through reference {candidate['targetRefId']}; rescanning Anthora.",
                        flush=True,
                    )
                    self.queue_worker_request(["scan-library", str(candidate["libraryId"])])
                    save_social_archive_sync_state(state_path, candidate["targetRefId"])
                    for cache_name in ("people-index-v7.json", "people-social-v7.json"):
                        (self.cache.parent / cache_name).unlink(missing_ok=True)
                    with folder_cache_lock:
                        folder_response_cache.clear()
                    with search_fusion_cache_lock:
                        search_fusion_cache.clear()
                    print(
                        f"[auto-sync] Anthora indexed Social Archive through reference {candidate['targetRefId']}.",
                        flush=True,
                    )
            except Exception as error:
                if candidate:
                    try:
                        with open_database(self.database) as database:
                            database.execute(
                                "UPDATE libraries SET scan_status='error',updated_at=? WHERE id=? AND scan_status='queued'",
                                (time.time(), candidate["libraryId"]),
                            )
                    except Exception:
                        pass
                print(f"[auto-sync] Social Archive sync failed: {error}", file=sys.stderr, flush=True)
            time.sleep(SOCIAL_ARCHIVE_SYNC_INTERVAL_SECONDS)

    def social_archive_latest_ref_id(self):
        output = self.cache.parent / f"social-archive-latest-ref-{uuid.uuid4().hex}.json"
        try:
            self.queue_worker_request(["social-archive-latest-ref", str(output)], timeout_seconds=120)
            return int(json.loads(output.read_text(encoding="utf-8"))["latestRefId"])
        finally:
            output.unlink(missing_ok=True)

    @staticmethod
    def set_analysis_suspended(suspended):
        global analysis_suspended
        if not MANAGE_ANALYSIS_WORKER:
            return
        with analysis_process_lock:
            if analysis_suspended == suspended:
                return
            try:
                result = subprocess.run(
                    ["pgrep", "-f", "^/Applications/Anthora.app/Contents/Helpers/AnthoraMediaReader analysis-worker "],
                    capture_output=True,
                    check=False,
                    text=True,
                )
                for value in result.stdout.split():
                    os.kill(int(value), signal.SIGSTOP if suspended else signal.SIGCONT)
                analysis_suspended = suspended
            except (OSError, ValueError):
                pass

    def resume_analysis_when_idle(self):
        while True:
            time.sleep(1)
            try:
                idle_seconds = time.time() - self.interactive_activity.stat().st_mtime
            except OSError:
                idle_seconds = 60
            if idle_seconds >= 8:
                self.set_analysis_suspended(False)

    def mark_interactive_activity(self):
        global interactive_activity_updated_at
        now = time.monotonic()
        with interactive_activity_lock:
            if now - interactive_activity_updated_at < 1:
                return
            interactive_activity_updated_at = now
        try:
            self.interactive_activity.touch()
        except OSError:
            pass
        self.set_analysis_suspended(True)

    def process_request(self, request, client_address):
        self.request_slots.acquire()
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class AnthoraHandler(BaseHTTPRequestHandler):
    server_version = "AnthoraService/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, message, *args):
        redacted = tuple(
            re.sub(r"([?&]access_token=)[^&\s]+", r"\1[REDACTED]", value)
            if isinstance(value, str) else value
            for value in args
        )
        print(f"{self.address_string()} - {message % redacted}", flush=True)

    def authorize(self, parsed, allow_bootstrap=False):
        token = self.server.auth_token
        if request_is_authorized(
            token,
            self.headers.get("Authorization", ""),
            self.headers.get("Cookie", ""),
        ):
            return True
        supplied = parse_qs(parsed.query).get("access_token", [""])[0] if allow_bootstrap else ""
        if token is not None and supplied and hmac.compare_digest(supplied, token):
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", path_without_access_token(self.path) or "/")
            self.send_header(
                "Set-Cookie",
                auth_cookie_header(token),
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        self.send_unauthorized(parsed.path.startswith("/api/"))
        return False

    def send_unauthorized(self, api_request=False):
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("Cache-Control", "no-store")
        self.send_header("WWW-Authenticate", 'Bearer realm="Anthora"')
        if api_request:
            data = b'{"error":"Authentication required"}'
            self.send_header("Content-Type", "application/json; charset=utf-8")
        else:
            data = b"<!doctype html><title>Anthora</title><p>This private Anthora library requires an access link.</p>"
            self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not getattr(self, "head_only", False):
            self.wfile.write(data)

    def require_paid_features(self):
        return True

    def do_GET(self):
        parsed = urlparse(self.path)
        if not self.authorize(parsed, allow_bootstrap=True):
            return
        try:
            if parsed.path == "/api/books":
                return self.books()
            if parsed.path == "/api/health":
                return self.health()
            if parsed.path == "/api/photos/status":
                return self.photos_status()
            if parsed.path == "/api/photos/items":
                return self.photos_items(parse_qs(parsed.query))
            if parsed.path == "/api/photos/albums":
                return self.photos_albums()
            photos_media_match = re.fullmatch(
                r"/api/photos/assets/([A-Za-z0-9_-]+)/(thumbnail|content)", parsed.path
            )
            if photos_media_match:
                return self.photos_media(
                    photos_media_match.group(1), photos_media_match.group(2), parse_qs(parsed.query)
                )
            if parsed.path == "/api/license":
                return self.send_json(license_status(self.server.database))
            if parsed.path == "/api/libraries":
                return self.libraries()
            if parsed.path == "/api/saved-searches":
                return self.saved_searches()
            if parsed.path == "/api/ai/status":
                return self.ai_status()
            if parsed.path == "/api/ai/suggestions":
                return self.ai_suggestions()
            if parsed.path == "/api/search/plan":
                query = parse_qs(parsed.query).get("q", [""])[0]
                return self.send_json({"plan": self.natural_search_plan(query)})
            if parsed.path == "/api/people":
                return self.people(parse_qs(parsed.query))
            if parsed.path == "/api/organization/suggestions":
                return self.organization_suggestions(parse_qs(parsed.query))
            if parsed.path == "/api/duplicates":
                return self.duplicates(parse_qs(parsed.query))
            if parsed.path == "/api/operations":
                return self.operations()
            if parsed.path == "/api/cleanup/stats":
                return self.cleanup_stats()
            if parsed.path == "/api/cleanup/impact":
                return self.cleanup_impact()
            if parsed.path == "/api/care/status":
                return self.care_status()
            if parsed.path == "/api/folders":
                return self.folders(parse_qs(parsed.query))
            if parsed.path == "/api/items":
                return self.items(parse_qs(parsed.query))
            face_match = re.fullmatch(r"/api/items/(\d+)/faces", parsed.path)
            if face_match:
                return self.item_faces(int(face_match.group(1)))
            metadata_match = re.fullmatch(r"/api/items/(\d+)/metadata", parsed.path)
            if metadata_match:
                return self.item_metadata(int(metadata_match.group(1)))
            match = re.fullmatch(r"/api/items/(\d+)/(thumbnail|content|frame|book-preview)", parsed.path)
            if match:
                if match.group(2) == "book-preview" and not self.require_paid_features():
                    return
                return self.media(int(match.group(1)), match.group(2), parse_qs(parsed.query))
            return self.static_file(parsed.path)
        except (BrokenPipeError, ConnectionResetError):
            return
        except PhotosBridgeFailure as error:
            self.send_json({"error": str(error)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except ValueError as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except Exception as error:
            self.send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        self.head_only = True
        if not self.authorize(parsed, allow_bootstrap=True):
            self.head_only = False
            return
        if parsed.path.startswith("/api/"):
            self.head_only = False
            return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        try:
            self.static_file(parsed.path)
        finally:
            self.head_only = False

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self.authorize(parsed):
            return
        if parsed.path == "/api/photos/request-access":
            # This endpoint accepts no body; close the connection so an unexpected
            # body cannot be interpreted as a second request.
            self.close_connection = True
            try:
                payload = self.server.photos.run(["request-access"], timeout_seconds=120)
                payload["configured"] = True
                return self.send_json(payload)
            except PhotosBridgeFailure as error:
                return self.send_json({"error": str(error)}, HTTPStatus.SERVICE_UNAVAILABLE)
        if parsed.path == "/api/license/activate":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            try:
                activated = activate_license(self.server.database, body.get("licenseKey", ""))
            except ValueError as error:
                return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return self.send_json({**license_status(self.server.database), **activated})
        if paid_action(parsed.path) and not self.require_paid_features():
            return
        if parsed.path == "/api/books":
            return self.save_book()
        remove_book_match = re.fullmatch(r"/api/books/([0-9a-f-]{36})/remove", parsed.path)
        if remove_book_match:
            return self.remove_book(remove_book_match.group(1))
        if parsed.path == "/api/books/export-check":
            return self.send_json({"ok": True})
        if parsed.path == "/api/libraries":
            return self.add_library()
        if parsed.path == "/api/saved-searches":
            return self.create_saved_search()
        rename_saved_search_match = re.fullmatch(
            r"/api/saved-searches/([0-9a-f]+)/rename", parsed.path
        )
        if rename_saved_search_match:
            return self.rename_saved_search(rename_saved_search_match.group(1))
        remove_saved_search_match = re.fullmatch(
            r"/api/saved-searches/([0-9a-f]+)/remove", parsed.path
        )
        if remove_saved_search_match:
            return self.remove_saved_search(remove_saved_search_match.group(1))
        scan_library_match = re.fullmatch(r"/api/libraries/(\d+)/scan", parsed.path)
        if scan_library_match:
            return self.scan_library(int(scan_library_match.group(1)))
        cancel_scan_match = re.fullmatch(r"/api/libraries/(\d+)/scan/cancel", parsed.path)
        if cancel_scan_match:
            return self.cancel_library_scan(int(cancel_scan_match.group(1)))
        edit_library_match = re.fullmatch(r"/api/libraries/(\d+)/edit", parsed.path)
        if edit_library_match:
            return self.edit_library(int(edit_library_match.group(1)))
        remove_library_match = re.fullmatch(r"/api/libraries/(\d+)/remove", parsed.path)
        if remove_library_match:
            return self.remove_library(int(remove_library_match.group(1)))
        if parsed.path == "/api/care/undo":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            token = str(json.loads(self.rfile.read(length) or b"{}").get("token", ""))
            with care_undo_lock:
                action = care_undo_actions.pop(token, None)
            if not action or time.time() - action["createdAt"] > CARE_UNDO_SECONDS:
                return self.send_json(
                    {"error": "That action can no longer be undone"},
                    HTTPStatus.CONFLICT,
                )
            with open_database(self.server.database) as database:
                restored = apply_care_undo(database, action)
            return self.send_json({"ok": True, "restored": restored})
        if parsed.path == "/api/cleanup/unreadable/redownload":
            with open_database(self.server.database) as database:
                rows = database.execute(
                    """SELECT m.id,s.download_url FROM media_items m
                       JOIN media_text_analysis a ON a.media_id=m.id AND a.error_message IS NOT NULL
                       JOIN media_recovery_sources s ON s.media_id=m.id AND s.download_url IS NOT NULL
                       WHERE m.missing=0 AND
                         NOT EXISTS(SELECT 1 FROM media_curation c WHERE c.media_id=m.id AND c.trashed_at IS NOT NULL) AND
                         NOT EXISTS(SELECT 1 FROM media_recovery_jobs j WHERE j.media_id=m.id AND j.status IN ('queued','running'))
                       ORDER BY m.id"""
                ).fetchall()
                jobs = []
                now = time.time()
                for row in rows:
                    download_url = valid_recovery_url(row["download_url"])
                    if not download_url:
                        continue
                    job_id = uuid.uuid4().hex
                    database.execute(
                        "INSERT INTO media_recovery_jobs(id,media_id,status,created_at,updated_at) VALUES(?,?,'queued',?,?)",
                        (job_id, int(row["id"]), now, now),
                    )
                    jobs.append((int(row["id"]), download_url, job_id))
            self.queue_background_requests(
                (["recover-item", str(item_id), download_url, job_id] for item_id, download_url, job_id in jobs),
                timeout_seconds=3_600,
            )
            return self.send_json({"ok": True, "queued": len(jobs)}, HTTPStatus.ACCEPTED)
        if parsed.path == "/api/cleanup/unreadable/recheck":
            with open_database(self.server.database) as database:
                result = recheck_unreadable_media(database)
            if result["retrying"]:
                self.enqueue_request(
                    ["analyze-text-batch", str(result["retrying"])],
                    self.server.analysis_queue,
                )
            with folder_cache_lock:
                folder_response_cache.clear()
            return self.send_json({"ok": True, **result}, HTTPStatus.ACCEPTED)
        if parsed.path == "/api/cleanup/unreadable/trash-unrecoverable":
            now = time.time()
            with open_database(self.server.database) as database:
                rows = database.execute(
                    """SELECT m.id FROM media_items m
                       JOIN media_text_analysis a ON a.media_id=m.id AND a.error_message IS NOT NULL
                       LEFT JOIN media_recovery_sources s ON s.media_id=m.id
                       WHERE m.missing=0 AND s.download_url IS NULL AND m.favorite=0 AND
                         NOT EXISTS(SELECT 1 FROM media_curation c WHERE c.media_id=m.id AND c.disposition='keep') AND
                         NOT EXISTS(SELECT 1 FROM media_curation c WHERE c.media_id=m.id AND c.trashed_at IS NOT NULL)"""
                ).fetchall()
                item_ids = [int(row["id"]) for row in rows]
                database.executemany(
                    """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                       VALUES(?,'remove',?,?) ON CONFLICT(media_id) DO UPDATE SET
                       disposition='remove',trashed_at=excluded.trashed_at,updated_at=excluded.updated_at""",
                    ((item_id, now, now) for item_id in item_ids),
                )
            return self.send_json({"ok": True, "trashed": len(item_ids), "retentionDays": 30})
        if parsed.path == "/api/items/bulk":
            length = min(int(self.headers.get("Content-Length", "0")), 512_000)
            body = json.loads(self.rfile.read(length) or b"{}")
            item_ids = list(dict.fromkeys(
                int(value) for value in body.get("ids", []) if str(value).isdigit()
            ))[:5_000]
            action = body.get("action")
            if not item_ids or action not in ("keep", "review", "favorite", "unfavorite", "trash"):
                return self.send_json({"error": "Valid item IDs and a bulk action are required"}, HTTPStatus.BAD_REQUEST)
            if action in ("keep", "review", "trash") and not self.require_paid_features():
                return
            now = time.time()
            with open_database(self.server.database) as database:
                if action == "trash":
                    item_ids = expanded_identity_media_ids(database, item_ids)
                previous_curation = (
                    curation_snapshot(database, item_ids)
                    if action in ("keep", "review", "trash")
                    else []
                )
                if action in ("keep", "review"):
                    disposition = "keep" if action == "keep" else "remove"
                    reaction = "like" if action == "keep" else "dislike"
                    database.executemany(
                        """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                           VALUES(?,?,NULL,?) ON CONFLICT(media_id) DO UPDATE SET
                           disposition=excluded.disposition,trashed_at=NULL,updated_at=excluded.updated_at""",
                        ((item_id, disposition, now) for item_id in item_ids),
                    )
                    database.executemany(
                        """INSERT INTO media_reactions(media_id,reaction,updated_at)
                           VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                           reaction=excluded.reaction,updated_at=excluded.updated_at""",
                        ((item_id, reaction, now) for item_id in item_ids),
                    )
                elif action in ("favorite", "unfavorite"):
                    database.executemany(
                        "UPDATE media_items SET favorite=? WHERE id=? AND missing=0",
                        ((int(action == "favorite"), item_id) for item_id in item_ids),
                    )
                else:
                    database.executemany(
                        """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                           VALUES(?,'remove',?,?) ON CONFLICT(media_id) DO UPDATE SET
                           disposition='remove',trashed_at=excluded.trashed_at,updated_at=excluded.updated_at""",
                        ((item_id, now, now) for item_id in item_ids),
                    )
            undo_token = (
                remember_care_undo("curation", {"items": previous_curation}, now)
                if previous_curation
                else None
            )
            return self.send_json({
                "ok": True,
                "action": action,
                "updated": len(item_ids),
                "updatedIds": item_ids,
                "undoToken": undo_token,
                "undoSeconds": CARE_UNDO_SECONDS if undo_token else 0,
            })
        if parsed.path == "/api/ai/analyze":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            batch_size = min(50, max(1, int(body.get("limit", 10))))
            self.enqueue_request(["analyze-text-batch", str(batch_size)], self.server.analysis_queue)
            return self.send_json({"queued": True}, HTTPStatus.ACCEPTED)
        recovery_source_match = re.fullmatch(r"/api/items/(\d+)/recovery-source", parsed.path)
        if recovery_source_match:
            item_id = int(recovery_source_match.group(1))
            length = min(int(self.headers.get("Content-Length", "0")), 16_384)
            body = json.loads(self.rfile.read(length) or b"{}")
            provider = str(body.get("provider", "")).strip()[:80] or None
            source_url = valid_recovery_url(body.get("sourceUrl"))
            download_url = valid_recovery_url(body.get("downloadUrl"))
            if body.get("sourceUrl") and not source_url:
                return self.send_json({"error": "Source URL must be HTTPS"}, HTTPStatus.BAD_REQUEST)
            if body.get("downloadUrl") and not download_url:
                return self.send_json({"error": "Download URL must be a direct HTTPS URL"}, HTTPStatus.BAD_REQUEST)
            if not source_url and not download_url:
                return self.send_json({"error": "A source or download URL is required"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                if not database.execute("SELECT 1 FROM media_items WHERE id=?", (item_id,)).fetchone():
                    return self.send_error(HTTPStatus.NOT_FOUND)
                database.execute(
                    """INSERT INTO media_recovery_sources(media_id,provider,source_url,download_url,updated_at)
                       VALUES(?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                       provider=excluded.provider,source_url=excluded.source_url,
                       download_url=excluded.download_url,updated_at=excluded.updated_at""",
                    (item_id, provider, source_url, download_url, time.time()),
                )
            return self.send_json({"ok": True, "itemId": item_id, "downloadAvailable": bool(download_url)})
        recovery_match = re.fullmatch(r"/api/items/(\d+)/redownload", parsed.path)
        if recovery_match:
            item_id = int(recovery_match.group(1))
            with open_database(self.server.database) as database:
                recovery = database.execute(
                    """SELECT s.download_url FROM media_items m
                       JOIN media_text_analysis a ON a.media_id=m.id AND a.error_message IS NOT NULL
                       JOIN media_recovery_sources s ON s.media_id=m.id
                       WHERE m.id=? AND m.missing=0""",
                    (item_id,),
                ).fetchone()
                if not recovery or not valid_recovery_url(recovery["download_url"]):
                    return self.send_json(
                        {"error": "No verified recovery download is available for this invalid file"},
                        HTTPStatus.CONFLICT,
                    )
                active = database.execute(
                    "SELECT 1 FROM media_recovery_jobs WHERE media_id=? AND status IN ('queued','running')",
                    (item_id,),
                ).fetchone()
                if active:
                    return self.send_json({"error": "Recovery is already in progress"}, HTTPStatus.CONFLICT)
                job_id = uuid.uuid4().hex
                now = time.time()
                database.execute(
                    "INSERT INTO media_recovery_jobs(id,media_id,status,created_at,updated_at) VALUES(?,?,'queued',?,?)",
                    (job_id, item_id, now, now),
                )
                download_url = recovery["download_url"]
            self.queue_background_request(
                ["recover-item", str(item_id), download_url, job_id],
                timeout_seconds=3_600,
            )
            return self.send_json({"ok": True, "status": "queued", "jobId": job_id}, HTTPStatus.ACCEPTED)
        disposition_match = re.fullmatch(r"/api/items/(\d+)/disposition", parsed.path)
        if disposition_match:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            value = json.loads(self.rfile.read(length) or b"{}").get("value")
            if value not in ("keep", "remove", None):
                return self.send_json({"error": "Invalid disposition"}, HTTPStatus.BAD_REQUEST)
            item_id = int(disposition_match.group(1))
            with open_database(self.server.database) as database:
                if value is None:
                    database.execute("DELETE FROM media_curation WHERE media_id=?", (item_id,))
                    database.execute("DELETE FROM media_reactions WHERE media_id=?", (item_id,))
                else:
                    database.execute(
                        """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                           VALUES(?,?,NULL,?) ON CONFLICT(media_id) DO UPDATE SET
                           disposition=excluded.disposition,trashed_at=NULL,updated_at=excluded.updated_at""",
                        (item_id, value, time.time()),
                    )
                    database.execute(
                        """INSERT INTO media_reactions(media_id,reaction,updated_at)
                           VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                           reaction=excluded.reaction,updated_at=excluded.updated_at""",
                        (item_id, "like" if value == "keep" else "dislike", time.time()),
                    )
            return self.send_json({"ok": True, "disposition": value})
        screenshot_category_match = re.fullmatch(r"/api/items/(\d+)/screenshot-category", parsed.path)
        if screenshot_category_match:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            category = json.loads(self.rfile.read(length) or b"{}").get("category")
            if category not in SCREENSHOT_CATEGORY_KEYS:
                return self.send_json({"error": "Invalid screenshot category"}, HTTPStatus.BAD_REQUEST)
            item_id = int(screenshot_category_match.group(1))
            with open_database(self.server.database) as database:
                if not database.execute(
                    "SELECT 1 FROM media_items WHERE id=? AND media_type='image' AND missing=0",
                    (item_id,),
                ).fetchone():
                    return self.send_json({"error": "Screenshot was not found"}, HTTPStatus.NOT_FOUND)
                database.execute(
                    """INSERT INTO media_screenshot_categories(media_id,category,updated_at)
                       VALUES(?,?,?) ON CONFLICT(media_id) DO UPDATE SET
                       category=excluded.category,updated_at=excluded.updated_at""",
                    (item_id, category, time.time()),
                )
            return self.send_json({"ok": True, "itemId": item_id, "category": category})
        face_match = re.fullmatch(r"/api/items/(\d+)/faces/(\d+)", parsed.path)
        if face_match:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            assigned_person_key = re.sub(r"[^a-z0-9]+", "", str(body.get("personKey", "")).lower()) or None
            item_id, face_index = int(face_match.group(1)), int(face_match.group(2))
            with open_database(self.server.database) as database:
                cursor = database.execute(
                    """UPDATE media_face_features SET person_key=?,match_distance=NULL,assignment_source=?
                       WHERE media_id=? AND face_index=?""",
                    (assigned_person_key, "user" if assigned_person_key else None, item_id, face_index),
                )
            if not cursor.rowcount:
                return self.send_json({"error": "Face was not found"}, HTTPStatus.NOT_FOUND)
            return self.send_json({"ok": True, "personKey": assigned_person_key})
        if parsed.path == "/api/curation/trash-removed":
            with open_database(self.server.database) as database:
                trashed, remaining = trash_reviewed_items(database, time.time())
                if remaining:
                    raise RuntimeError("Reviewed removals remain after the move")
            return self.send_json({
                "ok": True,
                "trashed": trashed,
                "remaining": remaining,
                "retentionDays": 30,
            })
        if parsed.path == "/api/curation/purge-trash/job":
            with open_database(self.server.database) as database:
                active = database.execute(
                    "SELECT id,kind FROM media_operations WHERE status IN ('queued','running') LIMIT 1"
                ).fetchone()
                if active:
                    return self.send_json(
                        {"error": "Another library operation is already running", "jobId": active["id"]},
                        HTTPStatus.CONFLICT,
                    )
                totals = database.execute(
                    """SELECT COUNT(*) item_count,COALESCE(SUM(m.size_bytes),0) total_bytes
                       FROM media_items m JOIN media_curation c ON c.media_id=m.id
                       WHERE c.trashed_at IS NOT NULL"""
                ).fetchone()
                total_items = int(totals["item_count"] or 0)
                if not total_items:
                    return self.send_json(
                        {"error": "Recently Deleted is already empty"},
                        HTTPStatus.CONFLICT,
                    )
                job_id = uuid.uuid4().hex
                now = time.time()
                database.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (job_id, "purgeTrash", "queued", total_items, 0, 0, 0, 0, "{}",
                     "Waiting to empty Recently Deleted", now, now),
                )
            threading.Thread(
                target=self.run_purge_trash_job,
                args=(job_id,),
                daemon=True,
            ).start()
            return self.send_json(
                {"ok": True, "status": "queued", "jobId": job_id, "totalItems": total_items,
                 "totalBytes": int(totals["total_bytes"] or 0)},
                HTTPStatus.ACCEPTED,
            )
        if parsed.path == "/api/curation/purge-trash":
            if not self.server.purge_lock.acquire(blocking=False):
                return self.send_json(
                    {"error": "Recently Deleted is already being emptied"},
                    HTTPStatus.CONFLICT,
                )
            lock_file = None
            file_locked = False
            try:
                lock_path = self.server.cache.parent / "purge-trash.lock"
                lock_file = lock_path.open("a+")
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    file_locked = True
                except BlockingIOError:
                    return self.send_json(
                        {"error": "Recently Deleted is already being emptied"},
                        HTTPStatus.CONFLICT,
                    )
                return self.purge_trash()
            finally:
                if file_locked:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                if lock_file is not None:
                    lock_file.close()
                self.server.purge_lock.release()
        if parsed.path == "/api/duplicates/exact/bulk":
            length = min(int(self.headers.get("Content-Length", "0")), 64_000)
            body = json.loads(self.rfile.read(length) or b"{}")
            action = body.get("action")
            all_groups = body.get("all") is True
            requested_hashes = list(dict.fromkeys(
                value.lower() for value in body.get("hashes", [])
                if isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value)
            ))[:250]
            if action not in ("consolidate", "trash") or (not all_groups and not requested_hashes):
                return self.send_json(
                    {"error": "An exact-copy action and valid groups are required"},
                    HTTPStatus.BAD_REQUEST,
                )
            if not self.server.duplicate_lock.acquire(blocking=False):
                return self.send_json(
                    {"error": "Exact-copy maintenance is already running"},
                    HTTPStatus.CONFLICT,
                )
            lock_file = None
            file_locked = False
            try:
                lock_file = (self.server.cache.parent / "exact-duplicates.lock").open("a+")
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    file_locked = True
                except BlockingIOError:
                    return self.send_json(
                        {"error": "Exact-copy maintenance is already running"},
                        HTTPStatus.CONFLICT,
                    )
                return self.send_json(self.exact_duplicate_action_result(
                    action, None if all_groups else requested_hashes,
                ))
            finally:
                if file_locked:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                if lock_file is not None:
                    lock_file.close()
                self.server.duplicate_lock.release()
        if parsed.path == "/api/duplicates/exact/job":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            action = body.get("action")
            if action not in ("consolidate", "trash"):
                return self.send_json({"error": "A valid exact-copy action is required"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                active = database.execute(
                    "SELECT id FROM media_operations WHERE kind='exactDuplicates' AND status IN ('queued','running') LIMIT 1"
                ).fetchone()
                if active:
                    return self.send_json(
                        {"error": "Exact-copy maintenance is already running", "jobId": active["id"]},
                        HTTPStatus.CONFLICT,
                    )
                hashes = exact_duplicate_hashes(database, limit=None)
                if not hashes:
                    return self.send_json({"error": "No exact-copy groups need review"}, HTTPStatus.CONFLICT)
                job_id = uuid.uuid4().hex
                now = time.time()
                database.execute(
                    "INSERT INTO media_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (job_id, "exactDuplicates", "queued", len(hashes), 0, 0, 0, 0,
                     json.dumps({"action": action, "hashes": hashes}),
                     "Waiting for exact-copy maintenance", now, now),
                )
            threading.Thread(
                target=self.run_exact_duplicate_job,
                args=(job_id,),
                daemon=True,
            ).start()
            return self.send_json(
                {"ok": True, "status": "queued", "jobId": job_id, "totalGroups": len(hashes)},
                HTTPStatus.ACCEPTED,
            )
        if parsed.path == "/api/duplicates/consolidate":
            length = min(int(self.headers.get("Content-Length", "0")), 16384)
            body = json.loads(self.rfile.read(length) or b"{}")
            keep_id = int(body.get("keepId", 0))
            trash_others = body.get("trashOthers") is True
            remove_ids = sorted(set(
                int(value) for value in body.get("removeIds", [])
                if str(value).isdigit() and int(value) != keep_id
            ))[:100]
            if not keep_id or not remove_ids:
                return self.send_json({"error": "A keeper and redundant items are required"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                keep_hash = database.execute("SELECT content_hash FROM media_items WHERE id=?", (keep_id,)).fetchone()
                remove_hashes = database.execute(
                    f"SELECT id,content_hash FROM media_items WHERE missing=0 AND id IN ({','.join('?' for _ in remove_ids)})",
                    tuple(remove_ids),
                ).fetchall()
                valid = bool(
                    keep_hash and keep_hash["content_hash"]
                    and len(remove_hashes) == len(remove_ids)
                    and all(row["content_hash"] == keep_hash["content_hash"] for row in remove_hashes)
                )
                saved_bytes = database.execute(
                    f"SELECT COALESCE(SUM(size_bytes),0) FROM media_items WHERE id IN ({','.join('?' for _ in remove_ids)})",
                    tuple(remove_ids),
                ).fetchone()[0]
            if not valid:
                return self.send_json({"error": "Items are not verified exact duplicates"}, HTTPStatus.CONFLICT)
            for item_id in remove_ids:
                self.queue_request(["consolidate-exact", str(keep_id), str(item_id)])
            with open_database(self.server.database) as database:
                if not exact_consolidation_completed(database, keep_id, remove_ids):
                    raise RuntimeError("Exact-copy consolidation did not finish cleanly")
                database.execute(
                    "INSERT INTO media_cleanup_events VALUES(?,?,?,?,?,?)",
                    (uuid.uuid4().hex, "consolidated", "exact", len(remove_ids) + 1, int(saved_bytes or 0), time.time()),
                )
            return self.send_json({
                "ok": True,
                "kept": keep_id,
                "consolidated": len(remove_ids),
                "estimatedBytes": int(saved_bytes or 0),
            })
        if parsed.path == "/api/duplicates/not-duplicates":
            length = min(int(self.headers.get("Content-Length", "0")), 16_384)
            body = json.loads(self.rfile.read(length) or b"{}")
            item_ids = sorted(set(
                int(value) for value in body.get("ids", []) if str(value).isdigit()
            ))[:100]
            if len(item_ids) < 2:
                return self.send_json({"error": "At least two media items are required"}, HTTPStatus.BAD_REQUEST)
            group_kind = body.get("kind") if body.get("kind") in ("resized", "cropped", "video", "bestShot") else "similar"
            changed_at = time.time()
            pairs = [
                (left, right, "not_duplicate", changed_at)
                for index, left in enumerate(item_ids)
                for right in item_ids[index + 1:]
            ]
            with open_database(self.server.database) as database:
                pair_keys = [(left, right) for left, right, _, _ in pairs]
                previous_by_pair = {
                    (int(row["left_media_id"]), int(row["right_media_id"])): row
                    for row in database.execute(
                        f"""SELECT left_media_id,right_media_id,decision,updated_at
                            FROM media_similarity_reviews
                            WHERE (left_media_id,right_media_id) IN ({
                                ",".join("(?,?)" for _ in pair_keys)
                            })""",
                        tuple(value for pair in pair_keys for value in pair),
                    )
                }
                previous_pairs = [
                    {
                        "left": left,
                        "right": right,
                        "existed": (left, right) in previous_by_pair,
                        "decision": (
                            previous_by_pair[(left, right)]["decision"]
                            if (left, right) in previous_by_pair else None
                        ),
                        "updatedAt": (
                            previous_by_pair[(left, right)]["updated_at"]
                            if (left, right) in previous_by_pair else None
                        ),
                    }
                    for left, right in pair_keys
                ]
                database.executemany(
                    """INSERT OR REPLACE INTO media_similarity_reviews(
                           left_media_id,right_media_id,decision,updated_at
                       ) VALUES(?,?,?,?)""",
                    pairs,
                )
                database.execute(
                    "INSERT INTO media_cleanup_events VALUES(?,?,?,?,?,?)",
                    (uuid.uuid4().hex, "not_duplicate", group_kind, len(item_ids), 0, time.time()),
                )
            undo_token = remember_care_undo(
                "similarity",
                {"pairs": previous_pairs},
                changed_at,
            )
            return self.send_json({
                "ok": True,
                "dismissedPairs": len(pairs),
                "undoToken": undo_token,
                "undoSeconds": CARE_UNDO_SECONDS,
            })
        if parsed.path == "/api/duplicates/use-recommendation":
            length = min(int(self.headers.get("Content-Length", "0")), 16_384)
            body = json.loads(self.rfile.read(length) or b"{}")
            keep_ids = sorted(set(
                int(value) for value in body.get("keepIds", [])
                if str(value).isdigit() and int(value) > 0
            ))[:100]
            keep_id = int(body.get("keepId", 0))
            if not keep_ids and keep_id > 0:
                keep_ids = [keep_id]
            trash_others = body.get("trashOthers") is True
            remove_ids = sorted(set(
                int(value) for value in body.get("removeIds", [])
                if str(value).isdigit() and int(value) not in keep_ids
            ))[:100]
            group_kind = body.get("kind") if body.get("kind") in ("resized", "cropped", "video", "bestShot") else "resized"
            if not keep_ids or not remove_ids:
                return self.send_json({"error": "At least one keeper and one unwanted version are required"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                rows = database.execute(
                    f"""SELECT m.id,m.size_bytes,m.favorite,c.disposition FROM media_items m
                        LEFT JOIN media_curation c ON c.media_id=m.id
                        WHERE m.missing=0 AND m.id IN ({','.join('?' for _ in [*keep_ids, *remove_ids])})""",
                    tuple([*keep_ids, *remove_ids]),
                ).fetchall()
                by_id = {int(row["id"]): row for row in rows}
                if any(item_id not in by_id for item_id in [*keep_ids, *remove_ids]):
                    return self.send_json({"error": "One or more media items no longer exist"}, HTTPStatus.CONFLICT)
                protected = [
                    item_id for item_id in remove_ids
                    if by_id[item_id]["favorite"] or by_id[item_id]["disposition"] == "keep"
                ]
                if trash_others and protected:
                    return self.send_json(
                        {"error": "A version you marked as a favorite or keeper is protected. Remove that choice first."},
                        HTTPStatus.CONFLICT,
                    )
                eligible = [
                    item_id for item_id in remove_ids
                    if not by_id[item_id]["favorite"] and by_id[item_id]["disposition"] != "keep"
                ]
                now = time.time()
                previous_curation = curation_snapshot(database, [*keep_ids, *eligible])
                database.executemany(
                    """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                       VALUES(?,'keep',NULL,?) ON CONFLICT(media_id) DO UPDATE SET
                       disposition='keep',trashed_at=NULL,updated_at=excluded.updated_at""",
                    ((item_id, now) for item_id in keep_ids),
                )
                database.executemany(
                    """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                       VALUES(?,'remove',?,?) ON CONFLICT(media_id) DO UPDATE SET
                       disposition='remove',trashed_at=excluded.trashed_at,updated_at=excluded.updated_at""",
                    ((item_id, now if trash_others else None, now) for item_id in eligible),
                )
                estimated_bytes = sum(int(by_id[item_id]["size_bytes"] or 0) for item_id in eligible)
                database.execute(
                    "INSERT INTO media_cleanup_events VALUES(?,?,?,?,?,?)",
                    (uuid.uuid4().hex, "kept_versions" if trash_others else "used_recommendation", group_kind, len(eligible) + len(keep_ids), estimated_bytes, now),
                )
            undo_token = remember_care_undo(
                "curation",
                {"items": previous_curation},
                now,
            )
            return self.send_json({
                "ok": True,
                "kept": keep_ids[0],
                "keptIds": keep_ids,
                "markedForRemoval": len(eligible),
                "movedToTrash": len(eligible) if trash_others else 0,
                "estimatedBytes": estimated_bytes,
                "undoToken": undo_token,
                "undoSeconds": CARE_UNDO_SECONDS,
            })
        if parsed.path == "/api/people/alias":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            source = person_key(body.get("source"))
            display = str(body.get("displayName", "")).strip()
            target = person_key(body.get("target", source))
            if not source or not target or not display:
                return self.send_json({"error": "Source, target, and display name are required"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                database.execute(
                    """INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)
                       ON CONFLICT(source_key) DO UPDATE SET target_key=excluded.target_key,display_name=excluded.display_name,updated_at=excluded.updated_at""",
                    (source, target, display, time.time()),
                )
            for cache_name in PEOPLE_CACHE_NAMES:
                (self.server.cache.parent / cache_name).unlink(missing_ok=True)
            return self.send_json({"ok": True, "source": source, "target": target, "displayName": display})
        if parsed.path == "/api/people/alias/reset":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            source = person_key(json.loads(self.rfile.read(length) or b"{}").get("source"))
            if not source:
                return self.send_json({"error": "Source identity is required"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                database.execute("DELETE FROM people_aliases WHERE source_key=?", (source,))
            for cache_name in PEOPLE_CACHE_NAMES:
                (self.server.cache.parent / cache_name).unlink(missing_ok=True)
            return self.send_json({"ok": True, "source": source})
        if parsed.path == "/api/people/merge":
            length = min(int(self.headers.get("Content-Length", "0")), 16_384)
            body = json.loads(self.rfile.read(length) or b"{}")
            keys = [person_key(value) for value in body.get("keys", [])]
            keys = [key for key in keys if key]
            target = person_key(body.get("target"))
            display = str(body.get("displayName", "")).strip()
            with open_database(self.server.database) as database:
                merged = merge_people(database, keys, target, display)
            if merged < 2:
                return self.send_json(
                    {"error": "Choose at least two people and provide one name"},
                    HTTPStatus.BAD_REQUEST,
                )
            for cache_name in PEOPLE_CACHE_NAMES:
                (self.server.cache.parent / cache_name).unlink(missing_ok=True)
            return self.send_json({"ok": True, "target": target, "displayName": display, "mergedGroups": len(set(keys))})
        if parsed.path == "/api/people/cover":
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            key = person_key(body.get("personKey"))
            try:
                media_id = int(body.get("mediaId", 0))
            except (TypeError, ValueError):
                media_id = 0
            if not key or media_id <= 0:
                return self.send_json(
                    {"error": "A person and image are required"},
                    HTTPStatus.BAD_REQUEST,
                )
            with open_database(self.server.database) as database:
                if not save_person_cover(database, key, media_id):
                    return self.send_json(
                        {"error": "Choose an image from this person's photos"},
                        HTTPStatus.CONFLICT,
                    )
            for cache_name in PEOPLE_CACHE_NAMES:
                (self.server.cache.parent / cache_name).unlink(missing_ok=True)
            return self.send_json({
                "ok": True,
                "personKey": key,
                "coverItemId": media_id,
                "coverUrl": f"/api/items/{media_id}/thumbnail?size=500",
            })
        organization_match = re.fullmatch(r"/api/organization/suggestions/(\d+)", parsed.path)
        if organization_match:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            body = json.loads(self.rfile.read(length) or b"{}")
            return self.organization_decision(
                int(organization_match.group(1)),
                str(body.get("personKey", "")),
                str(body.get("action", "")),
            )
        cover_match = re.fullmatch(r"/api/folders/(\d+)/cover", parsed.path)
        if cover_match:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            item_id = json.loads(self.rfile.read(length) or b"{}").get("itemId")
            folder_id = int(cover_match.group(1))
            with open_database(self.server.database) as database:
                folder = database.execute("SELECT path FROM folders WHERE id=?", (folder_id,)).fetchone()
                if not folder:
                    return self.send_error(HTTPStatus.NOT_FOUND)
                if item_id is None:
                    database.execute("DELETE FROM folder_covers WHERE folder_id=?", (folder_id,))
                else:
                    item_id = int(item_id)
                    escaped = folder["path"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"
                    belongs = database.execute(
                        """SELECT 1 FROM media_items m WHERE m.id=? AND m.missing=0 AND
                           (m.path LIKE ? ESCAPE '\\' OR m.id IN (SELECT r.media_item_id FROM media_references r
                           JOIN folders f ON f.id=r.folder_id WHERE f.path=? OR f.path LIKE ? ESCAPE '\\'))""",
                        (item_id, escaped, folder["path"], escaped),
                    ).fetchone()
                    if not belongs:
                        return self.send_json({"error": "Cover item is not in this folder"}, HTTPStatus.CONFLICT)
                    database.execute(
                        """INSERT INTO folder_covers(folder_id,media_item_id,updated_at) VALUES(?,?,?)
                           ON CONFLICT(folder_id) DO UPDATE SET media_item_id=excluded.media_item_id,updated_at=excluded.updated_at""",
                        (folder_id, item_id, time.time()),
                    )
            return self.send_json({"ok": True, "folderId": folder_id, "itemId": item_id})
        restore_match = re.fullmatch(r"/api/items/(\d+)/restore", parsed.path)
        if restore_match:
            with open_database(self.server.database) as database:
                item_ids = expanded_identity_media_ids(database, [int(restore_match.group(1))])
                placeholders = ",".join("?" for _ in item_ids)
                cursor = database.execute(
                    f"UPDATE media_curation SET trashed_at=NULL,disposition=NULL,updated_at=? WHERE media_id IN ({placeholders})",
                    (time.time(), *item_ids),
                )
            return self.send_json({"ok": cursor.rowcount > 0, "restored": cursor.rowcount})
        delete_match = re.fullmatch(r"/api/items/(\d+)/delete-now", parsed.path)
        if delete_match:
            item_id = int(delete_match.group(1))
            with open_database(self.server.database) as database:
                allowed = database.execute(
                    "SELECT 1 FROM media_curation WHERE media_id=? AND trashed_at IS NOT NULL", (item_id,)
                ).fetchone()
            if not allowed:
                return self.send_json({"error": "Item must be in Recently Deleted first"}, HTTPStatus.CONFLICT)
            self.queue_request(["purge-item", str(item_id), "now"])
            return self.send_json({"ok": True, "deleted": item_id})
        reentry_match = re.fullmatch(r"/api/items/(\d+)/reentry", parsed.path)
        if reentry_match:
            item_id = int(reentry_match.group(1))
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            decision = json.loads(self.rfile.read(length) or b"{}").get("decision")
            if decision not in ("approve", "remove"):
                return self.send_json({"error": "Decision must be approve or remove"}, HTTPStatus.BAD_REQUEST)
            with open_database(self.server.database) as database:
                pending = database.execute(
                    "SELECT 1 FROM media_reentry_reviews WHERE media_id=?", (item_id,)
                ).fetchone()
                if not pending:
                    return self.send_json({"error": "Item is not awaiting re-entry review"}, HTTPStatus.CONFLICT)
                if decision == "approve":
                    database.execute("UPDATE media_items SET missing=0 WHERE id=?", (item_id,))
                    database.execute("DELETE FROM media_reentry_reviews WHERE media_id=?", (item_id,))
            if decision == "remove":
                self.queue_request(["purge-item", str(item_id)])
            return self.send_json({"ok": True, "decision": decision, "itemId": item_id})
        match = re.fullmatch(r"/api/items/(\d+)/favorite", parsed.path)
        if not match:
            return self.send_error(HTTPStatus.NOT_FOUND)
        length = min(int(self.headers.get("Content-Length", "0")), 4096)
        body = json.loads(self.rfile.read(length) or b"{}")
        favorite = bool(body.get("favorite", True))
        with open_database(self.server.database) as database:
            cursor = database.execute(
                "UPDATE media_items SET favorite = ? WHERE id = ? AND missing = 0",
                (int(favorite), int(match.group(1))),
            )
        if cursor.rowcount != 1:
            return self.send_error(HTTPStatus.NOT_FOUND)
        self.send_json({"ok": True, "favorite": favorite})

    def books(self):
        with open_database(self.server.database) as database:
            book_table(database)
            rows = database.execute("SELECT payload FROM anthora_books ORDER BY updated_at DESC").fetchall()
        self.send_json({"books": [json.loads(row[0]) for row in rows]})

    def remove_book(self, book_id):
        # Read the request body so a reused connection cannot interpret it as another request.
        try:
            self._json_body(maximum=4096)
        except (ValueError, TypeError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        with open_database(self.server.database) as database:
            book_table(database)
            removed = database.execute("DELETE FROM anthora_books WHERE id=?", (book_id,)).rowcount
        if not removed:
            return self.send_json({"error": "This book has already been removed."}, HTTPStatus.NOT_FOUND)
        return self.send_json({"ok": True})

    def save_book(self):
        try:
            book = normalize_book(self._json_body(maximum=1_000_000))
            with open_database(self.server.database) as database:
                book_table(database)
                database.execute("INSERT INTO anthora_books VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
                                 (book["id"], json.dumps(book), time.time()))
            return self.send_json({"book": book})
        except (ValueError, TypeError, KeyError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    def health(self):
        with open_database(self.server.database) as database:
            count = database.execute(
                "SELECT COUNT(*) FROM media_items WHERE missing = 0"
            ).fetchone()[0]
        self.send_json({"status": "ok", "database": "reachable", "items": count})

    def cleanup_stats(self):
        with open_database(self.server.database) as database:
            self.send_json(cleanup_stats(database))

    def operations(self):
        with open_database(self.server.database) as database:
            row = database.execute(
                """SELECT * FROM media_operations
                   ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END,updated_at DESC
                   LIMIT 1"""
            ).fetchone()
        if not row:
            return self.send_json({"operation": None})
        return self.send_json({"operation": {
            "id": row["id"],
            "kind": row["kind"],
            "status": row["status"],
            "totalUnits": int(row["total_units"]),
            "completedUnits": int(row["completed_units"]),
            "failedUnits": int(row["failed_units"]),
            "processedItems": int(row["processed_items"]),
            "estimatedBytes": int(row["estimated_bytes"]),
            "message": row["message"],
            "updatedAt": float(row["updated_at"]),
        }})

    def saved_searches(self):
        with open_database(self.server.database) as database:
            ensure_saved_searches_table(database)
            rows = database.execute(
                "SELECT id,name,params_json,created_at,updated_at "
                "FROM saved_searches ORDER BY name COLLATE NOCASE,id"
            ).fetchall()
        return self.send_json({"savedSearches": [
            {
                "id": row["id"],
                "name": row["name"],
                "params": json.loads(row["params_json"]),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]})

    def _json_body(self, maximum=16384):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > maximum:
            raise ValueError("Request is too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def create_saved_search(self):
        try:
            body = self._json_body()
            name, params = normalize_saved_search(body.get("name"), body.get("params"))
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        identifier = uuid.uuid4().hex
        now = time.time()
        with open_database(self.server.database) as database:
            ensure_saved_searches_table(database)
            database.execute(
                "INSERT INTO saved_searches(id,name,params_json,created_at,updated_at) "
                "VALUES(?,?,?,?,?)",
                (identifier, name, json.dumps(params, sort_keys=True), now, now),
            )
        return self.send_json({
            "savedSearch": {
                "id": identifier, "name": name, "params": params,
                "createdAt": now, "updatedAt": now,
            }
        }, HTTPStatus.CREATED)

    def rename_saved_search(self, identifier):
        try:
            body = self._json_body(4096)
            name = " ".join(str(body.get("name") or "").split())
            if not name:
                raise ValueError("Enter a name for this Smart Search")
            if len(name) > 80:
                raise ValueError("Smart Search names must be 80 characters or fewer")
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        with open_database(self.server.database) as database:
            ensure_saved_searches_table(database)
            cursor = database.execute(
                "UPDATE saved_searches SET name=?,updated_at=? WHERE id=?",
                (name, time.time(), identifier),
            )
        if cursor.rowcount != 1:
            return self.send_json({"error": "Smart Search not found"}, HTTPStatus.NOT_FOUND)
        return self.send_json({"ok": True, "id": identifier, "name": name})

    def remove_saved_search(self, identifier):
        with open_database(self.server.database) as database:
            ensure_saved_searches_table(database)
            cursor = database.execute("DELETE FROM saved_searches WHERE id=?", (identifier,))
        if cursor.rowcount != 1:
            return self.send_json({"error": "Smart Search not found"}, HTTPStatus.NOT_FOUND)
        return self.send_json({"ok": True, "id": identifier})

    def cleanup_impact(self):
        with open_database(self.server.database) as database:
            self.send_json(cleanup_impact(database))

    def care_status(self):
        with open_database(self.server.database) as database:
            self.send_json(care_index_status(database))

    def ai_status(self):
        with open_database(self.server.database) as database:
            total = database.execute(
                "SELECT COUNT(*) FROM media_items WHERE missing=0 AND media_type IN ('image','video')"
            ).fetchone()[0]
            analyzed = database.execute(
                """SELECT COUNT(*) FROM media_text_analysis a
                   JOIN media_items m ON m.id=a.media_id
                   WHERE m.missing=0 AND a.model_version=?""",
                (TEXT_ANALYSIS_MODEL,),
            ).fetchone()[0]
            text_heavy = database.execute(
                """SELECT COUNT(*) FROM media_text_analysis a
                   JOIN media_items m ON m.id=a.media_id
                   WHERE m.missing=0 AND a.model_version=? AND a.is_text_heavy=1""",
                (TEXT_ANALYSIS_MODEL,),
            ).fetchone()[0]
            face_status = face_index_status(database)
            people_analyzed = database.execute("SELECT COUNT(*) FROM media_person_analysis").fetchone()[0]
            people_detected = database.execute("SELECT COALESCE(SUM(CASE WHEN person_count>0 THEN person_count ELSE 0 END),0) FROM media_person_analysis").fetchone()[0]
            secondary_people_analyzed = database.execute(
                "SELECT COUNT(*) FROM media_secondary_people_analysis WHERE model_version=? AND error_message IS NULL",
                (SECONDARY_PEOPLE_MODEL,),
            ).fetchone()[0]
            secondary_people_detected = database.execute(
                "SELECT COUNT(*) FROM media_secondary_people_analysis WHERE model_version=? AND person_detected=1 AND error_message IS NULL",
                (SECONDARY_PEOPLE_MODEL,),
            ).fetchone()[0]
            secondary_people_remaining = database.execute(
                """SELECT COUNT(DISTINCT m.id) FROM media_items m
                   JOIN media_person_analysis p ON p.media_id=m.id AND p.person_count=0
                   JOIN media_face_analysis f ON f.media_id=m.id AND f.face_count=0
                   JOIN media_tags mt ON mt.media_item_id=m.id AND COALESCE(mt.confidence,0)>=0.5
                   JOIN tags t ON t.id=mt.tag_id AND t.name='people'
                   WHERE m.missing=0 AND m.media_type='image'
                     AND NOT EXISTS (
                         SELECT 1 FROM media_secondary_people_analysis s
                         WHERE s.media_id=m.id AND s.model_version=?
                     )""",
                (SECONDARY_PEOPLE_MODEL,),
            ).fetchone()[0]
            semantic_analyzed = database.execute(
                """SELECT COUNT(*) FROM media_semantic_embeddings e
                   JOIN media_items m ON m.id=e.media_id
                   WHERE m.missing=0 AND e.model_version=?""",
                (EMBEDDING_MODEL,),
            ).fetchone()[0]
            quality_analyzed = database.execute(
                "SELECT COUNT(*) FROM media_quality_analysis WHERE model_version=?",
                (QUALITY_MODEL,),
            ).fetchone()[0]
            quality_total = database.execute(
                """SELECT COUNT(*) FROM media_items WHERE missing=0 AND (
                       media_type='image' OR (media_type='video' AND COALESCE(duration_seconds,0)>0 AND duration_seconds<=2.0)
                   )"""
            ).fetchone()[0]
        self.send_json({"total": total, "analyzed": analyzed, "remaining": total - analyzed, "ocrSearchAnalyzed": analyzed, "textHeavy": text_heavy, "facesTotal": face_status["total"], "facesAnalyzed": face_status["analyzed"], "facesRemaining": face_status["remaining"], "facesDetected": face_status["detected"], "facesLatestAt": face_status["latestAt"], "peopleAnalyzed": people_analyzed, "peopleDetected": people_detected, "secondaryPeopleAnalyzed": secondary_people_analyzed, "secondaryPeopleDetected": secondary_people_detected, "secondaryPeopleRemaining": secondary_people_remaining, "semanticAvailable": SEMANTIC_ENABLED, "semanticAnalyzed": semantic_analyzed if SEMANTIC_ENABLED else 0, "qualityAnalyzed": quality_analyzed, "qualityTotal": quality_total})

    def ai_suggestions(self):
        with open_database(self.server.database) as database:
            rows = database.execute(
                """SELECT t.name,COUNT(*) item_count,AVG(mt.confidence) confidence
                   FROM tags t JOIN media_tags mt ON mt.tag_id=t.id
                   WHERE t.source='vision'
                   GROUP BY t.id HAVING item_count >= 2
                   ORDER BY item_count DESC,confidence DESC LIMIT 20"""
            ).fetchall()
        self.send_json({"suggestions": [dict(row) for row in rows]})

    def natural_search_plan(self, query: str) -> dict:
        with open_database(self.server.database) as database:
            rows = database.execute(
                """SELECT target_key,MAX(display_name) display_name
                   FROM people_aliases GROUP BY target_key
                   UNION
                   SELECT person_key,person_key FROM people_media
                   WHERE person_key NOT IN (SELECT target_key FROM people_aliases)
                   GROUP BY person_key"""
            ).fetchall()
        known_people = tuple(
            (str(row["target_key"]), str(row["display_name"])) for row in rows
        )
        plan = parse_natural_language_query(query, known_people)
        plan["semanticAvailable"] = SEMANTIC_ENABLED
        return plan

    def fused_search_results(self, plan: dict) -> list[dict]:
        cache_key = json.dumps(plan, sort_keys=True, separators=(",", ":"))
        with search_fusion_cache_lock:
            cached = search_fusion_cache.get(cache_key)
            if cached and time.monotonic() - cached[0] < 5:
                return cached[1]
        semantic_results = self.semantic_results(plan["semanticQuery"])
        scores = {item["id"]: float(item["score"]) for item in semantic_results}
        if plan["people"]:
            with open_database(self.server.database) as database:
                for matched_person in plan["people"]:
                    rows = database.execute(
                        "SELECT media_id FROM people_media WHERE person_key=? LIMIT 2000",
                        (matched_person["key"],),
                    ).fetchall()
                    for row in rows:
                        scores[int(row["media_id"])] = max(
                            1.0, scores.get(int(row["media_id"]), 0)
                        )
        if not scores and not plan["ocrTerms"]:
            return []
        with open_database(self.server.database) as database:
            if plan["ocrTerms"]:
                expression = fts_query(" ".join(plan["ocrTerms"]))
                if expression:
                    try:
                        rows = database.execute(
                            """SELECT rowid media_id,bm25(media_ocr_fts) rank
                               FROM media_ocr_fts WHERE media_ocr_fts MATCH ?
                               ORDER BY rank LIMIT 1000""",
                            (expression,),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        rows = []
                    for row in rows:
                        scores[int(row["media_id"])] = scores.get(int(row["media_id"]), 0) + 0.15
            words = [
                word for word in re.findall(r"[\w'-]+", plan["semanticQuery"].lower())
                if len(word) >= 3
            ][:8]
            if words:
                tag_conditions = " OR ".join("lower(t.name) LIKE ?" for _ in words)
                tag_rows = database.execute(
                    f"""SELECT mt.media_item_id,MAX(COALESCE(mt.confidence,0)) confidence
                        FROM media_tags mt JOIN tags t ON t.id=mt.tag_id
                        WHERE {tag_conditions}
                        GROUP BY mt.media_item_id ORDER BY confidence DESC LIMIT 1000""",
                    tuple(f"%{word}%" for word in words),
                ).fetchall()
                for row in tag_rows:
                    item_id = int(row["media_item_id"])
                    scores[item_id] = scores.get(item_id, 0) + min(0.08, float(row["confidence"]) * 0.08)
            candidate_ids = list(scores)[:7000]
            if candidate_ids:
                for start in range(0, len(candidate_ids), 800):
                    chunk = candidate_ids[start:start + 800]
                    placeholders = ",".join("?" for _ in chunk)
                    rows = database.execute(
                        f"""SELECT m.id,m.favorite,COALESCE(m.created_at,m.modified_at,m.imported_at,0) media_date,
                                   c.disposition
                            FROM media_items m LEFT JOIN media_curation c ON c.media_id=m.id
                            WHERE m.id IN ({placeholders})""",
                        chunk,
                    ).fetchall()
                    current_year = datetime.datetime.now(datetime.timezone.utc).year
                    recent_floor = year_bounds(current_year - 5)[0]
                    recent_span = max(1, time.time() - recent_floor)
                    for row in rows:
                        item_id = int(row["id"])
                        if row["favorite"]:
                            scores[item_id] += 0.04
                        if row["disposition"] == "keep":
                            scores[item_id] += 0.025
                        media_date = float(row["media_date"] or 0)
                        if media_date >= recent_floor:
                            scores[item_id] += 0.015 * min(1, (media_date - recent_floor) / recent_span)
            hard_conditions = []
            hard_arguments = []
            if plan["mediaType"]:
                hard_conditions.append("media_type=?")
                hard_arguments.append(plan["mediaType"])
            if plan["favorite"]:
                hard_conditions.append("favorite=1")
            date_expression = "COALESCE(created_at,modified_at,imported_at,0)"
            if plan["after"] is not None:
                hard_conditions.append(f"{date_expression}>=?")
                hard_arguments.append(plan["after"])
            if plan["before"] is not None:
                hard_conditions.append(f"{date_expression}<?")
                hard_arguments.append(plan["before"])
            for matched_person in plan["people"]:
                hard_conditions.append("""(
                    id IN (SELECT media_id FROM people_media WHERE person_key=?)
                    OR id IN (SELECT media_id FROM media_face_features WHERE person_key=?)
                )""")
                hard_arguments.extend([matched_person["key"], matched_person["key"]])
            if plan["ocrTerms"]:
                expression = fts_query(" ".join(plan["ocrTerms"]))
                if expression:
                    hard_conditions.append(
                        "id IN (SELECT rowid FROM media_ocr_fts WHERE media_ocr_fts MATCH ?)"
                    )
                    hard_arguments.append(expression)
            ai_condition = ai_filter_condition(plan["aiFilter"])
            if ai_condition:
                hard_conditions.append(ai_condition)
            if hard_conditions and scores:
                allowed = set()
                all_ids = list(scores)
                for start in range(0, len(all_ids), 800):
                    chunk = all_ids[start:start + 800]
                    placeholders = ",".join("?" for _ in chunk)
                    rows = database.execute(
                        f"""SELECT id FROM media_items
                            WHERE missing=0 AND id IN ({placeholders})
                              AND {' AND '.join(hard_conditions)}""",
                        (*chunk, *hard_arguments),
                    ).fetchall()
                    allowed.update(int(row["id"]) for row in rows)
                scores = {
                    item_id: score for item_id, score in scores.items()
                    if item_id in allowed
                }
        results = [
            {"id": item_id, "score": score}
            for item_id, score in sorted(scores.items(), key=lambda item: item[1], reverse=True)[:1000]
        ]
        with search_fusion_cache_lock:
            search_fusion_cache[cache_key] = (time.monotonic(), results)
            if len(search_fusion_cache) > 100:
                oldest = min(search_fusion_cache, key=lambda key: search_fusion_cache[key][0])
                search_fusion_cache.pop(oldest, None)
        return results

    def people(self, query=None):
        social_only = (query or {}).get("scope", [""])[0] == "social"
        cache_path = self.server.cache.parent / ("people-social-v7.json" if social_only else "people-index-v7.json")
        if cache_path.exists() and time.time() - cache_path.stat().st_mtime < 60:
            return self.send_json(json.loads(cache_path.read_text(encoding="utf-8")))
        identities = self.social_identities()
        with open_database(self.server.database) as database:
            repair_legacy_face_alias_keys(database)
            aliases = {row["source_key"]: row for row in database.execute("SELECT * FROM people_aliases")}
            indexed_social_paths = database.execute(
                """SELECT DISTINCT f.path FROM folders f
                   JOIN libraries l ON l.id=f.library_id
                   JOIN media_items m ON m.folder_id=f.id
                   WHERE l.name='Social Archive' AND m.missing=0 AND m.size_bytes>0"""
            ).fetchall()
            inferred_paths = {}
            for row in indexed_social_paths:
                folder_path = Path(row["path"])
                for candidate in (folder_path, *folder_path.parents):
                    candidate_key = re.sub(r"[^a-z0-9]+", "", candidate.name.lower())
                    if candidate_key:
                        inferred_paths.setdefault(candidate_key, set()).add(str(candidate))
            grouped = {}
            now = time.time()
            for identity in identities:
                person_key = identity["key"]
                paths = list(dict.fromkeys((*identity["paths"], *sorted(inferred_paths.get(person_key, ())))))
                manual_alias = database.execute("SELECT display_name FROM people_aliases WHERE source_key=? AND target_key=?", (person_key, person_key)).fetchone()
                display_name = manual_alias["display_name"] if manual_alias else identity["name"]
                for path in paths:
                    source_key = re.sub(r"[^a-z0-9]+", "", Path(path).name.lower())
                    if source_key and source_key != person_key:
                        database.execute("""INSERT INTO people_aliases(source_key,target_key,display_name,updated_at) VALUES(?,?,?,?)
                            ON CONFLICT(source_key) DO UPDATE SET target_key=excluded.target_key,display_name=excluded.display_name,updated_at=excluded.updated_at""",
                            (source_key, person_key, display_name, now))
                folder_predicate = " OR ".join("(path=? OR instr(path, ? || '/')=1)" for _ in paths)
                folder_arguments = tuple(value for path in paths for value in (path, path))
                item_ids = database.execute(f"""WITH identity_folders AS (
                        SELECT id FROM folders WHERE {folder_predicate}
                    )
                    SELECT DISTINCT m.id FROM media_items m
                    LEFT JOIN media_curation c ON c.media_id=m.id
                    WHERE m.missing=0 AND m.size_bytes>0 AND c.trashed_at IS NULL
                    AND (
                        m.folder_id IN (SELECT id FROM identity_folders)
                        OR m.id IN (
                            SELECT r.media_item_id FROM media_references r
                            WHERE r.folder_id IN (SELECT id FROM identity_folders)
                        )
                    )""", folder_arguments).fetchall() if paths else []
                cover_id = int(item_ids[0]["id"]) if item_ids else None
                grouped[person_key] = {"id": person_key, "key": person_key, "name": display_name, "profileCount": len(identity["profiles"]),
                    "profiles": identity["profiles"], "sourceKeys": [person_key], "sourceNames": [display_name], "itemCount": len(item_ids),
                    "coverItemId": cover_id, "coverUrl": f"/api/items/{cover_id}/thumbnail?size=500" if cover_id else None,
                    "_itemIds": {int(row["id"]) for row in item_ids}, "socialArchive": True}
            if not social_only:
                rows = database.execute("""SELECT f.id,f.name,f.path FROM folders f JOIN libraries l ON l.id=f.library_id
                    WHERE l.name<>'Social Archive' AND f.parent_path LIKE '%/_Profiles' ORDER BY f.name COLLATE NOCASE""").fetchall()
                profile_paths = {row["path"] for row in rows}
                item_ids_by_path = {path: set() for path in profile_paths}
                indexed_paths = database.execute("""SELECT id,path FROM media_items WHERE missing=0 AND size_bytes>0
                    AND id NOT IN (SELECT media_id FROM media_curation WHERE trashed_at IS NOT NULL)
                    AND path LIKE '%/_Profiles/%'
                    UNION ALL SELECT r.media_item_id,rf.path FROM media_references r JOIN folders rf ON rf.id=r.folder_id
                    JOIN media_items m ON m.id=r.media_item_id
                    WHERE m.missing=0 AND m.size_bytes>0
                    AND m.id NOT IN (SELECT media_id FROM media_curation WHERE trashed_at IS NOT NULL)
                    AND rf.path LIKE '%/_Profiles/%'""").fetchall()
                for indexed in indexed_paths:
                    marker = indexed["path"].find("/_Profiles/")
                    if marker < 0:
                        continue
                    remainder = indexed["path"][marker + len("/_Profiles/"):]
                    profile_name = remainder.split("/", 1)[0]
                    profile_path = indexed["path"][:marker + len("/_Profiles/")] + profile_name
                    if profile_path in item_ids_by_path:
                        item_ids_by_path[profile_path].add(int(indexed["id"]))
                for row in rows:
                    source_key = re.sub(r"[^a-z0-9]+", "", row["name"].lower())
                    if not source_key:
                        continue
                    alias = aliases.get(source_key)
                    person_key = alias["target_key"] if alias else source_key
                    display_name = alias["display_name"] if alias else row["name"]
                    person = grouped.setdefault(person_key, {"id": person_key, "key": person_key, "name": display_name,
                        "profileCount": 0, "profiles": [], "sourceKeys": [], "sourceNames": [], "itemCount": 0,
                        "coverItemId": None, "coverUrl": None, "_itemIds": set(), "socialArchive": False})
                    if source_key not in person["sourceKeys"]:
                        person["sourceKeys"].append(source_key); person["sourceNames"].append(row["name"])
                        person["profileCount"] += 1
                    ids = item_ids_by_path[row["path"]]
                    person["_itemIds"].update(ids)
                    if person["coverItemId"] is None and ids:
                        cover_id = next(iter(ids)); person["coverItemId"] = cover_id; person["coverUrl"] = f"/api/items/{cover_id}/thumbnail?size=500"
                face_groups = database.execute(
                    """SELECT person_key,COUNT(DISTINCT media_id) item_count,MIN(media_id) cover_id
                       FROM media_face_features
                       WHERE person_key IS NOT NULL AND person_key<>''
                       GROUP BY person_key HAVING COUNT(DISTINCT media_id)>=2
                       ORDER BY item_count DESC,person_key"""
                ).fetchall()
                for position, face_group in enumerate(face_groups, start=1):
                    source_key = face_group["person_key"]
                    alias = aliases.get(source_key)
                    person_key = alias["target_key"] if alias else source_key
                    display_name = alias["display_name"] if alias else f"Person {position}"
                    face_ids = {
                        int(item["media_id"])
                        for item in database.execute(
                            """SELECT DISTINCT ff.media_id FROM media_face_features ff
                               JOIN media_items m ON m.id=ff.media_id
                               LEFT JOIN media_curation c ON c.media_id=m.id
                               WHERE ff.person_key=? AND m.missing=0 AND m.size_bytes>0
                                 AND c.trashed_at IS NULL""",
                            (source_key,),
                        )
                    }
                    if not face_ids:
                        continue
                    person = grouped.setdefault(person_key, {"id": person_key, "key": person_key, "name": display_name,
                        "profileCount": 0, "profiles": [], "sourceKeys": [], "sourceNames": [], "itemCount": 0,
                        "coverItemId": None, "coverUrl": None, "_itemIds": set(), "socialArchive": False})
                    if source_key not in person["sourceKeys"]:
                        person["sourceKeys"].append(source_key)
                        person["sourceNames"].append(display_name)
                    person["_itemIds"].update(face_ids)
                    if person["coverItemId"] is None:
                        cover_id = int(face_group["cover_id"])
                        person["coverItemId"] = cover_id
                        person["coverUrl"] = f"/api/items/{cover_id}/thumbnail?size=500"
            database.commit()
            if social_only:
                keys = list(grouped)
                if keys:
                    placeholders = ",".join("?" for _ in keys)
                    database.execute(f"DELETE FROM people_media WHERE person_key IN ({placeholders})", keys)
            else:
                database.execute("DELETE FROM people_media")
            manual_associations = [
                (row["person_key"], int(row["media_id"]))
                for row in database.execute(
                    """SELECT d.person_key,d.media_id
                       FROM media_profile_decisions d
                       JOIN media_items m ON m.id=d.media_id
                       LEFT JOIN media_curation c ON c.media_id=m.id
                       WHERE d.decision='associated' AND m.missing=0 AND m.size_bytes>0
                         AND c.trashed_at IS NULL
                         AND COALESCE(c.disposition,'')<>'remove'"""
                )
            ]
            for person_key, media_id in manual_associations:
                person = grouped.get(person_key)
                if person:
                    person["_itemIds"].add(media_id)
                    if person["coverItemId"] is None:
                        person["coverItemId"] = media_id
                        person["coverUrl"] = f"/api/items/{media_id}/thumbnail?size=500"
            associations = [
                (person["key"], media_id)
                for person in grouped.values()
                for media_id in person["_itemIds"]
            ]
            associations.extend(manual_associations)
            database.executemany(
                "INSERT OR IGNORE INTO people_media(person_key,media_id) VALUES(?,?)",
                associations,
            )
            preferred_covers = {
                row["person_key"]: int(row["cover_media_id"])
                for row in database.execute(
                    """SELECT person_key,cover_media_id FROM people_preferences
                       WHERE cover_media_id IS NOT NULL"""
                )
            }
            for person in grouped.values():
                preferred_cover = preferred_covers.get(person["key"])
                if preferred_cover in person["_itemIds"]:
                    person["coverItemId"] = preferred_cover
                    person["coverUrl"] = f"/api/items/{preferred_cover}/thumbnail?size=500"
            cover_face_boxes = {}
            cover_ids = sorted({
                int(person["coverItemId"])
                for person in grouped.values()
                if person.get("coverItemId")
            })
            if cover_ids:
                cover_placeholders = ",".join("?" for _ in cover_ids)
                for face_row in database.execute(
                    f"""SELECT ff.person_key,ff.media_id,ff.face_index,a.boxes_json
                        FROM media_face_features ff
                        JOIN media_face_analysis a ON a.media_id=ff.media_id
                        WHERE ff.person_key IS NOT NULL AND ff.person_key<>''
                          AND ff.media_id IN ({cover_placeholders})""",
                    cover_ids,
                ):
                    source_key = face_row["person_key"]
                    face_alias = aliases.get(source_key)
                    resolved_key = face_alias["target_key"] if face_alias else source_key
                    person = grouped.get(resolved_key)
                    if not person or int(person.get("coverItemId") or 0) != int(face_row["media_id"]):
                        continue
                    try:
                        boxes = json.loads(face_row["boxes_json"] or "[]")
                        box = boxes[int(face_row["face_index"])]
                        if len(box) == 4:
                            cover_face_boxes[resolved_key] = [float(value) for value in box]
                    except (ValueError, TypeError, IndexError):
                        continue
            newest_by_person = people_newest_dates(database)
            people = []
            for person in grouped.values():
                item_ids = person.pop("_itemIds")
                person["coverFaceBox"] = cover_face_boxes.get(person["key"])
                person["itemCount"] = len(item_ids)
                if person["itemCount"] == 0:
                    continue
                person["newestAt"] = newest_by_person.get(person["key"], 0)
                people.append(person)
            people.sort(key=lambda person: (-person["itemCount"], person["name"].lower()))
        payload = {"people": people}
        if people:
            temporary = cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, cache_path)
        self.send_json(payload)

    def organization_suggestions(self, query=None):
        limit = min(200, max(1, int((query or {}).get("limit", ["60"])[0])))
        with open_database(self.server.database) as database:
            rows = database.execute(
                """WITH recognized_people AS (
                       SELECT media_id,person_key,
                              MAX(CASE WHEN assignment_source='user' THEN 1 ELSE 0 END) user_confirmed
                       FROM media_face_features
                       WHERE person_key IS NOT NULL AND person_key<>''
                       GROUP BY media_id,person_key
                   )
                   SELECT m.*,c.disposition,c.trashed_at,
                          rp.person_key,rp.user_confirmed,
                          COALESCE(
                              (SELECT display_name FROM people_aliases a
                               WHERE a.target_key=rp.person_key
                               ORDER BY CASE WHEN a.source_key=a.target_key THEN 0 ELSE 1 END
                               LIMIT 1),
                              rp.person_key
                          ) person_name
                   FROM recognized_people rp
                   JOIN media_items m ON m.id=rp.media_id
                   LEFT JOIN media_curation c ON c.media_id=m.id
                   WHERE m.missing=0 AND m.size_bytes>0
                     AND c.trashed_at IS NULL
                     AND COALESCE(c.disposition,'')<>'remove'
                     AND NOT EXISTS(
                         SELECT 1 FROM people_media pm
                         WHERE pm.media_id=m.id AND pm.person_key=rp.person_key
                     )
                     AND NOT EXISTS(
                         SELECT 1 FROM media_profile_decisions d
                         WHERE d.media_id=m.id AND d.person_key=rp.person_key
                     )
                   ORDER BY rp.user_confirmed DESC,
                            COALESCE(m.created_at,m.modified_at,m.imported_at,0) DESC,
                            m.id DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
            total = database.execute(
                """SELECT COUNT(*) FROM (
                       SELECT ff.media_id,ff.person_key
                       FROM media_face_features ff
                       JOIN media_items m ON m.id=ff.media_id
                       LEFT JOIN media_curation c ON c.media_id=m.id
                       WHERE ff.person_key IS NOT NULL AND ff.person_key<>''
                         AND m.missing=0 AND m.size_bytes>0
                         AND c.trashed_at IS NULL
                         AND COALESCE(c.disposition,'')<>'remove'
                         AND NOT EXISTS(
                             SELECT 1 FROM people_media pm
                             WHERE pm.media_id=ff.media_id AND pm.person_key=ff.person_key
                         )
                         AND NOT EXISTS(
                             SELECT 1 FROM media_profile_decisions d
                             WHERE d.media_id=ff.media_id AND d.person_key=ff.person_key
                         )
                       GROUP BY ff.media_id,ff.person_key
                   )"""
            ).fetchone()[0]
        suggestions = []
        for row in rows:
            suggestion = item_payload(row)
            suggestion.update({
                "personKey": row["person_key"],
                "personName": row["person_name"],
                "confidence": "confirmed" if row["user_confirmed"] else "suggested",
                "canOrganize": True,
                "organizationMode": "association",
                "capabilityNote": "Adds this media to the profile in Anthora without moving, copying, or renaming the file.",
            })
            suggestions.append(suggestion)
        self.send_json({"suggestions": suggestions, "total": total})

    def organization_decision(self, item_id: int, person_key: str, action: str):
        person_key = re.sub(r"[^a-z0-9]+", "", person_key.lower())
        if not person_key or action not in {"associate", "dismiss"}:
            return self.send_json(
                {"error": "A recognized person and a valid action are required"},
                HTTPStatus.BAD_REQUEST,
            )
        with open_database(self.server.database, initialize=True) as database:
            recognized = database.execute(
                """SELECT 1
                   FROM media_face_features ff
                   JOIN media_items m ON m.id=ff.media_id
                   LEFT JOIN media_curation c ON c.media_id=m.id
                   WHERE ff.media_id=? AND ff.person_key=?
                     AND m.missing=0 AND m.size_bytes>0
                     AND c.trashed_at IS NULL
                     AND COALESCE(c.disposition,'')<>'remove'
                     AND NOT EXISTS(
                         SELECT 1 FROM people_media pm
                         WHERE pm.media_id=ff.media_id AND pm.person_key=ff.person_key
                     )
                   LIMIT 1""",
                (item_id, person_key),
            ).fetchone()
            if not recognized:
                return self.send_json(
                    {"error": "This profile suggestion is no longer available"},
                    HTTPStatus.CONFLICT,
                )
            decision = "associated" if action == "associate" else "dismissed"
            database.execute(
                """INSERT INTO media_profile_decisions(media_id,person_key,decision,updated_at)
                   VALUES(?,?,?,?) ON CONFLICT(media_id,person_key) DO UPDATE SET
                   decision=excluded.decision,updated_at=excluded.updated_at""",
                (item_id, person_key, decision, time.time()),
            )
            if action == "associate":
                database.execute(
                    "INSERT OR IGNORE INTO people_media(person_key,media_id) VALUES(?,?)",
                    (person_key, item_id),
                )
        for cache_name in ("people-index-v7.json", "people-social-v7.json"):
            (self.server.cache.parent / cache_name).unlink(missing_ok=True)
        return self.send_json({
            "ok": True,
            "itemId": item_id,
            "personKey": person_key,
            "decision": decision,
            "filesChanged": False,
        })

    def social_identities(self):
        with open_database(self.server.database) as database:
            if not has_social_archive_library(database):
                return []
        target = self.server.cache.parent / "social-identities.json"
        if target.exists() and time.time() - target.stat().st_mtime < 3_600:
            try:
                return json.loads(target.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                pass
        try:
            self.queue_request(["export-social-identities", str(target)])
        except Exception:
            if not target.exists():
                raise
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return []

    def item_faces(self, item_id):
        with open_database(self.server.database) as database:
            analysis = database.execute(
                "SELECT boxes_json FROM media_face_analysis WHERE media_id=?", (item_id,)
            ).fetchone()
            if not analysis:
                return self.send_json({"faces": []})
            boxes = json.loads(analysis["boxes_json"] or "[]")
            assignments = {
                int(row["face_index"]): row
                for row in database.execute(
                    "SELECT face_index,person_key,assignment_source FROM media_face_features WHERE media_id=?",
                    (item_id,),
                )
            }
            aliases = {row["source_key"]: row["target_key"] for row in database.execute("SELECT source_key,target_key FROM people_aliases")}
            faces = []
            for index, box in enumerate(boxes):
                assignment = assignments.get(index)
                faces.append({
                    "index": index,
                    "box": box,
                    "personKey": aliases.get(assignment["person_key"], assignment["person_key"]) if assignment else None,
                    "source": assignment["assignment_source"] if assignment else None,
                })
        self.send_json({"faces": faces})

    def item_metadata(self, item_id):
        with open_database(self.server.database) as database:
            row = database.execute(
                """SELECT m.path,f.path folder_path,l.name library_name,l.root_path
                   FROM media_items m
                   JOIN folders f ON f.id=m.folder_id
                   JOIN libraries l ON l.id=m.library_id
                   WHERE m.id=?""",
                (item_id,),
            ).fetchone()
            if not row:
                return self.send_json({"error": "Media item was not found"}, HTTPStatus.NOT_FOUND)
            linked_locations = [
                reference["path"]
                for reference in database.execute(
                    "SELECT path FROM media_references WHERE media_item_id=? ORDER BY path",
                    (item_id,),
                )
                if reference["path"] != row["path"]
            ]
        self.send_json({
            "path": row["path"],
            "folderPath": row["folder_path"],
            "libraryName": row["library_name"],
            "libraryRoot": row["root_path"],
            "available": Path(row["path"]).exists(),
            "linkedLocations": linked_locations,
        })

    def duplicates(self, query=None):
        query = query or {}
        requested_category = query.get("category", [""])[0]
        category = requested_category if requested_category in ("exact", "resized", "cropped", "video", "best") else "exact"
        legacy_response = not requested_category
        requested_order = query.get("sort", ["largest"])[0]
        order = requested_order if requested_order in ("largest", "items", "confidence") else "largest"
        try:
            offset = max(0, int(query.get("offset", ["0"])[0] or 0))
            limit = max(1, min(int(query.get("limit", ["12"])[0] or 12), 24))
        except (TypeError, ValueError):
            return self.send_json({"error": "Invalid duplicate page"}, HTTPStatus.BAD_REQUEST)
        with open_database(self.server.database) as database:
            hashed = database.execute("SELECT COUNT(*) FROM media_items WHERE missing=0 AND content_hash IS NOT NULL").fetchone()[0]
            candidates = database.execute(
                """SELECT COUNT(*) FROM media_items m WHERE m.missing=0 AND m.size_bytes>0
                   AND m.size_bytes IN (SELECT size_bytes FROM media_items WHERE missing=0 GROUP BY size_bytes HAVING COUNT(*)>1)"""
            ).fetchone()[0]
            exact_page = exact_duplicate_payload(
                database,
                offset if category == "exact" else 0,
                (100 if legacy_response else limit) if category == "exact" or legacy_response else 0,
                order,
            )
            similarity_signature = list(database.execute(
                """SELECT
                       (SELECT COUNT(*) FROM media_visual_hashes),
                       (SELECT COALESCE(MAX(analyzed_at),0) FROM media_visual_hashes),
                       (SELECT COUNT(*) FROM media_semantic_embeddings WHERE model_version=?),
                       (SELECT COALESCE(MAX(analyzed_at),0) FROM media_semantic_embeddings WHERE model_version=?)""",
                (SEMANTIC_DUPLICATE_MODEL, SEMANTIC_DUPLICATE_MODEL),
            ).fetchone())
            visual_hashed = int(similarity_signature[0])
            semantic_hashed = int(similarity_signature[2])
            cache_path = self.server.cache.parent / "duplicate-similarity-v10.json"
            with duplicate_similarity_lock:
                try:
                    cached = json.loads(cache_path.read_text(encoding="utf-8"))
                    pairs = cached["pairs"] if cached.get("signature") == similarity_signature else None
                except (OSError, ValueError, KeyError, TypeError):
                    pairs = None
                if pairs is None:
                    similarity_rows = database.execute(
                        """SELECT m.id,m.folder_id,m.filename,m.width,m.height,m.size_bytes,m.content_hash,
                                  m.created_at,m.modified_at,v.dhash,e.embedding_blob
                           FROM media_items m
                           LEFT JOIN media_visual_hashes v ON v.media_id=m.id
                           LEFT JOIN media_semantic_embeddings e
                             ON e.media_id=m.id AND e.model_version=?
                           WHERE m.missing=0 AND m.media_type='image'
                             AND (v.dhash IS NOT NULL OR e.embedding_blob IS NOT NULL)
                           ORDER BY m.id""",
                        (SEMANTIC_DUPLICATE_MODEL,),
                    ).fetchall()
                    pairs = build_similarity_pairs(similarity_rows)
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = cache_path.with_suffix(".tmp")
                    temporary.write_text(
                        json.dumps({"signature": similarity_signature, "pairs": pairs}, separators=(",", ":")),
                        encoding="utf-8",
                    )
                    os.replace(temporary, cache_path)
            pairs = reconcile_similarity_pairs(database, pairs)
            ignored_pairs = {
                (int(row["left_media_id"]), int(row["right_media_id"]))
                for row in database.execute(
                    "SELECT left_media_id,right_media_id FROM media_similarity_reviews WHERE decision='not_duplicate'"
                )
            }
            pairs = [
                pair for pair in pairs
                if (min(pair["left"], pair["right"]), max(pair["left"], pair["right"])) not in ignored_pairs
            ]
            resized_page = grouped_similarity_payload(
                database,
                pairs,
                "resized",
                offset if category == "resized" else 0,
                100 if legacy_response else (limit if category == "resized" else 0),
                order,
            )
            cropped_page = grouped_similarity_payload(
                database,
                pairs,
                "cropped",
                offset if category == "cropped" else 0,
                100 if legacy_response else (limit if category == "cropped" else 0),
                order,
            )
            best_page = grouped_similarity_payload(
                database,
                pairs,
                "bestShot",
                offset if category == "best" else 0,
                100 if legacy_response else (limit if category == "best" else 0),
                order,
            )
            video_status = database.execute(
                """SELECT
                       (SELECT COUNT(*) FROM media_items WHERE missing=0 AND media_type='video' AND COALESCE(duration_seconds,0)>0) total,
                       COUNT(f.media_id) indexed_count,
                       COALESCE(SUM(CASE WHEN error_message IS NOT NULL THEN 1 ELSE 0 END),0) failed,
                       COALESCE(MAX(analyzed_at),0) latest
                   FROM media_video_fingerprints f JOIN media_items m ON m.id=f.media_id
                   WHERE f.model_version=? AND m.missing=0 AND m.media_type='video'
                     AND COALESCE(m.duration_seconds,0)>0""",
                (VIDEO_FINGERPRINT_MODEL,),
            ).fetchone()
            video_page = {"groups": [], "total": 0, "potentialBytes": 0}
            if category == "video":
                indexed = int(video_status["indexed_count"])
                total_videos = int(video_status["total"])
                # Reuse results while the low-priority index grows instead of rebuilding per video.
                video_signature = [(indexed + 499) // 500, indexed == total_videos]
                video_cache_path = self.server.cache.parent / "video-overlap-v2.json"
                with duplicate_similarity_lock:
                    try:
                        video_cached = json.loads(video_cache_path.read_text(encoding="utf-8"))
                        video_pairs = video_cached["pairs"] if video_cached.get("signature") == video_signature else None
                    except (OSError, ValueError, KeyError, TypeError):
                        video_pairs = None
                    if video_pairs is None:
                        video_rows = database.execute(
                            """SELECT m.id,m.content_hash,f.duration_seconds,f.samples_json
                               FROM media_video_fingerprints f JOIN media_items m ON m.id=f.media_id
                               WHERE f.model_version=? AND f.error_message IS NULL AND m.missing=0
                               ORDER BY m.id""",
                            (VIDEO_FINGERPRINT_MODEL,),
                        ).fetchall()
                        video_pairs = build_video_overlap_pairs(video_rows)
                        video_cache_path.parent.mkdir(parents=True, exist_ok=True)
                        video_temporary = video_cache_path.with_suffix(".tmp")
                        video_temporary.write_text(
                            json.dumps({"signature": video_signature, "pairs": video_pairs}, separators=(",", ":")),
                            encoding="utf-8",
                        )
                        os.replace(video_temporary, video_cache_path)
                video_pairs = reconcile_similarity_pairs(database, video_pairs)
                video_pairs = [
                    pair for pair in video_pairs
                    if (min(pair["left"], pair["right"]), max(pair["left"], pair["right"])) not in ignored_pairs
                ]
                video_page = video_overlap_payload(database, video_pairs, offset, limit, order)
            cleanup_progress = database.execute(
                """SELECT COUNT(*) reviewed_groups,
                          COALESCE(SUM(estimated_bytes),0) estimated_bytes
                   FROM media_cleanup_events"""
            ).fetchone()
            selected_page = {
                "exact": exact_page,
                "resized": resized_page,
                "cropped": cropped_page,
                "video": video_page,
                "best": best_page,
            }[category]
        self.send_json({
            "hashed": hashed,
            "candidates": candidates,
            "remaining": max(0, candidates - hashed),
            "category": category,
            "offset": offset,
            "limit": limit,
            "sort": order,
            "page": selected_page,
            "summary": {
                "exact": {"groups": exact_page["total"], "potentialBytes": exact_page["potentialBytes"]},
                "resized": {"groups": resized_page["total"], "potentialBytes": resized_page["potentialBytes"]},
                "cropped": {"groups": cropped_page["total"], "potentialBytes": cropped_page["potentialBytes"]},
                "video": {"groups": video_page["total"], "potentialBytes": video_page["potentialBytes"]},
                "best": {"groups": best_page["total"], "potentialBytes": best_page["potentialBytes"]},
            },
            "reviewedGroups": int(cleanup_progress["reviewed_groups"]),
            "reviewedEstimatedBytes": int(cleanup_progress["estimated_bytes"]),
            "videoStatus": {
                "total": int(video_status["total"]),
                "indexed": int(video_status["indexed_count"]),
                "failed": int(video_status["failed"]),
                "remaining": max(0, int(video_status["total"]) - int(video_status["indexed_count"])),
            },
            "groups": exact_page["groups"],
            "visualHashed": visual_hashed,
            "semanticHashed": semantic_hashed,
            "resizedGroups": resized_page["groups"],
            "croppedGroups": cropped_page["groups"],
            "similarGroups": resized_page["groups"],
        })

    def libraries(self):
        # A mounted or sleeping network volume can block in stat(2) long enough
        # to keep the entire library landing screen in its loading state. A
        # headless deployment may opt out of this advisory filesystem probe;
        # scans and media reads still report their own concrete failures.
        assume_available = os.getenv("ANTHORA_ASSUME_LIBRARY_AVAILABLE", "0") == "1"
        with open_database(self.server.database) as database:
            rows = database.execute(
                """
                SELECT l.*,
                       (SELECT COUNT(*) FROM media_items m WHERE m.library_id=l.id AND m.missing=0) item_count,
                       (SELECT COUNT(*) FROM media_items m WHERE m.library_id=l.id AND m.missing=0 AND m.media_type='image') image_count,
                       (SELECT COUNT(*) FROM media_items m WHERE m.library_id=l.id AND m.missing=0 AND m.media_type='video') video_count,
                       (SELECT COALESCE(SUM(m.size_bytes),0) FROM media_items m WHERE m.library_id=l.id AND m.missing=0) total_bytes,
                       (SELECT COUNT(*) FROM media_items m WHERE m.library_id=l.id AND m.missing=1) missing_count,
                       (SELECT COUNT(*) FROM folders f WHERE f.library_id=l.id AND f.path<>l.root_path) folder_count,
                       (SELECT f.id FROM folders f WHERE f.library_id=l.id AND f.path=l.root_path LIMIT 1) root_folder_id,
                       (SELECT CAST(j.progress AS INTEGER) FROM scan_jobs j
                        WHERE j.library_id=l.id ORDER BY j.id DESC LIMIT 1) scan_items_indexed
                FROM libraries l ORDER BY l.name COLLATE NOCASE
                """
            ).fetchall()
            libraries = []
            for row in rows:
                root_path = Path(row["root_path"])
                payload = {
                    "id": int(row["id"]),
                    "name": row["name"],
                    "rootPath": row["root_path"],
                    "itemCount": int(row["item_count"]),
                    "imageCount": int(row["image_count"]),
                    "videoCount": int(row["video_count"]),
                    "totalBytes": int(row["total_bytes"]),
                    "missingCount": int(row["missing_count"]),
                    "folderCount": int(row["folder_count"]),
                    "rootFolderId": int(row["root_folder_id"]) if row["root_folder_id"] is not None else None,
                    "scanStatus": row["scan_status"],
                    "scanItemsIndexed": int(row["scan_items_indexed"] or 0),
                    "lastScannedAt": float(row["last_scanned_at"]) if row["last_scanned_at"] is not None else None,
                    "available": assume_available or (
                        root_path.is_dir() and os.access(root_path, os.R_OK | os.X_OK)
                    ),
                }
                cover = None
                if payload["rootFolderId"] is not None:
                    cover = database.execute(
                        """
                        SELECT m.id
                        FROM folder_covers c
                        JOIN media_items m ON m.id=c.media_item_id
                        WHERE c.folder_id=? AND m.library_id=?
                          AND m.missing=0 AND m.media_type='image'
                        LIMIT 1
                        """,
                        (payload["rootFolderId"], int(row["id"])),
                    ).fetchone()
                if cover is None:
                    cover = representative_item(database, int(row["id"]))
                payload["coverItemId"] = int(cover["id"]) if cover else None
                payload["coverUrl"] = f"/api/items/{cover['id']}/thumbnail?size=700" if cover else None
                libraries.append(payload)
        self.send_json({"libraries": libraries})

    def add_library(self):
        length = min(int(self.headers.get("Content-Length", "0")), 8192)
        body = json.loads(self.rfile.read(length) or b"{}")
        try:
            root_path = normalized_library_path(body.get("path", ""))
        except ValueError as error:
            return self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        name = re.sub(r"[\x00-\x1f\x7f]+", " ", str(body.get("name", ""))).strip()[:120] or root_path.name
        with open_database(self.server.database) as database:
            existing = database.execute("SELECT id,name,root_path FROM libraries").fetchall()
            for library in existing:
                existing_path = Path(library["root_path"]).resolve(strict=False)
                if library_paths_overlap(root_path, existing_path):
                    return self.send_json(
                        {"error": f"That folder overlaps the existing source {library['name']}"},
                        HTTPStatus.CONFLICT,
                    )
            now = time.time()
            cursor = database.execute(
                """INSERT INTO libraries(name,root_path,bookmark_data,created_at,updated_at,scan_status)
                   VALUES(?,?,NULL,?,?, 'queued')""",
                (name, str(root_path), now, now),
            )
            library_id = int(cursor.lastrowid)
        self.start_library_scan(library_id)
        return self.send_json(
            {"ok": True, "library": {"id": library_id, "name": name, "rootPath": str(root_path),
                                      "scanStatus": "queued", "itemCount": 0}},
            HTTPStatus.ACCEPTED,
        )

    def scan_library(self, library_id: int):
        with open_database(self.server.database) as database:
            library = database.execute(
                "SELECT id,scan_status FROM libraries WHERE id=?", (library_id,)
            ).fetchone()
            if not library:
                return self.send_json({"error": "Source was not found"}, HTTPStatus.NOT_FOUND)
            if library["scan_status"] in ("queued", "scanning"):
                return self.send_json({"error": "This source is already being scanned"}, HTTPStatus.CONFLICT)
        self.start_library_scan(library_id)
        return self.send_json({"ok": True, "libraryId": library_id, "scanStatus": "queued"}, HTTPStatus.ACCEPTED)

    def edit_library(self, library_id: int):
        length = min(int(self.headers.get("Content-Length", "0")), 4096)
        body = json.loads(self.rfile.read(length) or b"{}")
        name = re.sub(r"[\x00-\x1f\x7f]+", " ", str(body.get("name", ""))).strip()[:120]
        if not name:
            return self.send_json({"error": "Enter a display name"}, HTTPStatus.BAD_REQUEST)
        with open_database(self.server.database) as database:
            library = database.execute(
                "SELECT id,root_path FROM libraries WHERE id=?", (library_id,)
            ).fetchone()
            if not library:
                return self.send_json({"error": "Source was not found"}, HTTPStatus.NOT_FOUND)
            database.execute(
                "UPDATE libraries SET name=?,updated_at=? WHERE id=?",
                (name, time.time(), library_id),
            )
        with folder_cache_lock:
            folder_response_cache.clear()
        return self.send_json({"ok": True, "library": {
            "id": library_id, "name": name, "rootPath": library["root_path"]
        }})

    def start_library_scan(self, library_id: int):
        cancellation_file = self.server.cache.parent / f"scan-{library_id}.cancel"
        cancellation_file.unlink(missing_ok=True)
        with open_database(self.server.database) as database:
            database.execute(
                "UPDATE libraries SET scan_status='queued',updated_at=? WHERE id=?",
                (time.time(), library_id),
            )

        def run():
            try:
                command = ["scan-library", str(library_id), str(cancellation_file)]
                self.queue_request(
                    command,
                    timeout_seconds=86_400,
                )
            except Exception:
                with open_database(self.server.database) as database:
                    database.execute(
                        "UPDATE libraries SET scan_status='error',updated_at=? WHERE id=?",
                        (time.time(), library_id),
                    )
            finally:
                cancellation_file.unlink(missing_ok=True)

        threading.Thread(target=run, daemon=True).start()

    def cancel_library_scan(self, library_id: int):
        with open_database(self.server.database) as database:
            library = database.execute(
                "SELECT scan_status FROM libraries WHERE id=?", (library_id,)
            ).fetchone()
            if not library:
                return self.send_json({"error": "Source was not found"}, HTTPStatus.NOT_FOUND)
            if library["scan_status"] not in ("queued", "scanning"):
                return self.send_json({"error": "This source is not being scanned"}, HTTPStatus.CONFLICT)
        cancellation_file = self.server.cache.parent / f"scan-{library_id}.cancel"
        cancellation_file.parent.mkdir(parents=True, exist_ok=True)
        cancellation_file.touch()
        return self.send_json(
            {"ok": True, "libraryId": library_id, "scanStatus": "cancelling"},
            HTTPStatus.ACCEPTED,
        )

    def remove_library(self, library_id: int):
        with open_database(self.server.database) as database:
            library = database.execute(
                "SELECT id,name,scan_status FROM libraries WHERE id=?", (library_id,)
            ).fetchone()
            if not library:
                return self.send_json({"error": "Source was not found"}, HTTPStatus.NOT_FOUND)
            if library["scan_status"] in ("queued", "scanning"):
                return self.send_json(
                    {"error": "Wait for this source scan to finish before removing it"},
                    HTTPStatus.CONFLICT,
                )
            database.execute("DELETE FROM libraries WHERE id=?", (library_id,))
        with folder_cache_lock:
            folder_response_cache.clear()
        for cache_name in ("people-index-v7.json", "people-social-v7.json", "social-identities.json"):
            (self.server.cache.parent / cache_name).unlink(missing_ok=True)
        return self.send_json({"ok": True, "removed": library_id, "filesDeleted": False})

    def folders(self, query):
        library_id = int(query.get("libraryId", ["0"])[0])
        parent_id = query.get("parentId", [None])[0]
        include_system = query.get("includeSystem", ["0"])[0]
        cache_key = (library_id, parent_id, include_system)
        with folder_cache_lock:
            cached = folder_response_cache.get(cache_key)
        if cached and time.time() - cached[0] < FOLDER_CACHE_SECONDS:
            return self.send_json(cached[1])
        with open_database(self.server.database) as database:
            needs_reference_sync = refresh_symlink_references(database, library_id)
        if needs_reference_sync:
            self.queue_request(["sync-references", str(library_id)])
        with open_database(self.server.database) as database:
            if parent_id is None:
                library = database.execute(
                    "SELECT name, root_path FROM libraries WHERE id = ?", (library_id,)
                ).fetchone()
                if not library:
                    return self.send_error(HTTPStatus.NOT_FOUND)
                parent_path = library["root_path"]
                library_name = library["name"]
                hide_system_folders = library["name"] == "Social Archive"
            else:
                parent = database.execute(
                    "SELECT path FROM folders WHERE id = ? AND library_id = ?",
                    (int(parent_id), library_id),
                ).fetchone()
                if not parent:
                    return self.send_error(HTTPStatus.NOT_FOUND)
                parent_path = parent["path"]
                library_name = database.execute(
                    "SELECT name FROM libraries WHERE id=?", (library_id,)
                ).fetchone()["name"]
                hide_system_folders = library_name == "Social Archive"
            show_system_folders = query.get("includeSystem", ["0"])[0] == "1" or not hide_system_folders
            rows = database.execute(
                """
                SELECT f.id, f.library_id, f.name, f.path,
                       EXISTS(SELECT 1 FROM folders child WHERE child.library_id=f.library_id AND child.parent_path=f.path) has_children
                FROM folders f WHERE f.library_id = ? AND f.parent_path = ?
                  AND (? = 1 OR f.name NOT LIKE '\\_%' ESCAPE '\\')
                ORDER BY name COLLATE NOCASE
                """,
                (library_id, parent_path, int(show_system_folders)),
            ).fetchall()
            tree_sql = """
                WITH RECURSIVE folder_tree(root_id,folder_id,path) AS (
                    SELECT id,id,path FROM folders
                    WHERE library_id=? AND parent_path=?
                      AND (?=1 OR name NOT LIKE '\\_%' ESCAPE '\\')
                    UNION ALL
                    SELECT tree.root_id,child.id,child.path
                    FROM folder_tree tree
                    JOIN folders child ON child.library_id=? AND child.parent_path=tree.path
                ), candidates(root_id,media_id) AS (
                    SELECT tree.root_id,item.id
                    FROM folder_tree tree
                    JOIN media_items item ON item.folder_id=tree.folder_id
                    WHERE item.missing=0
                    UNION
                    SELECT tree.root_id,reference.media_item_id
                    FROM folder_tree tree
                    JOIN media_references reference ON reference.folder_id=tree.folder_id
                    JOIN media_items item ON item.id=reference.media_item_id
                    WHERE item.missing=0
                )
            """
            tree_arguments = (library_id, parent_path, int(show_system_folders), library_id)
            counts = {
                int(result["root_id"]): int(result["item_count"])
                for result in database.execute(
                    tree_sql + " SELECT root_id,COUNT(*) item_count FROM candidates GROUP BY root_id",
                    tree_arguments,
                ).fetchall()
            }
            folder_stats = {
                int(result["root_id"]): result
                for result in database.execute(
                    tree_sql + """
                    SELECT candidate.root_id,
                           COALESCE(SUM(item.size_bytes),0) total_bytes,
                           MIN(COALESCE(item.created_at,item.imported_at)) oldest_at,
                           MAX(COALESCE(item.created_at,item.imported_at)) newest_at
                    FROM candidates candidate
                    JOIN media_items item ON item.id=candidate.media_id
                    GROUP BY candidate.root_id
                    """,
                    tree_arguments,
                ).fetchall()
            }
            covers = {
                int(result["root_id"]): int(result["id"])
                for result in database.execute(
                    tree_sql + """
                    , ranked AS (
                        SELECT candidate.root_id,item.id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY candidate.root_id
                                   ORDER BY item.favorite DESC,
                                     CASE WHEN analysis.is_text_heavy=0 THEN 0 WHEN analysis.is_text_heavy=1 THEN 2 ELSE 1 END,
                                     COALESCE(item.width,0)*COALESCE(item.height,0) DESC,
                                     item.size_bytes DESC,item.id DESC
                               ) rank
                        FROM candidates candidate
                        JOIN media_items item ON item.id=candidate.media_id
                        LEFT JOIN media_text_analysis analysis ON analysis.media_id=item.id
                    )
                    SELECT root_id,id FROM ranked WHERE rank=1
                    """,
                    tree_arguments,
                ).fetchall()
            }
            manual_covers = {
                int(result["folder_id"]): int(result["media_item_id"])
                for result in database.execute(
                    "SELECT folder_id,media_item_id FROM folder_covers WHERE folder_id IN (SELECT id FROM folders WHERE library_id=? AND parent_path=?)",
                    (library_id, parent_path),
                ).fetchall()
            }
            folders = []
            for row in rows:
                item_count = counts.get(int(row["id"]), 0)
                cover_id = manual_covers.get(int(row["id"])) or covers.get(int(row["id"]))
                folders.append({
                    "id": int(row["id"]),
                    "libraryId": int(row["library_id"]),
                    "name": row["name"].lstrip("_") if parent_id is None and library_name == "^" else row["name"],
                    "itemCount": int(item_count),
                    "totalBytes": int(folder_stats.get(int(row["id"]), {"total_bytes": 0})["total_bytes"] or 0),
                    "oldestAt": float(folder_stats[int(row["id"])]["oldest_at"]) if int(row["id"]) in folder_stats and folder_stats[int(row["id"])]["oldest_at"] is not None else None,
                    "newestAt": float(folder_stats[int(row["id"])]["newest_at"]) if int(row["id"]) in folder_stats and folder_stats[int(row["id"])]["newest_at"] is not None else None,
                    "hasChildren": bool(row["has_children"]),
                    "coverItemId": cover_id,
                    "coverUrl": f"/api/items/{cover_id}/thumbnail?size=700" if cover_id else None,
                })
        payload = {"parentId": int(parent_id) if parent_id is not None else None, "folders": folders}
        with folder_cache_lock:
            folder_response_cache[cache_key] = (time.time(), payload)
        self.send_json(payload)

    def items(self, query):
        limit = min(MAX_PAGE_SIZE, max(1, int(query.get("limit", ["60"])[0])))
        offset = max(0, int(query.get("offset", ["0"])[0]))
        cursor = query.get("cursor", [""])[0]
        conditions = []
        arguments = []
        order_by = "id DESC"
        semantic_order_value = None
        offset_paging = False
        default_date_paging = True
        search = query.get("q", [""])[0].strip()
        search_plan = self.natural_search_plan(search) if search else None
        media_type = query.get("type", [""])[0]
        ai_filter = query.get("ai", [""])[0]
        folder_id = query.get("folderId", [""])[0]
        person = query.get("person", [""])[0].strip()
        identity_id = query.get("identityId", [""])[0]
        people_key = query.get("peopleKey", [""])[0]
        disposition = query.get("disposition", [""])[0]
        faces = query.get("faces", [""])[0]
        people = query.get("people", [""])[0]
        presentation = query.get("presentation", [""])[0]
        screenshot_category = query.get("screenshotCategory", [""])[0]
        aspect = query.get("aspect", [""])[0]
        resolution = query.get("resolution", [""])[0]
        quality = query.get("quality", [""])[0]
        sort = query.get("sort", ["relevance"])[0]
        trash = query.get("trash", ["0"])[0] == "1"
        order_by = default_media_order(trash=trash)
        offset_paging = trash
        default_date_paging = not trash
        cleanup = query.get("cleanup", ["0"])[0] == "1"
        reentry = query.get("reentry", ["0"])[0] == "1"
        invalid = query.get("invalid", ["0"])[0] == "1"
        if search_plan:
            media_type = media_type or search_plan["mediaType"]
            ai_filter = ai_filter or search_plan["aiFilter"]
        conditions.append(media_size_condition(invalid=invalid, trash=trash))
        if invalid:
            conditions.append("id IN (SELECT media_id FROM media_text_analysis WHERE error_message IS NOT NULL)")
        if reentry:
            conditions.append("id IN (SELECT media_id FROM media_reentry_reviews)")
        else:
            conditions.append("missing = 0")
            conditions.append("id NOT IN (SELECT media_id FROM media_reentry_reviews)")
        if trash:
            conditions.append("id IN (SELECT media_id FROM media_curation WHERE trashed_at IS NOT NULL)")
        else:
            conditions.append("id NOT IN (SELECT media_id FROM media_curation WHERE trashed_at IS NOT NULL)")
        if cleanup:
            conditions.append("favorite = 0")
            conditions.append("id NOT IN (SELECT media_id FROM media_curation WHERE disposition='keep')")
        if disposition == "remove":
            conditions.append("id IN (SELECT media_id FROM media_reactions WHERE reaction='dislike')")
        elif disposition == "keep":
            conditions.append("id IN (SELECT media_id FROM media_curation WHERE disposition=? AND trashed_at IS NULL)")
            arguments.append(disposition)
        curation_condition = active_curation_condition(disposition, trash)
        if curation_condition:
            conditions.append(curation_condition)
        if faces == "1":
            conditions.append("id IN (SELECT media_id FROM media_face_analysis WHERE face_count>0)")
        elif faces == "many":
            conditions.append("id IN (SELECT media_id FROM media_face_analysis WHERE face_count>1)")
        elif faces == "0":
            conditions.append("id IN (SELECT media_id FROM media_face_analysis WHERE face_count=0)")
        people_condition = people_filter_condition(people)
        if people_condition:
            conditions.append(people_condition)
        if presentation in PRESENTATION_PROMPTS:
            presentation_ids = self.presentation_matches(presentation)
            if presentation_ids:
                conditions.append(f"id IN ({','.join('?' for _ in presentation_ids)})")
                arguments.extend(presentation_ids)
                conditions.append("id IN (SELECT media_id FROM media_face_analysis WHERE face_count>0)")
            else:
                conditions.append("0")
        if aspect == "portrait":
            conditions.append("height > width * 1.08")
        elif aspect == "landscape":
            conditions.append("width > height * 1.08")
        elif aspect == "square":
            conditions.append("width IS NOT NULL AND height IS NOT NULL AND abs(width-height) <= max(width,height) * 0.08")
        if resolution == "large":
            conditions.append("COALESCE(width,0) * COALESCE(height,0) >= 8000000")
        elif resolution == "medium":
            conditions.append("COALESCE(width,0) * COALESCE(height,0) BETWEEN 2000000 AND 7999999")
        elif resolution == "small":
            conditions.append("COALESCE(width,0) * COALESCE(height,0) < 2000000")
        if quality == "tiny":
            conditions.append("COALESCE(width,0) > 0 AND COALESCE(height,0) > 0 AND width * height < 500000")
        screenshot_condition = screenshot_category_condition(screenshot_category)
        if screenshot_condition:
            conditions.append(screenshot_condition)
        if search_plan:
            date_expression = "COALESCE(created_at,modified_at,imported_at,0)"
            if search_plan["after"] is not None:
                conditions.append(f"{date_expression} >= ?")
                arguments.append(search_plan["after"])
            if search_plan["before"] is not None:
                conditions.append(f"{date_expression} < ?")
                arguments.append(search_plan["before"])
            for matched_person in search_plan["people"]:
                conditions.append("""(
                    id IN (SELECT media_id FROM people_media WHERE person_key=?)
                    OR id IN (SELECT media_id FROM media_face_features WHERE person_key=?)
                )""")
                arguments.extend([matched_person["key"], matched_person["key"]])
            if search_plan["ocrTerms"]:
                expression = fts_query(" ".join(search_plan["ocrTerms"]))
                if expression:
                    conditions.append(
                        "id IN (SELECT rowid FROM media_ocr_fts WHERE media_ocr_fts MATCH ?)"
                    )
                    arguments.append(expression)
        if person:
            person_key = re.sub(r"[^a-z0-9]+", "", person.lower())
            conditions.append("""id IN (
                SELECT m2.id FROM media_items m2
                LEFT JOIN media_references r2 ON r2.media_item_id=m2.id
                LEFT JOIN folders rf2 ON rf2.id=r2.folder_id
                LEFT JOIN folders mf2 ON mf2.id=m2.folder_id
                WHERE lower(rf2.path) LIKE ? OR lower(mf2.path) LIKE ? OR lower(m2.path) LIKE ?
            ) OR id IN (
                SELECT ff.media_id FROM media_face_features ff
                WHERE ff.person_key=? OR ff.person_key IN (
                    SELECT source_key FROM people_aliases WHERE target_key=? OR lower(display_name)=lower(?)
                )
            )""")
            person_pattern = "%/" + person.lower() + "/%"
            arguments.extend([person_pattern, person_pattern, person_pattern, person_key, person_key, person])
        if identity_id:
            identity = next((entry for entry in self.social_identities() if entry["key"] == identity_id), None)
            paths = identity["paths"] if identity else []
            if not paths:
                conditions.append("0")
            else:
                placeholders = ",".join("?" for _ in paths)
                conditions.append(f"id IN (SELECT r.media_item_id FROM media_references r JOIN folders rf ON rf.id=r.folder_id WHERE rf.path IN ({placeholders}))")
                arguments.extend(paths)
        if people_key:
            conditions.append("id IN (SELECT media_id FROM people_media WHERE person_key=?)")
            arguments.append(people_key)
        if search:
            pattern = "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            # Search recognized text even when semantic search is disabled or
            # returns other candidates. LIKE also finds part of a card number.
            ocr_condition = """id IN (
                SELECT media_id FROM media_text_analysis
                WHERE recognized_text LIKE ? ESCAPE '\\'
            )"""
            ranking_plan = {
                **search_plan,
                "mediaType": media_type,
                "favorite": search_plan["favorite"] or query.get("favorite", ["0"])[0] == "1",
                "aiFilter": ai_filter,
            }
            semantic_ids = [item["id"] for item in self.fused_search_results(ranking_plan)]
            if semantic_ids:
                conditions.append(f"(id IN ({','.join('?' for _ in semantic_ids)}) OR {ocr_condition})")
                semantic_order_value = "," + ",".join(str(item_id) for item_id in semantic_ids) + ","
                order_by = "COALESCE(NULLIF(instr(?, ',' || m.id || ','),0),2147483647),m.id DESC"
                offset_paging = True
                default_date_paging = False
                arguments.extend(semantic_ids)
                arguments.append(pattern)
            else:
                conditions.append(f"""(
                    filename LIKE ? ESCAPE '\\'
                    OR path LIKE ? ESCAPE '\\'
                    OR id IN (
                        SELECT mt.media_item_id FROM media_tags mt
                        JOIN tags t ON t.id=mt.tag_id
                        WHERE t.name LIKE ? ESCAPE '\\'
                    )
                    OR {ocr_condition}
                )""")
                arguments.extend([pattern, pattern, pattern, pattern])
        if media_type in ("image", "video"):
            conditions.append("media_type = ?")
            arguments.append(media_type)
        if query.get("favorite", ["0"])[0] == "1" or (search_plan and search_plan["favorite"]):
            conditions.append("favorite = 1")
        ai_condition = ai_filter_condition(ai_filter)
        if ai_condition:
            conditions.append(ai_condition)
        if folder_id:
            with open_database(self.server.database) as database:
                folder = database.execute("SELECT path,library_id FROM folders WHERE id = ?", (int(folder_id),)).fetchone()
                if folder:
                    needs_reference_sync = refresh_symlink_references(database, int(folder["library_id"]))
                else:
                    needs_reference_sync = False
            if needs_reference_sync:
                self.queue_request(["sync-references", str(folder["library_id"])])
            if not folder:
                return self.send_error(HTTPStatus.NOT_FOUND)
            conditions.append("(path LIKE ? ESCAPE '\\' OR id IN (SELECT r.media_item_id FROM media_references r JOIN folders rf ON rf.id=r.folder_id WHERE rf.path=? OR rf.path LIKE ? ESCAPE '\\'))")
            escaped = folder["path"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            arguments.extend([escaped + "/%", folder["path"], escaped + "/%"])
        sort_orders = {
            "newest": "COALESCE(created_at,modified_at,imported_at,0) DESC,id DESC",
            "oldest": "COALESCE(created_at,modified_at,imported_at,0) ASC,id ASC",
            "largest": "size_bytes DESC,id DESC",
            "smallest": "size_bytes ASC,id ASC",
            "resolution": "COALESCE(width,0)*COALESCE(height,0) DESC,size_bytes DESC,id DESC",
            "aspectWide": "CASE WHEN COALESCE(height,0)>0 THEN CAST(width AS REAL)/height ELSE 0 END DESC,id DESC",
            "aspectTall": "CASE WHEN COALESCE(width,0)>0 THEN CAST(height AS REAL)/width ELSE 0 END DESC,id DESC",
            "aspectSquare": "CASE WHEN max(COALESCE(width,0),COALESCE(height,0))>0 THEN CAST(abs(width-height) AS REAL)/max(width,height) ELSE 1 END ASC,id DESC",
            "longest": "COALESCE(duration_seconds,0) DESC,id DESC",
            "name": "filename COLLATE NOCASE ASC,id ASC",
        }
        if sort in sort_orders:
            order_by = sort_orders[sort]
            semantic_order_value = None
            offset_paging = True
            default_date_paging = False
        count_where = " AND ".join(conditions)
        count_arguments = list(arguments)
        if cursor:
            if cursor.startswith("d:") and default_date_paging:
                cursor_date, cursor_id = parse_default_media_cursor(cursor)
                date_expression = "COALESCE(created_at,modified_at,imported_at,0)"
                conditions.append(f"({date_expression} < ? OR ({date_expression} = ? AND id < ?))")
                arguments.extend([cursor_date, cursor_date, cursor_id])
                offset = 0
            elif cursor.startswith("o:"):
                offset = max(0, int(cursor[2:]))
            else:
                conditions.append("id < ?")
                arguments.append(int(cursor))
                offset = 0
        where = " AND ".join(conditions)
        with open_database(self.server.database) as database:
            total = database.execute(
                f"SELECT COUNT(*) FROM media_items WHERE {count_where}", count_arguments
            ).fetchone()[0]
            rows = database.execute(
                f"""
                SELECT m.*,c.disposition,c.trashed_at,
                       EXISTS(SELECT 1 FROM media_reentry_reviews review WHERE review.media_id=m.id) reentry_pending,
                       (SELECT error_message FROM media_text_analysis a WHERE a.media_id=m.id) analysis_error,
                       (SELECT provider FROM media_recovery_sources s WHERE s.media_id=m.id) recovery_provider,
                       (SELECT source_url FROM media_recovery_sources s WHERE s.media_id=m.id) source_url,
                       EXISTS(SELECT 1 FROM media_recovery_sources s WHERE s.media_id=m.id AND s.download_url IS NOT NULL) download_url_available,
                       (SELECT status FROM media_recovery_jobs j WHERE j.media_id=m.id ORDER BY j.updated_at DESC LIMIT 1) recovery_status,
                       (SELECT error_message FROM media_recovery_jobs j WHERE j.media_id=m.id ORDER BY j.updated_at DESC LIMIT 1) recovery_error
                       ,(SELECT category FROM media_screenshot_categories sc WHERE sc.media_id=m.id) screenshot_category
                FROM media_items m
                LEFT JOIN media_curation c ON c.media_id=m.id WHERE {where}
                ORDER BY {order_by}
                LIMIT ? OFFSET ?
                """,
                arguments + ([semantic_order_value] if semantic_order_value else []) + [limit, offset],
            ).fetchall()
        payload = [item_payload(row) for row in rows]
        next_cursor = None
        if len(rows) == limit:
            if offset_paging:
                next_cursor = f"o:{offset + len(rows)}"
            elif default_date_paging:
                next_cursor = default_media_cursor(rows[-1])
            else:
                next_cursor = str(rows[-1]["id"])
        self.send_json({
            "items": payload,
            "total": total,
            "nextCursor": next_cursor,
            "searchPlan": search_plan,
        })

    def static_file(self, request_path: str):
        root = self.server.web_root.resolve()
        relative = request_path.lstrip("/") or "index.html"
        candidate = (root / relative).resolve()
        if root not in candidate.parents and candidate != root:
            return self.send_error(HTTPStatus.FORBIDDEN)
        if not candidate.is_file():
            candidate = root / "index.html"
        if not candidate.is_file():
            return self.send_html(INDEX_HTML)
        cache = "private, max-age=31536000, immutable" if relative.startswith("assets/") else "no-cache"
        self.send_file(candidate, allow_ranges=False, cache_control=cache)

    def photos_status(self):
        if not self.server.photos.configured:
            return self.send_json({
                "configured": False,
                "readable": False,
                "status": "unavailable",
            })
        payload = self.server.photos.run(["status"])
        payload["configured"] = True
        self.send_json(payload)

    def photos_items(self, query):
        try:
            limit = max(1, min(MAX_PAGE_SIZE, int(query.get("limit", ["120"])[0])))
        except (TypeError, ValueError) as error:
            raise ValueError("Invalid Photos page size") from error
        cursor = query.get("cursor", [""])[0]
        try:
            offset = int(cursor[2:]) if cursor.startswith("o:") else 0
        except ValueError as error:
            raise ValueError("Invalid Photos cursor") from error
        if offset < 0 or (cursor and not cursor.startswith("o:")):
            raise ValueError("Invalid Photos cursor")
        arguments = ["catalog", "--offset", str(offset), "--limit", str(limit)]
        album = query.get("album", [""])[0]
        if album:
            arguments.extend(["--album-id", decode_photo_identifier(album)])
        search = query.get("q", [""])[0].strip()
        if search:
            arguments.extend(["--query", search[:200]])
        catalog = self.server.photos.run(arguments, timeout_seconds=60)
        items = [photo_item_payload(asset) for asset in catalog.get("assets", [])]
        total = int(catalog.get("total", 0))
        next_cursor = f"o:{offset + len(items)}" if offset + len(items) < total else None
        self.send_json({"items": items, "total": total, "nextCursor": next_cursor})

    def photos_albums(self):
        payload = self.server.photos.run(["albums"], timeout_seconds=60)
        folders = []
        for album in payload.get("albums", []):
            identifier = encode_photo_identifier(str(album["id"]))
            cover_id = album.get("coverAssetId")
            folders.append({
                "id": identifier,
                "libraryId": 0,
                "name": str(album.get("title") or "Untitled Album"),
                "itemCount": int(album.get("assetCount", 0)),
                "newestAt": None,
                "hasChildren": False,
                "coverUrl": (
                    f"/api/photos/assets/{encode_photo_identifier(str(cover_id))}/thumbnail?size=600"
                    if cover_id else None
                ),
            })
        self.send_json({"parentId": None, "folders": folders})

    def photos_media(self, encoded_id: str, kind: str, query):
        identifier = decode_photo_identifier(encoded_id)
        version = query.get("v", [""])[0][:80]
        self.server.mark_interactive_activity()
        if kind == "thumbnail":
            try:
                size = max(160, min(1600, int(query.get("size", ["600"])[0])))
            except (TypeError, ValueError) as error:
                raise ValueError("Invalid thumbnail size") from error
            fingerprint = hashlib.sha256(
                f"photos-thumbnail-v1:{identifier}:{version}:{size}".encode()
            ).hexdigest()
            target = self.server.cache / "Photos" / "Thumbnails" / fingerprint[:2] / f"{fingerprint}.jpg"
            if not target.is_file() or target.stat().st_size == 0:
                self.server.photos.write(
                    ["thumbnail", "--id", identifier, "--size", str(size)],
                    target,
                    timeout_seconds=30,
                )
            return self.send_file(target, content_type="image/jpeg", allow_ranges=False)
        filename = Path(query.get("filename", ["Photo"])[0]).name
        suffix = Path(filename).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
            suffix = ".bin"
        fingerprint = hashlib.sha256(f"photos-content-v1:{identifier}:{version}".encode()).hexdigest()
        target = self.server.cache / "Photos" / "Content" / fingerprint[:2] / f"{fingerprint}{suffix}"
        if not target.is_file() or target.stat().st_size == 0:
            self.server.photos.write(["export", "--id", identifier], target, timeout_seconds=300)
        return self.send_file(
            target,
            content_type=mimetypes.guess_type(filename)[0] or "application/octet-stream",
            allow_ranges=True,
            max_range_bytes=VIDEO_RANGE_CHUNK_BYTES,
        )

    def media(self, item_id: int, kind: str, query):
        # Background indexing watches this shared marker and yields while media
        # is being viewed, keeping the external library responsive.
        self.server.mark_interactive_activity()
        with open_database(self.server.database) as database:
            row = database.execute(
                """SELECT * FROM media_items WHERE id = ? AND (
                       missing = 0 OR id IN (SELECT media_id FROM media_reentry_reviews)
                   )""", (item_id,)
            ).fetchone()
        if not row:
            return self.send_error(HTTPStatus.NOT_FOUND)
        if kind == "content":
            return self.send_reader_content(row)
        if kind == "frame":
            if row["media_type"] != "video":
                return self.send_error(HTTPStatus.BAD_REQUEST)
            try:
                seconds = max(0.0, float(query.get("time", ["0"])[0]))
                size = max(160, min(640, int(query.get("size", ["360"])[0])))
            except (TypeError, ValueError):
                return self.send_error(HTTPStatus.BAD_REQUEST)
            frame = self.video_frame(item_id, size, seconds, row["modified_at"])
            return self.send_file(
                frame,
                content_type="image/jpeg",
                allow_ranges=False,
                cache_control="private, max-age=31536000, immutable",
            )
        # Cards share compact derivatives, while the full-screen viewer can ask
        # for a larger browser-compatible JPEG (especially for HEIC/HEIF files
        # that browsers cannot decode directly).
        try:
            if kind == "book-preview" and row["media_type"] != "image":
                return self.send_error(HTTPStatus.BAD_REQUEST)
            size = max(160, min(4800 if kind == "book-preview" else 1600, int(query.get("size", ["600"])[0])))
        except (TypeError, ValueError):
            return self.send_error(HTTPStatus.BAD_REQUEST)
        thumbnail = self.thumbnail(item_id, size, row["modified_at"])
        self.send_file(thumbnail, content_type="image/jpeg", allow_ranges=False)

    def video_frame(self, item_id: int, size: int, seconds: float, modified_at) -> Path:
        # Half-second buckets keep dragging responsive and cap the number of
        # durable previews generated for a video.
        bucket = round(max(0.0, seconds) * 2) / 2
        modified_key = int(float(modified_at or 0))
        fingerprint = hashlib.sha256(
            f"video-frame-v1:{item_id}:{size}:{bucket:.1f}:{modified_key}".encode()
        ).hexdigest()
        target = self.server.cache / "VideoFrames" / fingerprint[:2] / f"{fingerprint}.jpg"
        if target.exists() and target.stat().st_size > 0:
            return target
        with thumbnail_locks_guard:
            generation_lock = thumbnail_locks.setdefault(fingerprint, threading.Lock())
        with generation_lock:
            if target.exists() and target.stat().st_size > 0:
                return target
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = target.with_name(f"{fingerprint}.{uuid.uuid4().hex}.tmp.jpg")
            try:
                self.server.run_native_media(
                    ["thumbnail", str(item_id), str(size), str(temporary_path), f"{bucket:.1f}"],
                    timeout_seconds=20,
                )
                if not temporary_path.exists() or temporary_path.stat().st_size == 0:
                    raise FileNotFoundError("Video frame generation did not produce an image")
                os.replace(temporary_path, target)
            finally:
                temporary_path.unlink(missing_ok=True)
                with thumbnail_locks_guard:
                    thumbnail_locks.pop(fingerprint, None)
        return target

    def thumbnail(self, item_id: int, size: int, modified_at) -> Path:
        modified_key = int(float(modified_at or 0))
        fingerprint = hashlib.sha256(
            f"{item_id}:{size}:{modified_key}".encode()
        ).hexdigest()
        target = self.server.cache / fingerprint[:2] / f"{fingerprint}.jpg"
        if target.exists() and target.stat().st_size > 0:
            return target
        with thumbnail_locks_guard:
            generation_lock = thumbnail_locks.setdefault(fingerprint, threading.Lock())
        with generation_lock:
            if target.exists() and target.stat().st_size > 0:
                return target
            target.unlink(missing_ok=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = target.with_name(f"{fingerprint}.{uuid.uuid4().hex}.tmp.jpg")
            try:
                generated = False
                # A copied or separately configured Anthora library can already
                # have durable previews outside this instance's cache. Reuse a
                # valid JPEG before decoding the source again.
                with open_database(self.server.database) as database:
                    existing_row = database.execute(
                        "SELECT thumbnail_path FROM media_items WHERE id=?",
                        (item_id,),
                    ).fetchone()
                existing_path = Path(existing_row["thumbnail_path"]) if existing_row and existing_row["thumbnail_path"] else None
                if size <= 600 and existing_path and existing_path != target and existing_path.is_file():
                    try:
                        with existing_path.open("rb") as existing_file:
                            is_jpeg = existing_file.read(3) == b"\xff\xd8\xff"
                        if is_jpeg and existing_path.stat().st_size > 0:
                            shutil.copyfile(existing_path, temporary_path)
                            generated = True
                    except OSError:
                        generated = False
                if os.environ.get("ANTHORA_SIPS_THUMBNAILS", "0").lower() in {
                    "1", "true", "yes", "on"
                } and not generated:
                    with open_database(self.server.database) as database:
                        row = database.execute(
                            "SELECT path,media_type FROM media_items WHERE id=? AND missing=0",
                            (item_id,),
                        ).fetchone()
                    if row is not None and row["media_type"] == "image":
                        try:
                            generate_thumbnail_with_quicklook(Path(row["path"]), temporary_path, size)
                            generated = True
                        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                            print(
                                f"[thumbnail] Quick Look preview failed for item {item_id}: {error}",
                                file=sys.stderr,
                                flush=True,
                            )
                        if not generated:
                            try:
                                generate_thumbnail_with_sips(Path(row["path"]), temporary_path, size)
                                generated = True
                            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                                print(
                                    f"[thumbnail] macOS preview failed for item {item_id}: {error}",
                                    file=sys.stderr,
                                    flush=True,
                                )
                if not generated:
                    self.server.run_native_media(
                        ["thumbnail", str(item_id), str(size), str(temporary_path)],
                        timeout_seconds=30,
                    )
                if not temporary_path.exists() or temporary_path.stat().st_size == 0:
                    raise FileNotFoundError("Thumbnail generation did not produce an image")
                os.replace(temporary_path, target)
                # Print derivatives must not become the default gallery preview.
                if size <= 1600:
                    with open_database(self.server.database) as database:
                        database.execute("UPDATE media_items SET thumbnail_path=? WHERE id=?", (str(target), item_id))
            finally:
                temporary_path.unlink(missing_ok=True)
                with thumbnail_locks_guard:
                    thumbnail_locks.pop(fingerprint, None)
        return target

    def send_reader_content(self, row):
        direct_path = directly_readable_media_path(row)
        if direct_path is not None:
            self.stream_mode = "direct"
            return self.send_file(
                direct_path,
                content_type=mimetypes.guess_type(row["filename"])[0] or "application/octet-stream",
                allow_ranges=True,
                max_range_bytes=VIDEO_RANGE_CHUNK_BYTES if row["media_type"] == "video" else None,
                cache_control="private, max-age=86400",
            )
        size = int(row["size_bytes"] or 0)
        self.stream_mode = "native-reader"
        if size <= 0:
            return self.send_error(HTTPStatus.NOT_FOUND)
        start, end = 0, size - 1
        status = HTTPStatus.OK
        if self.headers.get("Range"):
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers["Range"].strip())
            if not match:
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            if match.group(1):
                start = int(match.group(1))
                end = min(end, int(match.group(2))) if match.group(2) else end
            elif match.group(2):
                start = max(0, size - int(match.group(2)))
            if start > end or start >= size:
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            if row["media_type"] == "video":
                end = min(end, start + VIDEO_RANGE_CHUNK_BYTES - 1)
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        response_directory = self.server.cache.parent / "Responses"
        response_directory.mkdir(parents=True, exist_ok=True)
        response = response_directory / f"{uuid.uuid4().hex}.bin"
        try:
            self.server.run_native_media(
                ["read-file", str(row["id"]), str(start), str(length), str(response)],
                timeout_seconds=20,
            )
            self.send_file(
                response,
                content_type=mimetypes.guess_type(row["filename"])[0] or "application/octet-stream",
                allow_ranges=False,
                status=status,
                content_range=(start, end, size) if status == HTTPStatus.PARTIAL_CONTENT else None,
            )
        finally:
            response.unlink(missing_ok=True)

    def enqueue_request(self, command, queue=None):
        identifier = uuid.uuid4().hex
        target_queue = queue or self.server.queue
        request = target_queue / f"{identifier}.req"
        temporary = target_queue / f".{identifier}.tmp"
        temporary.write_text("\t".join(command), encoding="utf-8")
        os.replace(temporary, request)
        return identifier

    def queue_request(self, command, queue=None, timeout_seconds=65):
        target_queue = queue or self.server.queue
        identifier = self.enqueue_request(command, target_queue)
        request = target_queue / f"{identifier}.req"
        done = target_queue / f"{identifier}.done"
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if done.exists():
                result = done.read_text(encoding="utf-8")
                done.unlink(missing_ok=True)
                if result != "ok":
                    raise RuntimeError(result.partition("\t")[2] or "Native media reader failed")
                return
            time.sleep(0.025)
        request.unlink(missing_ok=True)
        raise TimeoutError("Native media reader timed out")

    def purge_trash(self):
        with open_database(self.server.database) as database:
            rows = database.execute(
                """SELECT m.id,m.size_bytes FROM media_items m
                   JOIN media_curation c ON c.media_id=m.id
                   WHERE c.trashed_at IS NOT NULL ORDER BY c.trashed_at,m.id LIMIT 5000"""
            ).fetchall()
        item_sizes = {int(row["id"]): int(row["size_bytes"] or 0) for row in rows}
        self.purge_items_immediately(item_sizes)
        with open_database(self.server.database) as database:
            remaining_ids = existing_media_ids(database, item_sizes)
            remaining = database.execute(
                "SELECT COUNT(*) FROM media_curation WHERE trashed_at IS NOT NULL"
            ).fetchone()[0]
            deleted_ids = set(item_sizes) - remaining_ids
            deleted_bytes = sum(item_sizes[item_id] for item_id in deleted_ids)
            if deleted_ids:
                database.execute(
                    "INSERT INTO media_cleanup_events VALUES(?,?,?,?,?,?)",
                    (uuid.uuid4().hex, "deleted", "recentlyDeleted", len(deleted_ids), deleted_bytes, time.time()),
                )
        return self.send_json({
            "ok": not remaining_ids,
            "deleted": len(deleted_ids),
            "deletedBytes": deleted_bytes,
            "failed": len(remaining_ids),
            "remaining": int(remaining),
        })

    def run_purge_trash_job(self, job_id):
        lock_file = None
        file_locked = False
        thread_locked = False
        try:
            self.server.purge_lock.acquire()
            thread_locked = True
            lock_file = (self.server.cache.parent / "purge-trash.lock").open("a+")
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            file_locked = True
            with open_database(self.server.database) as database:
                rows = database.execute(
                    """SELECT m.id,m.size_bytes FROM media_items m
                       JOIN media_curation c ON c.media_id=m.id
                       WHERE c.trashed_at IS NOT NULL ORDER BY c.trashed_at,m.id"""
                ).fetchall()
                item_sizes = {int(row["id"]): int(row["size_bytes"] or 0) for row in rows}
                database.execute(
                    """UPDATE media_operations SET status='running',total_units=?,message=?,updated_at=?
                       WHERE id=?""",
                    (len(item_sizes), "Emptying Recently Deleted", time.time(), job_id),
                )
            item_ids = list(item_sizes)
            for start in range(0, len(item_ids), 20):
                batch = item_ids[start:start + 20]
                with open_database(self.server.database) as database:
                    pending = existing_media_ids(database, batch)
                if pending:
                    self.purge_items_immediately(pending)
                with open_database(self.server.database) as database:
                    remaining_ids = existing_media_ids(database, item_sizes)
                    deleted_ids = set(item_sizes) - remaining_ids
                    deleted_bytes = sum(item_sizes[item_id] for item_id in deleted_ids)
                    database.execute(
                        """UPDATE media_operations SET completed_units=?,processed_items=?,
                           estimated_bytes=?,message=?,updated_at=? WHERE id=?""",
                        (len(deleted_ids), len(deleted_ids), deleted_bytes,
                         f"{len(deleted_ids)} of {len(item_sizes)} items permanently deleted",
                         time.time(), job_id),
                    )
            with open_database(self.server.database) as database:
                remaining_ids = existing_media_ids(database, item_sizes)
                deleted_ids = set(item_sizes) - remaining_ids
                deleted_bytes = sum(item_sizes[item_id] for item_id in deleted_ids)
                failed = len(remaining_ids)
                if deleted_ids:
                    database.execute(
                        "INSERT INTO media_cleanup_events VALUES(?,?,?,?,?,?)",
                        (uuid.uuid4().hex, "deleted", "recentlyDeleted", len(deleted_ids),
                         deleted_bytes, time.time()),
                    )
                status = "completed_with_errors" if failed else "completed"
                message = (
                    f"{failed} items could not be permanently deleted"
                    if failed else "Recently Deleted is empty"
                )
                database.execute(
                    """UPDATE media_operations SET status=?,completed_units=?,failed_units=?,
                       processed_items=?,estimated_bytes=?,payload_json='{}',message=?,updated_at=?
                       WHERE id=?""",
                    (status, len(deleted_ids), failed, len(deleted_ids), deleted_bytes,
                     message, time.time(), job_id),
                )
        except Exception as error:
            with open_database(self.server.database) as database:
                database.execute(
                    "UPDATE media_operations SET status='failed',message=?,updated_at=? WHERE id=?",
                    (str(error)[:500], time.time(), job_id),
                )
        finally:
            if file_locked:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            if lock_file is not None:
                lock_file.close()
            if thread_locked:
                self.server.purge_lock.release()

    def purge_items_immediately(self, item_ids):
        """Run destructive maintenance outside the scan/thumbnail FIFO.

        A library scan can occupy the persistent reader worker for hours. Permanent
        deletion is an explicit, confirmed user action, so it must not sit behind
        that background work while the UI misleadingly reports zero progress.
        """
        failures = []
        for item_id in item_ids:
            try:
                self.server.run_native_media(
                    ["purge-item", str(item_id), "now"],
                    timeout_seconds=90,
                )
            except Exception as error:
                failures.append((item_id, str(error)))
        return failures

    def exact_duplicate_action_result(self, action, requested_hashes):
        with open_database(self.server.database) as database:
            reconcile_missing_exact_group_items(database, requested_hashes)
            groups = exact_duplicate_action_groups(database, requested_hashes, limit=250)
        if not groups:
            with open_database(self.server.database) as database:
                remaining = exact_duplicate_payload(database, offset=0, limit=0)["total"]
            return {
                "ok": True,
                "action": action,
                "groups": 0,
                "items": 0,
                "estimatedBytes": 0,
                "failedGroups": 0,
                "remainingExactGroups": remaining,
                "failedHashes": [],
            }

        if action == "trash":
            item_ids = [int(item["id"]) for group in groups for item in group["items"]]
            now = time.time()
            with open_database(self.server.database) as database:
                database.executemany(
                    """INSERT INTO media_curation(media_id,disposition,trashed_at,updated_at)
                       VALUES(?,'remove',?,?) ON CONFLICT(media_id) DO UPDATE SET
                       disposition='remove',trashed_at=excluded.trashed_at,updated_at=excluded.updated_at""",
                    ((item_id, now, now) for item_id in item_ids),
                )
                remaining = exact_duplicate_payload(database, offset=0, limit=0)["total"]
            return {
                "ok": True,
                "action": action,
                "groups": len(groups),
                "items": len(item_ids),
                "estimatedBytes": sum(int(item["size_bytes"] or 0) for group in groups for item in group["items"]),
                "failedGroups": 0,
                "remainingExactGroups": remaining,
                "failedHashes": [],
            }

        commands = []
        redundant_sizes = {}
        group_remove_ids = {}
        for group in groups:
            keeper_id = int(group["keeper"]["id"])
            remove_ids = [int(item["id"]) for item in group["items"] if int(item["id"]) != keeper_id]
            group_remove_ids[group["hash"]] = remove_ids
            for item in group["items"]:
                item_id = int(item["id"])
                if item_id == keeper_id:
                    continue
                redundant_sizes[item_id] = (
                    int(item["size_bytes"] or 0) if Path(item["path"]).is_file() else 0
                )
                commands.append(["consolidate-exact", str(keeper_id), str(item_id)])
        native_failures = self.queue_requests(commands, timeout_seconds=120)
        with open_database(self.server.database) as database:
            remaining_ids = existing_media_ids(database, redundant_sizes)
            failed_hashes = [
                content_hash for content_hash, remove_ids in group_remove_ids.items()
                if any(item_id in remaining_ids for item_id in remove_ids)
            ]
            failed_groups = len(failed_hashes)
            consolidated_ids = set(redundant_sizes) - remaining_ids
            estimated_bytes = sum(redundant_sizes[item_id] for item_id in consolidated_ids)
            if consolidated_ids:
                database.execute(
                    "INSERT INTO media_cleanup_events VALUES(?,?,?,?,?,?)",
                    (uuid.uuid4().hex, "consolidated", "exact", len(consolidated_ids), estimated_bytes, time.time()),
                )
            remaining = exact_duplicate_payload(database, offset=0, limit=0)["total"]
        return {
            "ok": failed_groups == 0,
            "action": action,
            "groups": len(groups) - failed_groups,
            "items": len(consolidated_ids),
            "estimatedBytes": estimated_bytes,
            "failedGroups": failed_groups,
            "failedHashes": failed_hashes,
            "remainingExactGroups": remaining,
            "failureMessage": native_failures[0][1] if native_failures else None,
        }

    def pause_active_scans_for_maintenance(self, job_id, timeout_seconds=90):
        with open_database(self.server.database) as database:
            library_ids = [
                int(row["id"])
                for row in database.execute(
                    "SELECT id FROM libraries WHERE scan_status IN ('queued','scanning')"
                )
            ]
            if library_ids:
                database.execute(
                    "UPDATE media_operations SET message=?,updated_at=? WHERE id=?",
                    ("Pausing the source scan for exact-copy maintenance", time.time(), job_id),
                )
        for library_id in library_ids:
            cancellation_file = self.server.cache.parent / f"scan-{library_id}.cancel"
            cancellation_file.parent.mkdir(parents=True, exist_ok=True)
            cancellation_file.touch()
        if not library_ids:
            return []

        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            with open_database(self.server.database) as database:
                active = database.execute(
                    "SELECT COUNT(*) FROM libraries WHERE id IN ({}) AND scan_status IN ('queued','scanning')".format(
                        ",".join("?" for _ in library_ids)
                    ),
                    library_ids,
                ).fetchone()[0]
            if not active:
                return library_ids
            time.sleep(0.25)
        raise RuntimeError(
            "The source scan did not pause. Stop the scan, then try exact-copy maintenance again."
        )

    def resume_library_scans(self, library_ids):
        for library_id in library_ids:
            try:
                self.start_library_scan(library_id)
            except Exception:
                with open_database(self.server.database) as database:
                    database.execute(
                        "UPDATE libraries SET scan_status='error',updated_at=? WHERE id=?",
                        (time.time(), library_id),
                    )

    def run_exact_duplicate_job(self, job_id):
        lock_file = None
        file_locked = False
        thread_locked = False
        paused_library_ids = []
        try:
            with open_database(self.server.database) as database:
                row = database.execute(
                    "SELECT payload_json FROM media_operations WHERE id=?", (job_id,)
                ).fetchone()
            if not row:
                return
            payload = json.loads(row["payload_json"])
            hashes = payload["hashes"]
            action = payload["action"]
            paused_library_ids = self.pause_active_scans_for_maintenance(job_id)
            self.server.duplicate_lock.acquire()
            thread_locked = True
            lock_file = (self.server.cache.parent / "exact-duplicates.lock").open("a+")
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            file_locked = True
            with open_database(self.server.database) as database:
                database.execute(
                    "UPDATE media_operations SET status='running',message=?,updated_at=? WHERE id=?",
                    ("Keeping recommended copies" if action == "consolidate" else "Moving exact-copy groups", time.time(), job_id),
                )
            completed = failed = processed_items = estimated_bytes = 0
            fatal_message = None
            for content_hash in hashes:
                result = self.exact_duplicate_action_result(action, [content_hash])
                failure_message = result.get("failureMessage")
                # A timeout means the native worker or source volume is no
                # longer making progress, so continuing would strand every
                # following group. An immediate native rejection is scoped to
                # the current group; leave it for manual review and continue.
                if failure_message and "timed out" in failure_message.lower():
                    fatal_message = failure_message
                    break
                failed += int(result["failedGroups"])
                completed += 1 - int(result["failedGroups"])
                processed_items += int(result["items"])
                estimated_bytes += int(result["estimatedBytes"])
                with open_database(self.server.database) as database:
                    database.execute(
                        """UPDATE media_operations SET completed_units=?,failed_units=?,processed_items=?,
                           estimated_bytes=?,message=?,updated_at=? WHERE id=?""",
                        (completed, failed, processed_items, estimated_bytes,
                         f"{completed + failed} of {len(hashes)} groups reviewed", time.time(), job_id),
                    )
            status = "failed" if fatal_message else "completed_with_errors" if failed else "completed"
            message = (
                f"Exact-copy maintenance stopped: {fatal_message}" if fatal_message
                else f"Finished with {failed} groups needing review" if failed
                else "Exact-copy maintenance finished"
            )
            with open_database(self.server.database) as database:
                database.execute(
                    "UPDATE media_operations SET status=?,payload_json='{}',message=?,updated_at=? WHERE id=?",
                    (status, message, time.time(), job_id),
                )
        except Exception as error:
            with open_database(self.server.database) as database:
                database.execute(
                    "UPDATE media_operations SET status='failed',message=?,updated_at=? WHERE id=?",
                    (str(error)[:500], time.time(), job_id),
                )
        finally:
            if file_locked:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            if lock_file is not None:
                lock_file.close()
            if thread_locked:
                self.server.duplicate_lock.release()
            if paused_library_ids:
                self.resume_library_scans(paused_library_ids)

    def queue_requests(self, commands, queue=None, timeout_seconds=900):
        target_queue = queue or self.server.queue
        identifiers = {
            self.enqueue_request(command, target_queue): command
            for command in commands
        }
        deadline = time.monotonic() + timeout_seconds
        failures = []
        while identifiers and time.monotonic() < deadline:
            for identifier, command in tuple(identifiers.items()):
                done = target_queue / f"{identifier}.done"
                if not done.exists():
                    continue
                result = done.read_text(encoding="utf-8")
                done.unlink(missing_ok=True)
                if result != "ok":
                    failures.append((command, result.partition("\t")[2] or "Native media reader failed"))
                del identifiers[identifier]
            if identifiers:
                time.sleep(0.05)
        for identifier, command in identifiers.items():
            (target_queue / f"{identifier}.req").unlink(missing_ok=True)
            failures.append((command, "Native media reader timed out"))
        return failures

    def queue_background_request(self, command, queue=None, timeout_seconds=65):
        def consume():
            try:
                self.queue_request(command, queue=queue, timeout_seconds=timeout_seconds)
            except Exception:
                # The native command records its own durable failure state.
                pass

        threading.Thread(target=consume, daemon=True).start()

    def queue_background_requests(self, commands, queue=None, timeout_seconds=65):
        target_queue = queue or self.server.queue
        identifiers = [self.enqueue_request(command, target_queue) for command in commands]
        if not identifiers:
            return

        def consume():
            pending = set(identifiers)
            deadline = time.monotonic() + timeout_seconds
            while pending and time.monotonic() < deadline:
                for identifier in tuple(pending):
                    done = target_queue / f"{identifier}.done"
                    if done.exists():
                        done.unlink(missing_ok=True)
                        pending.remove(identifier)
                if pending:
                    time.sleep(0.1)
            for identifier in pending:
                (target_queue / f"{identifier}.req").unlink(missing_ok=True)

        threading.Thread(target=consume, daemon=True).start()

    def semantic_results(self, query):
        if not SEMANTIC_ENABLED:
            return []
        query = query.replace("\t", " ").replace("\n", " ").strip()[:200]
        if not query:
            return []
        directory = self.server.cache.parent / "SemanticQueries"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / (
            hashlib.sha256((EMBEDDING_MODEL + ":" + query.lower()).encode()).hexdigest() + ".json"
        )
        with open_database(self.server.database) as database:
            embedding_state = database.execute(
                """SELECT COALESCE(MAX(analyzed_at),0) latest
                   FROM media_semantic_embeddings WHERE model_version=?""",
                (EMBEDDING_MODEL,),
            ).fetchone()
        stale = (
            target.exists()
            and float(embedding_state["latest"] or 0) > target.stat().st_mtime
        )
        if not target.exists() or stale:
            self.queue_request(["semantic-query", EMBEDDING_MODEL, query, str(target)])
        try:
            return [
                {"id": int(item["id"]), "score": float(item["score"])}
                for item in json.loads(target.read_text(encoding="utf-8"))[:5000]
            ]
        except (OSError, ValueError, KeyError, TypeError):
            return []

    def semantic_matches(self, query):
        return [item["id"] for item in self.semantic_results(query)]

    def presentation_matches(self, presentation):
        opposite = "masculine" if presentation == "feminine" else "feminine"
        positive = self.semantic_results(PRESENTATION_PROMPTS[presentation])
        negative = self.semantic_results(PRESENTATION_PROMPTS[opposite])
        return conservative_presentation_ids(positive, negative)

    def send_file(self, path: Path, content_type=None, allow_ranges=True, status=HTTPStatus.OK, content_range=None, cache_control="private, max-age=86400", max_range_bytes=None):
        size = path.stat().st_size
        start, end = 0, size - 1
        if allow_ranges and self.headers.get("Range"):
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers["Range"].strip())
            if not match:
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            if match.group(1):
                start = int(match.group(1))
                end = min(end, int(match.group(2))) if match.group(2) else end
            elif match.group(2):
                start = max(0, size - int(match.group(2)))
            if start > end or start >= size:
                return self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            if max_range_bytes:
                end = min(end, start + max_range_bytes - 1)
            status = HTTPStatus.PARTIAL_CONTENT
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if content_range:
            range_start, range_end, total_size = content_range
            self.send_header("Content-Range", f"bytes {range_start}-{range_end}/{total_size}")
        elif status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", cache_control)
        if hasattr(self, "stream_mode"):
            self.send_header("X-Anthora-Stream", self.stream_mode)
        self.end_headers()
        if getattr(self, "head_only", False):
            return
        with path.open("rb") as stream:
            stream.seek(start)
            remaining = length
            while remaining:
                if hasattr(self, "stream_mode"):
                    self.server.mark_interactive_activity()
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, markup):
        data = markup.encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


INDEX_HTML = """<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Anthora</title><style>
:root{font-family:Avenir Next,sans-serif;color:#17201b;background:#edf0e8}*{box-sizing:border-box}body{margin:0}header{position:sticky;top:0;z-index:2;padding:18px 5vw;background:#edf0e8e8;backdrop-filter:blur(18px);display:flex;gap:18px;align-items:center}h1{font:600 28px Georgia,serif;margin:0 auto 0 0}input,select{border:1px solid #ccd2c8;border-radius:999px;padding:10px 16px;background:#fff;font:inherit}main{padding:18px 5vw 60px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:18px}.card{position:relative;aspect-ratio:1;overflow:hidden;border-radius:18px;background:#d9ded5}.card img{width:100%;height:100%;object-fit:cover}.name{position:absolute;inset:auto 0 0;padding:28px 10px 9px;color:white;background:linear-gradient(transparent,#0009);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty{text-align:center;padding:20vh 0;color:#657067}@media(max-width:600px){header{flex-wrap:wrap}h1{width:100%}.grid{grid-template-columns:repeat(3,1fr);gap:7px}.card{border-radius:9px}input{flex:1;min-width:0}}
</style></head><body><header><h1>Anthora</h1><input id=q placeholder='Search photos and videos'><select id=type><option value='' selected>All media</option><option value=image>Images</option><option value=video>Videos</option></select></header><main><div id=grid class=grid></div><div id=empty class=empty hidden>Nothing found.</div></main><script>
let timer;const grid=document.querySelector('#grid'),q=document.querySelector('#q'),type=document.querySelector('#type');async function load(){const p=new URLSearchParams({limit:'120',q:q.value,type:type.value});const r=await fetch('/api/items?'+p),d=await r.json();grid.replaceChildren(...d.items.map(i=>{const a=document.createElement('a');a.className='card';a.href=i.contentUrl;a.innerHTML=`<img loading=lazy src="${i.thumbnailUrl}?size=500"><span class=name>${escapeHtml(i.name)}</span>`;return a}));document.querySelector('#empty').hidden=d.items.length>0}function escapeHtml(s){const e=document.createElement('span');e.textContent=s;return e.innerHTML}q.oninput=()=>{clearTimeout(timer);timer=setTimeout(load,250)};type.onchange=load;load();
</script></body></html>"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--reader", type=Path, default=DEFAULT_READER)
    parser.add_argument("--queue", type=Path, default=DEFAULT_QUEUE)
    parser.add_argument("--analysis-queue", type=Path, default=DEFAULT_ANALYSIS_QUEUE)
    parser.add_argument("--web-root", type=Path, default=DEFAULT_WEB_ROOT)
    parser.add_argument(
        "--photos-bridge",
        type=Path,
        default=DEFAULT_PHOTOS_BRIDGE,
        help="Path to the local-only PhotoKit helper used by the mobile Photos client.",
    )
    parser.add_argument("--auth-token-file", type=Path)
    parser.add_argument(
        "--ready-file",
        type=Path,
        help="Write the bound localhost URL after the service is ready.",
    )
    parser.add_argument(
        "--social-archive-sync",
        action="store_true",
        help="Enable the optional Social Archive connector and periodic rescans.",
    )
    arguments = parser.parse_args()
    auth_token = load_auth_token(arguments.auth_token_file)
    with open_database(arguments.database, initialize=True):
        pass
    server = AnthoraServer(
        (arguments.host, arguments.port),
        AnthoraHandler,
        arguments.database,
        arguments.cache,
        arguments.reader,
        arguments.queue,
        arguments.analysis_queue,
        arguments.web_root,
        auth_token,
        social_archive_sync=arguments.social_archive_sync,
        photos_bridge=arguments.photos_bridge,
    )
    bound_port = int(server.server_address[1])
    service_url = f"http://{arguments.host}:{bound_port}"
    if arguments.ready_file:
        arguments.ready_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = arguments.ready_file.with_name(
            f".{arguments.ready_file.name}.{uuid.uuid4().hex}.tmp"
        )
        temporary.write_text(
            json.dumps({"url": service_url, "pid": os.getpid()}, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, arguments.ready_file)
    print(f"Anthora service listening on {service_url}", flush=True)
    parent_pid_value = os.environ.get("ANTHORA_PARENT_PID", "")
    if parent_pid_value.isdigit() and int(parent_pid_value) > 1:
        parent_pid = int(parent_pid_value)

        def stop_after_parent_exits():
            while True:
                try:
                    os.kill(parent_pid, 0)
                except ProcessLookupError:
                    server.shutdown()
                    return
                except PermissionError:
                    pass
                time.sleep(0.5)

        threading.Thread(target=stop_after_parent_exits, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if arguments.ready_file:
            try:
                payload = json.loads(arguments.ready_file.read_text(encoding="utf-8"))
                if payload.get("pid") == os.getpid():
                    arguments.ready_file.unlink(missing_ok=True)
            except (OSError, ValueError, TypeError):
                pass


if __name__ == "__main__":
    main()
