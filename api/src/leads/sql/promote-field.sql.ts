// D01 — DDL templates for custom field promotion (PLAN §5.5)
// Virtual generated column + index on leads table.

export function buildPromoteDdl(k: string): string {
  // k already validated against ^[a-z_][a-z0-9_]{0,30}$
  return `
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS cf_${k} VARCHAR(255)
        AS (JSON_UNQUOTE(JSON_EXTRACT(custom_data, '$."${k}"'))) VIRTUAL,
      ADD INDEX IF NOT EXISTS idx_t_cf_${k} (tenant_id, cf_${k})
  `.trim();
}

export async function promoteCustomField(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  k: string,
): Promise<string> {
  const ddl = buildPromoteDdl(k);
  await prisma.$executeRawUnsafe(ddl);
  return ddl;
}
