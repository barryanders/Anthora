import test from "node:test";
import assert from "node:assert/strict";
import {
  boxes,
  templates,
  layouts,
  capacity,
  autoFill,
  newBook,
  changeLayout,
  page,
  imagePlacement,
  cropPercent,
  duplicatePage,
  duplicateBook,
  reorderPages,
} from "./books-model.js";
const photos = Array.from({ length: 17 }, (_, i) => ({
  id: i + 1,
  mediaType: "image",
  takenAt: 100 - i,
  width: 800,
  height: 1000,
}));
test("auto-fill preserves every selected photo once in date order", () => {
  for (const style of Object.keys(templates)) {
    const pages = autoFill(
      [...photos, photos[0], { id: 100, mediaType: "video" }],
      style,
    );
    const placed = pages.flatMap((p) => p.photos).filter(Boolean);
    assert.equal(placed.length, 17);
    assert.deepEqual(
      placed.map((p) => p.id),
      photos.toReversed().map((p) => p.id),
    );
    assert.ok(new Set(pages.map((p) => p.layout)).size > 1);
  }
});
test("landscape photos receive a single-photo layout", () =>
  assert.equal(
    autoFill([{ ...photos[0], width: 2000, height: 900 }], "travel")[0].layout,
    "single",
  ));
test("smaller layouts never silently discard assigned photos", () => {
  const p = page("pair");
  p.photos = photos.slice(0, 2);
  assert.throws(() => changeLayout(p, "single"));
  p.photos[1] = null;
  assert.equal(changeLayout(p, "single").photos[0].id, 1);
  assert.equal(changeLayout(p, "grid").photos.length, 4);
});
test("blank templates have a place to start and independent project IDs", () => {
  const a = newBook("album"),
    b = newBook("album");
  assert.notEqual(a.id, b.id);
  assert.ok(a.pages.length >= 5);
  assert.deepEqual(a.pages[0].photos, [null]);
});

test("auto-fill never leaves trailing empty spaces", () => {
  for (let n = 1; n <= 200; n++) {
    const list = Array.from({ length: n }, (_, i) => ({
      ...photos[0],
      id: i + 1,
    }));
    for (const style of Object.keys(templates))
      assert.ok(autoFill(list, style).every((p) => p.photos.every(Boolean)));
  }
});

test("cover and interior slots stay within the printable page and never overlap", () => {
  for (const template of Object.keys(templates))
    for (const cover of [true, false])
      for (const layout of Object.keys(layouts)) {
        const areas = boxes(layout, template, cover, true);
        assert.equal(areas.length, capacity[layout]);
        for (const [x, y, w, h] of areas) {
          assert.ok(x >= 0 && y >= 0 && x + w <= 100.0001 && y + h <= (cover ? 100.0001 : 80));
        }
        for (let a = 0; a < areas.length; a++)
          for (let b = a + 1; b < areas.length; b++) {
            const [x, y, w, h] = areas[a],
              [xx, yy, ww, hh] = areas[b];
            assert.ok(
              x + w <= xx || xx + ww <= x || y + h <= yy || yy + hh <= y,
            );
          }
      }
});

test("crop placement maps left and right edges to CSS object positioning", () => {
  assert.deepEqual(
    imagePlacement(
      { fit: "fill", cropX: 0, cropY: 50 },
      200,
      100,
      0,
      0,
      100,
      100,
    ),
    [0, 0, 200, 100],
  );
  assert.deepEqual(
    imagePlacement({ fit: "fill", cropX: 100 }, 200, 100, 0, 0, 100, 100),
    [-100, 0, 200, 100],
  );
  assert.deepEqual(
    imagePlacement({ fit: "fit", cropX: 100 }, 200, 100, 0, 0, 100, 100),
    [0, 25, 100, 50],
  );
  assert.deepEqual(
    imagePlacement({ fit: "fill", cropY: 100 }, 100, 200, 10, 20, 100, 100),
    [10, -80, 100, 200],
  );
  for (const invalid of [undefined, NaN, Infinity, "20"])
    assert.equal(cropPercent(invalid), 50);
  assert.equal(cropPercent(-1), 0);
  assert.equal(cropPercent(110), 100);
});
test("duplicating pages creates independent editable photo slots and respects limits", () => {
  const b = newBook("album", photos.slice(0, 2)),
    copy = duplicatePage(b, 0);
  assert.equal(copy.pages.length, b.pages.length + 1);
  assert.notEqual(copy.pages[0].id, copy.pages[1].id);
  copy.pages[1].photos[0].cropX = 100;
  assert.equal(b.pages[0].photos[0].cropX, undefined);
  assert.throws(() =>
    duplicatePage({ ...b, pages: Array(200).fill(b.pages[0]) }, 0),
  );
});
test("page reorder preserves all page IDs and content", () => {
  const b = newBook("album"),
    ids = b.pages.map((p) => p.id),
    r = reorderPages(b, 0, 3);
  assert.equal(r.pages[3].id, ids[0]);
  assert.deepEqual(
    b.pages.map((p) => p.id),
    ids,
  );
  assert.deepEqual(r.pages.map((p) => p.id).sort(), [...ids].sort());
  assert.equal(reorderPages(b, -1, 1), b);
});

