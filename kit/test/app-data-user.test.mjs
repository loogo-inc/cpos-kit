// AppData の行を利用者に紐づける (封筒の insuredNumber)。client の { user } と、KIT 模擬サーバでの振る舞い。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCpos } from '../fake/server.js';
import { createCposClient, CposClientError, displayInsuredNumber } from '../client.js';

const f = 'fac_sakura';

function spyClient() {
  const seen = [];
  const c = createCposClient({
    baseUrl: 'http://x', token: 'cpos_app_x',
    fetch: async (url, init) => { seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) }); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); }
  });
  return { c, seen };
}

test('user を付けなければ今までと同じ本文・同じ URL。付けると封筒の insuredNumber と ?insuredNumber= になる', async () => {
  const { c, seen } = spyClient();
  const d = c.appData('demo');
  await d.create('notes', { text: 'a' }, { facilityId: f });
  assert.deepEqual(seen.at(-1).body, { data: { text: 'a' }, facilityId: f });
  await d.create('notes', { text: 'a' }, { facilityId: f, user: 'mu_0021' });
  assert.deepEqual(seen.at(-1).body, { data: { text: 'a' }, facilityId: f, insuredNumber: 'mu_0021' });
  await d.update('notes', 'n1', { text: 'b' }, { facilityId: f });
  assert.deepEqual(seen.at(-1).body, { data: { text: 'b' } });
  await d.update('notes', 'n1', { text: 'b' }, { facilityId: f, user: 'mu_0021' });
  assert.deepEqual(seen.at(-1).body, { data: { text: 'b' }, insuredNumber: 'mu_0021' });
  await d.list('notes', { facilityId: f });
  assert.ok(!new URL(seen.at(-1).url).searchParams.has('insuredNumber'));
  await d.list('notes', { facilityId: f, user: 'mu_0021' });
  assert.equal(new URL(seen.at(-1).url).searchParams.get('insuredNumber'), 'mu_0021');
});

test('user が文字列でなければ CPOS に行く前に止まる', async () => {
  const { c, seen } = spyClient();
  const d = c.appData('demo');
  for (const user of ['', '  ', 123, { masterUserId: 'mu_0001' }]) {
    await assert.rejects(d.create('notes', { a: 1 }, { facilityId: f, user }), (e) => e instanceof CposClientError && /masterUserId/.test(e.hint), JSON.stringify(user));
  }
  await assert.rejects(d.list('notes', { facilityId: f, user: 1 }), (e) => e instanceof CposClientError);
  assert.equal(seen.length, 0);
});

test('KIT 模擬サーバ: user で作った行は本人に紐づき、どのキーの user でも一覧で引ける', async () => {
  const fake = createFakeCpos();
  const d = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch }).appData('demo');
  const r = await d.create('notes', { text: 'x' }, { facilityId: f, user: 'mu_0021' });
  assert.deepEqual([r.insuredNumber, r.masterUserId], ['0000000121', 'mu_0021']);
  await d.create('notes', { text: 'y' }, { facilityId: f, user: 'mu_0002' });
  await d.create('notes', { text: 'z' }, { facilityId: f });
  for (const user of ['mu_0021', '0000000121', '0000000021']) {
    assert.deepEqual((await d.list('notes', { facilityId: f, user })).map((x) => x.data.text), ['x'], user);
  }
  assert.equal((await d.list('notes', { facilityId: f })).length, 3, 'user を付けなければ全部 (今までどおり)');
});

