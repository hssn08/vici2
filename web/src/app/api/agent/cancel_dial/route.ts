import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// POST /api/agent/cancel_dial — idempotent cancel of an in-flight originate.

const CancelDialBody = z.object({
  attempt_uuid: z.string().uuid("attempt_uuid must be UUIDv4"),
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

  const parsed = CancelDialBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "INVALID_BODY", message: "attempt_uuid required" } },
      { status: 400 },
    );
  }

  const { attempt_uuid } = parsed.data;

  const dialerUrl = process.env.DIALER_ORIGINATE_URL;
  if (!dialerUrl) {
    // Stub for dev/CI
    return NextResponse.json({ cancelled: true, attempt_uuid });
  }

  try {
    const upstream = await fetch(`${dialerUrl}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: auth,
        "x-vici2-tenant": req.headers.get("x-vici2-tenant") ?? "",
      },
      body: JSON.stringify({ attempt_uuid }),
    });

    if (!upstream.ok) {
      const err = (await upstream.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      return NextResponse.json(
        {
          error: {
            code: err.error?.code ?? `cancel.${upstream.status}`,
            message: err.error?.message ?? upstream.statusText,
          },
        },
        { status: upstream.status },
      );
    }

    return NextResponse.json({ cancelled: true, attempt_uuid });
  } catch {
    return NextResponse.json(
      { error: { code: "CARRIER_FAIL", message: "Dialer unreachable" } },
      { status: 503 },
    );
  }
}

export const dynamic = "force-dynamic";
