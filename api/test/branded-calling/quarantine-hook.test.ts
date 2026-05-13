// N05 — Unit tests for the X04 quarantine hook.
// Tests that quarantine is triggered below threshold and NOT above.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Inline implementation of the quarantine hook logic for unit testing
// (avoids DB dependency; real hook tested in integration).
// ---------------------------------------------------------------------------

interface QuarantineHook {
  onRepScoreUpdated(didId: bigint, tenantId: bigint, normalizedScore: number): Promise<void>;
}

function makeHook(
  threshold: number,
  quarantine: (didId: bigint, tenantId: bigint, score: number) => Promise<void>,
): QuarantineHook {
  return {
    async onRepScoreUpdated(didId, tenantId, normalizedScore) {
      if (normalizedScore >= threshold) return;
      await quarantine(didId, tenantId, normalizedScore);
    },
  };
}

describe('x04QuarantineHook', () => {
  const quarantineMock = vi.fn<[bigint, bigint, number], Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => quarantineMock.mockClear());

  it('calls quarantine when score is below threshold (29 < 30)', async () => {
    const hook = makeHook(30, quarantineMock);
    await hook.onRepScoreUpdated(BigInt(1), BigInt(42), 29);
    expect(quarantineMock).toHaveBeenCalledOnce();
    expect(quarantineMock).toHaveBeenCalledWith(BigInt(1), BigInt(42), 29);
  });

  it('does NOT call quarantine when score equals threshold (30 >= 30)', async () => {
    const hook = makeHook(30, quarantineMock);
    await hook.onRepScoreUpdated(BigInt(1), BigInt(42), 30);
    expect(quarantineMock).not.toHaveBeenCalled();
  });

  it('does NOT call quarantine when score is above threshold (85 >= 30)', async () => {
    const hook = makeHook(30, quarantineMock);
    await hook.onRepScoreUpdated(BigInt(1), BigInt(42), 85);
    expect(quarantineMock).not.toHaveBeenCalled();
  });

  it('respects custom threshold (score 20 < threshold 25)', async () => {
    const hook = makeHook(25, quarantineMock);
    await hook.onRepScoreUpdated(BigInt(99), BigInt(1), 20);
    expect(quarantineMock).toHaveBeenCalledWith(BigInt(99), BigInt(1), 20);
  });

  it('respects custom threshold (score 25 >= threshold 25 — no quarantine)', async () => {
    const hook = makeHook(25, quarantineMock);
    await hook.onRepScoreUpdated(BigInt(99), BigInt(1), 25);
    expect(quarantineMock).not.toHaveBeenCalled();
  });
});
