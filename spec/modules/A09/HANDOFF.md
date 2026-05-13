# A09 — Pause Codes UI: HANDOFF

**Module:** A09 (Agent UI track, Phase 1)
**Date:** 2026-05-13
**Status:** STUB — to be updated after implementation

---

## Public Component API

### `<PauseButton />`

Location: `web/src/components/call/PauseButton.tsx`

```ts
interface PauseButtonProps {
  disabled?: boolean;
  size?: "sm" | "md";
}
```

Reads mode from `useAgentState()` internally. Renders as a one-click toggle (OFF mode) or opens `PauseCodeMenu` (OPTIONAL/FORCE). Registers `Ctrl+P` in `agent-shell` hotkey scope.

### `<PauseCodeMenu />`

Location: `web/src/components/call/PauseCodeMenu.tsx`

```ts
interface PauseCodeMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "OPTIONAL" | "FORCE";
  codes: PauseCodeOption[];
  loading: boolean;
  error: string | null;
  lastUsedCode: string | null;
  onSelect: (code: string | null, freeText?: string | null) => void;
  onCancel: () => void;
}
```

Dialog-based code picker. FORCE mode disables skip and free-text. Shows error when no codes are configured in FORCE mode.

### `useAgentState()`

Location: `web/src/lib/agent/useAgentState.ts`

Returns `{ status, pauseCode, pausedSince, currentCampaignId, pauseConfig, transitioning, pause(), unpause(), refreshPauseConfig() }`.

`pause(code, freeText?)` throws `PauseValidationError` in FORCE mode if `code` is null or invalid.

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/agent/pause-codes` | agent | Returns `{ pauseCodesRequired, codes[] }` for agent's current campaign |
| POST | `/api/agent/state` | agent | Transitions agent state; validates FORCE mode; writes `agent_log` |

---

## Key Integration Notes

- **Pause code admin** lives in M07 (`web/app/(admin)/pause-codes/page.tsx`). Changes in M07 are reflected immediately via the `GET /api/agent/pause-codes` fetch (60s cache).
- **PauseAfterCallToggle (A06)**: In FORCE mode, auto-dial must NOT silently pause without a code. The auto-dial router must catch `PauseValidationError` from `useAgentState.pause()` and open `PauseCodeMenu` before proceeding.
- **WS event `agent.state`**: All state changes are confirmed via WS. The `patchFromEvent` handler in `useAgentStore` is the authoritative update path. Optimistic updates in the store are overwritten by the server-confirmed payload.
- **`agent_log` entries**: Every pause/unpause creates an `agent_log` row. See `api/src/routes/agent/pause.ts` for INSERT logic.
- **Valkey key**: Agent state is cached in `t:{tenantId}:agent:{uid}:state` (JSON). `handleSetAgentState` must update this after writing to the DB.

---

## Acceptance Criteria Summary

All 15 ACs defined in PLAN.md §14. Key ones:
- AC-5: FORCE rejects without code
- AC-7: FORCE + no codes → error message, pause disabled
- AC-10: Ctrl+P in F1 overlay
- AC-15: PauseAfterCallToggle + FORCE → prompt for code
