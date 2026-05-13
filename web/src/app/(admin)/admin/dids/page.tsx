"use client";

// M06 — Admin DIDs list page.
// URL: /admin/dids

import * as React from "react";
import { DidTable } from "@/components/admin/DidTable";
import { DidBulkModal } from "@/components/admin/DidBulkModal";
import { Button } from "@/components/ui/button";

export default function DidsPage(): React.ReactElement {
  const [showBulkModal, setShowBulkModal] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);

  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">DID Numbers</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Manage inbound DID numbers and their routing targets.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setShowBulkModal(true)}>
            Bulk import CSV
          </Button>
          <a
            href="/admin/dids/new"
            className="inline-flex items-center justify-center rounded-md bg-[var(--color-brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-700)] transition-colors"
          >
            Add DID
          </a>
        </div>
      </div>

      <DidTable key={refreshKey} />

      {showBulkModal && (
        <DidBulkModal
          onClose={() => setShowBulkModal(false)}
          onImported={() => { setRefreshKey((k) => k + 1); setShowBulkModal(false); }}
        />
      )}
    </main>
  );
}
