// I02 — Prompt upload pipeline.
//
// Validates, converts (ffmpeg), stores to S3, and upserts ivr_prompts row.
// PLAN §5.1–§5.2

import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPrisma } from "../../lib/prisma.js";

const execAsync = promisify(exec);

export class PromptUploadError extends Error {
  constructor(
    message: string,
    public readonly code: "too_large" | "invalid_type" | "too_long" | "conversion_failed" | "upload_failed",
  ) {
    super(message);
    this.name = "PromptUploadError";
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DURATION_SEC = 120;
const ALLOWED_MIMES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/wave",
]);

export interface UploadResult {
  uri: string;
  durationMs: number;
  sizeBytes: number;
}

export interface UploadOptions {
  tenantId: bigint;
  ivrId: bigint;
  nodeId: bigint;
  lang: string;
  fileName: string;
  mimeType: string;
  fileBuffer: Buffer;
}

export async function uploadPrompt(opts: UploadOptions): Promise<UploadResult> {
  const { tenantId, ivrId, nodeId, lang, mimeType, fileBuffer } = opts;

  // 1. Validate size
  if (fileBuffer.length > MAX_FILE_BYTES) {
    throw new PromptUploadError(
      `File size ${fileBuffer.length} exceeds 10 MB limit`,
      "too_large",
    );
  }

  // 2. Validate MIME
  const normalizedMime = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  if (!ALLOWED_MIMES.has(normalizedMime)) {
    throw new PromptUploadError(
      `MIME type '${mimeType}' not allowed; expected audio/wav or audio/mpeg`,
      "invalid_type",
    );
  }

  // 3. Write to tmp file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vici2-ivr-"));
  const inFile = path.join(tmpDir, `input_${nodeId}_${lang}`);
  const outFile = path.join(tmpDir, `${nodeId}_${lang}.wav`);

  try {
    await fs.writeFile(inFile, fileBuffer);

    // 4. Convert to 8kHz mono PCM WAV
    try {
      await execAsync(
        `ffmpeg -y -i "${inFile}" -ar 8000 -ac 1 -acodec pcm_s16le "${outFile}" 2>&1`,
      );
    } catch (err) {
      throw new PromptUploadError(
        `ffmpeg conversion failed: ${(err as Error).message}`,
        "conversion_failed",
      );
    }

    // 5. Validate duration via ffprobe
    const { stdout: probeOut } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outFile}"`,
    );
    const durationSec = parseFloat(probeOut.trim());
    if (isNaN(durationSec) || durationSec > MAX_DURATION_SEC) {
      throw new PromptUploadError(
        `Prompt duration ${durationSec}s exceeds ${MAX_DURATION_SEC}s limit`,
        "too_long",
      );
    }
    const durationMs = Math.round(durationSec * 1000);

    // 6. Read converted file
    const convertedBuffer = await fs.readFile(outFile);
    const sizeBytes = convertedBuffer.length;

    // 7. S3 key + URI
    const s3Key = `ivr/${tenantId}/${ivrId}/${nodeId}_${lang}.wav`;
    const s3Uri = `s3://vici2-media/${s3Key}`;

    // 8. Upload to S3 (via env-configured S3 client; stub for Phase 1 if S3 unavailable)
    await uploadToS3(s3Key, convertedBuffer);

    // 9. Upsert ivr_prompts row
    const prisma = getPrisma();
    await (prisma as unknown as {
      ivrPrompt: {
        upsert: (args: unknown) => Promise<unknown>;
      };
    }).ivrPrompt.upsert({
      where: { nodeId_lang: { nodeId, lang } },
      create: {
        tenantId,
        nodeId,
        lang,
        fileUri: s3Uri,
        fileSizeBytes: sizeBytes,
        durationMs,
      },
      update: {
        fileUri: s3Uri,
        fileSizeBytes: sizeBytes,
        durationMs,
      },
    });

    return { uri: s3Uri, durationMs, sizeBytes };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── S3 adapter (stub — Phase 1 writes to local sounds dir if no S3 creds) ───

async function uploadToS3(key: string, data: Buffer): Promise<void> {
  const bucket = process.env.S3_BUCKET ?? "vici2-media";
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;

  if (!accessKey || !secretKey) {
    // Phase 1 fallback: write to local sounds dir
    const localDir = process.env.FS_SOUNDS_IVR_DIR ?? "/var/lib/freeswitch/sounds/ivr";
    const parts = key.split("/"); // ivr/tenantId/ivrId/nodeId_lang.wav
    const localPath = path.join(localDir, ...parts.slice(1)); // drop leading "ivr/"
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, data);
    return;
  }

  // Dynamic import to avoid hard dep when S3 not configured.
  type S3Module = { S3Client: new (cfg: unknown) => { send: (cmd: unknown) => Promise<void> }; PutObjectCommand: new (cfg: unknown) => unknown };
  const s3Module = await new Function('m', 'return import(m)')("@aws-sdk/client-s3").catch(() => {
    throw new PromptUploadError("@aws-sdk/client-s3 not installed", "upload_failed");
  }) as S3Module;

  const { S3Client, PutObjectCommand } = s3Module;

  const client = new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: "audio/wav",
    }),
  );
}
