import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { dataDir } from "../config.js";
import { integerValue, stringValue } from "../lib/sde-row.js";

const officialSdeJsonlUrl = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";

interface SdeArchiveMetadata {
  buildNumber: number | null;
  releaseDate: string | null;
  archiveUrl: string;
  archivePath: string;
  raw: Record<string, unknown>;
}

export interface OpenSdeArchiveOptions {
  archivePath?: string;
  archiveUrl?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  // Skip the "reuse the newest cached archive" short-circuit and download the latest
  // published archive. Used by the daily refresh; ignored when archivePath is set.
  forceDownload?: boolean;
}

interface ResolvedArchive {
  archivePath: string;
  archiveUrl: string;
}

export class SdeArchiveReader {
  constructor(
    public readonly archivePath: string,
    public readonly archiveUrl: string,
    public readonly metadata: SdeArchiveMetadata
  ) {}

  async readJsonl<T = unknown>(memberName: string, onRow: (row: T) => void | Promise<void>): Promise<number> {
    return readJsonlMember(this.archivePath, memberName, onRow);
  }
}

function configuredUrl(): string {
  return process.env.SDE_JSONL_URL?.trim() || officialSdeJsonlUrl;
}

// Both the cached filename and CCP's redirect target embed the build number as
// `eve-online-static-data-<build>-jsonl.zip`.
const archiveBuildPattern = /eve-online-static-data-(\d+)-jsonl\.zip/;

function buildNumberFromUrl(url: string): number | null {
  const match = archiveBuildPattern.exec(url);
  return match ? Number(match[1]) : null;
}

function localArchiveUrl(archivePath: string): string {
  return pathToFileURL(path.resolve(archivePath)).href;
}

function sdeCacheDir(options: OpenSdeArchiveOptions): string {
  return path.resolve(options.cacheDir ?? path.join(dataDir, "sde"));
}

function cachedArchives(cacheDir: string): string[] {
  if (!fs.existsSync(cacheDir)) return [];
  function safeMtime(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }
  return fs
    .readdirSync(cacheDir)
    .filter((name) => /^eve-online-static-data-.+-jsonl\.zip$/.test(name))
    .map((name) => path.join(cacheDir, name))
    .sort((a, b) => safeMtime(b) - safeMtime(a));
}

async function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error(`Unable to open ZIP archive ${zipPath}`));
        return;
      }
      resolve(zipFile);
    });
  });
}

function normalizeMemberName(name: string): string {
  return name.replaceAll("\\", "/").replace(/^\/+/, "");
}

function memberMatches(actual: string, requested: string): boolean {
  const entryName = normalizeMemberName(actual);
  const wanted = normalizeMemberName(requested);
  return entryName === wanted || path.posix.basename(entryName) === wanted || entryName.endsWith(`/${wanted}`);
}

