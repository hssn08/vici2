// N01 — Notification service.
// Single write path for all notification producers.
//
// Idempotency: each notify() call is independent; callers may deduplicate
// upstream via Valkey SET NX (e.g. D06 uses t:{tid}:d06:upcoming_seen:{id}).

import pino from "pino";
import client from "prom-client";
import type { PrismaClient } from "@prisma/client";

import {
  ALL_CATEGORIES,
  CATEGORY_DEFAULTS,
  type NotifCategory,
  type NotifChannel,
  type NotifSeverity,
} from "./categories.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "n01" },
});

// ---------------------------------------------------------------------------
// Prometheus counters
// ---------------------------------------------------------------------------
const notifyTotal = new client.Counter({
  name: "vici2_n01_notify_total",
  help: "Total notifications created by channel and category",
  labelNames: ["category", "channel"] as const,
});
const wsPushTotal = new client.Counter({
  name: "vici2_n01_ws_push_total",
  help: "Total WebSocket push attempts",
  labelNames: ["category"] as const,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotifyParams {
  tenantId: number | bigint;
  userId: number | bigint;
  category: NotifCategory;
  subject: string;
  body: string;
  link?: string;
  severity?: NotifSeverity;
  channels?: NotifChannel[]; // override category defaults
}

export interface NotificationDto {
  id: string;
  tenantId: string;
  userId: string;
  channel: NotifChannel;
  category: string;
  subject: string;
  body: string;
  severity: NotifSeverity;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Channel resolver
// ---------------------------------------------------------------------------

export async function resolveChannels(
  prisma: PrismaClient,
  userId: number | bigint,
  tenantId: number | bigint,
  category: NotifCategory,
  override?: NotifChannel[],
): Promise<NotifChannel[]> {
  if (override && override.length > 0) return override;

  const pref = await prisma.notificationPref.findUnique({
    where: {
      // Prisma-generated compound key name from @@unique([tenantId, userId, category])
      tenantId_userId_category: {
        tenantId: BigInt(tenantId),
        userId: BigInt(userId),
        category,
      },
    },
  });

  if (pref) {
    const channels = pref.channels as NotifChannel[];
    return channels;
  }

  return CATEGORY_DEFAULTS[category].defaultChannels;
}

// ---------------------------------------------------------------------------
// notify() — the single write path
// ---------------------------------------------------------------------------

export async function notify(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emailQueue: any | null,
  params: NotifyParams,
): Promise<void> {
  const { tenantId, userId, category, subject, body, link, severity, channels: channelsOverride } = params;

  const resolvedSeverity = severity ?? CATEGORY_DEFAULTS[category].severity;

  let channels: NotifChannel[];
  try {
    channels = await resolveChannels(prisma, userId, tenantId, category, channelsOverride);
  } catch (err) {
    logger.error({ err, category, userId: String(userId) }, "n01: failed to resolve channels; using defaults");
    channels = CATEGORY_DEFAULTS[category].defaultChannels;
  }

  for (const channel of channels) {
    try {
      const notif = await prisma.notification.create({
        data: {
          tenantId: BigInt(tenantId),
          userId: BigInt(userId),
          channel,
          category,
          subject,
          body,
          severity: resolvedSeverity,
          link: link ?? null,
        },
      });

      notifyTotal.inc({ category, channel });

      if (channel === "in_app") {
        await pushWs(redis, tenantId, userId, {
          id: String(notif.id),
          tenantId: String(notif.tenantId),
          userId: String(notif.userId),
          channel: notif.channel as NotifChannel,
          category: notif.category,
          subject: notif.subject,
          body: notif.body,
          severity: notif.severity as NotifSeverity,
          link: notif.link ?? null,
          readAt: null,
          createdAt: notif.createdAt.toISOString(),
        });
        wsPushTotal.inc({ category });
      }

      if (channel === "email" && emailQueue !== null) {
        await enqueueEmail(emailQueue, prisma, BigInt(userId), BigInt(tenantId), notif.id, subject, body);
      }
    } catch (err) {
      logger.error({ err, channel, category, userId: String(userId) }, "n01: failed to create notification row");
    }
  }
}

// ---------------------------------------------------------------------------
// WS push helper
// ---------------------------------------------------------------------------

async function pushWs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  tenantId: number | bigint,
  userId: number | bigint,
  notification: NotificationDto,
): Promise<void> {
  const channel = `t:${tenantId}:ws:user:${userId}`;
  const payload = JSON.stringify({ type: "notifications.new", notification });
  try {
    await redis.publish(channel, payload);
  } catch (err) {
    logger.error({ err, channel }, "n01: WS publish failed");
  }
}

// ---------------------------------------------------------------------------
// BullMQ email enqueue helper
// ---------------------------------------------------------------------------

async function enqueueEmail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emailQueue: any,
  prisma: PrismaClient,
  userId: bigint,
  tenantId: bigint,
  notificationId: bigint,
  subject: string,
  body: string,
): Promise<void> {
  // Fetch user email
  let toEmail: string | null = null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    toEmail = user?.email ?? null;
  } catch (err) {
    logger.error({ err, userId: String(userId) }, "n01: failed to fetch user email");
    return;
  }

  if (!toEmail) {
    logger.warn({ userId: String(userId), notificationId: String(notificationId) }, "n01: user has no email; skipping email delivery");
    return;
  }

  try {
    await emailQueue.add(
      "email-delivery",
      {
        notificationId: String(notificationId),
        tenantId: String(tenantId),
        userId: String(userId),
        to: toEmail,
        subject,
        body,
      },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  } catch (err) {
    logger.error({ err, notificationId: String(notificationId) }, "n01: failed to enqueue email job");
  }
}

// ---------------------------------------------------------------------------
// Prefs helpers
// ---------------------------------------------------------------------------

export interface PrefEntry {
  category: NotifCategory;
  channels: NotifChannel[];
  isDefault: boolean;
}

export async function getUserPrefs(
  prisma: PrismaClient,
  userId: bigint,
  tenantId: bigint,
): Promise<PrefEntry[]> {
  const rows = await prisma.notificationPref.findMany({
    where: { userId, tenantId },
    select: { category: true, channels: true },
  });

  const overrideMap = new Map<string, NotifChannel[]>();
  for (const row of rows) {
    overrideMap.set(row.category, row.channels as NotifChannel[]);
  }

  return ALL_CATEGORIES.map((cat) => {
    const override = overrideMap.get(cat);
    if (override) {
      return { category: cat, channels: override, isDefault: false };
    }
    return { category: cat, channels: CATEGORY_DEFAULTS[cat].defaultChannels, isDefault: true };
  });
}

export async function upsertUserPref(
  prisma: PrismaClient,
  userId: bigint,
  tenantId: bigint,
  category: NotifCategory,
  channels: NotifChannel[],
): Promise<void> {
  await prisma.notificationPref.upsert({
    where: {
      tenantId_userId_category: { tenantId, userId, category },
    },
    create: { tenantId, userId, category, channels },
    update: { channels },
  });
}

// ---------------------------------------------------------------------------
// Retention cleanup
// ---------------------------------------------------------------------------

export async function cleanupOldNotifications(prisma: PrismaClient): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Delete read notifications older than 7 days
  const readResult = await prisma.$executeRaw`
    DELETE FROM notifications
    WHERE read_at IS NOT NULL AND created_at < ${sevenDaysAgo}
    LIMIT 1000
  `;

  // Delete unread notifications older than 30 days
  const unreadResult = await prisma.$executeRaw`
    DELETE FROM notifications
    WHERE read_at IS NULL AND created_at < ${thirtyDaysAgo}
    LIMIT 1000
  `;

  return Number(readResult) + Number(unreadResult);
}
