'use client';

// N03 — SF field mappings editor: dispo code → SF Task Status.

import { useState } from 'react';
import { usePatchSfIntegration } from './useSfIntegration.js';

const DEFAULT_DISPO_MAP: Record<string, string> = {
  SALE:     'Completed',
  NOANSWER: 'Not Started',
  BUSY:     'Not Started',
  DNC:      'Deferred',
  CBHOLD:   'In Progress',
  CALLBACK: 'In Progress',
};

const SF_STATUS_OPTIONS = ['Completed', 'Not Started', 'In Progress', 'Waiting on someone else', 'Deferred'];

interface SfFieldMappingsProps {
  initialMappings?: Record<string, string>;
}

export function SfFieldMappings({ initialMappings }: SfFieldMappingsProps): React.ReactElement {
  const [mappings, setMappings] = useState<Record<string, string>>({
    ...DEFAULT_DISPO_MAP,
    ...initialMappings,
  });
  const [saved, setSaved] = useState(false);
  const patch = usePatchSfIntegration();

  async function handleSave(): Promise<void> {
    await patch.mutateAsync({ fieldMappings: { dispoToTaskStatus: mappings } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Map vici2 disposition codes to Salesforce Task Status values.
      </p>
      <div className="border border-gray-700 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 text-slate-400">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Dispo Code</th>
              <th className="text-left px-3 py-2 font-medium">SF Task Status</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(mappings).map(([dispo, status]) => (
              <tr key={dispo} className="border-t border-gray-700">
                <td className="px-3 py-2 text-slate-300 font-mono">{dispo}</td>
                <td className="px-3 py-2">
                  <select
                    value={status}
                    onChange={(e) => setMappings({ ...mappings, [dispo]: e.target.value })}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {SF_STATUS_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={() => void handleSave()}
        disabled={patch.isPending}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
      >
        {saved ? 'Saved!' : patch.isPending ? 'Saving...' : 'Save Mappings'}
      </button>
    </div>
  );
}
