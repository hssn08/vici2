# RFC 001 — pnpm vs npm workspaces for the TS layer

**Status:** PROPOSED
**Modules affected:** F01 (primarily); A01, M01, downstream TS modules
   (transitively, through workspace tooling)
**Author:** F01 sub-agent
**Date:** 2026-05-06

## Problem
`spec/modules/F01.md` lists `package.json   # workspace root, npm
workspaces` in its Implementation-phase file list. `SPEC.md §2` does not
pin a workspace tool. F01.md was drafted before the pnpm-as-default
trend solidified in 2026.

The choice has real downstream effects:
- install speed (~3× faster with pnpm),
- dependency-isolation strictness (pnpm catches phantom deps; npm
  hoists everything to the root and lets bugs hide until prod),
- `workspace:*` protocol vs relative paths (pnpm/yarn vs npm),
- compatibility with future task runners (Turborepo officially
  recommends pnpm).

## Proposed change
Use **pnpm 9.x workspaces** for the TS layer (`api`, `web`, `workers`,
`shared/types`). Update F01.md to reflect: `package.json   # workspace
root, pnpm workspaces` and add a sibling `pnpm-workspace.yaml` to the
file list.

## Alternatives considered

1. **npm workspaces** (status quo per F01.md text)
   - Pros: ships with Node, no extra install, smallest learning curve.
   - Cons: ~3× slower install, no graph filtering, no `workspace:*`,
     phantom-dep risk. "OK for small repos, not OK for >10 packages."
2. **pnpm workspaces** (proposed)
   - Pros: industry default in 2026, strict isolation, fast, Turborepo-
     ready, `workspace:*` protocol.
   - Cons: requires `corepack enable` or a `pnpm` install step. Trivial.
3. **yarn berry / PnP**
   - Pros: zero `node_modules`.
   - Cons: PnP compatibility edge cases persist; smaller community
     momentum than pnpm.
4. **Bun workspaces**
   - Pros: fastest install.
   - Cons: smaller ecosystem; some packages (especially around
     Prisma's binary engine) still hit edge cases on Bun.

References live in `spec/modules/F01/RESEARCH.md` §3.

## Impact

### Interface
None. The choice is a build-tool preference; no production runtime
characteristic changes.

### Schema
None.

### Downstream modules
- A01, M01 onward simply use `pnpm` instead of `npm`. The
  `package.json` `packageManager` field pins the version.
- O04 CI uses `pnpm/action-setup@v4` instead of `actions/setup-node`'s
  npm cache.
- Documentation in README + CONTRIBUTING uses `pnpm` commands.

## Migration plan
N/A — no code yet. F01 IMPLEMENT phase ships pnpm from day 1.

## Decision
Pending review.

If **accepted**: F01 PLAN.md proceeds as written; F01.md is updated
under the same PR to swap `npm` → `pnpm` and add the
`pnpm-workspace.yaml` file.

If **rejected**: F01 swaps `pnpm-workspace.yaml` for a root
`package.json` `workspaces:` field, drops `pnpm` install in
`make hooks`, and adopts npm 10. Cost: ~2 hours.
