"use client";

// M03 — Generic report data table component.
// Renders a scrollable table from column definitions and row data.
// Handles loading skeleton, empty state, and string/number/null cells.

interface Column<T> {
  key: keyof T;
  header: string;
  align?: "left" | "right";
  format?: (v: T[keyof T]) => string;
}

interface ReportTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  rows: T[] | null;
  isLoading?: boolean;
  emptyMessage?: string;
}

function formatCell<T>(col: Column<T>, row: T): string {
  const v = row[col.key];
  if (col.format) return col.format(v);
  if (v == null) return "—";
  return String(v);
}

const SKELETON_ROWS = 5;

export function ReportTable<T extends Record<string, unknown>>({
  columns,
  rows,
  isLoading = false,
  emptyMessage = "No data for the selected range.",
}: ReportTableProps<T>): React.ReactElement {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <table className="min-w-full text-sm">
        <thead className="bg-[var(--color-surface-muted)]">
          <tr>
            {columns.map((col) => (
              <th
                key={String(col.key)}
                scope="col"
                className={`px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)] ${col.align === "right" ? "text-right" : "text-left"}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                <tr key={i} aria-hidden>
                  {columns.map((col) => (
                    <td key={String(col.key)} className="px-4 py-2">
                      <div className="h-4 animate-pulse rounded bg-[var(--color-surface-muted)]" />
                    </td>
                  ))}
                </tr>
              ))
            : !rows || rows.length === 0
              ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-4 py-8 text-center text-[var(--color-fg-muted)]"
                    >
                      {emptyMessage}
                    </td>
                  </tr>
                )
              : rows.map((row, idx) => (
                  <tr
                    key={idx}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] transition-colors"
                  >
                    {columns.map((col) => (
                      <td
                        key={String(col.key)}
                        className={`px-4 py-2 text-[var(--color-fg)] ${col.align === "right" ? "text-right tabular-nums" : ""}`}
                      >
                        {formatCell(col, row)}
                      </td>
                    ))}
                  </tr>
                ))}
        </tbody>
      </table>
    </div>
  );
}
