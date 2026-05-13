// N03 — SF Integration route Zod schemas + TypeScript types.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field mappings sub-schemas
// ---------------------------------------------------------------------------

export const SfDispoStatusMapSchema = z.record(z.string(), z.string());

export const SfFieldMappingsSchema = z.object({
  dispoToTaskStatus: SfDispoStatusMapSchema.optional(),
  dispoToCallType: z.record(z.string(), z.enum(['Inbound', 'Outbound'])).optional(),
  sfContactToLead: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().optional(),
    company: z.string().optional(),
  }).optional(),
  sfLeadToLead: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().optional(),
    company: z.string().optional(),
    status: z.string().optional(),
  }).optional(),
}).default({});

export type SfFieldMappings = z.infer<typeof SfFieldMappingsSchema>;

// ---------------------------------------------------------------------------
// Default dispo → SF Task Status mapping
// ---------------------------------------------------------------------------

export const DEFAULT_STATUS_MAP: Record<string, string> = {
  SALE:     'Completed',
  NOANSWER: 'Not Started',
  BUSY:     'Not Started',
  DNC:      'Deferred',
  CBHOLD:   'In Progress',
  CALLBACK: 'In Progress',
};

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

// GET /api/admin/sf-integration
export const GetConfigResponseSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  enabled: z.boolean(),
  instanceUrl: z.string().nullable(),
  clientId: z.string().nullable(),
  hasSecret: z.boolean(),
  hasTokens: z.boolean(),
  tokenExpiry: z.string().nullable(),
  fieldMappings: SfFieldMappingsSchema,
  lastWritebackAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type GetConfigResponse = z.infer<typeof GetConfigResponseSchema>;

// PATCH /api/admin/sf-integration
export const PatchConfigBodySchema = z.object({
  enabled: z.boolean().optional(),
  fieldMappings: SfFieldMappingsSchema.optional(),
});

export type PatchConfigBody = z.infer<typeof PatchConfigBodySchema>;

// POST /api/admin/sf-integration/connect
export const ConnectBodySchema = z.object({
  instanceUrl: z.string().url().max(255),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1),
});

export type ConnectBody = z.infer<typeof ConnectBodySchema>;

export const ConnectResponseSchema = z.object({
  authUrl: z.string(),
});

// GET /admin/sf-integration/oauth/callback
export const OauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type OauthCallbackQuery = z.infer<typeof OauthCallbackQuerySchema>;

// DELETE /api/admin/sf-integration/disconnect
export const DisconnectResponseSchema = z.object({
  ok: z.boolean(),
});

// POST /api/leads/sf-import
export const SfImportBodySchema = z.object({
  phone: z.string().min(1).max(32),
  sfRecordId: z.string().min(1).max(32),
  sfObjectType: z.enum(['Lead', 'Contact', 'Account']).default('Lead'),
  firstName: z.string().max(64).optional(),
  lastName: z.string().max(64).optional(),
  email: z.string().email().max(128).optional(),
  company: z.string().max(128).optional(),
});

export type SfImportBody = z.infer<typeof SfImportBodySchema>;

// Fastify JSON schema stubs (type:object wrappers so Fastify skips AJV validation;
// body validation is done by Zod in the handler)
export const sfIntegrationSchemas = {
  getConfig: { response: { 200: { type: 'object', additionalProperties: true } } },
  patchConfig: { response: { 200: { type: 'object', additionalProperties: true } } },
  connect: { response: { 200: { type: 'object', additionalProperties: true } } },
  oauthCallback: {},
  disconnect: { response: { 200: { type: 'object', additionalProperties: true } } },
};
