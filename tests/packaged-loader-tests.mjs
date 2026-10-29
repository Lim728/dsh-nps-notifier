// Real Loader, packaged entry and child IPC; HTTP is restricted to this test's loopback stub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boot } from '@deepseek-ai/dsh-app-boot';

const packageDir = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const entry = pathToFileURL(path.join(packageDir, 'lib', 'index.js')).href;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nps-loader-'));
const contexts = [], payloads = [], rows = new Map();
let count = 0, serial = 0;
const check = (value, message) => { assert.ok(value, message); count++; };
const equal = (a, b, message) => { assert.deepEqual(a, b, message); count++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause(10);
  check(predicate(), message);
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/state') {
    res.end(JSON.stringify({ ok: true, finishedWidgetRetentionSec: 1, sessions: [...rows.values()] })); return;
  }
  if (req.method !== 'POST' || req.url !== '/notify') { res.writeHead(404).end('{}'); return; }
  let text = '';
  req.on('data', chunk => { text += chunk; if (text.length > 4096) req.destroy(); });
  req.on('end', () => {
    const p = JSON.parse(text); payloads.push(p);
    const previous = rows.get(p.source);
    if (!p.heartbeat) rows.set(p.source, {
      source: p.source, status: p.status, taskId: p.taskId ?? previous?.taskId ?? null,
      eventTime: p.timestamp, terminalSinceUtc: ['finished', 'error', 'closed'].includes(p.status) ? new Date().toISOString() : null,
      autoClosed: false,
    });
    res.end(JSON.stringify({ ok: true, source: p.source, status: p.status, heartbeat: p.heartbeat === true }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
check(port !== 17877, 'the real NPS port is never used');

async function fixture({ legacy = false, disabledLegacy = false, duplicate = false } = {}) {
  const dir = path.join(home, String(++serial)); fs.mkdirSync(dir);
  const config = path.join(dir, 'cordis.yml');
  const entries = [{ id: 'nps-notifier', name: entry, config: { port } }];
  if (legacy || disabledLegacy) entries.unshift({ id: 'nps-dsh-bounded-observer', name: 'cordis:legacy', disabled: disabledLegacy });
  if (duplicate) entries.push({ id: 'nps-notifier-duplicate', name: entry, config: { port } });
  fs.writeFileSync(config, JSON.stringify(entries));
  const registry = new Map(), callbacks = new Set();
  const ctx = await boot('nps-test', config, [], host => {
    host.provide('profileContext', { dir });
    host.provide('agents', { get: id => registry.get(id) });
    host.provide('appReady', { onReady(fn) { callbacks.add(fn); return () => callbacks.delete(fn); } });
    host.loader.builtins.legacy = { name: 'legacy-fixture', apply() {} };
  });
  contexts.push(ctx);
  return { ctx, dir, callbacks, registry, ready() { for (const fn of [...callbacks]) fn(); },
    bridge() { try { return JSON.parse(fs.readFileSync(path.join(dir, 'nps-notifier', 'bridge-status.json'), 'utf8')); } catch { return null; } } };
}
function agent(f, id) {
  const a = { session: { id }, status: 'idle', inbox: { hasPending: false }, whenIdle: async () => {} };
  f.registry.set(id, a); return a;
}
function event(f, a, type, turn, seq, reason = 'completed') {
  f.ctx.emit('session/event', a.session, { type, seq, time: Date.now(), data: { turn, reason: { kind: reason } } });
}
async function task(f, a, turn, reason = 'completed') {
  const begin = payloads.length;
  a.status = 'running'; f.ctx.emit('agent/status', { agent: a, status: 'running' });
  event(f, a, 'turn/start', turn, turn * 2);
  await until(() => payloads.slice(begin).some(p => p.status === 'working'), 'working reaches the test HTTP endpoint');
  event(f, a, 'turn/end', turn, turn * 2 + 1, reason);
  a.status = 'idle'; f.ctx.emit('agent/status', { agent: a, status: 'idle' });
  const expected = { completed: 'finished', error: 'error', aborted: 'closed' }[reason];
  await until(() => payloads.slice(begin).some(p => p.status === expected), 'paired terminal reaches the endpoint');
  return begin;
}
try {
  const f = await fixture();
  check(!fs.existsSync(path.join(f.dir, 'nps-notifier')), 'Loader registration does not spawn before appReady');
  const captureBase=path.join(f.dir,'nps-notifier');fs.mkdirSync(captureBase);
  fs.writeFileSync(path.join(captureBase,'reception-request.json'),JSON.stringify({id:'abcdef1234567890',expires:Date.now()+600000}));
  const readyCallback = [...f.callbacks][0];
  readyCallback(); readyCallback();
  await until(() => f.bridge()?.phase === 'ready', 'packaged worker handshake succeeds');
  const instance = f.bridge().instance;
  equal(f.callbacks.size, 0, 'one-shot appReady registration removed');
  const a = agent(f, 'synthetic-session');
  f.ctx.emit('agent/created', { agent: a, source: 'startup' });
  await until(() => payloads.some(p => p.status === 'running'), 'fresh idle is sent');
  const source = payloads[0].source;
  const begin = await task(f, a, 1);
  const captured=fs.readFileSync(path.join(captureBase,'reception-abcdef1234567890','records.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  for(const stage of ['published','global_subscriber','subscriber','observer','accepted','enqueue']) {
    check(captured.some(r=>r.stage===stage&&r.type==='turn/start'&&r.turn===1&&r.source===source&&r.sameSession===true),'real Loader capture identifies each admission stage');
  }
  check(captured.some(r=>r.stage==='idle_after_event'&&r.type==='turn/start'&&r.idleAcknowledged===false),'capture observes idle revocation without changing it');
  await until(() => payloads.slice(begin).filter(p => p.status === 'running').length === 1, 'finished retention resumes running');
  equal(payloads.map(p => p.status), ['running', 'working', 'finished', 'running'], 'complete lifecycle sequence');
  check(payloads.every(p => p.source === source), 'identity survives recovery');
  equal(f.bridge().instance, instance, 'duplicate readiness never replaces worker identity');
  await task(f, a, 2, 'error');
  const locked = payloads.length; await pause(1300);
  equal(payloads.length, locked, 'error never resumes running');
  await task(f, a, 3, 'aborted');
  equal(payloads.at(-1).status, 'closed', 'aborted is not success');
  const snapshot = payloads.length;
  await f.ctx.fiber.dispose();
  event(f, a, 'turn/start', 4, 8); await pause(150);
  equal(payloads.length, snapshot, 'unload forbids sends');
  equal(f.bridge()?.phase, 'stopped', 'worker is explicitly stopped');

  const early = await fixture(), late = [...early.callbacks][0];
  await early.ctx.fiber.dispose(); late(); await pause(50);
  check(!fs.existsSync(path.join(early.dir, 'nps-notifier')), 'unload cancels pending startup');
  const legacy = await fixture({ legacy: true });
  equal(legacy.callbacks.size, 0, 'enabled legacy adapter rejects builtin startup');
  legacy.ready(); await pause(50);
  check(!fs.existsSync(path.join(legacy.dir, 'nps-notifier')), 'legacy conflict never spawns another forwarder');
  const duplicate = await fixture({ duplicate: true });
  check(duplicate.callbacks.size <= 1, 'duplicate mount cannot register two forwarders');
  await duplicate.ctx.fiber.dispose();
  const changed = await fixture({ disabledLegacy: true }); changed.ready();
  await until(() => changed.bridge()?.phase === 'ready', 'disabled legacy does not prevent builtin startup');
  const legacyEntry = [...changed.ctx.loader.entries()].find(e => e.options.id === 'nps-dsh-bounded-observer');
  await legacyEntry.update({ disabled: false });
  equal(changed.bridge()?.phase, 'stopped', 'late legacy activation stops builtin before forwarding can overlap');
  equal(payloads.length, snapshot, 'failed composition cannot forward');
  console.log(JSON.stringify({ suite: 'packaged Loader + real child IPC + isolated HTTP stub', passed: count, failed: 0, skipped: 0, realNpsRequests: 0 }));
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const resolved = fs.realpathSync(home), parent = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase() || !path.basename(resolved).startsWith('dsh-nps-loader-')) throw new Error('cleanup_boundary');
  fs.rmSync(resolved, { recursive: true, force: true });
}
