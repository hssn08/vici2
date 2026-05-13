// W02 — Jobs queue admin: layout with breadcrumb.

import type { ReactNode } from 'react';

export const metadata = { title: 'Job Queues · vici2 Admin' };

export default function JobsLayout({ children }: { children: ReactNode }): React.ReactElement {
  return <>{children}</>;
}
