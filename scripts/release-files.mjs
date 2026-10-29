export const runtimeFiles = [
  'observer.mjs', 'running-controller.mjs', 'forward-core.mjs', 'forward-bridge.mjs',
  'forwarder.mjs', 'forward-http.mjs', 'heartbeat-controller.mjs', 'state-reader.mjs',
  'recorder.mjs', 'handshake-diagnostics.mjs', 'reception-capture.mjs',
];
export const releaseFiles = [
  'README.md', 'LICENSE', 'checksums.sha256', 'docs/README.md', 'plugin/package.json',
  'plugin/lib/index.js', 'plugin/lib/types/index.d.ts', 'plugin/lib/types/types.d.ts',
  ...runtimeFiles.map(name => `plugin/runtime/${name}`),
].sort();
export const releaseName = 'DSH-NPS-Builtin';
export const releaseVersion = 'v0.1.0-preview.1';
