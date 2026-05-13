// N05 — Branded Calling admin route Zod schemas.

import { z } from 'zod';

export const PROVIDER_KINDS = ['first_orion', 'hiya', 'tns'] as const;

export const BRAND_VERTICALS = [
  'FINANCIAL_SERVICES', 'HEALTHCARE', 'INSURANCE', 'RETAIL',
  'UTILITIES', 'TELEMARKETING', 'NON_PROFIT', 'GOVERNMENT',
  'TECHNOLOGY', 'REAL_ESTATE', 'COLLECTIONS', 'OTHER',
] as const;

// Credentials schema — shape varies by provider; validated in provider.ts.
const FirstOrionCredsSchema = z.object({
  client_id:     z.string().min(1).max(255),
  client_secret: z.string().min(1).max(255),
});

const HiyaCredsSchema = z.object({
  api_key: z.string().min(1).max(255),
});

const TnsCredsSchema = z.object({
  api_key:    z.string().min(1).max(255),
  api_secret: z.string().min(1).max(255),
});

export const CredentialsSchema = z.union([
  FirstOrionCredsSchema,
  HiyaCredsSchema,
  TnsCredsSchema,
]);

// Brand profile fields (shared by create + update).
export const BrandProfileSchema = z.object({
  brandName:    z.string().min(1).max(30),
  logoUrl:      z.string().url().startsWith('https://').nullable().optional(),
  vertical:     z.enum(BRAND_VERTICALS),
  callReasons:  z.array(z.string().min(1).max(64)).min(1).max(20),
  website:      z.string().url().optional(),
  contactEmail: z.string().email().optional(),
});

// POST /api/admin/branded-calling/:provider — create/configure provider.
export const ConfigureProviderSchema = BrandProfileSchema.extend({
  credentials: CredentialsSchema,
});

// PATCH /api/admin/branded-calling/:provider — update brand profile (no creds required).
export const UpdateProviderSchema = BrandProfileSchema.partial().extend({
  credentials: CredentialsSchema.optional(),
});

// POST /api/admin/branded-calling/:provider/dids — register individual DID.
export const RegisterDidSchema = z.object({
  didId:      z.string().regex(/^\d+$/),
  callReason: z.string().min(1).max(64),
});

// POST /api/admin/branded-calling/:provider/dids/bulk-register — bulk register DIDs.
export const BulkRegisterSchema = z.object({
  didIds:     z.array(z.string().regex(/^\d+$/)).min(1).max(500),
  callReason: z.string().min(1).max(64),
});

// POST /api/admin/branded-calling/:provider/dids/:didId/dispute — submit dispute.
export const DisputeSchema = z.object({
  notes: z.string().min(1).max(2000),
});

// GET /api/admin/branded-calling/:provider/dids — list query params.
export const ListDidsQuerySchema = z.object({
  page:     z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status:   z.enum(['pending', 'submitted', 'active', 'rejected', 'deregistering', 'deregistered', 'error', 'all']).default('all'),
});
