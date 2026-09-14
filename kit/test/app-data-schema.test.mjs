// manifest の resources[].schema (data の形の宣言): CPOS と同じ規則で kit が検査し、KIT 模擬サーバが書込を 400 にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkResourceSchema, validateAgainstSchema } from '../app-data-schema.js';
import { validateManifest } from '../manifest.js';
import { createFakeCpos } from '../fake/server.js';
import { createCposClient, CposApiError } from '../client.js';

const good = { type: 'object', properties: { text: { type: 'string' }, recordedAt: { type: 'string', format: 'date-time' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] };

test('宣言の検査: 対応外のキーワード・型・format、トップが object でない、properties 空、を CPOS と同じ文言で落とす', () => {
  assert.deepEqual(checkResourceSchema(good), []);
  const bad = checkResourceSchema({ type: 'object', properties: { n: { type: 'string', minLength: 1, pattern: 'x' } } });
  assert.equal(bad.length, 2);
  assert.match(bad[0].message, /CPOS が検証しません/);
  assert.equal(bad[0].path, 'properties.n.minLength');
  assert.deepEqual(checkResourceSchema({ type: 'array', items: { type: 'string' } }).map((i) => i.path), ['(全体)', 'properties']);
  assert.match(checkResourceSchema({ type: 'object', properties: { d: { type: 'string', format: 'email' } } })[0].message, /未対応の format: email/);
  assert.match(checkResourceSchema({ type: 'object', properties: { d: { type: 'money' } } })[0].message, /未対応の型: money/);
});

test('data の照合: 型・必須・enum・format・宣言に無い項目', () => {
  assert.deepEqual(validateAgainstSchema({ text: 'a', recordedAt: '2026-09-14T10:00:00Z', tags: ['x'] }, good), []);
  const issues = validateAgainstSchema({ recordedAt: '昨日', tags: [1] }, good);
  assert.deepEqual(issues.map((i) => i.path).sort(), ['recordedAt', 'tags[0]', 'text']);
  assert.match(issues.find((i) => i.path === 'text').message, /必須/);
  assert.match(validateAgainstSchema({ s: 'c' }, { type: 'object', properties: { s: { type: 'string', enum: ['a', 'b'] } } })[0].message, /いずれかのはず/);
  assert.equal(validateAgainstSchema({ a: 1, b: 2 }, { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: false })[0].path, 'b');
  assert.deepEqual(validateAgainstSchema(undefined, undefined), []);
});

test('validateManifest: schema の不備は error、apps:admin は error、isPublic は warning、tokenDelivery は pattern で検査', () => {
  const base = { appId: 'demo', name: 'x', url: 'https://demo.example', apiTokenScopes: ['facilities:read'] };
  assert.equal(validateManifest({ ...base, resources: [{ name: 'notes', schema: good }] }).ok, true);
  const r1 = validateManifest({ ...base, resources: [{ name: 'notes', schema: { type: 'object', properties: { n: { type: 'string', pattern: 'x' } } } }] });
  assert.equal(r1.ok, false); assert.match(r1.errors[0], /resources\[0\]\.schema properties\.n\.pattern/);
  const r2 = validateManifest({ ...base, apiTokenScopes: ['facilities:read', 'apps:admin'] });
  assert.equal(r2.ok, false); assert.match(r2.errors[0], /apps:admin/);
  const r3 = validateManifest({ ...base, isPublic: true });
  assert.equal(r3.ok, true); assert.ok(r3.warnings.some((w) => /isPublic/.test(w)));
  assert.equal(validateManifest({ ...base, tokenDelivery: { secretManager: { secret: 'cpos-app-token-demo', project: 'my-project-1' } } }).ok, true);
  const r4 = validateManifest({ ...base, tokenDelivery: { secretManager: { secret: 'bad name!' } } });
  assert.equal(r4.ok, false); assert.match(r4.errors[0], /tokenDelivery\.secretManager\.secret/);
});

test('KIT 模擬サーバ: manifest に schema があれば、合わない data の作成・更新を 400 (issues 付き) にする', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpos-kit-schema-'));
  const manifest = join(dir, 'cpos.manifest.json');
  writeFileSync(manifest, JSON.stringify({ appId: 'demo', name: 'x', apiTokenScopes: ['app-data:demo:read', 'app-data:demo:write', 'facilities:read'], resources: [{ name: 'notes', schema: good }, { name: 'free' }] }));
  const fake = createFakeCpos({ manifest });
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const ok = await c.appData('demo').create('notes', { text: 'hello' }, { facilityId: 'fac_sakura' });
  assert.ok(ok.id);
  await assert.rejects(c.appData('demo').create('notes', { recordedAt: 'x' }, { facilityId: 'fac_sakura' }), (e) => e instanceof CposApiError && e.status === 400 && /Manifest 宣言と合いません/.test(e.error) && e.code === 'schema_mismatch');
  await assert.rejects(c.appData('demo').update('notes', ok.id, { text: 1 }, { facilityId: 'fac_sakura' }), (e) => e.status === 400);
  // 宣言の無いリソースは今までどおり素通し
  const free = await c.appData('demo').create('free', { anything: [1, 2] }, { facilityId: 'fac_sakura' });
  assert.ok(free.id);
});
