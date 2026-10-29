# Compatibility

This is a community integration, not an official DeepSeek release. The component keeps its internal package name for self-resolution; it is not published to the DeepSeek npm scope.

## Supported integration target

DSH 0.2.1-rc.2 with the tested companion Web/session/approval interfaces. A version string alone is insufficient. Building this plugin from published dependencies does not install or implement those host extensions.

The compatible host supplies:

- An explicit ordinary-session opening association tied to the current connection, including release on navigation/disconnection. List previews, automatic restore, preload and child tasks do not grant readiness.
- The backend api-session/interaction signal used for guarded restored readiness, retaining the real agent/session instance and cancellation signal.
- An authoritative approval pending-state query, synchronized before idle admission.
- Agent registry/status/lifecycle, session/event, turn/start and turn/end, appReady and whenIdle behavior expected by the runtime.

The restored-ready feature involves these companion artifacts, which are NOT shipped here:

- dsh-api-session-controller/lib/index.js
- dsh-api-session-controller/lib/client.js
- dsh-api-session-controller/lib/typert.host.js
- dsh-api-session-controller/lib/typert.remote-client.js
- dsh-api-remotes/lib/client.js
- dsh-client-ui-workspace/lib/client.js
- dsh-user-approval/lib/index.js

No complete compatible DSH distribution is attached to this release. Distribution maintainers must supply the companion implementation; an unmodified upstream checkout is not claimed to deliver all restored-ready behavior. A Desktop instance using a separate backend must be verified separately.

## NPS companion

NPS must separately provide NPS.Plugin.AiCliNotifier with local /notify and the /state metadata used for retention recovery. Same-tool display filtering and reminder diagnostics are NPS-side features, not this plugin's source or binary. Installing this package does not replace NPS files.

## Dependencies and registration

Node supports ^22.19.0 or >=24.0.0. Runtime dependencies remain external: Cordis ~4.0.5, loader ~1.0.6, Schemastery ~3.18.5, and DSH agent/app-boot/cmdline 0.2.1-rc.2. Host peer instances must be shared, not bundled as a second Cordis runtime.

The source repository is private-to-npm (private=true); this does not mean a private GitHub repository. It prevents accidental npm publication. The runtime ZIP omits build/test dependencies, source exports and npm publishing configuration. There is no dsh.bundle declaration; copying or installing a plain dependency does not activate it. The compatible Web bundle owns activation. See examples/builtin-registration.yml.

Official mechanism: https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish
