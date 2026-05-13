// M05 — Settings panel shared types.
// Mirror of api/src/routes/admin/settings/schema.ts response shape.

export interface AuthConfigData {
  passwordMinLength: number;
  lockoutAfterFailures: number;
  lockoutWindowSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  totpGracePeriodDays: number;
}

export interface TenantSettingsData {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  settings: {
    recordingConsentDefault?: boolean;
    allowCallTimeOverrides?: boolean;
    brandLabel?: string;
    reportTimezone?: string;
    supportEmail?: string | null;
    unknownTzPolicyDefault?: "deny" | "warn_pass";
    pacingDefaults?: {
      dialMethod?: string;
      dropTargetMax?: number;
    };
  };
  internalDncRetentionYears: number;
  consentMinimumMode: string;
  defaultCallerState: string | null;
  auth: AuthConfigData;
  updatedAt: string;
}

export type ConsentMode = "PROMPT_MESSAGE" | "REQUIRE_ACTIVE" | "SKIP";
export type DialMethod =
  | "MANUAL"
  | "RATIO"
  | "PROGRESSIVE"
  | "ADAPT_HARD"
  | "ADAPT_AVG"
  | "ADAPT_TAPERED";
export type UnknownTzPolicy = "deny" | "warn_pass";
