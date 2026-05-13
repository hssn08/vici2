'use client';

// N03 — SF embed shell component.
// Rendered inside the vici2 inner iframe within the SF softphone panel.
// Compact layout — no top nav, no sidebar.

import { useSearchParams } from 'next/navigation';
import { useSfBridge } from './useSfBridge.js';
import type { SfDialMessage } from './openCtiBridge.js';

// ---------------------------------------------------------------------------
// Placeholder types — real stores (A02/A03) provide these via zustand
// ---------------------------------------------------------------------------

function useEmbedMode(): boolean {
  const params = useSearchParams();
  return params.get('embed') === 'sf';
}

function useAgentStatePlaceholder(): string {
  // Phase 1 placeholder — real agent store (A02) provides this
  return 'READY';
}

export function SfEmbedShell(): React.ReactElement {
  const isEmbed = useEmbedMode();
  const agentState = useAgentStatePlaceholder();

  function handleDial(msg: SfDialMessage): void {
    // Phase 1: placeholder — real implementation calls sf-import API then dials via A02
    // TODO(N03): wire to sf-import endpoint + A02 dial action
    void msg;
  }

  useSfBridge({
    onDial: handleDial,
    agentState,
  });

  if (!isEmbed) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        Open from Salesforce softphone panel
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-950 text-white" style={{ width: 300, height: 600 }}>
      <SfHeader agentState={agentState} />
      <div className="flex-1 flex items-center justify-center">
        <SfReadyPanel />
      </div>
      <SfFooter />
    </div>
  );
}

function SfHeader({ agentState }: { agentState: string }): React.ReactElement {
  const stateColors: Record<string, string> = {
    READY:  'bg-emerald-500',
    PAUSED: 'bg-amber-500',
    INCALL: 'bg-blue-500',
  };
  const color = stateColors[agentState] ?? 'bg-slate-500';

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
      <span className="text-xs font-semibold text-slate-300">Vici2 Agent</span>
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-xs text-slate-400">{agentState}</span>
      </div>
    </div>
  );
}

function SfReadyPanel(): React.ReactElement {
  return (
    <div className="text-center px-4">
      <div className="text-slate-500 text-xs mb-1">Ready for calls</div>
      <div className="text-slate-600 text-xs">Click a phone number in Salesforce to dial</div>
    </div>
  );
}

function SfFooter(): React.ReactElement {
  return (
    <div className="px-3 py-2 border-t border-gray-800 text-center">
      <span className="text-xs text-slate-600">Powered by Vici2</span>
    </div>
  );
}