async function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new Error(`Unable to open ZIP member ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

async function withEntryStream<T>(
  zipPath: string,
  memberName: string,
  readStream: (stream: Readable) => Promise<T>
): Promise<T> {
  const zipFile = await openZip(zipPath);
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    function settle(error: unknown, value?: T): void {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
      try {
        zipFile.close();
      } catch {
        // Closing after the target stream has ended is best-effort cleanup.
      }
    }

    zipFile.on("entry", (entry) => {
      if (/\/$/.test(entry.fileName) || !memberMatches(entry.fileName, memberName)) {
        zipFile.readEntry();
        return;
      }

      void openEntryStream(zipFile, entry)
        .then(readStream)
        .then((value) => settle(null, value))
        .catch((error: unknown) => settle(error));
    });

    zipFile.on("end", () => settle(new Error(`SDE archive member not found: ${memberName}`)));
    zipFile.on("error", (error) => settle(error));
    zipFile.readEntry();
  });
}

async function readJsonlMember<T>(
  zipPath: string,
  memberName: string,
  onRow: (row: T) => void | Promise<void>
): Promise<number> {
  return withEntryStream(zipPath, memberName, (stream) => {
    let pending = "";
    let count = 0;

    let badLines = 0;
    async function processLine(line: string): Promise<void> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: T;
      try {
        parsed = JSON.parse(trimmed) as T;
      } catch {
        badLines += 1;
        return;
      }
      await onRow(parsed);
      count += 1;
    }

    return new Promise<number>((resolve, reject) => {
      let chain = Promise.resolve();

      function processChunk(chunk: Buffer | string): void {
        pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          chain = chain.then(() => processLine(line));
          newline = pending.indexOf("\n");
        }
      }

      stream.on("data", processChunk);
      stream.on("end", () => {
        chain
          .then(() => processLine(pending))
          .then(() => {
            if (badLines > 0) console.warn(`[sde-archive] skipped ${badLines} malformed JSON line(s) in ${memberName}`);
            resolve(count);
          })
          .catch((error: unknown) => reject(error));
      });
      stream.on("error", (error) => reject(error));
    });
  });
}

async function readMetadata(archivePath: string, archiveUrl: string): Promise<SdeArchiveMetadata> {
  let raw: Record<string, unknown> = {};
  try {
    await readJsonlMember<Record<string, unknown>>(archivePath, "_sde.jsonl", (row) => {
      if (Object.keys(raw).length === 0) raw = row;
    });
  } catch {
    // _sde.jsonl absent or unreadable — proceed with empty metadata
  }

  return {
    buildNumber: integerValue(raw, ["buildNumber", "build_number", "build"]),
    releaseDate: stringValue(raw, ["releaseDate", "release_date", "date"]),
    archiveUrl,
    archivePath,
    raw
  };
}

async function downloadArchive(url: string, cacheDir: string, fetchImpl: typeof fetch): Promise<ResolvedArchive> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/zip, application/octet-stream",
      "User-Agent": "lp-calc/0.1 SDE JSONL bootstrap"
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download SDE JSONL archive from ${url}: ${response.status} ${response.statusText}`);
  }

  const tempPath = path.join(cacheDir, `.sde-jsonl-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  await finished(Readable.fromWeb(response.body).pipe(fs.createWriteStream(tempPath)));
  const archiveUrl = response.url || url;
  try {
    const metadata = await readMetadata(tempPath, archiveUrl);
    if (metadata.buildNumber === null) {
      throw new Error(`Downloaded SDE archive from ${url} is missing _sde.jsonl or has no buildNumber`);
    }
    const finalPath = path.join(cacheDir, `eve-online-static-data-${metadata.buildNumber}-jsonl.zip`);
    if (!fs.existsSync(finalPath)) {
      fs.renameSync(tempPath, finalPath);
    } else {
      fs.unlinkSync(tempPath);
    }
    return { archivePath: finalPath, archiveUrl };
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

async function resolveArchive(options: OpenSdeArchiveOptions): Promise<ResolvedArchive> {
  if (options.archivePath) {
    return {
      archivePath: path.resolve(options.archivePath),
      archiveUrl: options.archiveUrl ?? localArchiveUrl(options.archivePath)
    };
  }

  const cacheDir = sdeCacheDir(options);
  if (!options.forceDownload) {
    const cached = cachedArchives(cacheDir)[0];
    if (cached) {
      return { archivePath: cached, archiveUrl: options.archiveUrl ?? configuredUrl() };
    }
  }

  return downloadArchive(options.archiveUrl ?? configuredUrl(), cacheDir, options.fetchImpl ?? fetch);
}

// Resolve the latest published build number cheaply, WITHOUT downloading the ~100MB
// archive: CCP's `latest` URL 302-redirects to a build-numbered filename, so a HEAD that
// follows the redirect exposes the build via the final response URL. Returns null when the
// build can't be determined (HEAD unsupported, a non-versioned override URL, or a network
// error) — the daily refresh then falls back to a full download rather than skipping.
export async function latestRemoteBuildNumber(options: OpenSdeArchiveOptions = {}): Promise<number | null> {
  const url = options.archiveUrl ?? configuredUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "HEAD",
      headers: { "User-Agent": "lp-calc/0.1 SDE JSONL bootstrap" }
    });
    return buildNumberFromUrl(response.url || "") ?? buildNumberFromUrl(url);
  } catch {
    return null;
  }
}

// Keep only the `keep` most-recent build archives in the cache dir and delete the rest.
// The daily refresh downloads a fresh ~100MB zip per CCP build, so without pruning the
// cache would grow unbounded. Only ever touches `eve-online-static-data-*-jsonl.zip`
// files (never the Fuzzwork sqlite or anything else). Returns the deleted paths.
export function pruneCachedArchives(options: OpenSdeArchiveOptions = {}, keep = 2): string[] {
  const cacheDir = sdeCacheDir(options);
  const deleted: string[] = [];
  // cachedArchives is newest-first by mtime, so slice(keep) is everything but the newest few.
  for (const filePath of cachedArchives(cacheDir).slice(keep)) {
    try {
      fs.unlinkSync(filePath);
      deleted.push(filePath);
    } catch {
      // best-effort: a file we couldn't remove is re-evaluated on the next run
    }
  }
  return deleted;
}

export async function openSdeArchive(options: OpenSdeArchiveOptions = {}): Promise<SdeArchiveReader> {
  const archive = await resolveArchive(options);
  const metadata = await readMetadata(archive.archivePath, archive.archiveUrl);
  return new SdeArchiveReader(archive.archivePath, archive.archiveUrl, metadata);
}
