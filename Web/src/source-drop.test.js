import test from "node:test";
import assert from "node:assert/strict";
import { connectDroppedSources } from "./source-drop.js";

test("multiple folders skip existing and repeated paths while retaining partial failures", async () => {
  const calls = [];
  const folders = ["existing", "first", "first", "overlap", "last"].map(name => ({ name, path: `/${name}` }));
  const result = await connectDroppedSources(folders, [{rootPath: "/existing"}], async folder => {
    calls.push(folder.path);
    if (folder.path === "/overlap") throw new Error("Overlaps an existing source");
  });
  assert.deepEqual(calls, ["/first", "/overlap", "/last"]);
  assert.deepEqual(result, {added: 2, skipped: 2, errors: ["overlap: Overlaps an existing source"]});
});
