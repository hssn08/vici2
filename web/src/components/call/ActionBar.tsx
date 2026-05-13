"use client";

import * as React from "react";
import { useCallStore, type CallPhase } from "@/lib/stores/call";
import { useSoftphone } from "@/lib/sip";
import { useHangupGrace } from "@/lib/hooks/useHangupGrace";
import { DtmfPad } from "@/components/call/DtmfPad";
import { TransferModal } from "@/components/call/TransferModal";
import { ThreeWayModal } from "@/components/call/ThreeWayModal";
import { CallbackScheduler } from "@/components/call/CallbackScheduler";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

// Phases where each action is enabled
const ACTIVE_PHASES: Set<CallPhase> = new Set(["active", "hold", "transferring"]);
const HOLD_PHASES: Set<CallPhase> = new Set(["active", "hold"]);

interface ActionButtonProps {
  label: string;
  ariaLabel: string;
  icon: React.ReactNode;
  hotkey?: string;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
  className?: string;
  disabledReason?: string;
}

function ActionButton({
  label,
  ariaLabel,
  icon,
  hotkey,
  active,
  disabled,
  loading,
  onClick,
  className,
  disabledReason,
}: ActionButtonProps): React.ReactElement {
  const liveRef = React.useRef<HTMLSpanElement>(null);

  const handleClick = () => {
    if (disabled) {
      if (liveRef.current) {
        liveRef.current.textContent = disabledReason ?? "Action unavailable";
        setTimeout(() => { if (liveRef.current) liveRef.current.textContent = ""; }, 3000);
      }
      return;
    }
    onClick();
  };

  return (
    <div className="relative flex flex-col items-center">
      <span
        ref={liveRef}
        aria-live="polite"
        className="sr-only"
      />
      <button
        aria-label={`${ariaLabel}${hotkey ? ` (${hotkey})` : ""}`}
        aria-pressed={active}
        aria-disabled={disabled}
        title={disabled ? (disabledReason ?? "Unavailable") : `${label}${hotkey ? ` · ${hotkey}` : ""}`}
        onClick={handleClick}
        className={cn(
          "relative flex h-10 min-w-[56px] items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-600)]",
          disabled
            ? "cursor-default opacity-50"
            : "cursor-pointer hover:opacity-90 active:scale-95",
          className,
        )}
      >
        {loading ? (
          <span aria-hidden className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          icon
        )}
        <span className="hidden sm:inline">{label}</span>
      </button>
    </div>
  );
}

// Icons (inline SVG lucide-like)
const PhoneOffIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.42 19.42 0 0 1 4.27 8.11"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);
const PauseIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
  </svg>
);
const PlayIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
);
const MicOffIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23"/>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);
const MicIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);
const DialpadIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="4" height="4" rx="1"/><rect x="10" y="2" width="4" height="4" rx="1"/>
    <rect x="18" y="2" width="4" height="4" rx="1"/><rect x="2" y="10" width="4" height="4" rx="1"/>
    <rect x="10" y="10" width="4" height="4" rx="1"/><rect x="18" y="10" width="4" height="4" rx="1"/>
    <rect x="2" y="18" width="4" height="4" rx="1"/><rect x="10" y="18" width="4" height="4" rx="1"/>
    <rect x="18" y="18" width="4" height="4" rx="1"/>
  </svg>
);
const ForkIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/>
    <path d="M6 9v3m0 0c0 3 5 5 12 0M6 12c0 3 5 5 12 0"/>
    <path d="M6 9v3"/><path d="M6 15v3"/>
  </svg>
);
const UsersIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);
const CircleIcon = ({ filled }: { filled: boolean }) => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"/>
  </svg>
);
const CalendarClockIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/>
    <path d="M16 2v4M8 2v4M3 10h5"/>
    <circle cx="18" cy="18" r="5"/><path d="M18 15v4l2 2"/>
  </svg>
);
const BanIcon = () => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
  </svg>
);