test('upsertBy に user: 本人の行を CPOS 側で絞って更新し、紐づけ前の行は keyField が本人キーのときだけ拾って紐づける', async () => {
  const fake = createFakeCpos();
  const d = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch }).appData('demo');
  // 1. 紐づけ前 (data にしか本人がいない) の古い行
  const legacy = await d.create('notes', { masterUserId: 'mu_0001', text: '古い' }, { facilityId: f });
  assert.equal(legacy.insuredNumber, null);
  // 2. user 付きの upsert は古い行を拾って更新し、本人に紐づける (重複を作らない)
  const up = await d.upsertBy('notes', 'masterUserId', { masterUserId: 'mu_0001', text: '新しい' }, { facilityId: f, user: 'mu_0001' });
  assert.equal(up.id, legacy.id, '古い行を更新する (2 件目を作らない)');
  assert.deepEqual([up.insuredNumber, up.masterUserId, up.data.text], ['0000000001', 'mu_0001', '新しい']);
  // 3. 以後は CPOS 側の絞り込みで当たる (一覧を全部取らない)
  const before = fake.state.requests.length;
  const again = await d.upsertBy('notes', 'masterUserId', { masterUserId: 'mu_0001', text: '3 回目' }, { facilityId: f, user: 'mu_0001' });
  assert.equal(again.id, legacy.id);
  assert.equal(fake.state.requests.length - before, 2, '絞った一覧 1 回 + 更新 1 回');
  assert.equal((await d.list('notes', { facilityId: f })).length, 1);
  // 4. 無ければ本人に紐づけて作る
  const created = await d.upsertBy('notes', 'masterUserId', { masterUserId: 'mu_0022', text: 'x' }, { facilityId: f, user: 'mu_0022' });
  assert.deepEqual([created.insuredNumber, created.masterUserId], ['tmp-k7Qm2xLp', 'mu_0022']);
});

test('upsertBy に user: keyField が本人キーでなければ、紐づけ前の他人の行を付け替えない', async () => {
  const fake = createFakeCpos();
  const d = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_x', fetch: fake.fetch }).appData('demo');
  const someoneElse = await d.create('plans', { month: '2026-09', masterUserId: 'mu_0002' }, { facilityId: f });
  const mine = await d.upsertBy('plans', 'month', { month: '2026-09', masterUserId: 'mu_0003' }, { facilityId: f, user: 'mu_0003' });
  assert.notEqual(mine.id, someoneElse.id, '同じ month でも別の人の行は更新しない');
  assert.equal(mine.masterUserId, 'mu_0003');
  const untouched = await d.get('plans', someoneElse.id, { facilityId: f });
  assert.deepEqual([untouched.data.masterUserId, untouched.insuredNumber], ['mu_0002', null]);
});

test('displayInsuredNumber: CPOS が返した値を優先し、無ければ仮番号 (tmp-*) と mu を出さない', () => {
  assert.equal(displayInsuredNumber({ insuredNumber: '0000000001' }), '0000000001');
  assert.equal(displayInsuredNumber({ insuredNumber: 'tmp-k7Qm2xLp' }), null);
  assert.equal(displayInsuredNumber({ insuredNumber: 'mu_abcdef12' }), null);
  assert.equal(displayInsuredNumber({ insuredNumber: '0000000001', displayInsuredNumber: null }), null, 'CPOS が null と言えば出さない');
  assert.equal(displayInsuredNumber({ insuredNumber: 'tmp-x', displayInsuredNumber: '0000000009' }), '0000000009');
  assert.equal(displayInsuredNumber({}), null);
  assert.equal(displayInsuredNumber(null), null);
  assert.equal(displayInsuredNumber({ insuredNumber: 'mu_ab' }), 'mu_ab', 'CPOS の正本と同じく mu_ + 6 文字未満は mu と見なさない');
});

test('upsertBy が探す一覧は CPOS のキャッシュを素通しする (Cache-Control: no-cache)。ふつうの list は付けない', async () => {
  const { c, seen } = spyClient();
  const d = c.appData('demo');
  await d.upsertBy('notes', 'masterUserId', { masterUserId: 'mu_0001', text: 'a' }, { facilityId: f, user: 'mu_0001' });
  const gets = seen.filter((r) => r.method === 'GET');
  assert.ok(gets.length >= 1 && gets.every((r) => r.headers['Cache-Control'] === 'no-cache'), JSON.stringify(gets.map((g) => g.headers)));
  await d.list('notes', { facilityId: f });
  assert.equal(seen.at(-1).headers['Cache-Control'], undefined);
});
