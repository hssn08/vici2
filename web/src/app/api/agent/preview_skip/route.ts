import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// POST /api/agent/preview_skip
// Releases a hopper claim token and optionally marks DNC / schedules callback.

const PreviewSkipBody = z.object({
  lead_id: z.number().int().positive(),
  claim_token: z.string().min(1),
  reason: z.enum(["skipped", "dnc", "callback"]),
  dnc: z.boolean().optional(),
  callback_at: z.string().datetime().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
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

  const parsed = PreviewSkipBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_BODY",
          message: "Validation failed",
          detail: parsed.error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  const apiUrl = process.env.API_INTERNAL_URL ?? process.env.DIALER_ORIGINATE_URL;
  if (!apiUrl) {
    return NextResponse.json({ released: true });
  }

  try {
    const upstream = await fetch(`${apiUrl}/agent/preview_skip`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth,
        "x-vici2-tenant": req.headers.get("x-vici2-tenant") ?? "",
      },
      body: JSON.stringify(parsed.data),
    });

    if (!upstream.ok) {
      const err = (await upstream.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      return NextResponse.json(
        { error: err.error ?? { code: "UPSTREAM_ERROR", message: "Upstream error" } },
        { status: upstream.status },
      );
    }

    return NextResponse.json({ released: true });
  } catch {
    return NextResponse.json(
      { error: { code: "CARRIER_FAIL", message: "Service unreachable" } },
      { status: 503 },
    );
  }
}

export const dynamic = "force-dynamic";
