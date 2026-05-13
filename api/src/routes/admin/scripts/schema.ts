// M07 — Script Zod schemas.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const ScriptVariableSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/, { message: "Invalid variable name format" }),
  description: z.string().optional(),
});

export type ScriptVariable = z.infer<typeof ScriptVariableSchema>;

export const ScriptResponseSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  body: z.string(),
  campaignId: z.string().nullable(),
  active: z.boolean(),
  version: z.number(),
  variables: z.array(ScriptVariableSchema),
  usedByCampaignCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScriptResponse = z.infer<typeof ScriptResponseSchema>;

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const ScriptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  campaignId: z.string().optional(),
  search: z.string().optional(),
  active: z.enum(["true", "false", "all"]).default("all"),
});

export type ScriptListQuery = z.infer<typeof ScriptListQuerySchema>;

export const ScriptListResponseSchema = z.object({
  data: z.array(ScriptResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
});

export type ScriptListResponse = z.infer<typeof ScriptListResponseSchema>;

// ---------------------------------------------------------------------------
// Create body
// ---------------------------------------------------------------------------

export const ScriptCreateSchema = z.object({
  name: z.string().min(1).max(64, { message: "Script name is required (max 64 chars)" }),
  body: z.string().max(65535, { message: "Script body cannot exceed 65,535 characters" }).default(""),
  campaignId: z.string().max(32).nullable().default(null),
  active: z.boolean().default(true),
  variables: z.array(ScriptVariableSchema).default([]),
});

export type ScriptCreateInput = z.infer<typeof ScriptCreateSchema>;

// ---------------------------------------------------------------------------
// Update body (partial)
// ---------------------------------------------------------------------------

export const ScriptUpdateSchema = ScriptCreateSchema.partial();

export type ScriptUpdateInput = z.infer<typeof ScriptUpdateSchema>;

// ---------------------------------------------------------------------------
// Render body
// ---------------------------------------------------------------------------

export const ScriptRenderSchema = z.object({
  mode: z.enum(["preview", "live"]).default("preview"),
  sampleData: z
    .object({
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      custom: z.record(z.string()).optional(),
    })
    .optional(),
  leadId: z.string().optional(),
  agentName: z.string().optional(),
  campaignName: z.string().optional(),
});

export type ScriptRenderInput = z.infer<typeof ScriptRenderSchema>;

export const ScriptRenderResponseSchema = z.object({
  scriptId: z.string(),
  version: z.number(),
  html: z.string(),
});

export type ScriptRenderResponse = z.infer<typeof ScriptRenderResponseSchema>;

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

export const ScriptVersionResponseSchema = z.object({
  id: z.string(),
  scriptId: z.string(),
  version: z.number(),
  name: z.string(),
  bodyPreview: z.string(), // first 120 chars, HTML stripped
  savedAt: z.string(),
});

export type ScriptVersionResponse = z.infer<typeof ScriptVersionResponseSchema>;
