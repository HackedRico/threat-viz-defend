import { test } from "node:test";
import assert from "node:assert/strict";

import type { FilePolicy } from "../api/types.ts";
import { collect, fromFileList, newFiles, sourceName } from "./readFiles.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks that a picked folder keeps its paths, that folders the policy
// ignores, however many files they hold, come back as one skipped entry each,
// that a file already staged under its name is never staged again, and that a
// later pick keeps to the room left while naming the policy's own limits.

const policy = { ignoredDirs: ["node_modules", ".git", ".venv"] } as FilePolicy;

// No name is a secret, lockfile or binary here, so only the caps decide.
const capped: FilePolicy = {
  ...policy,
  secretNames: [],
  secretWordsPattern: "secret",
  configExtensions: [],
  secretPaths: [],
  secretExtensions: [],
  safeEnvSuffixes: [],
  lockfiles: [],
  binaryExtensions: [],
  maxFileBytes: 1000,
  maxUploadBytes: 2500,
  maxFiles: 3,
};

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

test("a later pick keeps to the room left but names the policy's own limits", () => {
  const pick = (
    [
      ["a.py", 900],
      ["b.py", 100],
      ["c.py", 50],
      ["d.py", 10],
    ] as const
  ).map(([path, size]) => ({ file: picked(path), path, size }));
  const reasons = (plan: { skipped: { path: string; reason: string }[] }) => Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));

  const later = collect(pick, capped, 2000, 1);
  assert.deepEqual(later.accepted.map((f) => f.path), ["b.py", "c.py"]);
  assert.deepEqual(reasons(later), {
    "a.py": "over the 2.5 KB upload limit with what is already added",
    "d.py": "over the 3 file limit with what is already added",
  });

  // A first pick has nothing added, and a slot kept free for pasted notes is not something added either.
  assert.deepEqual(reasons(collect(pick, capped)), { "d.py": "over the 3 file limit" });
  assert.deepEqual(reasons(collect(pick, capped, 0, 1)), { "c.py": "over the 3 file limit", "d.py": "over the 3 file limit" });
});
