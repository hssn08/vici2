// M07 — Status flag badge pills (SALE, DNC, CB, NI, HA).

import * as React from "react";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  sale?: boolean;
  dnc?: boolean;
  callback?: boolean;
  notInterested?: boolean;
  humanAnswered?: boolean;
}

function FlagPill({
  label,
  active,
  className,
}: {
  label: string;
  active: boolean;
  className?: string;
}): React.ReactElement | null {
  if (!active) return null;
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        className,
      )}
    >
      {label}
    </span>
  );
}

export function StatusBadge({
  sale = false,
  dnc = false,
  callback = false,
  notInterested = false,
  humanAnswered = false,
}: StatusBadgeProps): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      <FlagPill label="SALE" active={sale} className="bg-green-100 text-green-700" />
      <FlagPill label="DNC" active={dnc} className="bg-red-100 text-red-700" />
      <FlagPill label="CB" active={callback} className="bg-blue-100 text-blue-700" />
      <FlagPill label="NI" active={notInterested} className="bg-amber-100 text-amber-700" />
      <FlagPill label="HA" active={humanAnswered} className="bg-purple-100 text-purple-700" />
    </div>
  );
}
