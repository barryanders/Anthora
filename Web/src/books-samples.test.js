import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { templates, layouts, boxes, newBook } from "./books-model.js";
import { sampleSets, samplePhoto } from "./books-samples.js";
test("every design has a bundled sample set and a distinct cover scene", () => {
  assert.deepEqual(
    Object.keys(sampleSets).sort(),
    Object.keys(templates).sort(),
  );
  for (const key of Object.keys(templates)) {
    assert.ok(existsSync(new URL(sampleSets[key].url)));
    assert.equal(sampleSets[key].scenes.length, 4);
    assert.equal(samplePhoto(key, 0, 0, 50, 60).tile, 0);
    const b = newBook(key);
    assert.ok(
      b.pages.every((p) => p.photos.every((p) => p === null)),
      "Samples must never prepopulate a real project",
    );
  }
});
test("sample crops preserve square tile geometry in every photo layout", () => {
  for (const layout of Object.keys(layouts))
    for (const [, , w, h] of boxes(layout, "wedding")) {
      for (let i = 0; i < 4; i++) {
        const sample = samplePhoto("wedding", i, 1, w, h);
        const actualWidth = (parseFloat(sample.width) * w) / 100,
          actualHeight = (parseFloat(sample.height) * h) / 100;
        assert.ok(Math.abs(actualWidth - actualHeight) < 0.0001);
        assert.ok(actualWidth >= w && actualHeight >= h);
        assert.ok(sample.tile >= 0 && sample.tile < 4);
      }
    }
});
