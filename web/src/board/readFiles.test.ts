import { test } from "node:test";
import assert from "node:assert/strict";

import type { FilePolicy } from "../api/types.ts";
import { fromFileList, newFiles, sourceName } from "./readFiles.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that a picked folder keeps its paths, that folders the policy
// ignores, however many files they hold, come back as one skipped entry each,
// and that a file already staged under its name is never staged again.

const policy = { ignoredDirs: ["node_modules", ".git", ".venv"] } as FilePolicy;

function picked(path: string): File {
  const file = new File(["x"], path.split("/").pop() ?? path);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

test("keeps folder paths and folds ignored folders into one entry each", () => {
  const list = [
    picked("app/README.md"),
    picked("app/src/main.py"),
    ...Array.from({ length: 500 }, (_, i) => picked(`app/node_modules/pkg${i}/index.js`)),
    picked("app/web/node_modules/react/index.js"),
    picked("app/.venv/lib/site.py"),
  ];
  const { files, skipped } = fromFileList(list, policy);
  assert.deepEqual(files.map((f) => f.path), ["app/README.md", "app/src/main.py"]);
  assert.deepEqual(skipped.map((s) => s.path), ["app/node_modules/", "app/web/node_modules/", "app/.venv/"]);
  assert.match(skipped[0]!.reason, /500 files/);
  assert.match(skipped[1]!.reason, /1 file$/);
});

test("leaves out files already staged or repeated in the pick, matching the name each is sent under", () => {
  const deep = `${"nested/".repeat(50)}main.py`;
  const pick = ["app/README.md", "app/main.py", "app/main.py", deep, "app/api.py"].map((path) => ({ file: picked(path), size: 1, path }));
  const kept = newFiles(pick, ["app/README.md", sourceName(deep)]);
  assert.deepEqual(kept.map((f) => f.path), ["app/main.py", "app/api.py"]);
  assert.equal(sourceName(deep).length, 300);
});
