// E01 — Campaign schema (Zod validators).
//
// Covers every Campaign column including the 16 E01 amendments
// (§10 of E01 PLAN / F02 AMENDMENTS-HANDOFF §2) plus
// CampaignStatusOverride and CampaignList linkage.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (mirror Prisma enums)
// ---------------------------------------------------------------------------

export const DialMethodEnum = z.enum([
  "MANUAL",
  "RATIO",
  "PROGRESSIVE",
  "ADAPT_HARD",
  "ADAPT_AVG",
  "ADAPT_TAPERED",
]);

export const NextAgentCallEnum = z.enum([
  "longest_wait",
  "random",
  "fewest_calls",
  "rank",
]);

export const RecordingModeEnum = z.enum(["NEVER", "ONDEMAND", "ALL", "ALLFORCE"]);

export const AmdActionEnum = z.enum(["drop", "vmdrop", "agent"]);

export const PauseCodesRequiredEnum = z.enum(["OFF", "OPTIONAL", "FORCE"]);

export const UnknownTzPolicyEnum = z.enum(["deny", "warn_pass"]);

export const MultiListMixEnum = z.enum(["EVEN", "MULTI", "NONE"]);

// ---------------------------------------------------------------------------
// SQL fragment safety — rejects DDL / injection vectors
// ---------------------------------------------------------------------------

const FORBIDDEN_SQL_PATTERNS = [
  /\bDROP\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bEXEC\b/i,
  /\bEXECUTE\b/i,
  /;/,
  /--/,
  /\/\*/,
  /\bUNION\b/i,
];

function isSafeLeadFilterSql(val: string): boolean {
  return !FORBIDDEN_SQL_PATTERNS.some((p) => p.test(val));
}

// ---------------------------------------------------------------------------
// Campaign create / update body
// ---------------------------------------------------------------------------

// Base object (without cross-field validation) so we can call .omit/.partial
const CampaignBaseObject = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, "campaign id must be alphanumeric/underscore/hyphen"),
  name: z.string().min(1).max(128),
  active: z.boolean().default(true),
  dial_method: DialMethodEnum.default("MANUAL"),
  auto_dial_level: z.number().min(0).max(10).default(0),
  adaptive_max_level: z.number().min(0).max(10).default(3),
  adaptive_drop_pct: z.number().min(0).max(100).default(1.5),
  dial_timeout_sec: z.number().int().min(5).max(120).default(22),
  wrapup_seconds: z.number().int().min(0).max(600).default(10),
  next_agent_call: NextAgentCallEnum.default("longest_wait"),
  available_only_tally: z.boolean().default(false),
  hopper_size_target: z.number().int().min(0).default(0),
  hopper_multiplier: z.number().min(0.1).max(10).default(2.0),
  caller_id_carrier_id: z.number().int().positive().nullable().default(null),
  caller_id_override: z.string().max(16).nullable().default(null),
  recording_mode: RecordingModeEnum.default("ALL"),
  amd_enabled: z.boolean().default(false),
  amd_action: AmdActionEnum.default("drop"),
  vmdrop_audio: z.string().max(255).nullable().default(null),
  safe_harbor_audio: z.string().max(255).nullable().default(null),
  script_id: z.number().int().positive().nullable().default(null),
  webform_url: z.string().url().max(512).nullable().default(null),
  dial_status_filter: z.array(z.string()).default([]),
  call_time_id: z.number().int().positive().nullable().default(null),
  use_internal_dnc: z.boolean().default(true),
  use_federal_dnc: z.boolean().default(true),
  use_state_dnc: z.boolean().default(true),
  pause_codes_required: PauseCodesRequiredEnum.default("OPTIONAL"),
  hot_keys_active: z.boolean().default(true),
  closer_ingroups: z.array(z.string()).default([]),
  // C01 amendment
  unknown_tz_policy: UnknownTzPolicyEnum.default("deny"),
  // E01 amendments (§10 / F02 AMENDMENTS-HANDOFF §2)
  dial_level: z.number().min(0.1).max(10).default(1.5),
  lock_ttl_sec: z.number().int().min(5).max(120).default(30),
  min_hopper_level: z.number().int().min(0).default(50),
  max_hopper_level: z.number().int().min(1).default(5000),
  hopper_buffer_multiplier: z.number().min(0.1).max(10).default(1.5),
  recycle_delay_seconds: z.number().int().min(0).default(600),
  max_calls_per_lead: z.number().int().min(1).max(127).default(5),
  dial_statuses: z.array(z.string().max(8)).default(["NEW", "NA", "B", "CALLBK"]),
  low_water_pct: z.number().int().min(1).max(100).default(25),
  high_water_pct: z.number().int().min(1).max(100).default(90),
  over_fetch_ratio: z.number().min(0.1).max(10).default(1.5),
  machine_terminal: z.boolean().default(true),
  lead_filter_sql: z
    .string()
    .max(4096)
    .nullable()
    .default(null)
    .refine(
      (v) => v === null || isSafeLeadFilterSql(v),
      "lead_filter_sql contains forbidden SQL keywords or injection patterns",
    ),
  multi_list_mix: MultiListMixEnum.default("EVEN"),
});

