# ADR 0001: External TUI adapter boundary

Status: accepted (phase 0)

## Context

`opensource/deepseek-harness` and its vendored Cordis will continue to update. Building the TUI inside that checkout would mix product ownership with an upstream mirror and turn routine updates into source merges. Pulling the Web client runtime into the terminal would also carry Host, browser state, and a product-sized dependency closure.

## Decision

The TUI is an independent private package at `packages/dsh-tui`. The Harness checkout is read-only application infrastructure and a compatibility target.

Only `src/harness-adapter.ts` knows Harness module locations and live service shapes. It maps Agent/Session/approval data into TUI-owned contracts. The bundle is mounted as an external profile layer through a development symlink; it does not patch upstream files. `upstream-compat.json` pins the accepted baseline, and `scripts/check-upstream.ts` rejects known contract drift before build or smoke tests run.

Ink is restricted to the rendering module. The selected phase-zero pair is Ink 5.2.1 with React 18.3.1; Ink 6.8.0 was rejected after the real Loader smoke exposed its React 19 peer requirement.

## Consequences

Harness updates normally touch one adapter and the compatibility record. A failed compatibility gate leaves the last verified upstream baseline usable. This protects TUI releases from involuntary upstream churn; it does not promise compatibility with arbitrary Harness commits.

The adapter uses narrow runtime structural checks rather than compiling the upstream source files into the TUI TypeScript aggregate. Harness owns a project-reference graph that must be built and checked in its own workspace. Product acceptance therefore requires both local unit/type checks and a real Loader profile smoke.

## Alternatives

**Add `packages/bundle/tui` to the Harness checkout.** Rejected because it modifies the update target and makes the TUI release cadence depend on upstream merges.

**Reuse the complete Web client runtime.** Rejected because its Host, React/Zustand and browser protocol layers violate the lightweight direct-Agent target.

**Copy Harness Agent/session logic.** Rejected because it forks safety, persistence and lifecycle semantics that must remain upstream-owned.
