// D02 — S3/local file storage abstraction (PLAN §5.2)

import { createWriteStream, existsSync, mkdirSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

const UPLOAD_DIR = process.env.D02_UPLOAD_DIR ?? "/tmp/vici2-imports";
const USE_S3 = process.env.D02_USE_S3 === "true";

export function ensureUploadDir(): void {
  if (!USE_S3) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/** Generate a local file path for an import file. */
export function localPath(importId: string, filename: string): string {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return join(UPLOAD_DIR, `${importId}_${safeFilename}`);
}

/** Generate the source_key for storage (s3:// or local path). */
export function sourceKey(importId: string, filename: string): string {
  if (USE_S3) {
    const bucket = process.env.D02_S3_BUCKET ?? "vici2-imports";
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
    return `s3://${bucket}/imports/${importId}/${safeFilename}`;
  }
  return localPath(importId, filename);
}

/** Stream upload file to local disk (dev mode). */
export async function uploadLocalStream(
  stream: Readable,
  filePath: string,
  maxBytes: number,
): Promise<{ bytesWritten: number }> {
  ensureUploadDir();
  mkdirSync(join(filePath, ".."), { recursive: true });

  let bytesWritten = 0;
  const writer = createWriteStream(filePath);

  await pipeline(
    stream,
    async function* (source) {
      for await (const chunk of source) {
        bytesWritten += (chunk as Buffer).length;
        if (bytesWritten > maxBytes) {
          throw Object.assign(new Error(`File exceeds maximum size of ${maxBytes} bytes`), {
            code: "FILE_TOO_LARGE",
          });
        }
        yield chunk;
      }
    },
    writer,
  );

  return { bytesWritten };
}

/** Read a file from local storage as a readable stream. */
export function readLocalStream(filePath: string): Readable {
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`File not found: ${filePath}`), { code: "NOT_FOUND" });
  }
  return createReadStream(filePath);
}

/** Read an errors.csv file path for streaming download. */
export function errorsFilePath(sourceKey: string): string {
  if (sourceKey.startsWith("s3://")) {
    // In dev mode, errors are stored locally under tmpdir
    const key = sourceKey.replace(/^s3:\/\/[^/]+\//, "");
    return join("/tmp/vici2-errors", key.replace(/\.csv$/, ".errors.csv"));
  }
  return sourceKey.replace(/\.[^.]+$/, ".errors.csv");
}

export const MAX_UPLOAD_BYTES = parseInt(process.env.D02_MAX_UPLOAD_BYTES ?? "") || 512 * 1024 * 1024; // 512 MB
