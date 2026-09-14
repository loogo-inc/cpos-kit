// 生成された client (kit/api.json → cpos.app.* / cpos.session.*)。1 operation = 1 メソッド。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCposClient, CposClientError, CposApiError, loadApi, lookupOperation, pathMatches } from '../client.js';
import { createFakeCpos } from '../fake/server.js';
import { signatureOf } from '../api-sig.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const spec = JSON.parse(readFileSync(resolve(root, 'spec', 'cpos-openapi.json'), 'utf8'));
const api = loadApi();

test('api.json は spec/cpos-openapi.json と同じ operation を持つ (数・id・署名)。生成元の版が刻まれている', () => {
  const ops = Object.entries(spec.paths).flatMap(([p, item]) => Object.entries(item).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(([m, op]) => ({ method: m.toUpperCase(), path: p, op })));
  assert.equal(api.operations.length, ops.length);
  assert.ok(api.operations.length > 1000, `operation が少なすぎる: ${api.operations.length}`);
  const ids = new Set(api.operations.map((o) => o.id));
  for (const { op } of ops) assert.ok(ids.has(op.operationId), `${op.operationId} が api.json に無い`);
  for (const o of api.operations) assert.equal(o.sig, signatureOf(o), `${o.id} の署名が計算と合わない`);
  assert.ok(api.generatedFrom.version && api.generatedFrom.revision && api.generatedFrom.fetchedAt, JSON.stringify(api.generatedFrom));
  assert.equal(spec['x-cpos-kit'].revision, api.generatedFrom.revision);
});

test('実測の証跡 (spec/cpos-live-evidence.json) の operation は全部 api.json に存在する (再生成で黙って消えない)', () => {
  const ev = JSON.parse(readFileSync(resolve(root, 'spec', 'cpos-live-evidence.json'), 'utf8'));
  const ids = new Set(api.operations.map((o) => o.id));
  for (const id of Object.keys(ev.operations)) assert.ok(ids.has(id), `${id} が api.json に無い`);
  for (const o of api.operations) if (o.observed) assert.equal(o.observed.status, ev.operations[o.id].status, o.id);
  assert.ok(Object.keys(ev.operations).length >= 4);
});

test('名前は ns.group.name で一意。app は Bearer か認証なし、session は Cookie 専用', () => {
  const names = api.operations.map((o) => `${o.ns}.${o.group}.${o.name}`);
  assert.equal(new Set(names).size, names.length, '名前の衝突');
  for (const o of api.operations) {
    assert.match(o.group, /^[a-z][A-Za-z0-9]*$/, o.group);
    assert.match(o.name, /^(get|post|put|patch|delete)[A-Za-z0-9_]*$/, o.name);
    if (o.ns === 'session') assert.equal(o.auth, 'session'); else assert.notEqual(o.auth, 'session');
  }
  const t = lookupOperation('GET', '/api/transport/plans');
  assert.equal(`${t.ns}.${t.group}.${t.name}`, 'app.transport.getPlans');
  assert.equal(t.scope, 'transport:read');
  assert.ok(pathMatches('/api/app-data/{appId}/{resource}/{id}', '/api/app-data/demo/notes/n1?x=1'));
  assert.ok(!pathMatches('/api/app-data/{appId}/{resource}', '/api/app-data/demo/notes/n1'));
});

