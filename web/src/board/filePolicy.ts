import type { FilePolicy, SourceIn } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Decides which picked files are read at all, before a single byte is read.
// `skipReason` mirrors the server's own rule for one path, and `planUpload`
// applies it to a whole pick, then stops at the file count and upload size caps
// so the user sees every skipped file and why.

/** A file the user picked, before it is read. */
export interface PickedFile {
  path: string;
  size: number;
}

/** A file left out, with a reason fit to show the user. */
export interface Skipped {
  path: string;
  reason: string;
}

/** The files to read and the files left out. */
export interface UploadPlan<T extends PickedFile> {
  accepted: T[];
  skipped: Skipped[];
  totalBytes: number;
}

const DOC_EXTENSIONS = new Set(["md", "markdown", "txt", "rst", "adoc", "org", "text"]);

/** Say why a path is never read, or return `null` when it may be read. */
export function skipReason(path: string, policy: FilePolicy): string | null {
  const parts = splitPath(path);
  const name = parts.at(-1)?.toLowerCase();
  if (name === undefined) return "empty path";
  // Folder names compare case sensitively, as the server does, so `Pods` and `DerivedData` match exactly.
  if (parts.slice(0, -1).some((part) => policy.ignoredDirs.includes(part))) return "vendored or generated folder";
  const inFolder = parts.length > 1 ? `${parts.at(-2)?.toLowerCase()}/${name}` : name;
  if (isSecretName(name, policy) || policy.secretPaths.includes(inFolder)) return "may hold credentials";
  if (policy.lockfiles.includes(name)) return "dependency lockfile";
  if (policy.binaryExtensions.includes(extension(name)) || name.endsWith(".min.js")) return "binary or generated file";
  return null;
}

/** Split a pick into files to read and files to skip, keeping to the policy's caps. */
export function planUpload<T extends PickedFile>(files: readonly T[], policy: FilePolicy): UploadPlan<T> {
  const accepted: T[] = [];
  const skipped: Skipped[] = [];
  let totalBytes = 0;
  // Entry points and manifests first, tests and docs last, then by path, so a cap cuts what matters least
  // and the same folder always keeps the same files.
  const ordered = [...files].sort((a, b) => uploadPriority(a.path) - uploadPriority(b.path) || a.path.localeCompare(b.path));
  for (const file of ordered) {
    const reason = skipReason(file.path, policy);
    if (reason !== null) {
      skipped.push({ path: file.path, reason });
    } else if (file.size === 0) {
      skipped.push({ path: file.path, reason: "empty file" });
    } else if (file.size > policy.maxFileBytes) {
      skipped.push({ path: file.path, reason: `larger than ${formatBytes(policy.maxFileBytes)}` });
    } else if (accepted.length >= policy.maxFiles) {
      skipped.push({ path: file.path, reason: `over the ${policy.maxFiles} file limit` });
    } else if (totalBytes + file.size > policy.maxUploadBytes) {
      skipped.push({ path: file.path, reason: `over the ${formatBytes(policy.maxUploadBytes)} upload limit` });
    } else {
      accepted.push(file);
      totalBytes += file.size;
    }
  }
  return { accepted, skipped, totalBytes };
}

// The server ranks what it reads the same way (`_PRIORITY` in api/app/boards/ingest.py).
const HIGH_VALUE =
  /(^|\/)(readme[^/]*|package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml|\.env\.(example|sample|template)|(main|app|server|index|wsgi|asgi|manage|settings|config)\.[a-z]+)$/i;
const LOW_VALUE =
  /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|testdata|examples?|samples?|mocks?|__mocks__|docs?)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|\.d\.ts$/i;

function uploadPriority(path: string): number {
  if (HIGH_VALUE.test(path)) return 0;
  return LOW_VALUE.test(path) ? 2 : 1;
}

/** The source kind for a file: documents are `file`, everything else is `code`. */
export function sourceKind(path: string): SourceIn["kind"] {
  const name = splitPath(path).at(-1)?.toLowerCase() ?? "";
  return DOC_EXTENSIONS.has(extension(name)) || name.startsWith("readme") ? "file" : "code";
}

/** True when decoded text holds NUL characters, which text files never do. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\u0000");
}

/** Bytes in words, such as `200 KB` or `1.5 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${trimDecimal(bytes / 1000, bytes < 10_000)} KB`;
  return `${trimDecimal(bytes / 1_000_000, true)} MB`;
}

function trimDecimal(value: number, keepOne: boolean): string {
  return keepOne ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
}

function isSecretName(name: string, policy: FilePolicy): boolean {
  if (name === ".env") return true;
  if (name.startsWith(".env.") && !policy.safeEnvSuffixes.includes(name.slice(5))) return true;
  if (policy.secretNames.includes(name) || policy.secretExtensions.includes(extension(name))) return true;
  return new RegExp(policy.secretWordsPattern).test(name) && policy.configExtensions.includes(extension(name));
}

function splitPath(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");
}

function extension(name: string): string {
  // A dotfile such as `.gitignore` has no extension, matching the server.
  const trimmed = name.replace(/^\.+|\.+$/g, "");
  return trimmed.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
}
