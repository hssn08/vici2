"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDialStore } from "@/lib/stores/dial";
import { useAgentStore } from "@/lib/stores/agent";
import { useAuthStore } from "@/lib/stores/auth";
import { api } from "@/lib/api";
import { ManualDialModal } from "./ManualDialModal";
import { LeadPreviewCard } from "./LeadPreviewCard";
import { DialButton } from "./DialButton";
import { CallingBadge } from "./CallingBadge";
import { BlockedScreen } from "./BlockedScreen";
import type { CallHistory, ComplianceWindow, DncResult } from "./types";
import type { LeadPreview } from "@/lib/stores/dial";

// ── BroadcastChannel multi-tab guard ─────────────────────────────────────────

const DIAL_CHANNEL = "vici2-agent-dial";

function useBroadcastGuard(attemptUuid: string | null) {
  const setBlock = useDialStore((s) => s.setBlock);

  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(DIAL_CHANNEL);
    bc.onmessage = (e: MessageEvent<{ event: string; attempt_uuid?: string }>) => {
      if (e.data.event === "dial-started" && e.data.attempt_uuid !== attemptUuid) {
        setBlock({
          code: "AGENT_DIAL_LOCK",
          message: "Another tab started a dial. Switch to it.",
        });
      }
    };
    return () => bc.close();
  }, [attemptUuid, setBlock]);

  function broadcastDialStarted(uuid: string) {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(DIAL_CHANNEL);
    bc.postMessage({ event: "dial-started", attempt_uuid: uuid });
    bc.close();
  }

  return { broadcastDialStarted };
}

// ── Parallel data fetch for the lead preview card ─────────────────────────────

interface LeadCardData {
  lead: LeadPreview | null;
  compliance: ComplianceWindow | null;
  dnc: DncResult | null;
  history: CallHistory[] | null;
  scriptSnippet: string | null;
}

async function fetchLeadCardData(
  lead: LeadPreview,
  campaignId: number | null,
): Promise<LeadCardData> {
  const [complianceResult, dncResult, historyResult, scriptResult] =
    await Promise.allSettled([
      campaignId
        ? api.get<ComplianceWindow>(
            `/api/compliance/window?phone=${encodeURIComponent(lead.phoneE164)}&campaign_id=${campaignId}`,
          )
        : Promise.resolve(null as ComplianceWindow | null),
      api.get<{ hit: boolean; sources: string[] }>(
        `/api/dnc/check?phone=${encodeURIComponent(lead.phoneE164)}${campaignId ? `&campaign_id=${campaignId}` : ""}`,
      ),
      api.get<CallHistory[]>(`/api/leads/${lead.id}/history?limit=10`),
      campaignId
        ? api.get<{ snippet: string }>(`/api/campaigns/${campaignId}/script`)
        : Promise.resolve(null),
    ]);

  return {
    lead,
    compliance:
      complianceResult.status === "fulfilled" ? complianceResult.value : null,
    dnc:
      dncResult.status === "fulfilled"
        ? { hit: dncResult.value.hit, sources: dncResult.value.sources }
        : null,
    history:
      historyResult.status === "fulfilled" ? historyResult.value : null,
    scriptSnippet:
      scriptResult?.status === "fulfilled" && scriptResult.value
        ? (scriptResult.value as { snippet: string }).snippet
        : null,
  };
}

// ── DialShell ─────────────────────────────────────────────────────────────────

export interface DialShellProps {
  initialMode?: "manual" | "next" | "preview";
}