function addCrossFieldValidation<T extends z.ZodTypeAny>(
  schema: T,
  ctx: z.RefinementCtx,
  data: {
    lock_ttl_sec?: number;
    dial_timeout_sec?: number;
    min_hopper_level?: number;
    max_hopper_level?: number;
    low_water_pct?: number;
    high_water_pct?: number;
  },
): void {
  if (
    data.lock_ttl_sec !== undefined &&
    data.dial_timeout_sec !== undefined &&
    data.lock_ttl_sec <= data.dial_timeout_sec + 5
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lock_ttl_sec"],
      message: `lock_ttl_sec (${data.lock_ttl_sec}) must be > dial_timeout_sec + 5 (${data.dial_timeout_sec + 5})`,
    });
  }
  if (
    data.min_hopper_level !== undefined &&
    data.max_hopper_level !== undefined &&
    data.min_hopper_level > data.max_hopper_level
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["min_hopper_level"],
      message: "min_hopper_level must be <= max_hopper_level",
    });
  }
  if (
    data.low_water_pct !== undefined &&
    data.high_water_pct !== undefined &&
    data.low_water_pct >= data.high_water_pct
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["low_water_pct"],
      message: "low_water_pct must be < high_water_pct",
    });
  }
  void schema; // suppress unused param warning
}

export const CampaignCreateSchema = CampaignBaseObject.superRefine((data, ctx) => {
  addCrossFieldValidation(CampaignBaseObject, ctx, data);
});

export type CampaignCreateInput = z.infer<typeof CampaignCreateSchema>;

// PATCH body — all fields optional (id not patchable)
export const CampaignUpdateSchema = CampaignBaseObject.omit({ id: true })
  .partial()
  .superRefine((data, ctx) => {
    addCrossFieldValidation(CampaignBaseObject, ctx, data);
  });

export type CampaignUpdateInput = z.infer<typeof CampaignUpdateSchema>;

// ---------------------------------------------------------------------------
// Campaign-status override
// ---------------------------------------------------------------------------

export const StatusOverrideUpsertSchema = z.object({
  status_code: z.string().min(1).max(8),
  recycle_delay_seconds: z.number().int().min(0).nullable().optional(),
  max_calls: z.number().int().min(0).max(127).nullable().optional(),
  notes: z.string().max(255).nullable().optional(),
});

export type StatusOverrideUpsertInput = z.infer<typeof StatusOverrideUpsertSchema>;

// ---------------------------------------------------------------------------
// Campaign-list linkage
// ---------------------------------------------------------------------------

export const CampaignListLinkSchema = z.object({
  list_id: z.number().int().positive(),
  priority: z.number().int().min(0).max(32767).default(0),
});

export type CampaignListLinkInput = z.infer<typeof CampaignListLinkSchema>;

// ---------------------------------------------------------------------------
// Campaign state machine actions
// ---------------------------------------------------------------------------

export const CampaignActionSchema = z.object({
  action: z.enum(["start", "pause", "stop"]),
});

// ---------------------------------------------------------------------------
// Query params for list endpoint
// ---------------------------------------------------------------------------

export const CampaignListQuerySchema = z.object({
  active: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  dial_method: DialMethodEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
