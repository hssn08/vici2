import { NextRequest, NextResponse } from "next/server";

// GET /api/agent/current_call
// Restore dial state after page reload. Reads from Valkey t:{tid}:in_flight:{user_id}_*

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } },
      { status: 401 },
    );
  }

  const apiUrl = process.env.API_INTERNAL_URL ?? process.env.DIALER_ORIGINATE_URL;
  if (!apiUrl) {
    // Stub: no active call
    return NextResponse.json(
      { error: { code: "NO_CALL", message: "No active call" } },
      { status: 404 },
    );
  }

  try {
    const upstream = await fetch(`${apiUrl}/agent/current_call`, {
      headers: {
        authorization: auth,
        "x-vici2-tenant": req.headers.get("x-vici2-tenant") ?? "",
      },
    });

    if (upstream.status === 404) {
      return NextResponse.json(
        { error: { code: "NO_CALL", message: "No active call" } },
        { status: 404 },
      );
    }

    if (!upstream.ok) {
      return NextResponse.json(
        { error: { code: "UPSTREAM_ERROR", message: "Upstream error" } },
        { status: upstream.status },
      );
    }

    const result = await upstream.json();
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: { code: "CARRIER_FAIL", message: "Service unreachable" } },
      { status: 503 },
    );
  }
}

export const dynamic = "force-dynamic";
