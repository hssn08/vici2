import { describe, it, expect } from 'vitest';
import { check, assertCallWindowOrThrow } from '../check.js';
import type { CheckRequest } from '../types.js';
import { REASONS } from '../types.js';
import fixturesRaw from './fixtures.json';

interface Fixture {
  id: number;
  desc: string;
  req: {
    phoneE164: string;
    knownTimezone: string;
    state: string;
    enforcementPoint: string;
    isAutoDialer: boolean;
    unknownTzPolicy?: string;
    when: string;
    campaignWindow?: { openLocal: number; closeLocal: number };
  };
  want: { outcome: string; reason: string };
}

const fixtures = fixturesRaw as Fixture[];

describe('check() — fixture catalog', () => {
  for (const fx of fixtures) {
    it(`[${fx.id}] ${fx.desc}`, async () => {
      const req: CheckRequest = {
        phoneE164: fx.req.phoneE164,
        knownTimezone: fx.req.knownTimezone || undefined,
        state: fx.req.state || undefined,
        enforcementPoint: fx.req.enforcementPoint as CheckRequest['enforcementPoint'],
        isAutoDialer: fx.req.isAutoDialer,
        unknownTzPolicy: (fx.req.unknownTzPolicy as CheckRequest['unknownTzPolicy']) ?? undefined,
        when: new Date(fx.req.when),
        campaignWindow: fx.req.campaignWindow
          ? { openLocal: fx.req.campaignWindow.openLocal, closeLocal: fx.req.campaignWindow.closeLocal }
          : undefined,
      };
      const res = await check(req);
      expect(res.outcome).toBe(fx.want.outcome);
      expect(res.reason).toBe(fx.want.reason);
    });
  }
});

describe('check() — invariants', () => {
  it('federal floor never weakens (campaign 6am-11pm does not override 8am open)', async () => {
    // 7:30am ET → before federal open regardless of campaign window
    const res = await check({
      knownTimezone: 'America/New_York',
      phoneE164: '+12125550099',
      enforcementPoint: 'hopper_filler',
      campaignWindow: { openLocal: 6 * 3600, closeLocal: 23 * 3600 },
      when: new Date('2026-05-13T11:30:00Z'), // 7:30am ET
    });
    expect(res.outcome).toBe('SKIP_UNTIL');
    expect(res.effective?.openLocal).toBe(8 * 3600); // federal floor
  });

  it('most-restrictive wins: RI Sat 10-17 beats campaign 8-21', async () => {
    // 10:30am ET Saturday → in window
    const res = await check({
      knownTimezone: 'America/New_York',
      state: 'RI',
      phoneE164: '+14015550099',
      enforcementPoint: 'hopper_filler',
      campaignWindow: { openLocal: 8 * 3600, closeLocal: 21 * 3600 },
      when: new Date('2026-05-16T14:30:00Z'),
    });
    expect(res.outcome).toBe('ALLOW');
    expect(res.effective?.openLocal).toBe(10 * 3600);
    expect(res.effective?.closeLocal).toBe(17 * 3600);
  });

  it('AL Sunday blackout returns SKIP_UNTIL regardless of time', async () => {
    const res = await check({
      knownTimezone: 'America/Chicago',
      state: 'AL',
      phoneE164: '+12055550099',
      enforcementPoint: 'hopper_filler',
      when: new Date('2026-05-17T15:00:00Z'), // Sunday 10am CT
    });
    expect(res.outcome).toBe('SKIP_UNTIL');
    expect(res.reason).toBe(REASONS.STATE_SUNDAY_BLACKOUT);
  });

  it('manual dial same outcome as originate_path for after-window case', async () => {
    const when = new Date('2026-05-14T01:01:00Z'); // 9:01pm ET
    const base = { knownTimezone: 'America/New_York', phoneE164: '+12125550099', when };
    const orig = await check({ ...base, enforcementPoint: 'originate_path' });
    const manual = await check({ ...base, enforcementPoint: 'manual_dial' });
    expect(orig.outcome).toBe(manual.outcome);
    expect(orig.reason).toBe(manual.reason);
  });

  it('assertCallWindowOrThrow throws on SKIP_UNTIL', async () => {
    let thrown: Error & { code?: string } | undefined;
    try {
      await assertCallWindowOrThrow({
        knownTimezone: 'America/New_York',
        phoneE164: '+12125550099',
        enforcementPoint: 'hopper_filler',
        when: new Date('2026-05-14T02:00:00Z'), // 10pm ET
      });
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe('OUTSIDE_CALL_WINDOW');
  });

  it('assertCallWindowOrThrow resolves on ALLOW', async () => {
    await expect(
      assertCallWindowOrThrow({
        knownTimezone: 'America/New_York',
        phoneE164: '+12125550099',
        enforcementPoint: 'hopper_filler',
        when: new Date('2026-05-13T15:00:00Z'), // 11am ET
      }),
    ).resolves.toBeUndefined();
  });
});

describe('check() — DST regressions', () => {
  const transitions = [
    // spring-forward: clocks 2am→3am
    { desc: 'ET spring 2026', tz: 'America/New_York', when: '2026-03-08T07:00:00Z' },
    { desc: 'PT spring 2026', tz: 'America/Los_Angeles', when: '2026-03-08T10:00:00Z' },
    // fall-back: clocks 2am→1am
    { desc: 'ET fall 2026', tz: 'America/New_York', when: '2026-11-01T06:00:00Z' },
    { desc: 'PT fall 2026', tz: 'America/Los_Angeles', when: '2026-11-01T09:00:00Z' },
  ];

  for (const tr of transitions) {
    it(`${tr.desc} — probes around transition produce defined outcomes`, async () => {
      const offsets = [-60_000, 0, 60_000, 3_600_000]; // -1m, 0, +1m, +1h
      for (const off of offsets) {
        const res = await check({
          knownTimezone: tr.tz,
          phoneE164: '+12125550099',
          enforcementPoint: 'hopper_filler',
          when: new Date(new Date(tr.when).getTime() + off),
        });
        expect(res.outcome).toBeDefined();
        expect(['ALLOW', 'SKIP_UNTIL', 'BLOCK_INVALID']).toContain(res.outcome);
      }
    });
  }
});
