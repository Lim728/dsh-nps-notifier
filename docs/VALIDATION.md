# Validation boundaries

## Standalone offline validation

Validated with Node.js 24.11.0, pnpm 11.7.0, TypeScript 6.0.3 and tsdown 0.22.2 from locked public-registry dependencies, outside the DSH monorepo.

| Suite | Passed assertions | Failed | Skipped |
|---|---:|---:|---:|
| restored-ready | 61 | 0 | 0 |
| finished-resume | 274 | 0 | 0 |
| permanent-lifecycle | 3075 | 0 | 0 |
| packaged Loader + child IPC + isolated HTTP stub | 33 | 0 | 0 |
| reception-capture | 28 | 0 | 0 |
| Total | 3471 | 0 | 0 |

Counts are test assertions, not separate natural tasks. Four network-guarded suites report zero forbidden I/O attempts. The Loader suite reports zero real NPS requests; its HTTP traffic is isolated to the test stub. Its legacy-adapter rejection and duplicate-owner warnings are expected negative cases, not skipped tests.

The runtime implementation and existing test bodies were copied without logic changes. Source packaging adds build/test/release scripts and documentation, not new status behavior. The rebuilt ESM entry matches the previously approved binary hash. The initial Release retains the approved runtime artifacts and declarations.

## Existing manual acceptance

User-observed restored running, idle heartbeats, working takeover, finished retention and return to running passed. A paired aborted → closed transfer and terminal lock have evidence. Working heartbeats sustained a natural task beyond 45 seconds without reactivating its terminal status afterward.

These are historical acceptance results, not tests repeated during release preparation. No DSH/NPS restart, deployment or real notification was performed for packaging.

## Not fully validated live

- Naturally triggered whole-turn error, red 450ms breathing and repeated-error reminder deduplication.
- Approval mapping (not implemented for DSH), full cancellation interaction, page close and all terminal-lock reopen scenarios.
- The earlier intermittent missed-event report remains open.
- Reminder interface success does not prove visible pixels. Top reminders require human confirmation.
- Compatibility with arbitrary official DSH builds, other Node/platform combinations and independent Desktop backends is not established.

Current NPS retention of finished=10s and error=30s is configuration, not a universal protocol. This plugin reads actual retention metadata for finished recovery. NPS display filtering and reminder diagnostics are companion features not contained in this release.
