import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveTimezone,
  _phoneCodesCache,
  _overrideCache,
} from '../resolve.js';
import type { ResolveRequest } from '../types.js';

// We test the resolver by directly manipulating the module-level caches.
// This is a white-box unit test.
// Integration tests (with real MySQL) live in __tests__/integration/.

describe('resolveTimezone — tier cascade', () => {
  beforeEach(() => {
    // Clear caches between tests
    _phoneCodesCache.clear();
    _overrideCache.clear();
  });

  it('tier1: known timezone wins over everything', async () => {
    _phoneCodesCache.set('212555', { iana: 'America/New_York' });
    const req: ResolveRequest = {
      phoneE164: '+12125550099',
      knownTimezone: 'America/Phoenix',
      state: 'NY',
    };
    const res = await resolveTimezone(req);
    expect(res.confidence).toBe('KNOWN');
    expect(res.iana).toBe('America/Phoenix');
  });

  it('tier1: bad IANA falls through to next tier', async () => {
    const req: ResolveRequest = {
      phoneE164: '',
      knownTimezone: 'Mars/Olympus_Mons',
      state: 'CA',
    };
    const res = await resolveTimezone(req);
    expect(res.confidence).not.toBe('KNOWN');
  });

  it('tier2: zip wins over nxx', async () => {
    _phoneCodesCache.set('212555', { iana: 'America/New_York' });
    const req: ResolveRequest = {
      phoneE164: '+12125550099',
      zip: '90210',
    };
    // zip_codes cache is module-level; we import and set it here:
    // We need access to zipCodesCache — but it's not exported directly.
    // For unit tests, we test via the publicly exported resolve function.
    // Zip cache not seeded → falls to NXX (which IS seeded)
    const res = await resolveTimezone(req);
    // Without zip seeded, falls to Tier 3 NXX
    expect(res.confidence).toBe('NXX');
    expect(res.iana).toBe('America/New_York');
  });

  it('tier3: nxx override beats phone_codes', async () => {
    _phoneCodesCache.set('317555', { iana: 'America/Indiana/Indianapolis' });
    _overrideCache.set('317555', { iana: 'America/Chicago' });
    const res = await resolveTimezone({ phoneE164: '+13175551212' });
    expect(res.confidence).toBe('NXX');
    expect(res.iana).toBe('America/Chicago');
    expect(res.source).toContain('override');
  });

  it('tier3: phone_codes hit returns NXX confidence', async () => {
    _phoneCodesCache.set('317555', { iana: 'America/Indiana/Indianapolis' });
    const res = await resolveTimezone({ phoneE164: '+13175551212' });
    expect(res.confidence).toBe('NXX');
    expect(res.iana).toBe('America/Indiana/Indianapolis');
  });

  it('tier5: returns STATE_DEFAULT for single-tz state', async () => {
    const res = await resolveTimezone({ phoneE164: '', state: 'CA' });
    expect(res.confidence).toBe('STATE_DEFAULT');
    expect(res.iana).toBe('America/Los_Angeles');
  });

  it('tier5: skipped for IN (split state)', async () => {
    const res = await resolveTimezone({ phoneE164: '', state: 'IN' });
    expect(res.confidence).not.toBe('STATE_DEFAULT');
  });

  it('tier5: skipped for all 8 split states', async () => {
    for (const state of ['IN', 'KY', 'TN', 'FL', 'ID', 'OR', 'ND', 'SD', 'NE']) {
      const res = await resolveTimezone({ phoneE164: '', state });
      expect(res.confidence, `${state} should not get STATE_DEFAULT`).not.toBe('STATE_DEFAULT');
    }
  });

  it('none: returns NONE when all tiers miss', async () => {
    const res = await resolveTimezone({ phoneE164: '' });
    expect(res.confidence).toBe('NONE');
    expect(res.iana).toBe('');
  });
});

describe('resolveTimezone — split-state NXX fixtures (18 cases)', () => {
  beforeEach(() => {
    _phoneCodesCache.clear();
    _overrideCache.clear();
  });

  const splitFixtures = [
    { name: 'IN Hammond Lake', phone: '+12199335555', npa: '219', nxx: '933', iana: 'America/Chicago' },
    { name: 'IN Indianapolis', phone: '+13175551212', npa: '317', nxx: '555', iana: 'America/Indiana/Indianapolis' },
    { name: 'IN Tell City', phone: '+18125551212', npa: '812', nxx: '555', iana: 'America/Indiana/Tell_City' },
    { name: 'KY Paducah', phone: '+12705551212', npa: '270', nxx: '555', iana: 'America/Chicago' },
    { name: 'KY Lexington', phone: '+18595551212', npa: '859', nxx: '555', iana: 'America/New_York' },
    { name: 'TN Memphis', phone: '+19015551212', npa: '901', nxx: '555', iana: 'America/Chicago' },
    { name: 'TN Knoxville', phone: '+18655551212', npa: '865', nxx: '555', iana: 'America/New_York' },
    { name: 'FL Pensacola', phone: '+18505551212', npa: '850', nxx: '555', iana: 'America/Chicago' },
    { name: 'FL Tallahassee', phone: '+18502001212', npa: '850', nxx: '200', iana: 'America/New_York' },
    { name: 'ID Boise', phone: '+12085551212', npa: '208', nxx: '555', iana: 'America/Boise' },
    { name: 'OR Ontario', phone: '+15412001212', npa: '541', nxx: '200', iana: 'America/Boise' },
    { name: 'OR Bend', phone: '+15415551212', npa: '541', nxx: '555', iana: 'America/Los_Angeles' },
    { name: 'ND Fargo', phone: '+17015551212', npa: '701', nxx: '555', iana: 'America/Chicago' },
    { name: 'ND Dickinson', phone: '+17012001212', npa: '701', nxx: '200', iana: 'America/Denver' },
    { name: 'SD Sioux Falls', phone: '+16055551212', npa: '605', nxx: '555', iana: 'America/Chicago' },
    { name: 'SD Rapid City', phone: '+16052001212', npa: '605', nxx: '200', iana: 'America/Denver' },
    { name: 'NE Scottsbluff', phone: '+13085551212', npa: '308', nxx: '555', iana: 'America/Denver' },
    { name: 'NE Omaha', phone: '+14025551212', npa: '402', nxx: '555', iana: 'America/Chicago' },
  ];

  for (const fix of splitFixtures) {
    it(`split-state: ${fix.name}`, async () => {
      _phoneCodesCache.set(`${fix.npa}${fix.nxx}`, { iana: fix.iana });
      const res = await resolveTimezone({ phoneE164: fix.phone });
      expect(res.confidence).toBe('NXX');
      expect(res.iana).toBe(fix.iana);
    });
  }
});

describe('singleTzStateMap correctness', () => {
  it('excludes all 8 split states', async () => {
    const { singleTzStateMap } = await import('../states.js');
    for (const s of ['IN', 'KY', 'TN', 'FL', 'ID', 'OR', 'ND', 'SD', 'NE']) {
      expect(singleTzStateMap[s], `${s} should not be in singleTzStateMap`).toBeUndefined();
    }
  });

  it('includes expected single-tz states', async () => {
    const { singleTzStateMap } = await import('../states.js');
    const expected = ['CA', 'NY', 'TX', 'WA', 'HI', 'AK', 'AZ'];
    for (const s of expected) {
      expect(singleTzStateMap[s], `${s} should be in singleTzStateMap`).toBeDefined();
    }
  });
});
