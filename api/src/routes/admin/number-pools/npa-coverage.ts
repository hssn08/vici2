// X05 — NPA coverage report route handler.
//
// GET /api/admin/number-pools/:id/npa-coverage
//
// Returns the per-NPA DID count for a pool by scanning the Valkey NPA index
// built by the X05 index builder. Used by the admin UI to surface coverage gaps.

import { getPrisma } from "../../../lib/prisma.js";
import type { NpaCoverageEntry, NpaCoverageResponse } from "./schema.js";

// NPA→state mapping: a lightweight embedded map for the coverage report.
// Sourced from the same NANPA dataset used by the Go dialer's tz package.
// US-only; Canadian/Caribbean NPAs return null for state.
const npaToState: Record<string, string> = {
  // New York
  "212": "NY", "718": "NY", "917": "NY", "646": "NY", "332": "NY",
  "347": "NY", "929": "NY", "315": "NY", "516": "NY", "518": "NY",
  "585": "NY", "607": "NY", "631": "NY", "716": "NY", "845": "NY",
  "914": "NY",
  // California
  "213": "CA", "310": "CA", "323": "CA", "408": "CA", "415": "CA",
  "424": "CA", "510": "CA", "562": "CA", "619": "CA", "626": "CA",
  "628": "CA", "650": "CA", "657": "CA", "661": "CA", "669": "CA",
  "707": "CA", "714": "CA", "747": "CA", "760": "CA", "805": "CA",
  "818": "CA", "831": "CA", "858": "CA", "909": "CA", "916": "CA",
  "925": "CA", "949": "CA", "951": "CA", "341": "CA",
  // Texas
  "210": "TX", "214": "TX", "254": "TX", "281": "TX", "325": "TX",
  "346": "TX", "361": "TX", "409": "TX", "430": "TX", "432": "TX",
  "469": "TX", "512": "TX", "682": "TX", "713": "TX", "726": "TX",
  "737": "TX", "806": "TX", "817": "TX", "830": "TX", "832": "TX",
  "903": "TX", "915": "TX", "936": "TX", "940": "TX", "945": "TX",
  "956": "TX", "972": "TX", "979": "TX",
  // Florida
  "239": "FL", "305": "FL", "321": "FL", "352": "FL", "386": "FL",
  "407": "FL", "561": "FL", "727": "FL", "754": "FL", "772": "FL",
  "786": "FL", "813": "FL", "850": "FL", "863": "FL", "904": "FL",
  "941": "FL", "954": "FL",
  // Illinois
  "217": "IL", "224": "IL", "309": "IL", "312": "IL", "331": "IL",
  "447": "IL", "464": "IL", "618": "IL", "630": "IL", "708": "IL",
  "773": "IL", "779": "IL", "815": "IL", "847": "IL", "872": "IL",
  // Georgia
  "229": "GA", "404": "GA", "470": "GA", "478": "GA", "678": "GA",
  "706": "GA", "762": "GA", "770": "GA", "912": "GA",
  // Pennsylvania
  "215": "PA", "223": "PA", "267": "PA", "272": "PA", "412": "PA",
  "445": "PA", "484": "PA", "570": "PA", "610": "PA", "717": "PA",
  "724": "PA", "814": "PA", "878": "PA",
  // Washington DC / Maryland / Virginia
  "202": "DC",
  "240": "MD", "301": "MD", "410": "MD", "443": "MD", "667": "MD",
  "571": "VA", "703": "VA", "757": "VA", "804": "VA",
  // Washington State
  "206": "WA", "253": "WA", "360": "WA", "425": "WA", "509": "WA",
  "564": "WA",
  // Colorado
  "303": "CO", "719": "CO", "720": "CO", "970": "CO",
  // Arizona
  "480": "AZ", "520": "AZ", "602": "AZ", "623": "AZ", "928": "AZ",
  // Massachusetts
  "339": "MA", "351": "MA", "413": "MA", "508": "MA", "617": "MA",
  "774": "MA", "781": "MA", "857": "MA", "978": "MA",
  // Nevada
  "702": "NV", "725": "NV", "775": "NV",
  // Minnesota
  "218": "MN", "320": "MN", "507": "MN", "612": "MN", "651": "MN",
  "763": "MN", "952": "MN",
  // Oregon
  "458": "OR", "503": "OR", "541": "OR", "971": "OR",
  // Missouri
  "314": "MO", "417": "MO", "573": "MO", "636": "MO", "660": "MO",
  "816": "MO",
  // Wisconsin
  "262": "WI", "414": "WI", "608": "WI", "715": "WI", "920": "WI",
  // Michigan
  "231": "MI", "248": "MI", "269": "MI", "313": "MI", "517": "MI",
  "586": "MI", "616": "MI", "734": "MI", "810": "MI", "906": "MI",
  "947": "MI", "989": "MI",
  // Ohio
  "216": "OH", "234": "OH", "283": "OH", "330": "OH", "380": "OH",
  "419": "OH", "440": "OH", "513": "OH", "567": "OH", "614": "OH",
  "740": "OH", "937": "OH",
  // North Carolina
  "252": "NC", "336": "NC", "704": "NC", "743": "NC", "828": "NC",
  "910": "NC", "919": "NC", "980": "NC",
};

/**
 * getNpaCoverageReport scans the Valkey NPA index for a pool and returns
 * per-NPA DID counts. Requires a Valkey client with SCAN + SCARD support.
 *
 * Note: This is not on the hot path — called only by admin UI.
 */
export async function getNpaCoverageReport(
  tenantId: bigint,
  poolId: bigint,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  valkeyClient: any, // ioredis or compatible; typed loosely for portability
): Promise<NpaCoverageResponse> {
  const db = getPrisma();

  const pool = await db.numberPool.findFirst({
    where: { id: poolId, tenantId },
    select: { id: true, localPresenceEnabled: true },
  });

  if (!pool) {
    throw new Error("pool not found");
  }

  const prefix = `t:${tenantId}:pool:{${poolId}}:npa:`;
  const coverage: NpaCoverageEntry[] = [];

  // SCAN for all NPA index keys for this pool.
  let cursor = "0";
  do {
    const [nextCursor, keys]: [string, string[]] = await valkeyClient.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      "200",
    );
    cursor = nextCursor;

    for (const key of keys) {
      const npa = key.slice(prefix.length);
      const didCount: number = await valkeyClient.scard(key);
      coverage.push({
        npa,
        state: npaToState[npa] ?? null,
        didCount,
      });
    }
  } while (cursor !== "0");

  // Sort by NPA for deterministic output.
  coverage.sort((a, b) => a.npa.localeCompare(b.npa));

  return {
    poolId: String(poolId),
    localPresenceEnabled: pool.localPresenceEnabled,
    coverage,
  };
}
