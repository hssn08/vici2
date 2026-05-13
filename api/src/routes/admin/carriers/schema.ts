// M06 — Carrier / Gateway admin schemas (Zod validators).
//
// Covers CRUD for: carriers, per-carrier gateways.
// Credential fields (username/password) are super_admin-only writes;
// reads always return credentialStatus: "set"|"unset" (never plaintext).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Carrier kind enum (mirrors Prisma CarrierKind)
// ---------------------------------------------------------------------------

export const CarrierKindEnum = z.enum([
  "twilio",
  "telnyx",
  "telnyx-creds",
  "telnyx-ip",
  "signalwire",
  "ringcentral",
  "bandwidth",
  "flowroute",
  "byoc",
]);

export type CarrierKind = z.infer<typeof CarrierKindEnum>;

// ---------------------------------------------------------------------------
// Carrier create
// ---------------------------------------------------------------------------

export const CarrierCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-. ]+$/, "Only alphanumeric, spaces, underscores, hyphens, dots"),
  kind: CarrierKindEnum,
  proxy: z.string().min(1).max(255),
  // Credentials — plain text on input; service layer encrypts before storing.
  username: z.string().max(128).optional(),
  password: z.string().max(256).optional(),
  register: z.boolean().default(false),
  callerIdE164: z
    .string()
    .max(16)
    .regex(/^\+[1-9]\d{1,14}$/, "Must be E.164 format (+12065551234)")
    .optional(),
  active: z.boolean().default(true),
  ipAllowlist: z.array(z.string().max(50)).default([]),
  configJson: z.record(z.unknown()).default({}),
  sendPai: z.boolean().default(false),
  isEmergency: z.boolean().default(false),
  maxConcurrent: z.number().int().min(1).max(100000).optional(),
  notes: z.record(z.unknown()).default({}),
  priority: z.number().int().min(1).max(9999).default(100),
});

export type CarrierCreateInput = z.infer<typeof CarrierCreateSchema>;

// ---------------------------------------------------------------------------
// Carrier update (all optional)
// ---------------------------------------------------------------------------

export const CarrierUpdateSchema = CarrierCreateSchema.partial().strict();

export type CarrierUpdateInput = z.infer<typeof CarrierUpdateSchema>;

// ---------------------------------------------------------------------------
// Carrier list query
// ---------------------------------------------------------------------------

export const CarrierListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  active: z.enum(["true", "false", "all"]).default("all"),
  kind: CarrierKindEnum.optional(),
  search: z.string().max(100).optional(),
});

export type CarrierListQuery = z.infer<typeof CarrierListQuerySchema>;

// ---------------------------------------------------------------------------
// Carrier response (masks credentials)
// ---------------------------------------------------------------------------

export interface CarrierResponse {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
  proxy: string;
  credentialStatus: "set" | "unset";
  kekVersion: number;
  register: boolean;
  callerIdE164: string | null;
  active: boolean;
  ipAllowlist: unknown;
  configJson: unknown;
  sendPai: boolean;
  isEmergency: boolean;
  maxConcurrent: number | null;
  notes: unknown;
  version: number;
  gatewayCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CarrierListResponse {
  data: CarrierResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Gateway transport enum
// ---------------------------------------------------------------------------

export const GatewayTransportEnum = z.enum(["udp", "tcp", "tls"]);

// ---------------------------------------------------------------------------
// Gateway create
// ---------------------------------------------------------------------------

export const GatewayCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-.]+$/, "Only alphanumeric, underscores, hyphens, dots"),
  proxy: z.string().min(1).max(255),
  realm: z.string().max(255).optional(),
  fromUser: z.string().max(64).optional(),
  fromDomain: z.string().max(255).optional(),
  extension: z.string().max(64).optional(),
  register: z.boolean().default(false),
  expireSeconds: z.number().int().min(60).max(86400).default(3600),
  retrySeconds: z.number().int().min(10).max(3600).default(30),
  transport: GatewayTransportEnum.default("udp"),
  priority: z.number().int().min(1).max(9999).default(100),
  active: z.boolean().default(true),
  templateOverrides: z.record(z.unknown()).default({}),
  weight: z.number().int().min(1).max(10000).default(100),
  maxConcurrent: z.number().int().min(1).max(100000).optional(),
  costPerMinCents: z.number().int().min(0).max(10000).optional(),
});

export type GatewayCreateInput = z.infer<typeof GatewayCreateSchema>;

// ---------------------------------------------------------------------------
// Gateway update
// ---------------------------------------------------------------------------

export const GatewayUpdateSchema = GatewayCreateSchema.partial().strict();

export type GatewayUpdateInput = z.infer<typeof GatewayUpdateSchema>;

// ---------------------------------------------------------------------------
// Gateway response
// ---------------------------------------------------------------------------

export interface GatewayResponse {
  id: string;
  tenantId: string;
  carrierId: string;
  name: string;
  proxy: string;
  realm: string | null;
  fromUser: string | null;
  fromDomain: string | null;
  extension: string | null;
  register: boolean;
  expireSeconds: number;
  retrySeconds: number;
  transport: string;
  priority: number;
  active: boolean;
  templateOverrides: unknown;
  weight: number;
  maxConcurrent: number | null;
  version: number;
  costPerMinCents: number | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Gateway health response (from Redis cache written by T02 health poller)
// ---------------------------------------------------------------------------

export interface GatewayHealthEntry {
  gatewayId: string;
  gatewayName: string;
  state: string;       // REGED | NOREG | UNREG | FAILED | FAIL_WAIT | EXPIRED
  status: string;      // UP (ping) | DOWN | UNKNOWN
  pingMs: number | null;
  polledAt: string | null;
}

export interface CarrierHealthResponse {
  carrierId: string;
  gateways: GatewayHealthEntry[];
}
