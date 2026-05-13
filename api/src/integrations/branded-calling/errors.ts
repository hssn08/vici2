// N05 — Branded Calling provider error type.

import type { ProviderKind } from './types.js';

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderKind,
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly body?: string,
  ) {
    super(`[${provider}] ${code} (HTTP ${httpStatus})`);
    this.name = 'ProviderError';
  }
}
