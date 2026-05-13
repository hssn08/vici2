"use client";

// M03 — Date range picker component.
// Renders two <input type="date"> fields with a label.
// Calls onChange(from, to) when either field changes.

interface DateRangePickerProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  maxDays?: number;
}

export function DateRangePicker({ from, to, onChange, maxDays = 365 }: DateRangePickerProps): React.ReactElement {
  const today = new Date().toISOString().slice(0, 10);

  function handleFrom(e: React.ChangeEvent<HTMLInputElement>): void {
    onChange(e.target.value, to);
  }

  function handleTo(e: React.ChangeEvent<HTMLInputElement>): void {
    onChange(from, e.target.value);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label
          htmlFor="report-from"
          className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]"
        >
          From
        </label>
        <input
          id="report-from"
          type="date"
          value={from}
          max={to || today}
          onChange={handleFrom}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-brand-600)] focus:outline-none"
        />
      </div>
      <div>
        <label
          htmlFor="report-to"
          className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]"
        >
          To
        </label>
        <input
          id="report-to"
          type="date"
          value={to}
          max={today}
          onChange={handleTo}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-brand-600)] focus:outline-none"
        />
      </div>
      {maxDays && (
        <p className="text-xs text-[var(--color-fg-muted)]">Max {maxDays} days</p>
      )}
    </div>
  );
}
