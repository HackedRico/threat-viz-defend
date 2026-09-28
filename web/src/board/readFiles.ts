import type { FilePolicy, SourceIn } from "../api/types.ts";
import { looksBinary, planUpload, sourceKind, type PickedFile, type Skipped } from "./filePolicy.ts";

// =============================================================================
// Module Overview
// =============================================================================
// Gets files out of the browser without reading them first: from a file or
// folder picker, or from a drop that may hold whole folders. `newFiles` drops
// what is already staged, `collect` applies the file policy to names and sizes,
// and only then `readAccepted` reads the survivors as text. Dropped folders the
// policy ignores are never walked.

/** A picked file with the path it was picked under. */
export interface Picked extends PickedFile {
  file: File;
}

/** The outcome of a pick: files to read, what was skipped and why. */
export interface Collected {
  accepted: Picked[];
  skipped: Skipped[];
  totalBytes: number;
}

// A dropped home directory could hold millions of entries; stop walking long before the tab stalls.
const MAX_WALK = 20_000;

/**
 * Files from an `<input type="file">`, keeping folder paths when a folder was picked. A picked folder brings
 * every file under it, `node_modules` included, so each folder the policy ignores becomes one skipped entry.
 */
export function fromFileList(list: ArrayLike<File>, policy: FilePolicy): { files: Picked[]; skipped: Skipped[] } {
  const files: Picked[] = [];
  const ignored = new Map<string, number>();
  for (const file of Array.from(list)) {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split("/");
    const at = parts.slice(0, -1).findIndex((part) => policy.ignoredDirs.includes(part));
    if (at === -1) {
      files.push({ file, size: file.size, path });
    } else {
      const folder = `${parts.slice(0, at + 1).join("/")}/`;
      ignored.set(folder, (ignored.get(folder) ?? 0) + 1);
    }
  }
  const skipped = Array.from(ignored, ([path, count]) => ({
    path,
    reason: `vendored or generated folder, ${count.toLocaleString()} file${count === 1 ? "" : "s"}`,
  }));
  return { files, skipped };
}

/** Files from a drop, walking dropped folders but never into ones the policy ignores. */
export async function fromDrop(transfer: DataTransfer, policy: FilePolicy): Promise<{ files: Picked[]; skipped: Skipped[] }> {
  const files: Picked[] = [];
  const skipped: Skipped[] = [];
  const entries = Array.from(transfer.items)
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  // Some browsers give no entries for plain file drops; fall back to the file list.
  if (entries.length === 0) return fromFileList(transfer.files, policy);

  let walked = 0;
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (walked >= MAX_WALK) return;
    walked += 1;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      // One broken link or unreadable file must not throw away the whole drop.
      try {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        files.push({ file, size: file.size, path });
      } catch {
        skipped.push({ path, reason: "could not be read" });
      }
      return;
    }
    if (policy.ignoredDirs.includes(entry.name)) {
      skipped.push({ path: `${path}/`, reason: "vendored or generated folder" });
      return;
    }
    for (const child of await readDirectory(entry as FileSystemDirectoryEntry)) await walk(child, path);
  };
  for (const entry of entries) await walk(entry, "");
  if (walked >= MAX_WALK) skipped.push({ path: "(the rest)", reason: `stopped after ${MAX_WALK} files` });
  return { files, skipped };
}

async function readDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  // `readEntries` returns entries in batches and an empty batch at the end.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** The name a file is staged and sent under: its path, cut to the last 300 characters the server takes. */
export function sourceName(path: string): string {
  return path.slice(-300);
}

/** The picked files not staged yet under the names in `staged`, keeping the first of any the pick repeats. */
export function newFiles(picked: readonly Picked[], staged: Iterable<string>): Picked[] {
  const taken = new Set(staged);
  return picked.filter((file) => {
    const name = sourceName(file.path);
    if (taken.has(name)) return false;
    taken.add(name);
    return true;
  });
}

/** Apply the file policy to picked files, before any is read. */
export function collect(files: readonly Picked[], policy: FilePolicy, alreadyBytes = 0, alreadyFiles = 0): Collected {
  // Caps count what is already staged, so two picks together still respect them.
  const room: FilePolicy = {
    ...policy,
    maxFiles: Math.max(0, policy.maxFiles - alreadyFiles),
    maxUploadBytes: Math.max(0, policy.maxUploadBytes - alreadyBytes),
  };
  return planUpload(files, room);
}

/** Read accepted files as text, dropping any that turn out to be binary. */
export async function readAccepted(files: readonly Picked[]): Promise<{ sources: (SourceIn & { bytes: number })[]; skipped: Skipped[] }> {
  const sources: (SourceIn & { bytes: number })[] = [];
  const skipped: Skipped[] = [];
  for (const picked of files) {
    let text: string;
    try {
      text = await picked.file.text();
    } catch {
      skipped.push({ path: picked.path, reason: "could not be read" });
      continue;
    }
    if (looksBinary(text)) {
      skipped.push({ path: picked.path, reason: "binary content" });
      continue;
    }
    sources.push({ name: sourceName(picked.path), kind: sourceKind(picked.path), text, bytes: picked.size });
  }
  return { sources, skipped };
}
