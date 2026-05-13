import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// POST /api/agent/manual_dial
// Wraps the T04 originate pipeline. Returns attempt_uuid on success.

const ManualDialBody = z.object({
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "Must be E.164")
    .describe("E.164 phone number"),
  lead_id: z.number().int().positive().optional(),
  alt_dial: z.boolean().optional(),
  attempt_uuid: z.string().uuid("attempt_uuid must be UUIDv4"),
  consent_attested: z.boolean().optional(),
  post_answer_digits: z
    .string()
    .regex(/^[\d#*,]+$/)
    .max(32)
    .optional(),
  campaign_id: z.number().int().positive().optional(),
  dial_mode: z.enum(["manual", "next", "preview"]).optional(),
  claim_token: z.string().optional(),
});

export type ManualDialBodyType = z.infer<typeof ManualDialBody>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth guard: verify bearer token present
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_BODY", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = ManualDialBody.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return NextResponse.json(
      {
        error: {
          code: "INVALID_PHONE",
          message: first?.message ?? "Validation error",
          detail: parsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  const data = parsed.data;

  // Forward to the dialer originate service (T04 contract).
  // In dev/test without a real dialer, return a stub success response.
  const dialerUrl = process.env.DIALER_ORIGINATE_URL;
  if (!dialerUrl) {
    // Stub: return mock response for local dev / CI
    return NextResponse.json({
      attempt_uuid: data.attempt_uuid,
      lead: {
        id: data.lead_id ?? 0,
        phone_e164: data.phone,
      },
    });
  }

  try {
    const upstream = await fetch(`${dialerUrl}/originate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth,
        "x-vici2-tenant": req.headers.get("x-vici2-tenant") ?? "",
      },
      body: JSON.stringify(data),
    });

    if (!upstream.ok) {
      const err = (await upstream.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; detail?: unknown };
      };
      return NextResponse.json(
        {
          error: {
            code: err.error?.code ?? `dial.${upstream.status}`,
            message: err.error?.message ?? upstream.statusText,
            detail: err.error?.detail,
          },
        },
        { status: upstream.status },
      );
    }

    const result = await upstream.json();
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: { code: "CARRIER_FAIL", message: "Dialer unreachable" } },
      { status: 503 },
    );
  }
}

export const dynamic = "force-dynamic";
