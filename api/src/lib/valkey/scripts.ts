// F04 PLAN §6.7 + §7.1 — Lua script registry. Loads scripts at boot via
// SCRIPT LOAD, calls via EVALSHA, transparent NOSCRIPT reload.
//
// Scripts ship from `shared/lua/`. We read them from disk relative to
// the package, then SCRIPT LOAD against the connected Valkey instance.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Redis } from "ioredis";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ScriptName =
  | "claim_lead_from_hopper.v1"
  | "release_hopper_lock.v1"
  | "record_call_outcome.v1"
  | "pick_agent_for_call.v1"
  | "agent_state_transition.v1"
  | "originate_acquire.v1"
  | "originate_release.v1"
  | "dnc_bloom_check.v1"
  | "refresh_consume.v1";

export const ALL_SCRIPTS: ReadonlyArray<ScriptName> = [
  "claim_lead_from_hopper.v1",
  "release_hopper_lock.v1",
  "record_call_outcome.v1",
  "pick_agent_for_call.v1",
  "agent_state_transition.v1",
  "originate_acquire.v1",
  "originate_release.v1",
  "dnc_bloom_check.v1",
  "refresh_consume.v1",
];

export class ScriptRegistry {
  private readonly source = new Map<ScriptName, string>();
  private readonly sha = new Map<ScriptName, string>();
  private luaDir: string;

  /**
   * @param luaDir Optional override for the directory that holds the
   *   `*.v1.lua` files. Defaults to the bundled copy under
   *   `<this package>/lua/`. Tests can override to point at
   *   `shared/lua/` directly.
   */
  constructor(luaDir?: string) {
    this.luaDir = luaDir ?? join(__dirname, "lua");
  }

  /** Read every `<name>.lua` into memory. Idempotent. */
  async loadSources(): Promise<void> {
    for (const name of ALL_SCRIPTS) {
      if (this.source.has(name)) continue;
      const path = join(this.luaDir, `${name}.lua`);
      const body = await readFile(path, "utf8");
      this.source.set(name, body);
    }
  }

  /** SCRIPT LOAD every script against `client`; cache the SHA1s. */
  async loadAll(client: Redis): Promise<void> {
    await this.loadSources();
    for (const [name, body] of this.source) {
      const sha = await client.script("LOAD", body);
      this.sha.set(name, sha as string);
    }
  }

  /** @returns SHA1 for the named script, or empty string if unknown. */
  shaFor(name: ScriptName): string {
    return this.sha.get(name) ?? "";
  }

  /** @returns raw Lua source for the named script. */
  sourceFor(name: ScriptName): string {
    return this.source.get(name) ?? "";
  }

  /**
   * Run the named script via EVALSHA. On NOSCRIPT (server cache wiped)
   * silently reload and retry once. Returns whatever ioredis decodes;
   * caller does type assertion.
   */
  async eval(
    client: Redis,
    name: ScriptName,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> {
    let sha = this.shaFor(name);
    if (!sha) {
      await this.loadAll(client);
      sha = this.shaFor(name);
      if (!sha) throw new Error(`valkey: script ${name} not loaded`);
    }
    try {
      return await client.evalsha(sha, keys.length, ...keys, ...args.map(String));
    } catch (err) {
      if (isNoScript(err)) {
        await this.loadAll(client);
        sha = this.shaFor(name);
        return await client.evalsha(sha, keys.length, ...keys, ...args.map(String));
      }
      throw err;
    }
  }
}

function isNoScript(err: unknown): boolean {
  return (
    err instanceof Error &&
    typeof err.message === "string" &&
    err.message.startsWith("NOSCRIPT")
  );
}
