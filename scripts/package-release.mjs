import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { releaseFiles, runtimeFiles, releaseName, releaseVersion } from './release-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
if (argv.length !== 4 || argv[0] !== '--artifacts' || argv[2] !== '--out')
  throw new Error('usage: --artifacts <existing-release-or-built-package> --out <new-output-directory>');
const input = path.resolve(argv[1]);
const output = path.resolve(argv[3]);
if (fs.existsSync(output)) throw new Error('output_exists_refusing_overwrite');
const artifactRoot = fs.existsSync(path.join(input, 'plugin/package.json')) ? path.join(input, 'plugin') : input;
const code = ['lib/index.js', 'lib/types/index.d.ts', 'lib/types/types.d.ts', ...runtimeFiles.map(x => `runtime/${x}`)];
const payload = new Map();
for (const name of code) {
  const bytes = fs.readFileSync(path.join(artifactRoot, name));
  const normalize = value => value.toString('utf8').replace(/\r\n/g, '\n');
  if (name.startsWith('runtime/') && normalize(bytes) !== normalize(fs.readFileSync(path.join(root, name))))
    throw new Error('runtime_does_not_match_source');
  payload.set(`plugin/${name}`, bytes);
}
const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, 'package.json'), 'utf8'));
if (manifest.name !== '@deepseek-ai/dsh-host-nps-notifier' || manifest.version !== '0.2.1-rc.2')
  throw new Error('unexpected_component_identity');
if (/workspace:|file:|link:/.test(JSON.stringify([manifest.dependencies, manifest.peerDependencies])))
  throw new Error('nonportable_release_dependencies');
for (const key of ['devDependencies', 'scripts', 'private', 'publishConfig', 'repository', 'packageManager']) delete manifest[key];
if (manifest.exports) delete manifest.exports['./src/*'];
payload.set('plugin/package.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
for (const [target, source] of [
  ['README.md', 'docs/RELEASE-README.md'], ['docs/README.md', 'docs/INSTALLATION.md'], ['LICENSE', 'LICENSE'],
]) payload.set(target, fs.readFileSync(path.join(root, source)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checksums = [...payload].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes]) => `${sha(bytes)}  ${name}`).join('\n') + '\n';
payload.set('checksums.sha256', Buffer.from(checksums));
if (JSON.stringify([...payload.keys()].sort()) !== JSON.stringify(releaseFiles)) throw new Error('release_allowlist_mismatch');
fs.mkdirSync(output, { recursive: true });
const archiveFiles = {};
for (const [name, bytes] of payload) {
  const target = path.join(output, releaseName, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  archiveFiles[`${releaseName}/${name}`] = [new Uint8Array(bytes), { mtime: new Date('2026-01-01T00:00:00Z') }];
}
const zipName = `${releaseName}-${releaseVersion}.zip`;
fs.writeFileSync(path.join(output, zipName), zipSync(archiveFiles, { level: 9 }), { flag: 'wx' });
fs.writeFileSync(path.join(output, 'checksums.sha256'), checksums, { flag: 'wx' });
// Outer checksums are emitted only by verify-release after extraction and verification.
console.log(JSON.stringify({ status: 'packaged_requires_verification', files: payload.size, zipName }));
