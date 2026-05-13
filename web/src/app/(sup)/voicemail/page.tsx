"use client";

// I03 — Supervisor voicemail page.
// Same UX as agent page but supervisors see mailboxes assigned to their groups.
// Re-uses the agent page component with identical fetch logic — access control
// is enforced server-side by getAccessibleBoxIds() based on the user's role.

import AgentVoicemailPage from "../../(agent)/voicemail/page.js";

export default AgentVoicemailPage;
