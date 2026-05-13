# Module S04 — Supervisor Wallboard (TV Dashboard) — PLAN

| Field | Value |
|---|---|
| Track | Supervisor |
| Phase | 3 |
| Status | PLAN |
| Author | S04-IMPLEMENT agent (Claude Sonnet 4.6) |
| Date | 2026-05-13 |
| Depends on | S01 (dashboard store + components), E05 (drop gauges), I01 (queue stats), M02 (RBAC) |

---

## 0. TL;DR

S04 ships `/sup/wallboard` — a read-only, full-screen, large-format live dashboard
for call-floor TV screens. It reuses S01's Zustand store and sup components, adds
a rotation engine for multiple "boards", and layers in TV-friendly CSS: 24pt+
baseline font, high-contrast, rem-based sizing, print-mode styles.

Phase 1 ships a fixed-layout 1080p/4K-friendly UI. Phase 2 adds a layout
customizer and a signed-token unauthenticated TV display path.

---

## 1. Route

```
web/src/app/(sup)/wallboard/page.tsx   ← server shell + RBAC check (no shell chrome)
web/src/app/(sup)/wallboard/layout.tsx ← blank wrapper (no nav/sidebar)
```

The route lives inside the `(sup)` route group but uses its own blank layout so
the wallboard is chrome-free. The `(sup)/layout.tsx` shell does NOT apply.

---

## 2. Built-in boards (Phase 1)

Four built-in boards rotate on a configurable interval (default 30 s):

| Board ID | Title | What it shows |
|---|---|---|
| `agents` | Agents on Calls | Full-screen agent grid; big state badges; call timers; high-contrast |
| `campaigns` | Campaign Performance | Drop rates, dial level, contacts/hour per campaign (top N) |
| `queue` | Inbound Queue | Per in_group: callers waiting, longest wait, EWT |
| `performers` | Top Performers | Top 5 agents by sales (stub — calls GET /api/sup/agents sorted by metric) |

---

## 3. Wallboard features

### 3.1 Full-screen + Wake Lock
- `useFullscreen` hook: click-to-enter Fullscreen API; F key shortcut.
- `useWakeLock` hook: `navigator.wakeLock.request("screen")` on mount; re-request
  on `visibilitychange` (tab re-focus). Graceful no-op on unsupported browsers.

### 3.2 Board rotation
- `useWallboardRotation(boards, rotateMs)` hook.
- `boards` array = IDs of enabled boards in display order.
- `rotateMs` defaults to 30 000 ms; configurable via URL param `?rotate=N`.
- Renders a dot-progress indicator at the bottom edge; no click navigation
  (TV remote / passive display — mouse is optional).
- Pauses rotation on hover (`onMouseEnter` / `onMouseLeave`).

### 3.3 Data source
- Subscribes to the same WS events as S01 (uses shared `useDashboardStore`).
- 10-second polling fallback via shared `DashboardClient` fetch logic.

### 3.4 Large-format CSS
- Root font-size override: `text-[1.75rem]` (28px) on the wallboard shell.
- All internal sizing uses `em` / `rem` so scaling is automatic.
- Tailwind utility classes sized up by a constant factor via wallboard-specific
  class names (e.g., `wb-agent-tile`, `wb-kpi-value`).
- High-contrast theme: dark background (`#0a0d14`), white text, vivid state colors.
- CSS `@media print` rules collapse to a single-column snapshot for shift wrap-up.

### 3.5 Inbound Queue board stub
- Reads from `useDashboardStore` (same data pipeline).
- Phase 1: shows same campaign queue depth data already in store
  (`queueDepth`, `agentsReady`, `agentsWaiting` per campaign).
- Full I01 per-in-group queue data wiring deferred to Phase 2 (depends on I01
  queue stats endpoint not yet shipped).

### 3.6 Top Performers board stub
- Phase 1: shows top 5 agents sorted by `callDurationSec` descending (proxy for
  productivity until sales tracking ships).
- Label: "Top Performers — by call time today (stub)".

---

## 4. Layout config table

New Prisma model added to schema.prisma:

