// Prisma client singleton.

import { PrismaClient } from "@prisma/client";

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}

export function setPrismaForTests(client: PrismaClient | null): void {
  _prisma = client;
}

export async function closePrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}
