import test from "node:test";
import assert from "node:assert/strict";
import { collectBookPhotos, selectedBookPhotos } from "./books-source.js";

test("selected book photos preserve every selected image", () => {
  const items = [
    { id: 1, mediaType: "image" },
    { id: 2, mediaType: "image" },
    { id: 3, mediaType: "image" },
    { id: 4, mediaType: "video" },
  ];

  assert.deepEqual(
    selectedBookPhotos(items, new Set([1, 2, 3, 4])).map((item) => item.id),
    [1, 2, 3],
  );
});
const photo = (id) => ({ id, mediaType: "image" });
test("book source keeps album, search, person, and sorting filters across pagination", async () => {
  const queries = [];
  const result = await collectBookPhotos(
    {
      folderId: 9,
      q: "wedding",
      peopleKey: "sam",
      favorite: "1",
      sort: "oldest",
      defaultSortApplied: true,
    },
    async (path) => {
      const q = new URL(path, "http://localhost").searchParams;
      queries.push(q);
      return q.has("cursor")
        ? { items: [photo(2), photo(3)], total: 3, nextCursor: null }
        : { items: [photo(1), photo(2)], total: 3, nextCursor: "next" };
    },
  );
  assert.deepEqual(
    result.photos.map((p) => p.id),
    [1, 2, 3],
  );
  assert.equal(result.limited, false);
  for (const q of queries) {
    assert.equal(q.get("folderId"), "9");
    assert.equal(q.get("q"), "wedding");
    assert.equal(q.get("peopleKey"), "sam");
    assert.equal(q.get("favorite"), "1");
    assert.equal(q.get("type"), "image");
    assert.equal(q.get("sort"), "oldest");
    assert.equal(q.has("defaultSortApplied"), false);
  }
});
test("book source explicitly reports the 200-photo limit instead of silently dropping photos", async () => {
  let offset = 0;
  const result = await collectBookPhotos({}, async (path) => {
    const limit = Number(
      new URL(path, "http://localhost").searchParams.get("limit"),
    );
    const items = Array.from({ length: limit }, (_, i) =>
      photo(offset + i + 1),
    );
    offset += limit;
    return { items, total: 230, nextCursor: String(offset) };
  });
  assert.equal(result.photos.length, 200);
  assert.equal(result.total, 230);
  assert.equal(result.limited, true);
});
test("empty and video-only sets do not fabricate book photos; failed pages propagate errors", async () => {
  assert.deepEqual(
    (
      await collectBookPhotos({}, async () => ({
        items: [],
        total: 0,
        nextCursor: null,
      }))
    ).photos,
    [],
  );
  assert.deepEqual(
    (
      await collectBookPhotos({ type: "video" }, async () => {
        throw new Error("must not run");
      })
    ).photos,
    [],
  );
  await assert.rejects(
    collectBookPhotos({}, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(
    collectBookPhotos({}, async () => ({
      items: [photo(1)],
      total: 3,
      nextCursor: "repeated",
    })),
    /Could not finish/,
  );
});
