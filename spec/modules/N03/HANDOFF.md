# N03 — Salesforce Open CTI Adapter — HANDOFF

| Field | Value |
|---|---|
| **Module** | N03 — Salesforce Open CTI Adapter |
| **Status** | STUB (to be completed post-implementation) |

---

## Install guide

_To be written by the implementing agent after the module ships._

Topics to cover:
1. Creating a Salesforce Connected App (step-by-step with screenshots).
2. Downloading and importing `sf-cti-manifest.xml` via SF Setup → Call Centers.
3. Assigning Salesforce users to the Call Center.
4. Completing the vici2 admin OAuth flow.
5. Configuring dispo-to-Task status field mappings.
6. Verifying click-to-dial and screen-pop in a sandbox.

---

## postMessage schema reference

_See PLAN.md §3 for the full postMessage schema. Final canonical schema to be transcribed here post-implementation._

---

## Extending with custom actions

_To be written post-implementation. Outline:_
- How to add new `vici2:*` message types to `openCtiBridge.ts`.
- How to add new `sf:*` handlers in `sf-cti.js`.
- How to invoke Apex via `sforce.opencti.runApex` (Phase 2, managed package only).
- How to add custom dispo → SF Task field mappings beyond the default map.