test('生成メソッド: 必須パラメータ・facilityId・body を呼ぶ前に検査し、パスと query を組み立てて呼ぶ', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  // 模擬サーバが応答を持つもの (手書き 5 系統と同じパス) は生成メソッドでも通る
  // (GET /api/platform/me は公式 OpenAPI 上「Cookie 専用」と書かれているので cpos.session 側に生成される。実測では App Token で 200。CPOS 側の記述の問題として課題台帳に記録)
  const facilities = await c.app.platform.getFacilities();
  assert.ok(Array.isArray(facilities) && facilities.length > 0, JSON.stringify(facilities).slice(0, 80));
  const users = await c.app.platform.getMasterUsers({ facilityId: 'fac_sakura' });
  assert.ok(Array.isArray(users) && users.length > 0);
  const fakeOps = api.operations.filter((o) => o.ns === 'app' && o.fake);
  assert.ok(fakeOps.length >= 5, '模擬サーバが応答を持つ app の operation が ' + fakeOps.length + ' 本');
  // facilityId 必須 (OpenAPI で required) は付け忘れで止まる
  await assert.rejects(c.app.transport.getPlans(), (e) => e instanceof CposClientError && /facilityId/.test(e.message));
  // 模擬サーバに無いものは 501 (CPOS 接続待ちにする)
  await assert.rejects(c.app.transport.getPlans({ facilityId: 'fac_sakura' }), (e) => e instanceof CposApiError && e.status === 501 && /ステージング/.test(e.hint));
  // path パラメータの欠け
  const withId = api.operations.find((o) => o.ns === 'app' && o.params.some((p) => p.in === 'path'));
  await assert.rejects(c.app[withId.group][withId.name]({ facilityId: 'f' }), (e) => e instanceof CposClientError && new RegExp(withId.params.find((p) => p.in === 'path').name).test(e.message));
  // 組み立て: path の置換と query
  let seen = null;
  const spy = createCposClient({ baseUrl: 'http://x', token: 'cpos_app_x', fetch: async (url, init) => { seen = { url: String(url), init }; return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  await spy.app.transport.getPlans({ facilityId: 'fac_sakura', serviceDate: '2026-09-14' });
  assert.equal(seen.url, 'http://x/api/transport/plans?facilityId=fac_sakura&serviceDate=2026-09-14');
  assert.equal(seen.init.headers['X-Cpos-Facility-Id'], 'fac_sakura');
  const byId = api.operations.find((o) => o.path === '/api/app-data/{appId}/{resource}/{id}' && o.method === 'GET');
  await spy.app[byId.group][byId.name]({ appId: 'demo', resource: 'notes', id: 'n 1', facilityId: 'f' });
  assert.equal(seen.url, 'http://x/api/app-data/demo/notes/n%201?facilityId=f');
});

test('session (Cookie 専用) は cookie を渡したときだけ呼べる。raw() は OpenAPI に無いパスを拒む', async () => {
  const fake = createFakeCpos();
  const noCookie = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const s = api.operations.find((o) => o.ns === 'session');
  await assert.rejects(noCookie.session[s.group][s.name]({ facilityId: 'f' }), (e) => e instanceof CposClientError && /Cookie/.test(e.message) && /app-kit/.test(e.hint));
  const withCookie = createCposClient({ baseUrl: fake.baseUrl, cookie: 'cpos_session=x', fetch: fake.fetch });
  assert.equal(typeof withCookie.session[s.group][s.name], 'function');
  await assert.rejects(noCookie.raw('GET', '/api/not-in-openapi'), (e) => e instanceof CposClientError && /OpenAPI に無い/.test(e.message));
  await assert.rejects(noCookie.raw('GET', '/api/transport/plans'), (e) => e instanceof CposClientError && /facilityId/.test(e.message));
  await assert.rejects(noCookie.raw('GET', '/api/transport/plans', { facilityId: 'f' }), (e) => e.status === 501);
  assert.equal(noCookie.api.generatedFrom.revision, api.generatedFrom.revision);
});

test('事業所限定トークンが facilityId 無しで一覧を呼ぶと 400 facility-id-required (本物 2026-09 と同じ形)', async () => {
  const fake = createFakeCpos();
  const limited = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_limited', fetch: fake.fetch });
  await assert.rejects(limited.app.platform.getMasterUsers(), (e) => e instanceof CposApiError && e.status === 400 && e.code === 'facility-id-required' && Array.isArray(e.body?.allowedFacilityIds) && e.body.reasonCode === 'facility-id-required');
  const all = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  assert.ok(Array.isArray(await all.app.platform.getMasterUsers()), '全事業所のトークンは facilityId 無しでも通る (本物と同じ)');
});
