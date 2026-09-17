// このアプリが CPOS から読み書きできることを確かめる。
//   - ソケットは使わない (AI エージェントのサンドボックスでは TCP の listen が禁止されていることがある)
//   - 事業所 ID を固定しない (KIT 模擬サーバの seed の ID を書くと本物では 404 になり、二度と本物で流せない)
//   - {{APP}}_CPOS_BASE_URL と {{APP}}_CPOS_APP_TOKEN があれば、その CPOS (ステージング等) に本当に繋ぐ

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCposClient } from '@cpos/kit/client';
import { createFakeCpos } from '@cpos/kit/fake';
import { cposForTests, pickFacilities } from '@cpos/kit/testing';
import { readManifest } from '@cpos/kit/manifest';
import { createApp } from '../server.mjs';

let app, env, main, other, cpos;
const written = [];   // 本物に書いた記録の id。テストの最後に消す (KIT 模擬サーバでは消す必要が無いが同じ道を通す)

before(async () => {
  env = cposForTests({ envPrefix: '{{APP}}', createFakeCpos });
  cpos = createCposClient({ baseUrl: env.baseUrl, token: env.token, fetch: env.fetch });
  [main, other] = await pickFacilities(cpos, 2);          // どの CPOS でも「見てよい事業所」から選ぶ
  app = createApp({ cposBaseUrl: env.baseUrl, cposToken: env.token, cposFetch: env.fetch, appDataAppId: env.appDataAppId });
});

after(async () => {
  for (const id of written) await cpos.appData(env.appDataAppId ?? '{{appId}}').remove('notes', id, { facilityId: main.id }).catch(() => {});
});

const q = (path, facilityId) => `${path}?facilityId=${encodeURIComponent(facilityId)}`;

test('cpos.manifest.json を配信していて、形が正しい', async () => {
  const res = await app.inject('GET', '/cpos.manifest.json');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).appId, '{{appId}}');
  assert.deepEqual(readManifest(new URL('../cpos.manifest.json', import.meta.url)).errors, []);
});

test('事業所の一覧が取れ、事業所を指定して利用者一覧が取れる', async () => {
  const facilities = await (await app.inject('GET', '/api/facilities')).json();
  assert.ok(facilities.some((f) => f.id === main.id));
  const res = await app.inject('GET', q('/api/users', main.id));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const users = JSON.parse(text);
  assert.ok(Array.isArray(users));
  assert.ok(users.every((u) => typeof u.masterUserId === 'string' && typeof u.name === 'string'));
});

test('メモを保存すると利用者 1 人に 1 件で、事業所をまたいで見えない', async (t) => {
  // 本物 (ステージング) でも書く。トークンに app-data:{{appId}}:write が無ければ 403 になるので、そのときだけ skip (理由を出す)
  const users = await (await app.inject('GET', q('/api/users', main.id))).json();
  if (users.length === 0) return t.skip('この事業所に利用者がいない');
  const body = (text) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facilityId: main.id, masterUserId: users[0].masterUserId, text }) });
  const first = await app.inject('POST', '/api/notes', body('1 回目'));
  const firstText = await first.text();
  if (env.external && first.status === 403) return t.skip(`本物の CPOS が 403: ${firstText.slice(0, 120)}`);
  assert.equal(first.status, 201, firstText);
  written.push(JSON.parse(firstText).id);
  const second = await app.inject('POST', '/api/notes', body('2 回目'));
  const secondText = await second.text();
  assert.equal(second.status, 201, secondText);
  written.push(JSON.parse(secondText).id);
  const mine = (await (await app.inject('GET', q('/api/notes', main.id))).json()).filter((n) => n.data.masterUserId === users[0].masterUserId);
  assert.equal(mine.length, 1, '同じ利用者に 2 回保存しても 1 件');
  assert.equal(mine[0].data.text, '2 回目');
  const theirs = await (await app.inject('GET', q('/api/notes', other.id))).json();
  assert.ok(!theirs.some((n) => n.data.masterUserId === users[0].masterUserId), '別の事業所からは見えない');
});

test('見てよい事業所に無い ID は CPOS に行く前に止まり、理由が返る', async () => {
  const res = await app.inject('GET', q('/api/users', 'no-such-facility'));
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.match(j.hint ?? j.message, /事業所/);
});

test('本文が壊れていれば 400 で、CPOS には行かない', async () => {
  const res = await app.inject('POST', '/api/notes', { body: '{' });
  assert.equal(res.status, 400);
});

test('保存したものは 1 件で取れ、変更でき、取り消せる (一覧から消える)', async (t) => {
  // 保存できるものは直せるようにする。CRUD の手本。app.inject での PUT / DELETE の書き方もここに置く
  const users = await (await app.inject('GET', q('/api/users', main.id))).json();
  if (users.length === 0) return t.skip('この事業所に利用者がいない');
  const body = (o) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  const created = await app.inject('POST', '/api/notes', body({ facilityId: main.id, masterUserId: users[0].masterUserId, text: '最初' }));
  const createdText = await created.text();
  if (env.external && created.status === 403) return t.skip(`本物の CPOS が 403: ${createdText.slice(0, 120)}`);
  assert.equal(created.status, 201, createdText);
  const id = JSON.parse(createdText).id;
  written.push(id);

  const got = await app.inject('GET', q(`/api/notes/${id}`, main.id));
  assert.equal(got.status, 200);
  assert.equal((await got.json()).data.text, '最初');

  const updated = await app.inject('PUT', `/api/notes/${id}`, body({ facilityId: main.id, text: '直した' }));
  assert.equal(updated.status, 200, await updated.text());
  assert.equal((await (await app.inject('GET', q(`/api/notes/${id}`, main.id))).json()).data.text, '直した');

  const removed = await app.inject('DELETE', q(`/api/notes/${id}`, main.id));
  assert.equal(removed.status, 204);
  const after = await (await app.inject('GET', q('/api/notes', main.id))).json();
  assert.ok(!after.some((n) => n.id === id), '取り消したものは一覧に残らない');
  written.splice(written.indexOf(id), 1);   // 消したので後片付け不要
});
