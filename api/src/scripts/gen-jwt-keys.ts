/* eslint-disable no-console */
// scripts/gen-jwt-keys: generate an Ed25519 JWK pair and print base64 envs.
//
// Usage:  pnpm exec tsx api/src/scripts/gen-jwt-keys.ts [kid]

import { exportJWK, generateKeyPair } from "jose";

const kid = process.argv[2] ?? `ed25519-${new Date().getFullYear()}-1`;

async function main(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const privJwk = { ...(await exportJWK(privateKey)), kid, alg: "EdDSA", use: "sig" };
  const pubJwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" };
  const privB64 = Buffer.from(JSON.stringify(privJwk)).toString("base64");
  const jwksB64 = Buffer.from(JSON.stringify({ keys: [pubJwk] })).toString("base64");
  console.log("VICI2_JWT_ALG=EdDSA");
  console.log(`VICI2_JWT_PRIVATE_KEY_JWK=${privB64}`);
  console.log(`VICI2_JWT_PUBLIC_KEYS_JWKS=${jwksB64}`);
  console.log(`# kid=${kid}`);
}

void main();
