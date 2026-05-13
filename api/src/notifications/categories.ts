// N01 — Notification category registry.
// Defines all known categories, their default channels, severity, and subject templates.
// Producers call notify() with a category; N01 resolves the defaults from here.

export type NotifChannel = "in_app" | "email";
export type NotifSeverity = "info" | "warning" | "error";

export type NotifCategory =
  | "callback_due"
  | "callback_upcoming"
  | "import_complete"
  | "import_failed"
  | "recording_failed"
  | "agent_disconnected"
  | "drop_gate_engaged";

export const ALL_CATEGORIES: ReadonlyArray<NotifCategory> = [
  "callback_due",
  "callback_upcoming",
  "import_complete",
  "import_failed",
  "recording_failed",
  "agent_disconnected",
  "drop_gate_engaged",
];

export interface CategoryConfig {
  severity: NotifSeverity;
  defaultChannels: NotifChannel[];
}

// FROZEN: category defaults. To change a default, RFC against N01.
export const CATEGORY_DEFAULTS: Record<NotifCategory, CategoryConfig> = {
  callback_due: {
    severity: "warning",
    defaultChannels: ["in_app"],
  },
  callback_upcoming: {
    severity: "info",
    defaultChannels: ["in_app"],
  },
  import_complete: {
    severity: "info",
    defaultChannels: ["in_app", "email"],
  },
  import_failed: {
    severity: "error",
    defaultChannels: ["in_app", "email"],
  },
  recording_failed: {
    severity: "error",
    defaultChannels: ["in_app"],
  },
  agent_disconnected: {
    severity: "warning",
    defaultChannels: ["in_app"],
  },
  drop_gate_engaged: {
    severity: "error",
    defaultChannels: ["in_app"],
  },
};
