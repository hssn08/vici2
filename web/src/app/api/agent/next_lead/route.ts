import { NextRequest, NextResponse } from "next/server";

// GET /api/agent/next_lead?campaign_id=<id>
// Returns the next undialed lead for the agent's active campaign.
// Phase-1 SQL: ORDER BY list_id ASC, id ASC + FOR UPDATE SKIP LOCKED
// + Valkey advisory lock t:{tid}:lead_claim:{lead_id}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } },
      { status: 401 },
    );
  }

  const campaignId = req.nextUrl.searchParams.get("campaign_id");

  const apiUrl = process.env.API_INTERNAL_URL ?? process.env.DIALER_ORIGINATE_URL;
  if (!apiUrl) {
    // Stub for dev/CI — return a synthetic lead
    return NextResponse.json({
      lead: {
        id: 1001,
        firstName: "Jane",
        lastName: "Sample",
        vendorLeadCode: null,
        phoneE164: "+15005550006",
        phoneType: "mobile",
        city: "San Francisco",
        state: "California",
        stateAbbr: "CA",
        postalCode: "94102",
        tzOffsetMin: -480,
        tzName: "America/Los_Angeles",
        customData: {},
        calledCount: 0,
        lastCalledAt: null,
        listId: campaignId ? Number(campaignId) : 1,
      },
      claim_token: `stub-claim-${Date.now()}`,
    });
  }

  try {
    const qs = campaignId ? `?campaign_id=${encodeURIComponent(campaignId)}` : "";
    const upstream = await fetch(`${apiUrl}/agent/next_lead${qs}`, {
      headers: {
        authorization: auth,
        "x-vici2-tenant": req.headers.get("x-vici2-tenant") ?? "",
      },
    });

    if (upstream.status === 404) {
      return NextResponse.json(
        { error: { code: "NO_LEAD", message: "No leads available" } },
        { status: 404 },
      );
    }

    if (!upstream.ok) {
      const err = (await upstream.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      return NextResponse.json(
        { error: err.error ?? { code: "UPSTREAM_ERROR", message: "Upstream error" } },
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
