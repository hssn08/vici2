// Shared types for dial UI components

export interface CallHistory {
  date: string;
  duration: number; // seconds
  status: string;
  agentName: string | null;
}

export interface ComplianceWindow {
  allowed: boolean;
  hint: "allow" | "skip_until" | "block" | "unknown";
  windowStart: string | null; // "08:00"
  windowEnd: string | null;   // "21:00"
  nextOpenAt: string | null;  // ISO8601
  leadTz: string | null;
}

export interface DncResult {
  hit: boolean;
  sources: string[];
}
