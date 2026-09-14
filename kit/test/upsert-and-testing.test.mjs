import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCpos } from '../fake/server.js';
import { createCposClient, CposClientError } from '../client.js';
import { pickFacilities, cposForTests } from '../testing.js';

test('upsertBy は同じキーなら update、無ければ create', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const d = c.appData('demo');
  const a = await d.upsertBy('plans', 'masterUserId', { masterUserId: 'mu_1', morning: true }, { facilityId: 'fac_sakura' });
  const b = await d.upsertBy('plans', 'masterUserId', { masterUserId: 'mu_1', evening: true }, { facilityId: 'fac_sakura' });
  assert.equal(a.id, b.id);
  assert.deepEqual(b.data, { masterUserId: 'mu_1', morning: true, evening: true });
  assert.equal((await d.list('plans', { facilityId: 'fac_sakura' })).length, 1);
  await assert.rejects(d.upsertBy('plans', 'masterUserId', { morning: true }, { facilityId: 'fac_sakura' }), (e) => e instanceof CposClientError);
  await assert.rejects(d.upsertBy('plans', 'masterUserId', { masterUserId: 'mu_2' }), (e) => /scope: 'organization'/.test(e.hint));
});

test('resource 名は a-z 0-9 ハイフンだけ (本物と同じ)。client も KIT 模擬サーバも止める', async () => {
  const fake = createFakeCpos();
  const c = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  await assert.rejects(c.appData('demo').list('transportPlans', { facilityId: 'fac_sakura' }), (e) => e instanceof CposClientError && /transport-plans/.test(e.hint));
  await assert.rejects(c.raw('GET', '/api/app-data/demo/transportPlans'), (e) => e.status === 400 && /resource の形式が不正/.test(e.error));
  // 方針 (所有者 2026-09-13 / 2026-09-14): CPOS にあるものは全部使ってよい。止めるのは「OpenAPI に無いパス」と「事業所 ID の付け忘れ」だけ。
  await assert.rejects(c.raw('GET', '/api/transport/plans'), (e) => e instanceof CposClientError && /facilityId/.test(e.message), '事業所 ID が無ければ止める');
  await assert.rejects(c.raw('GET', '/api/transport/plans', { facilityId: 'fac_sakura' }), (e) => e.status === 501, '事業所 ID があれば CPOS に届く (模擬サーバには無いので 501)');
  await assert.rejects(c.raw('GET', '/api/not-in-openapi', { facilityId: 'f' }), (e) => /OpenAPI/.test(e.message), 'OpenAPI に無いパスは通さない');
  const { validateManifest } = await import('../manifest.js');
  const r = validateManifest({ appId: 'demo', name: 'x', resources: [{ name: 'transportPlans' }] });
  assert.ok(r.errors.some((m) => m.startsWith('resources[0].name')));
});

test('pickFacilities は見てよい事業所から選び、足りなければ例外。prefer で並べ替え', async () => {
  const fake = createFakeCpos();
  const admin = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch });
  const [day] = await pickFacilities(admin, 1, { prefer: /デイ/ });
  assert.equal(day.id, 'fac_momiji');
  const limited = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_limited', fetch: fake.fetch });
  await assert.rejects(pickFacilities(limited, 2), /事業所が 2 件必要/);
});

test('cposForTests は env が無ければ KIT 模擬サーバ', () => {
  const env = cposForTests({ envPrefix: 'NOPE_' + Date.now(), createFakeCpos });
  assert.equal(env.external, false);
  assert.equal(typeof env.fetch, 'function');
});
