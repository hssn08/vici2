'use client';

// N03 — SF embed agent shell page at /sf?embed=sf&tenant=<slug>
// Loaded inside the vici2 inner iframe of the SF softphone panel.
// No nav chrome — compact 300×600 layout only.

import { Suspense } from 'react';
import { SfEmbedShell } from '@/components/sf-cti/SfEmbedShell';

export default function SfEmbedPage(): React.ReactElement {
  return (
    <Suspense fallback={<SfLoadingState />}>
      <SfEmbedShell />
    </Suspense>
  );
}

function SfLoadingState(): React.ReactElement {
  return (
    <div className="flex items-center justify-center h-full text-slate-400 text-sm font-sans">
      Loading Vici2...
    </div>
  );
}
