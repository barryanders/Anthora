import test from "node:test";
import assert from "node:assert/strict";
import { librarySummary, connectChosenFolder } from "./library-home.js";

test("home separates disconnected sources from active scans and reports missing files", () => {
  const result = librarySummary([
    { itemCount: 18, imageCount: 16, videoCount: 2, available: true, scanStatus: "scanning" },
    { itemCount: 10, imageCount: 10, available: false, scanStatus: "scanning", missingCount: 3 },
    { available: true, scanStatus: "error" },
  ]);
  assert.deepEqual(result, { items: 28, photos: 26, videos: 2, scanning: 1, offline: 1, failed: 1, missing: 3 });
  assert.equal(librarySummary([]).items, 0);
});

test("cancelling first-folder selection does not send a mutation", async () => {
  for (const selection of [null, undefined, {}]) {
    assert.equal(await connectChosenFolder(async () => selection, () => assert.fail("Unexpected request")), null);
  }
});

test("native choice is connected once and picker or server failures remain retryable", async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return { library: { id: 1 } }; };
  const folder = { path: "/Volumes/Family Photos/Trips", name: "Trips" };
  assert.deepEqual(await connectChosenFolder(async () => folder, request), { library: { id: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/libraries");
  assert.deepEqual(JSON.parse(calls[0][1].body), folder);
  await assert.rejects(connectChosenFolder(async () => { throw new Error("Picker failed"); }, request), /Picker failed/);
  await assert.rejects(connectChosenFolder(async () => folder, async () => { throw new Error("Drive disconnected"); }), /Drive disconnected/);
});
