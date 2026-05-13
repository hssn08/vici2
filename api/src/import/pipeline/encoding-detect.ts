// D02 Stage 1 — Encoding detect + transcode Transform (PLAN §3.3)
// Detects encoding from first 32 KB, prepends iconv-lite for non-UTF-8.

import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import * as chardet from "chardet";
import * as iconv from "iconv-lite";
import * as fs from "node:fs";

const SAMPLE_SIZE = 32 * 1024; // 32 KB sample for chardet

export type SupportedEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export class UnsupportedEncodingError extends Error {
  readonly code = "UNSUPPORTED_ENCODING";
  constructor(detected: string) {
    super(`Unsupported encoding: "${detected}". Save as UTF-8 and re-upload.`);
    this.name = "UnsupportedEncodingError";
  }
}

/** Detect encoding from a local file path using chardet. */
export async function detectEncoding(filePath: string): Promise<SupportedEncoding> {
  // Read a sample
  const fd = fs.openSync(filePath, "r");
  const sample = Buffer.alloc(SAMPLE_SIZE);
  const bytesRead = fs.readSync(fd, sample, 0, SAMPLE_SIZE, 0);
  fs.closeSync(fd);
  const buf = sample.subarray(0, bytesRead);

  // Check BOM first
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8";

  // Use chardet for the rest
  const detected = chardet.detect(buf);
  if (!detected) return "utf-8";  // Assume UTF-8 if unknown

  const norm = detected.toLowerCase();
  if (norm === "utf-8" || norm === "ascii" || norm === "iso-8859-1") return "utf-8";
  if (norm === "utf-16le" || norm === "utf-16 le") return "utf-16le";
  if (norm === "utf-16be" || norm === "utf-16 be") return "utf-16be";
  if (norm === "windows-1252" || norm === "iso-8859-1" || norm.includes("1252")) {
    return "windows-1252";
  }

  // Anything else — reject
  throw new UnsupportedEncodingError(detected);
}

/** Create an encoding-transcode Transform (or pass-through for UTF-8). */
export function createEncodingTransform(encoding: SupportedEncoding): Transform | null {
  if (encoding === "utf-8") return null;

  // Map our enum to iconv-lite encoding names
  const iconvName =
    encoding === "utf-16le" ? "utf-16le" :
    encoding === "utf-16be" ? "utf-16be" :
    "windows-1252";

  return iconv.decodeStream(iconvName) as unknown as Transform;
}

/** Detect delimiter from first 4 KB of text. */
export function detectDelimiter(sample: string): "," | "\t" | ";" {
  const first4k = sample.slice(0, 4096);
  const tabs = (first4k.match(/\t/g) || []).length;
  const commas = (first4k.match(/,/g) || []).length;
  const semis = (first4k.match(/;/g) || []).length;

  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/** Pass-through Transform that sniffs first chunk for delimiter detection. */
export class DelimiterSnifferTransform extends Transform {
  private _sniffed = false;
  private _firstChunk = "";
  private _onDetected: (delimiter: "," | "\t" | ";") => void;

  constructor(onDetected: (delimiter: "," | "\t" | ";") => void) {
    super();
    this._onDetected = onDetected;
  }

  override _transform(chunk: Buffer | string, _enc: string, cb: TransformCallback): void {
    if (!this._sniffed) {
      this._firstChunk += chunk.toString("utf8");
      if (this._firstChunk.length >= 512) {
        const delim = detectDelimiter(this._firstChunk);
        this._onDetected(delim);
        this._sniffed = true;
      }
    }
    this.push(chunk);
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (!this._sniffed) {
      const delim = detectDelimiter(this._firstChunk);
      this._onDetected(delim);
    }
    cb();
  }
}
