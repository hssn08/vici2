// N03 — SF embed layout: no TopNav/SideNav, fixed 300×600 softphone panel size.

import type { ReactNode } from 'react';

export const metadata = {
  title: 'Vici2 Agent — Salesforce',
};

export default function SfEmbedLayout({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body
        className="bg-gray-950 text-white"
        style={{ width: 300, height: 600, overflow: 'hidden', margin: 0, padding: 0 }}
      >
        {children}
      </body>
    </html>
  );
}
