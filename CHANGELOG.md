# Changelog

## v0.1.0-preview.1 — Pre-release

First community preview of the DSH NPS integration. The release tag is independent of the retained component version 0.2.1-rc.2.

- Guarded fresh and explicitly opened restored-session readiness.
- Independent working and idle heartbeats; task start revokes idle eligibility.
- Paired terminal mapping and finished-retention recovery based on NPS state.
- Lifetime-owned forwarding with bounded diagnostic rotation.
- Source, synthetic tests, build instructions and a runtime-only ZIP.

Same-tool display priority and reminder diagnostics belong to the companion NPS AiCliNotifier. They are not included in this plugin archive; installing it does not update NPS.

Requires DSH 0.2.1-rc.2 with the companion host interfaces. Generic official-version compatibility is not claimed. See docs/COMPATIBILITY.md and docs/VALIDATION.md.