// DNC confirmation dialog
function DncConfirm({
  phone,
  onConfirm,
  onCancel,
}: {
  phone: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div
      role="alertdialog"
      aria-label="Mark DNC confirmation"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-80 rounded-lg border border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] p-6 shadow-xl">
        <h2 className="mb-2 text-base font-semibold">Add to DNC?</h2>
        <p className="mb-4 text-sm text-[var(--color-fg-muted)]">
          Add {phone} to internal DNC? This cannot be undone from this screen.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded px-4 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded bg-[var(--color-state-error)] px-4 py-2 text-sm text-white hover:opacity-90"
          >
            Confirm DNC
          </button>
        </div>
      </div>
    </div>
  );
}

export function ActionBar(): React.ReactElement {
  const phase = useCallStore((s) => s.phase);
  const callUuid = useCallStore((s) => s.callUuid);
  const lead = useCallStore((s) => s.lead);
  const campaign = useCallStore((s) => s.campaign);
  const recording = useCallStore((s) => s.recording);
  const hangupGraceActive = useCallStore((s) => s.hangupGraceActive);
  const setPhase = useCallStore((s) => s.setPhase);

  const { muted, mute: sipMute, unmute: sipUnmute } = useSoftphone();
  const sipToggleMute = () => muted ? sipUnmute() : sipMute();
  const { triggerHangup } = useHangupGrace();

  const [holdLoading, setHoldLoading] = React.useState(false);
  const [recordLoading, setRecordLoading] = React.useState(false);
  const [dtmfOpen, setDtmfOpen] = React.useState(false);
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [threeWayOpen, setThreeWayOpen] = React.useState(false);
  const [callbackOpen, setCallbackOpen] = React.useState(false);
  const [dncConfirm, setDncConfirm] = React.useState(false);

  const isInCall = ACTIVE_PHASES.has(phase);
  const isHoldPhase = HOLD_PHASES.has(phase);
  const isHeld = phase === "hold";

  const handleHold = async () => {
    if (!callUuid || holdLoading) return;
    const action = isHeld ? "unhold" : "hold";
    setHoldLoading(true);
    // Optimistic
    setPhase(isHeld ? "active" : "hold");
    try {
      await apiFetch(`/api/agent/call/${callUuid}/hold`, {
        method: "PATCH",
        body: { action },
      });
    } catch {
      // Revert on failure
      setPhase(isHeld ? "hold" : "active");
    } finally {
      setHoldLoading(false);
    }
  };

  const handleRecord = async () => {
    if (!callUuid || recordLoading) return;
    const action = recording === "on" ? "stop" : "start";
    setRecordLoading(true);
    try {
      await apiFetch(`/api/agent/call/${callUuid}/recording`, {
        method: "PATCH",
        body: { action },
      });
    } catch {
      // WS will confirm or revert
    } finally {
      setRecordLoading(false);
    }
  };

  const handleDnc = async () => {
    if (!lead?.id) return;
    setDncConfirm(false);
    try {
      await apiFetch(`/api/agent/lead/${lead.id}/dnc`, {
        method: "POST",
        body: {},
      });
    } catch {
      // best-effort
    }
  };

  const showRecordButton =
    campaign?.recording_mode === "ONDEMAND";

  const isWrapup = phase === "wrapup";

  return (
    <footer
      aria-label="Call actions"
      className="call-action-bar flex items-center justify-start gap-2 border-t border-[var(--color-surface-border)] bg-[var(--color-surface-elevated)] px-4"
      style={{ gridColumn: "1 / -1", gridRow: 3, height: 64 }}
    >
      {/* 1. Hangup — always visible, always leftmost, always red */}
      <ActionButton
        label="Hangup"
        ariaLabel="Hangup"
        hotkey="F3"
        icon={<PhoneOffIcon />}
        disabled={isWrapup && !hangupGraceActive}
        disabledReason="Call already ended"
        onClick={triggerHangup}
        className="bg-[var(--color-state-error)] text-white"
      />

      {/* 2. Hold */}
      <ActionButton
        label={isHeld ? "Resume" : "Hold"}
        ariaLabel={isHeld ? "Resume hold" : "Place on hold"}
        hotkey="F2"
        icon={isHeld ? <PlayIcon /> : <PauseIcon />}
        disabled={!isHoldPhase}
        loading={holdLoading}
        active={isHeld}
        onClick={() => void handleHold()}
        className={cn(
          isHeld
            ? "bg-[var(--color-state-hold)] text-white"
            : "bg-[var(--color-surface-muted)] text-[var(--color-fg)]",
        )}
      />

      {/* 3. Mute */}
      <ActionButton
        label={muted ? "Unmute" : "Mute"}
        ariaLabel={muted ? "Unmute microphone" : "Mute microphone"}
        hotkey="F4"
        icon={muted ? <MicIcon /> : <MicOffIcon />}
        disabled={!isInCall && !isWrapup}
        active={muted}
        onClick={() => sipToggleMute()}
        className={cn(
          muted
            ? "bg-[var(--color-state-hold)] text-white"
            : "bg-[var(--color-surface-muted)] text-[var(--color-fg)]",
        )}
      />

      {/* 4. DTMF */}
      <div className="relative">
        <ActionButton
          label="DTMF"
          ariaLabel="Open DTMF keypad"
          hotkey="D"
          icon={<DialpadIcon />}
          disabled={!isInCall}
          active={dtmfOpen}
          onClick={() => setDtmfOpen((v) => !v)}
          className="bg-[var(--color-surface-muted)] text-[var(--color-fg)]"
        />
        {dtmfOpen && <DtmfPad onClose={() => setDtmfOpen(false)} />}
      </div>

      {/* 5. Transfer */}
      <ActionButton
        label="Transfer"
        ariaLabel="Blind transfer"
        hotkey="Ctrl+T"
        icon={<ForkIcon />}
        disabled={!isInCall}
        onClick={() => setTransferOpen(true)}
        className="bg-[var(--color-surface-muted)] text-[var(--color-fg)]"
      />

      {/* 6. 3-way */}
      <ActionButton
        label="3-way"
        ariaLabel="3-way conference"
        hotkey="Ctrl+3"
        icon={<UsersIcon />}
        disabled={!isInCall}
        onClick={() => setThreeWayOpen(true)}
        className="bg-[var(--color-surface-muted)] text-[var(--color-fg)]"
      />

      {/* 7. Record (ONDEMAND only) */}
      {showRecordButton && (
        <ActionButton
          label="Record"
          ariaLabel={recording === "on" ? "Stop recording" : "Start recording"}
          hotkey="R"
          icon={<CircleIcon filled={recording === "on"} />}
          disabled={!isInCall || recording === "pending"}
          active={recording === "on"}
          loading={recordLoading}
          onClick={() => void handleRecord()}
          className={cn(
            recording === "on"
              ? "bg-[var(--color-state-error)] text-white"
              : "bg-[var(--color-surface-muted)] text-[var(--color-fg)]",
          )}
        />
      )}

      {/* 8. Callback */}
      <ActionButton
        label="Callback"
        ariaLabel="Schedule callback"
        hotkey="Ctrl+B"
        icon={<CalendarClockIcon />}
        disabled={!isInCall && !isWrapup}
        onClick={() => setCallbackOpen(true)}
        className="bg-[var(--color-surface-muted)] text-[var(--color-fg)]"
      />

      {/* 9. Mark DNC */}
      <ActionButton
        label="Mark DNC"
        ariaLabel="Mark as Do Not Call"
        hotkey="Ctrl+D"
        icon={<BanIcon />}
        disabled={!isInCall && !isWrapup}
        onClick={() => setDncConfirm(true)}
        className="bg-[var(--color-surface-muted)] text-[var(--color-fg)]"
      />

      {/* Modals */}
      {transferOpen && <TransferModal onClose={() => setTransferOpen(false)} />}
      {threeWayOpen && <ThreeWayModal onClose={() => setThreeWayOpen(false)} />}
      {callbackOpen && <CallbackScheduler onClose={() => setCallbackOpen(false)} />}
      {dncConfirm && (
        <DncConfirm
          phone={lead?.phoneE164 ?? "this number"}
          onConfirm={() => void handleDnc()}
          onCancel={() => setDncConfirm(false)}
        />
      )}
    </footer>
  );
}