test("occasion books have complete independent sequences and editable headings", () => {
  for (const [key, t] of Object.entries(templates)) {
    const book = newBook(key);
    assert.equal(book.pages.length, t.sequence.length);
    assert.equal(book.title, t.title);
    assert.ok(book.pages.length >= 6);
    assert.equal(book.pages[0].photos.length, key === "yearbook" ? 2 : 1);
    assert.ok(book.pages.every((p) => p.photos.length === capacity[p.layout]));
    if (key !== "portfolio") assert.ok(book.pages.some((p) => p.heading));
    book.pages[1].heading = "Changed";
    assert.notEqual(newBook(key).pages[1].heading, "Changed");
  }
});
test("selection order is preserved when requested and all designs handle 200 photos", () => {
  for (const key of Object.keys(templates)) {
    const list = Array.from({ length: 200 }, (_, i) => ({
      ...photos[0],
      id: i + 1,
    }));
    const book = newBook(key, list, "selection");
    assert.deepEqual(
      book.pages.flatMap((p) => p.photos).map((p) => p.id),
      list.map((p) => p.id),
    );
    assert.ok(book.pages.length <= 200);
    assert.ok(book.pages.every((p) => p.photos.every(Boolean)));
  }
  assert.deepEqual(
    autoFill(photos, "wedding", "selection")
      .flatMap((p) => p.photos)
      .map((p) => p.id),
    photos.map((p) => p.id),
  );
});
test("switching to a smaller layout preserves occupied photos after empty slots", () => {
  const p = page("grid");
  p.photos = [null, photos[0], null, photos[1]];
  assert.deepEqual(
    changeLayout(p, "pair").photos.map((p) => p.id),
    [1, 2],
  );
});

test("saved book copies have independent IDs and do not change the source", () => {
  const source = newBook("valentine", photos),
    copy = duplicateBook(source);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.title, "You & me (copy)");
  assert.ok(copy.pages.every((p, i) => p.id !== source.pages[i].id));
  copy.pages[0].photos[0].cropX = 13;
  copy.pages[1].heading = "A different story";
  assert.notEqual(source.pages[0].photos[0].cropX, 13);
  assert.notEqual(source.pages[1].heading, "A different story");
});

test("book formats are saved explicitly; legacy books stay square", async () => {
  const { formats, bookFormat, coverStyles, bookCover } = await import(
    "./books-model.js"
  );
  assert.equal(bookFormat({ template: "wedding" }), formats.square);
  assert.equal(bookCover({ template: "wedding" }), coverStyles.classic);
  for (const template of Object.keys(templates)) {
    const b = newBook(template, photos);
    assert.ok(formats[b.format]);
    assert.ok(coverStyles[b.coverStyle]);
    assert.equal(duplicateBook(b).format, b.format);
    const resized = { ...b, format: "panorama" };
    assert.equal(resized.pages, b.pages);
    for (const cover of Object.keys(coverStyles)) {
      for (const layout of Object.keys(layouts)) {
        const areas = boxes(layout, template, true, false, cover);
        for (const [x, y, w, h] of areas)
          assert.ok(x >= 0 && y >= 0 && x + w <= 100.0001 && y + h <= 100.0001);
      }
    }
  }
});
test("words-only layouts never erase photos and can be followed by photo pages", () => {
  const occupied = { ...page("single"), photos: [photos[0]] };
  assert.throws(() => changeLayout(occupied, "story"));
  assert.deepEqual(changeLayout(page("single"), "story").photos, []);
  const b = newBook("vows", photos);
  assert.ok(!b.pages.some((p) => p.layout === "story"));
  assert.ok(newBook("vows").pages.some((p) => p.layout === "story"));
  assert.equal(b.pages.flatMap((p) => p.photos).length, photos.length);
});
test("long text fits its frame without losing characters", async () => {
  const { fitText } = await import("./books-render.js");
  for (const value of [
    "W".repeat(80),
    "Our wedding day — " + "a story ".repeat(160),
    "愛".repeat(500),
  ]) {
    const result = fitText(
      value,
      (str, size) => str.length * size * 0.6,
      800,
      300,
      50,
    );
    assert.ok(result.lines.length * result.lineHeight <= 300);
    assert.ok(
      result.lines.every((line) => line.length * result.size * 0.6 <= 800),
    );
    assert.equal(
      result.lines.join("").replaceAll(" ", ""),
      value.replaceAll(" ", ""),
    );
  }
});

test("custom book colors retain readable text and travel with copies", async () => {
  const { bookStyle, readableInk, bookColors } = await import(
    "./books-model.js"
  );
  assert.equal(readableInk("#000000"), "#ffffff");
  assert.equal(readableInk("#ffffff"), "#000000");
  for (const color of [
    ...bookColors.map((c) => c.value),
    "#123456",
    "#ffff00",
  ]) {
    const b = { ...newBook("wedding"), color };
    assert.equal(bookStyle(b).color, color);
    assert.equal(duplicateBook(b).color, color);
    assert.ok(["#ffffff", "#000000"].includes(bookStyle(b).ink));
  }
  assert.equal(
    bookStyle({ template: "wedding" }).color,
    templates.wedding.color,
  );
  assert.equal(
    bookStyle({ template: "wedding", color: "invalid" }).color,
    templates.wedding.color,
  );
});
