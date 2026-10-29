import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1) throw new Error('usage: <release-output-directory>');
const release = path.resolve(args[0]);
const git = argv => execFileSync('git', argv, { cwd: root, encoding: 'utf8', windowsHide: true });
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
if (!staged.length) throw new Error('nothing_staged');
const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['secret_literal', /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["'][^"']{8,}["']/i],
  ['personal_path', /(?:[A-Z]:[\\/]+Users[\\/]+[^\s"'/\\]+|\/Users\/[^/\s]+|\/home\/[^/\s]+)/i],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['credential_url', /https?:\/\/[^/\s:@]+:[^/\s@]+@/i],
];
const forbiddenPath = /(?:^|\/)(?:node_modules|\.git|\.env(?:\..*)?|logs?|records?|sessions?|credentials?|backups?)(?:\/|$)|\.(?:jsonl|log|bak|tmp|pem|key|pfx|tsbuildinfo)$/i;
const findings = [];
let checked = 0;
function scan(name, bytes, area) {
  checked++;
  if (forbiddenPath.test(name)) findings.push({ area, file: name, category: 'excluded_file' });
  const text = bytes.toString('utf8');
  if (text.includes('\0')) findings.push({ area, file: name, category: 'unexpected_binary' });
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const [category, pattern] of patterns) if (pattern.test(line)) findings.push({ area, file: name, line: index + 1, category });
  }
}
for (const name of staged) {
  const bytes = execFileSync('git', ['show', `:${name}`], { cwd: root, windowsHide: true });
  const normalize = value => value.toString('utf8').replace(/\r\n/g, '\n');
  if (normalize(bytes) !== normalize(fs.readFileSync(path.join(root, name)))) throw new Error('staged_worktree_mismatch');
  scan(name, bytes, 'staged');
}
for (const item of fs.readdirSync(release, { withFileTypes: true })) {
  if (!item.isFile()) continue;
  const bytes = fs.readFileSync(path.join(release, item.name));
  if (item.name.endsWith('.zip')) {
    for (const [name, data] of Object.entries(unzipSync(bytes))) scan(name, Buffer.from(data), 'archive');
  } else scan(item.name, bytes, 'attachment');
}
console.log(JSON.stringify({ stagedFiles: staged.length, checkedTextFiles: checked, findings, scope: 'staged bytes and extracted attachment contents; pattern scan plus manual review required' }));
if (findings.length) process.exitCode = 1;
