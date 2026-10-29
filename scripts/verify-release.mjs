import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { releaseFiles, releaseName, releaseVersion } from './release-files.mjs';

if (process.argv.length !== 3) throw new Error('usage: <release-output-directory>');
const root = path.resolve(process.argv[2]);
const zipName = `${releaseName}-${releaseVersion}.zip`;
const zipBytes = fs.readFileSync(path.join(root, zipName));
const entries = unzipSync(zipBytes);
const expected = releaseFiles.map(x => `${releaseName}/${x}`).sort();
if (JSON.stringify(Object.keys(entries).sort()) !== JSON.stringify(expected)) throw new Error('archive_allowlist_mismatch');
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nps-release-verify-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const name of expected) {
    const target = path.join(extracted, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entries[name], { flag: 'wx' });
    if (!fs.readFileSync(target).equals(fs.readFileSync(path.join(root, name)))) throw new Error('archive_tree_mismatch');
  }
  const inside = fs.readFileSync(path.join(extracted, releaseName, 'checksums.sha256'));
  if (!inside.equals(fs.readFileSync(path.join(root, 'checksums.sha256')))) throw new Error('checksum_attachment_mismatch');
  const names = new Set();
  for (const line of inside.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || names.has(match[2]) || !releaseFiles.includes(match[2]) || match[2] === 'checksums.sha256') throw new Error('invalid_checksum_entry');
    names.add(match[2]);
    if (sha(fs.readFileSync(path.join(extracted, releaseName, match[2]))) !== match[1]) throw new Error('checksum_mismatch');
  }
  if (names.size !== releaseFiles.length - 1) throw new Error('incomplete_checksum_coverage');
  const outer = `${sha(zipBytes)}  ${zipName}\n${sha(inside)}  checksums.sha256\n`;
  const outerPath = path.join(root, 'release-checksums.sha256');
  if (fs.existsSync(outerPath)) {
    if (fs.readFileSync(outerPath, 'utf8') !== outer) throw new Error('outer_checksum_mismatch');
  } else fs.writeFileSync(outerPath, outer, { flag: 'wx' });
  console.log(JSON.stringify({ status: 'verified', extractedFiles: expected.length, checksumEntries: names.size, attachments: [zipName, 'checksums.sha256', 'release-checksums.sha256'].map(name => ({ name, bytes: fs.statSync(path.join(root, name)).size, sha256: sha(fs.readFileSync(path.join(root, name))) })) }));
} finally {
  // Delete only this invocation's checked temporary extraction directory.
  if (path.dirname(extracted) !== os.tmpdir() || !path.basename(extracted).startsWith('dsh-nps-release-verify-')) throw new Error('cleanup_boundary');
  fs.rmSync(extracted, { recursive: true });
}
