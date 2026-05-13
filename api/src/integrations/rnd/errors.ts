/**
 * api/src/integrations/rnd/errors.ts
 *
 * N06 — RND client error hierarchy.
 */

export class RndError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = this.constructor.name;
  }
}

export class RndAuthError extends RndError {}

export class RndRateLimitError extends RndError {
  constructor(
    msg: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(msg);
  }
}

export class RndQuotaError extends RndError {}

export class RndOutageError extends RndError {}

export class RndApiError extends RndError {
  constructor(
    msg: string,
    public readonly statusCode?: number,
  ) {
    super(msg);
  }
}

export class RndCredentialInvalidError extends RndError {}
