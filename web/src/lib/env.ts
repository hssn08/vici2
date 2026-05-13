import { z } from "zod";

// Public env is read at module load. Misconfigured env crashes early.
const PublicEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_WS_URL: z.string().optional(),
  NEXT_PUBLIC_FS_WSS: z.string().optional(),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

const raw = {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  NEXT_PUBLIC_FS_WSS: process.env.NEXT_PUBLIC_FS_WSS,
};

const parsed = PublicEnvSchema.safeParse(raw);

if (!parsed.success) {
  console.error("[env] invalid public env:", parsed.error.flatten());
  throw new Error("Invalid public environment configuration");
}

export const env: PublicEnv = parsed.data;

/**
 * Derive the WebSocket URL from the API URL unless one is explicitly set.
 * `http://...` → `ws://...`, `https://...` → `wss://...`.
 */
export function getWsUrl(): string {
  if (env.NEXT_PUBLIC_WS_URL) return env.NEXT_PUBLIC_WS_URL;
  const api = new URL(env.NEXT_PUBLIC_API_URL);
  const proto = api.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${api.host}/ws`;
}
