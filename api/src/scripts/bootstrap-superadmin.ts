/* eslint-disable no-console */
// Bootstrap the initial super_admin user (PLAN §13).
// Idempotent: re-runs return 0 with "already_bootstrapped".

import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../auth/argon2.js";
import { audit } from "../auth/audit.js";
import {
  encryptSipPassword,
  generateSipPassword,
  generateSipUsername,
} from "../auth/sip-creds.js";
import { env } from "../lib/env.js";

async function main(): Promise<void> {
  if (!env.bootstrapSuperadminEmail || !env.bootstrapSuperadminPassword) {
    console.error(
      "BOOTSTRAP_SUPERADMIN_EMAIL and BOOTSTRAP_SUPERADMIN_PASSWORD must be set",
    );
    process.exit(2);
  }
  const tenantId = BigInt(env.bootstrapSuperadminTenantId);
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findFirst({
      where: { tenantId, role: "superadmin" },
    });
    if (existing) {
      console.log(`already_bootstrapped user_id=${existing.id.toString()}`);
      return;
    }
    const passwordHash = await hashPassword(env.bootstrapSuperadminPassword);
    const username = "superadmin";
    const user = await prisma.user.create({
      data: {
        tenantId,
        username,
        email: env.bootstrapSuperadminEmail,
        passwordHash,
        role: "superadmin",
        active: true,
      },
    });
    const sipPassword = generateSipPassword(32);
    const sipUsername = generateSipUsername(Number(user.id));
    const cred = await prisma.sipCredential.create({
      data: {
        tenantId,
        userId: user.id,
        sipUsername,
        sipPasswordCt: Buffer.from(""),
        kekVersion: 1,
      },
    });
    const enc = encryptSipPassword(sipPassword, {
      rowId: cred.id,
      tenantId,
    });
    await prisma.sipCredential.update({
      where: { id: cred.id },
      data: {
        sipPasswordCt: Buffer.from(enc.ciphertextBlob),
        kekVersion: enc.kekVersion,
        lastRotatedAt: new Date(),
      },
    });
    await audit({
      tx: prisma,
      actorUserId: null,
      actorKind: "system",
      action: "auth.user.created",
      tenantId: Number(tenantId),
      entityType: "user",
      entityId: String(user.id),
      afterJson: { role: "superadmin", bootstrap: true },
    });
    console.log(`bootstrap_ok user_id=${user.id.toString()}`);
    console.log("remember_to_unset BOOTSTRAP_SUPERADMIN_PASSWORD");
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error("bootstrap failed", err);
  process.exit(1);
});
