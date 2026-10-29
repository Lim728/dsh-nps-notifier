# Build, test and package

## Verified standalone environment

Validated on Windows with Node.js 24.11.0 and pnpm 11.7.0. Dependencies were installed from the public npm registry into this repository. No DSH monorepo, global DSH package, installed adapter, production profile or NPS installation was used as a build dependency.

Run from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm test
```

All three commands have been executed successfully. Install scripts were disabled; no allow-build exception was required. The build type-checks the entry and emits declarations using TypeScript 6.0.3, then emits the ESM entry with tsdown 0.22.2. Dependencies remain external. Declaration checking uses skipLibCheck for dependency declarations; the plugin source is still checked under strict mode.

The standalone entry's SHA256 matches the previous packaged entry:

```text
4F06A1D00A095A0A6BAD9B59684709C3B6A876858AEFE1747991418A66EBA4B6
```

The two independently generated declarations omit the old sourceMappingURL comments; their declarations are otherwise unchanged. The first preview archive preserves the previously approved declarations byte-for-byte. Runtime modules contain no build transformations. Git may normalize text line endings without changing implementation.

Building this component does not build the companion DSH host extensions. See COMPATIBILITY.md before integration. Do not treat a successful standalone build as evidence that an unmodified official DSH installation supports restored readiness.

## Offline tests

pnpm test runs five existing synthetic suites. Four preload offline-network-guard.mjs, which denies network and process creation. The packaged-loader suite deliberately starts a test worker and an ephemeral loopback HTTP stub; it rejects the real NPS port 17877. It does not submit notifications to NPS or run natural DSH tasks.

The tests use generated temporary directories, synthetic identities and virtual clocks; no actual session histories are required. Duplicate-owner and legacy-adapter rejection warnings are expected negative cases. Test logs are not committed or attached to releases.

## Package a release

The packaging scripts are local tools, not installers. They never launch DSH, NPS or the runtime modules. The output directory must not exist. Input may be a previously approved DSH-NPS-Builtin directory or a freshly built package root.

```sh
node scripts/package-release.mjs --artifacts <artifact-directory> --out <new-output-directory>
node scripts/verify-release.mjs <new-output-directory>
```

Replace the angle-bracket arguments with your selected directories. These script paths and argument forms were executed for this preview. The first preview uses the previously approved artifact directory; this preserves the original runtime bytes and two declarations. An archive built from new artifacts must be validated as a new artifact set.

Packaging uses a strict 19-file allowlist. Only release documentation, sanitized package metadata and LICENSE accompany the existing runtime and declarations. No source, tests, node_modules, logs, credentials or host installation is copied. The runtime package keeps its internal name/version but drops development and publishing fields.

Verification decompresses the ZIP into a unique temporary directory, checks its exact file list, compares extracted bytes with the package tree and verifies all 18 inner checksums. Only then does it write release-checksums.sha256 for the ZIP and standalone checksums.sha256. A manifest never hashes itself.

After reviewing and staging explicit source files, run:

```sh
git diff --cached --check
node scripts/privacy-scan.mjs <new-output-directory>
```

The scan reads staged Git blobs, not merely the worktree, and scans the decompressed ZIP plus checksum attachments. Findings show file/line/category, not matched secret values. Pattern scans supplement human review; they cannot prove absence of every possible secret format.

## Publication gate

The public repository is https://github.com/Lim728/dsh-nps-notifier, verified under owner Lim728. Documentation updates change archive bytes: regenerate the archive and both checksum layers, re-run verification and privacy scanning before uploading. Do not reuse preliminary attachment hashes after any change. GitHub publication is separate from deployment; this release does not change running DSH or NPS installations.