export function DialShell({
  initialMode = "manual",
}: DialShellProps): React.ReactElement {
  const router = useRouter();

  // Store slices
  const dialPhase = useDialStore((s) => s.dialPhase);
  const dialMode = useDialStore((s) => s.dialMode);
  const clientGates = useDialStore((s) => s.clientGates);
  const hopperClaimToken = useDialStore((s) => s.hopperClaimToken);
  const consentAttested = useDialStore((s) => s.consentAttested);
  const agentStatus = useAgentStore((s) => s.status);
  const currentCampaignId = useAgentStore((s) => s.currentCampaignId);
  const user = useAuthStore((s) => s.user);

  const {
    openModal,
    closeModal,
    setLoadingLead,
    setLead,
    startCallRequested,
    setAttemptUuid,
    setBlock,
    clearBlock,
    setHopperClaimToken,
    setClientGates,
    resetDial,
    restoreFromServer,
  } = useDialStore.getState();

  // Lead card async data
  const [cardData, setCardData] = React.useState<LeadCardData | null>(null);
  const [cardLoading, setCardLoading] = React.useState(false);
  const [cancelLoading, setCancelLoading] = React.useState(false);

  // Derive attemptUuid from calling state
  const callingAttemptUuid =
    dialPhase.state === "calling" ? dialPhase.attemptUuid : null;

  const { broadcastDialStarted } = useBroadcastGuard(callingAttemptUuid);

  // ── On mount: restore from server ──────────────────────────────────────────
  React.useEffect(() => {
    if (dialPhase.state !== "idle") return;
    api
      .get<{
        attempt_uuid: string;
        phase: string;
        lead: LeadPreview;
        started_at: string;
      }>("/api/agent/current_call")
      .then((data) => {
        if (data.phase === "active") {
          router.replace("/call");
          return;
        }
        restoreFromServer(data);
      })
      .catch(() => {
        // 404 NO_CALL → stay idle; any error is safe to ignore
      });
  }, []); // intentionally empty: only on mount

  // ── Sync agentReady gate ───────────────────────────────────────────────────
  React.useEffect(() => {
    setClientGates({ agentReady: agentStatus === "ready" });
  }, [agentStatus, setClientGates]);

  // ── Preview mode: auto-fetch on mount/return ───────────────────────────────
  React.useEffect(() => {
    if (dialPhase.state === "idle" && initialMode === "preview") {
      handleLoadNextLead();
    }
  }, []); // intentionally empty: only on mount

  // ── When lead is selected: fetch card data in parallel ────────────────────
  React.useEffect(() => {
    const lead =
      dialPhase.state === "lead_selected" ||
      dialPhase.state === "call_requested" ||
      dialPhase.state === "calling"
        ? dialPhase.lead
        : null;
    if (!lead) {
      setCardData(null);
      return;
    }
    setCardLoading(true);
    fetchLeadCardData(lead, currentCampaignId).then((data) => {
      setCardData(data);
      setCardLoading(false);
      // Update client gates from compliance/DNC results
      setClientGates({
        tcpaHint: data.compliance?.hint ?? "unknown",
        dncHint: data.dnc?.hit ? "hit" : data.dnc ? "clear" : "unknown",
        phoneValid: true, // already validated before setting lead
        campaignActive: currentCampaignId !== null,
      });
    });
  }, [
    dialPhase.state === "lead_selected" ? dialPhase.lead?.id : null,
    currentCampaignId,
    setClientGates,
  ]);

  // ── WebSocket subscriptions ────────────────────────────────────────────────
  // Handled by parent (DialShellWsSubscriber) to keep this component pure.

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleLoadNextLead() {
    setLoadingLead();
    const controller = new AbortController();
    try {
      const qs = currentCampaignId
        ? `?campaign_id=${currentCampaignId}`
        : "";
      const data = await api.get<{
        lead: LeadPreview;
        claim_token: string;
      }>(`/api/agent/next_lead${qs}`);
      setLead(data.lead, "next");
      setHopperClaimToken(data.claim_token ?? null);
      setClientGates({ phoneValid: true, campaignActive: currentCampaignId !== null });
    } catch (err: unknown) {
      resetDial();
      const code = (err as { code?: string }).code;
      if (code !== "NO_LEAD") {
        console.warn("[A04] next_lead error:", code);
      }
    }
    return controller;
  }

  async function handleCall() {
    if (dialPhase.state !== "lead_selected") return;
    startCallRequested();

    const attemptUuid = crypto.randomUUID();
    const lead = dialPhase.lead;

    try {
      const resp = await api.post<{ attempt_uuid: string; lead: LeadPreview }>(
        "/api/agent/manual_dial",
        {
          phone: lead.phoneE164,
          lead_id: lead.id,
          attempt_uuid: attemptUuid,
          campaign_id: currentCampaignId ?? undefined,
          dial_mode: dialMode ?? "manual",
          claim_token: hopperClaimToken ?? undefined,
          consent_attested: consentAttested || undefined,
        },
      );
      setAttemptUuid(resp.attempt_uuid);
      broadcastDialStarted(resp.attempt_uuid);
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; status?: number; details?: Record<string, unknown> };
      setBlock({
        code: (e.code as import("@/lib/stores/dial").DialErrorCode) ?? "CARRIER_FAIL",
        message: e.message ?? "Unknown error",
        detail: e.details,
      });
    }
  }

  async function handleCancel() {
    const phase = useDialStore.getState().dialPhase;
    if (phase.state !== "calling") return;
    if (useDialStore.getState().dialPhase.state === "idle") return;

    setCancelLoading(true);
    try {
      await api.post("/api/agent/cancel_dial", {
        attempt_uuid: phase.attemptUuid,
      });
      resetDial();
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number };
      if (e.code === "ALREADY_BRIDGED" || e.status === 409) {
        router.push("/call");
        return;
      }
      // Other errors: still reset
      resetDial();
    } finally {
      setCancelLoading(false);
    }
  }

  async function handlePreviewSkip(reason: "skipped" | "dnc" | "callback") {
    const phase = useDialStore.getState().dialPhase;
    if (phase.state !== "lead_selected") return;
    const token = useDialStore.getState().hopperClaimToken;
    if (!token) return;

    try {
      await api.post("/api/agent/preview_skip", {
        lead_id: phase.lead.id,
        claim_token: token,
        reason,
      });
    } catch {
      // ignore — move to next lead anyway
    }
    handleLoadNextLead();
  }

  function handleManualDialSubmit(phone: string) {
    // Minimal synthetic lead for manual dial
    const syntheticLead: LeadPreview = {
      id: 0,
      firstName: null,
      lastName: null,
      vendorLeadCode: null,
      phoneE164: phone,
      phoneType: null,
      city: null,
      state: null,
      stateAbbr: null,
      postalCode: null,
      tzOffsetMin: null,
      tzName: null,
      customData: null,
      calledCount: 0,
      lastCalledAt: null,
      listId: null,
    };
    setLead(syntheticLead, "manual");
    setClientGates({ phoneValid: true, campaignActive: currentCampaignId !== null });
  }

  function announceReason(msg: string) {
    // The aria-live region in DialButton handles this announcement.
    // Log at warn level for observability (no-console only blocks info/log).
    console.warn("[A04] dial blocked:", msg);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const lead =
    dialPhase.state === "lead_selected" ||
    dialPhase.state === "call_requested" ||
    dialPhase.state === "calling" ||
    dialPhase.state === "blocked"
      ? dialPhase.lead
      : null;

  const isModalOpen = dialPhase.state === "modal_open";
  const isCalling =
    dialPhase.state === "calling" || dialPhase.state === "call_requested";
  const isBlocked = dialPhase.state === "blocked";
  const isLoadingLead = dialPhase.state === "loading_lead";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {/* ── Idle: action buttons ── */}
      {dialPhase.state === "idle" && (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            onClick={() => openModal()}
            aria-label="Open manual dial modal (m)"
          >
            Manual Dial
          </Button>
          <Button
            variant="secondary"
            onClick={handleLoadNextLead}
            aria-label="Load next lead from campaign (n)"
          >
            Dial Next Lead
          </Button>
        </div>
      )}

      {/* ── Loading lead skeleton ── */}
      {isLoadingLead && (
        <div role="status" aria-label="Loading next lead" className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      )}

      {/* ── Lead selected: preview card + actions ── */}
      {(dialPhase.state === "lead_selected" ||
        dialPhase.state === "call_requested") &&
        lead && (
          <div className="space-y-4">
            <LeadPreviewCard
              lead={lead}
              compliance={cardData?.compliance ?? null}
              dnc={cardData?.dnc ?? null}
              history={cardData?.history ?? null}
              scriptSnippet={cardData?.scriptSnippet ?? null}
              agentVisibleKeys={[]}
              redactedKeys={[]}
              loading={cardLoading}
            />

            <div className="flex flex-col gap-3">
              <DialButton
                gates={clientGates}
                onCall={handleCall}
                onAnnounce={announceReason}
                loading={dialPhase.state === "call_requested"}
              />

              <div className="flex gap-2 justify-end">
                {dialMode === "preview" && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handlePreviewSkip("skipped")}
                      aria-label="Skip this lead (s)"
                    >
                      Skip
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handlePreviewSkip("dnc")}
                      aria-label="Add to DNC and skip (Ctrl+Enter)"
                    >
                      DNC this number
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetDial}
                  aria-label="Cancel and return to idle (Esc)"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

      {/* ── Calling: ringing badge + cancel ── */}
      {isCalling &&
        dialPhase.state === "calling" &&
        lead && (
          <CallingBadge
            lead={lead}
            callUuid={dialPhase.callUuid}
            onCancel={handleCancel}
            cancelLoading={cancelLoading}
          />
        )}

      {/* ── Blocked ── */}
      {isBlocked && dialPhase.state === "blocked" && (
        <BlockedScreen
          reason={dialPhase.reason}
          hasLead={dialPhase.lead !== null}
          onDismiss={clearBlock}
          onTryAgain={lead ? handleCall : undefined}
        />
      )}

      {/* ── Manual Dial Modal ── */}
      <ManualDialModal
        open={isModalOpen}
        onOpenChange={(v) => (v ? openModal() : closeModal())}
        onSubmit={handleManualDialSubmit}
      />

      {/* ── Agent not in campaign hint ── */}
      {!currentCampaignId &&
        user?.role === "agent" &&
        dialPhase.state === "idle" && (
          <p
            role="status"
            className="text-sm text-[var(--color-fg-muted)] text-center"
          >
            Join a campaign to enable Dial Next Lead.
          </p>
        )}
    </div>
  );
}
