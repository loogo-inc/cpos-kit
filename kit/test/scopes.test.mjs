// scopes: CPOS が知る全スコープ (kit/scopes.json) と、ソースから必要なスコープを出す CLI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadApi } from '../client.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = resolve(root, 'kit', 'bin', 'cpos-kit.mjs');
const table = JSON.parse(readFileSync(resolve(root, 'kit', 'scopes.json'), 'utf8'));

test('scopes.json: operation が要求するスコープは全部一覧にあり、雛形は {appId} を含む 4 種', () => {
  const known = new Set(table.scopes.map((s) => s.name));
  for (const o of loadApi().operations) if (o.scope) assert.ok(known.has(o.scope), o.scope);
  assert.ok(table.scopes.length >= 100);
  assert.deepEqual(table.scopes.filter((s) => s.template).map((s) => s.name).sort(), ['app-data:{appId}:delete', 'app-data:{appId}:read', 'app-data:{appId}:write', 'apps:{appId}:ai:run']);
  assert.equal(table.generatedFrom.revision, loadApi().generatedFrom.revision);
});

test('scopes --used: ソースが呼ぶメソッドから必要なスコープを出し、manifest に足りないものを示す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpos-kit-scopes-'));
  writeFileSync(join(dir, 'cpos.manifest.json'), JSON.stringify({ appId: 'demo', name: 'x', apiTokenScopes: ['facilities:read', 'alerts:read'] }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'server.mjs'), [
    "const plans = await cpos.app.transport.getPlans({ facilityId });",
    "const users = await cpos.masterUsers.list({ facilityId });",
    "await cpos.appData('demo').create('notes', { a: 1 }, { facilityId });",
    "await cpos.raw('GET', '/api/care-documents/v1', { facilityId });",
    "await cpos.app.nope.nothing();",
  ].join('\n'));
  const r = spawnSync(process.execPath, [cli, 'scopes', '--used'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CPOS_URL: '', CPOS_TOKEN: '' } });
  assert.equal(r.status, 0, r.stderr);
  for (const s of ['transport:read', 'master-users:read', 'app-data:demo:write', 'care-documents:read']) assert.match(r.stdout, new RegExp(s), s);
  assert.match(r.stdout, /apiTokenScopes に足す/);
  assert.match(r.stdout, /"transport:read"/);
  assert.match(r.stdout, /manifest にあるがソースは使っていない: .*alerts:read/);
  assert.match(r.stdout, /cpos\.app\.nope\.nothing \(api\.d\.ts に無い\)/);
  const list = spawnSync(process.execPath, [cli, 'scopes', '送迎'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CPOS_URL: '', CPOS_TOKEN: '' } });
  assert.match(list.stdout, /transport:read/);
  assert.match(list.stdout, /cpos\.app\.transport\.getPlans/);
});
