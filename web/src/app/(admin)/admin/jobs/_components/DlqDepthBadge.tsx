'use client';
// W02 — Red badge showing DLQ depth. Hidden when depth === 0.

interface Props {
  depth: number;
  href?: string;
}

export function DlqDepthBadge({ depth, href }: Props): React.ReactElement | null {
  if (depth === 0) return null;
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
      aria-label={`${depth} DLQ entries`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden />
      DLQ {depth}
    </a>
  );
}
