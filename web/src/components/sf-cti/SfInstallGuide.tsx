'use client';

// N03 — SF Call Center installation guide + manifest download.

interface SfInstallGuideProps {
  tenantSlug?: string;
}

export function SfInstallGuide({ tenantSlug }: SfInstallGuideProps): React.ReactElement {
  const manifestUrl = tenantSlug
    ? `/static/sf-cti-manifest.xml?tenant=${encodeURIComponent(tenantSlug)}`
    : '/static/sf-cti-manifest.xml';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-white mb-2">Step 1 — Download Call Center XML</h3>
        <a
          href={manifestUrl}
          download="sf-cti-manifest.xml"
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-sm text-white rounded transition-colors"
        >
          Download sf-cti-manifest.xml
        </a>
        {!tenantSlug && (
          <p className="mt-1 text-xs text-amber-400">
            Connect your Salesforce org first to pre-fill the tenant slug in the manifest.
          </p>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium text-white mb-2">Step 2 — Import into Salesforce</h3>
        <ol className="space-y-1 text-sm text-slate-400 list-decimal list-inside">
          <li>Go to Salesforce Setup</li>
          <li>Search for &quot;Call Centers&quot; in Quick Find</li>
          <li>Click <strong className="text-slate-300">Import</strong> and upload the XML file</li>
          <li>Open the new Call Center record and click <strong className="text-slate-300">Manage Call Center Users</strong></li>
          <li>Add the agents who should use Vici2</li>
        </ol>
      </div>

      <div>
        <h3 className="text-sm font-medium text-white mb-2">Step 3 — Enable Open CTI in Console App</h3>
        <ol className="space-y-1 text-sm text-slate-400 list-decimal list-inside">
          <li>Go to <strong className="text-slate-300">App Manager</strong> in Setup</li>
          <li>Edit your Service Cloud or Sales Cloud Console app</li>
          <li>Under <strong className="text-slate-300">Utility Items</strong>, add the Open CTI Softphone</li>
          <li>Save and refresh the app</li>
        </ol>
      </div>

      <div className="bg-gray-800 border border-gray-700 rounded p-3">
        <p className="text-xs text-slate-400">
          <strong className="text-slate-300">Requirements:</strong> Salesforce API v55+ is required.
          The adapter URL in the manifest points to this vici2 instance.
          Ensure your Salesforce Connected App has the callback URL whitelisted.
        </p>
      </div>
    </div>
  );
}
