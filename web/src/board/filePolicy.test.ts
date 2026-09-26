import { test } from "node:test";
import assert from "node:assert/strict";

import type { FilePolicy } from "../api/types.ts";
import { formatBytes, looksBinary, planUpload, skipReason, sourceKind } from "./filePolicy.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Checks each skip rule against the server's lists, and that the caps stop a
// large folder at the file count and upload size with a reason per file.

const policy: FilePolicy = {
  secretNames: [".env", ".npmrc", "credentials", "id_rsa"],
  secretWordsPattern: "secret|credential|service-?account",
  configExtensions: ["json", "yaml", "yml", "toml", "txt", "ini", "xml", "cfg", "conf"],
  secretPaths: [".docker/config.json", ".kube/config"],
  secretExtensions: ["pem", "key", "tfvars"],
  safeEnvSuffixes: ["example", "sample", "template"],
  ignoredDirs: ["node_modules", ".git", "dist", "Pods"],
  lockfiles: ["package-lock.json", "uv.lock", "poetry.lock"],
  binaryExtensions: ["png", "zip", "woff2", "map"],
  maxFileBytes: 1000,
  maxUploadBytes: 2500,
  maxFiles: 3,
};

test("skips credential files but keeps documented env templates", () => {
  assert.equal(skipReason("app/.env", policy), "may hold credentials");
  assert.equal(skipReason(".env.production", policy), "may hold credentials");
  assert.equal(skipReason(".env.example", policy), null);
  assert.equal(skipReason("keys/server.PEM", policy), "may hold credentials");
  assert.equal(skipReason("config/service-account.json", policy), "may hold credentials");
  assert.equal(skipReason("docs/secret-handling.md", policy), null);
});

test("skips vendored folders, lockfiles and binaries", () => {
  assert.equal(skipReason("web/node_modules/react/index.js", policy), "vendored or generated folder");
  assert.equal(skipReason("ios/Pods/x.swift", policy), "vendored or generated folder");
  assert.equal(skipReason("ios/pods/x.swift", policy), null);
  assert.equal(skipReason("Package-Lock.json", policy), "dependency lockfile");
  assert.equal(skipReason("assets/logo.png", policy), "binary or generated file");
  assert.equal(skipReason("vendor.min.js", policy), "binary or generated file");
  assert.equal(skipReason(".gitignore", policy), null);
  assert.equal(skipReason("src\\main.py", policy), null);
});

test("stops at the size and count caps", () => {
  const plan = planUpload(
    [
      { path: "a.py", size: 900 },
      { path: "b.py", size: 900 },
      { path: "c.py", size: 900 },
      { path: "d.py", size: 100 },
      { path: "e.py", size: 50 },
      { path: "big.py", size: 5000 },
      { path: "empty.py", size: 0 },
    ],
    policy,
  );
  assert.deepEqual(plan.accepted.map((f) => f.path), ["a.py", "b.py", "d.py"]);
  assert.equal(plan.totalBytes, 1900);
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons["big.py"], "larger than 1 KB");
  assert.equal(reasons["c.py"], "over the 2.5 KB upload limit");
  assert.equal(reasons["e.py"], "over the 3 file limit");
  assert.equal(reasons["empty.py"], "empty file");
});

test("tells documents from code and spots binary text", () => {
  assert.equal(sourceKind("docs/DESIGN.md"), "file");
  assert.equal(sourceKind("README"), "file");
  assert.equal(sourceKind("src/app.ts"), "code");
  assert.equal(looksBinary("abc\u0000def"), true);
  assert.equal(looksBinary("plain text"), false);
  assert.equal(formatBytes(1_500_000), "1.5 MB");
});