```prisma
model WallboardLayout {
  id            BigInt   @id @default(autoincrement())
  tenantId      BigInt   @default(1)   @map("tenant_id")
  name          String   @db.VarChar(128)
  boards        Json                             // string[] of board IDs
  rotateSeconds Int      @default(30)  @map("rotate_seconds")
  active        Boolean  @default(true)

  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt     DateTime @updatedAt      @map("updated_at") @db.DateTime(6)

  tenant  Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "fk_wallboard_tenant")

  @@index([tenantId, active], map: "idx_wallboard_tenant_active")
  @@map("wallboard_layouts")
}
```

---

## 5. API endpoints

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| `GET` | `/api/sup/wallboard/layouts` | `wallboard:view` | List active layouts for tenant |
| `POST` | `/api/sup/wallboard/layouts` | `wallboard:manage` (admin+) | Create/update layout |

Both are thin CRUD wrappers. Phase 1 returns a single default layout if none exist.

---

## 6. RBAC

- Permission: `wallboard:view` — granted to `supervisor` and `admin` roles.
- Permission: `wallboard:manage` — granted to `admin` and `super_admin` only.
- Server component `page.tsx` checks role ≥ supervisor; redirects to `/unauthorized`.
- Same pattern as S01 `dashboard/page.tsx`.

---

## 7. Files to create

```
spec/modules/S04/PLAN.md                              ← this file
web/src/app/(sup)/wallboard/layout.tsx                ← blank full-screen layout
web/src/app/(sup)/wallboard/page.tsx                  ← server shell + RBAC
web/src/components/sup/wallboard/WallboardClient.tsx  ← top-level client island
web/src/components/sup/wallboard/BoardAgents.tsx      ← "Agents on Calls" board
web/src/components/sup/wallboard/BoardCampaigns.tsx   ← "Campaign Performance" board
web/src/components/sup/wallboard/BoardQueue.tsx       ← "Inbound Queue" board
web/src/components/sup/wallboard/BoardPerformers.tsx  ← "Top Performers" board
web/src/components/sup/wallboard/RotationDots.tsx     ← rotation progress indicator
web/src/components/sup/wallboard/WallboardHeader.tsx  ← clock + fullscreen button
web/src/hooks/useWakeLock.ts                          ← Wake Lock API hook
web/src/hooks/useFullscreen.ts                        ← Fullscreen API hook
web/src/hooks/useWallboardRotation.ts                 ← board rotation hook
web/src/lib/stores/wallboard.ts                       ← Zustand config store
api/src/routes/supervisor/wallboard.layouts.ts        ← GET+POST /api/sup/wallboard/layouts
web/src/test/unit/sup.wallboard.WallboardClient.test.tsx ← rotation + render tests
web/src/test/unit/sup.wallboard.BoardAgents.test.tsx  ← agent board tests
```

---

## 8. URL parameters

| Param | Default | Effect |
|---|---|---|
| `rotate` | `30` | Rotation interval in seconds |
| `boards` | all | Comma-separated board IDs to show |
| `theme` | `dark` | `dark` or `light` |

Example: `/sup/wallboard?rotate=20&boards=agents,campaigns&theme=dark`

---

## 9. Print mode CSS

`@media print` rules (in `wallboard.css` imported by WallboardClient):
- Hide rotation dots, header buttons, fullscreen toggle.
- Show all boards stacked vertically.
- Print date/time stamp at top.
- B&W safe: state colors expressed as border patterns, not fills.

---

## 10. Acceptance criteria

- Wallboard route renders without nav chrome (no sidebar, no top bar).
- Full-screen API triggered on click or F key.
- Boards rotate every N seconds with visible dot indicator.
- Agent board uses wallboard-sized tiles (28px+ base font).
- Campaign board shows drop gauge with correct threshold colors.
- Queue board shows per-campaign queue depth, agents ready/waiting.
- Performers board shows top-5 agents by call time.
- WS events update all boards without full reload.
- Print stylesheet produces readable snapshot.
- `pnpm test` passes (WallboardClient rotation tests + BoardAgents render tests).
- `pnpm typecheck` and `pnpm lint` clean.
- `pnpm build` succeeds; wallboard route included.

---

## 11. Phase 2 backlog (not in scope)

- Layout customizer UI (drag-and-drop board ordering).
- Signed-token unauthenticated display path for TV screens without browser login.
- Per-in-group queue board (depends on I01 queue stats endpoint).
- Custom board: "Leaderboard" with real sales count from A-track disposition data.
- Layout CRUD in admin UI (M01/M03).
