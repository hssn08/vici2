/**
 * workers/src/jobs/audit-attest/s3-publisher.ts
 *
 * PUT attestation JSON to S3 with Object Lock Compliance, 7-year retention.
 * (PLAN §5.5)
 *
 * Phase 1: uses @aws-sdk/client-s3 (must be installed in workers package).
 * If S3 is not configured (no AWS creds), logs a warning and returns null
 * (development / test mode).
 *
 * The S3 key format: <tenant_id>/<table>/<YYYY>/<MM>/<DD>.json
 * Bucket: process.env.VICI2_AUDIT_ATTESTATION_BUCKET
 */

export interface S3PutResult {
  etag: string | null;
  s3Key: string;
}

/** Build the S3 object key for an attestation. */
export function buildS3Key(tenantId: bigint, tableName: string, date: string): string {
  const [year, month, day] = date.split('-');
  return `${tenantId}/${tableName}/${year}/${month}/${day}.json`;
}

/**
 * PUT the attestation JSON to S3 with Object Lock Compliance.
 * Returns null if AWS SDK / bucket not configured (dev mode).
 */
export async function putAttestation(
  s3Key: string,
  body: string,
): Promise<S3PutResult | null> {
  const bucket = process.env.VICI2_AUDIT_ATTESTATION_BUCKET;
  if (!bucket) {
    console.warn('[audit-attest] VICI2_AUDIT_ATTESTATION_BUCKET not set — skipping S3 PUT (dev mode)');
    return null;
  }

  try {
    // Dynamic import so tests that don't exercise S3 don't fail on missing SDK
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });

    // Retention: now + 7 years (2557 days for leap-year safety)
    const retainUntil = new Date();
    retainUntil.setDate(retainUntil.getDate() + 2557);

    const cmd = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentType: 'application/json',
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
      ChecksumAlgorithm: 'SHA256',
    });

    const result = await client.send(cmd);
    return { etag: result.ETag ?? null, s3Key };
  } catch (err) {
    throw new Error(`S3 PUT failed for key ${s3Key}: ${(err as Error).message}`);
  }
}
