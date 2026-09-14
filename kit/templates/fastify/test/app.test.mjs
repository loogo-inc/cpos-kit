// このアプリが「ログインした人にだけ、その人が見てよい事業所の CPOS のデータを見せる」ことを確かめる。
//   - ソケットは使わない (KIT 模擬サーバは createFakeCpos、アプリは Fastify の inject)
//   - 事業所 ID を固定しない (pickFacilities)。誰として入るかは seed の accounts から権限で選ぶ
//   - {{APP}}_CPOS_BASE_URL と {{APP}}_CPOS_APP_TOKEN があれば、その CPOS (ステージング等) に本当に繋ぐ。
//     ただしログインは本物では自動化できない (Google) ので、ログインの試験は KIT 模擬サーバでだけ流す

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCposClient } from '@cpos/kit/client';
import { createFakeCpos } from '@cpos/kit/fake';
import { cposForTests, pickFacilities } from '@cpos/kit/testing';
import { sealSession } from '@cpos/kit/app-kit';
import { readManifest } from '@cpos/kit/manifest';
import { createApp } from '../server.mjs';

const SECRET = 'テスト用のセッション秘密 (16 バイト以上)';
let app, env, main, other, cpos, who;
const written = [];   // 本物に書いた記録の id。テストの最後に消す

before(async () => {
  env = cposForTests({ envPrefix: '{{APP}}', createFakeCpos });
  cpos = createCposClient({ baseUrl: env.baseUrl, token: env.token, fetch: env.fetch });
  [main, other] = await pickFacilities(cpos, 2);
  app = createApp({ cposBaseUrl: env.baseUrl, cposToken: env.token, cposFetch: env.fetch, appDataAppId: env.appDataAppId, sessionSecret: SECRET, loginMode: 'auto' });
  await app.ready();
  const accounts = env.fake?.seed.accounts ?? [];
  who = {
    all: accounts.find((a) => a.allowedFacilityIds === null),
    limited: accounts.find((a) => Array.isArray(a.allowedFacilityIds) && a.allowedFacilityIds.length > 0),
    none: accounts.find((a) => Array.isArray(a.allowedFacilityIds) && a.allowedFacilityIds.length === 0)
  };
});
after(async () => {
  for (const id of written) await cpos.appData(env.appDataAppId ?? '{{appId}}').remove('notes', id, { facilityId: main.id }).catch(() => {});
  await app.close();
});

const HOST = 'app.test';   // 模擬サーバ (fake-cpos) と違う host → auto は OAuth を選ぶ
const q = (path, facilityId) => `${path}?facilityId=${encodeURIComponent(facilityId)}`;
const inject = (method, url, { cookie, body } = {}) => app.inject({ method, url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
const cookieOf = (res, name) => String(res.headers['set-cookie'] ?? '').split(/,(?=[^ ])/).map((s) => s.trim()).find((s) => s.startsWith(`${name}=`))?.split(';')[0];

/** 本物では Google ログイン。テストでは「ログイン済みの人」のセッションを直接作る (秘密はテストのもの)。 */
const sessionFor = (facilityScope, id = 'tester') => `app_session=${sealSession({ user: { id, name: id, role: 'staff' }, organizationId: 'org', facilityScope, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;

/** KIT 模擬サーバの OAuth を一巡してログインし、アプリのセッション cookie を返す (本物と同じ手順) */
async function loginViaOAuth(account) {
  const start = await inject('GET', '/');
  assert.equal(start.statusCode, 302, 'まず CPOS の同意画面へ');
  const consent = await env.fake.fetch(start.headers.location);
  const link = (await consent.text()).match(new RegExp(`href="([^"]*/oauth/authorize/as/${account.id}[^"]*)"`))[1].replace(/&amp;/g, '&');
  const back = await env.fake.fetch(`${env.baseUrl}${link}`, { redirect: 'manual' });
  const cb = new URL(back.headers.get('location'));
  const done = await inject('GET', cb.pathname + cb.search, { cookie: cookieOf(start, 'app_session_login') });
  assert.equal(done.statusCode, 302, done.body);
  return cookieOf(done, 'app_session');
}

test('cpos.manifest.json と /api/health はログイン無しで見える。形も正しい', async () => {
  const res = await inject('GET', '/cpos.manifest.json');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().appId, '{{appId}}');
  assert.deepEqual(readManifest(new URL('../cpos.manifest.json', import.meta.url)).errors, []);
  assert.equal((await inject('GET', '/api/health')).statusCode, 200);
});

test('未ログインは画面が CPOS へ 302、API は 401 (何も見せない)', async () => {
  const page = await inject('GET', '/');
  assert.equal(page.statusCode, 302);
  assert.ok(page.headers.location.startsWith(env.baseUrl), `CPOS (${env.baseUrl}) へ送る: ${page.headers.location}`);
  const api = await inject('GET', '/api/users');
  assert.equal(api.statusCode, 401);
  assert.equal(api.json().error, 'login_required');
});

test('OAuth で KIT 模擬サーバのログインを一巡し、以後は自分の cookie だけで入れる', async (t) => {
  if (env.external) return t.skip('本物の Google ログインは自動化できない (ブラウザで確かめる)');
  const cookie = await loginViaOAuth(who.all);
  const me = await inject('GET', '/api/me', { cookie });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().user.id, who.all.id);
  assert.equal(me.json().via, 'oauth');
  assert.ok(!cookie.includes('cpos_pat_'), 'トークンを cookie に入れない');
  const page = await inject('GET', '/', { cookie });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<select name="facilityId"/, '画面に事業所の一覧がある');
});

test('ゲートウェイ方式 (同じ cookie ドメイン) でも入れる: cpos_session を CPOS に転送して誰かを聞く', async (t) => {
  if (env.external) return t.skip('本物では cookie ドメインが要る');
  const login = await env.fake.fetch(`${env.baseUrl}/api/auth/login/as/${who.all.id}?next=/`, { redirect: 'manual' });
  const cposCookie = login.headers.get('set-cookie').match(/cpos_session=[^;]+/)[0];
  const res = await app.inject({ method: 'GET', url: '/api/me', headers: { host: new URL(env.baseUrl).host, cookie: cposCookie } });   // host が CPOS と同じ → cookie 方式
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().user.id, who.all.id);
  assert.ok(cookieOf(res, 'app_session'), '自分のセッションを発行する');
});

test('見てよい事業所は、ログインした人の範囲で絞られる (読めない人は 0 件 = fail-close)', async () => {
  const all = await inject('GET', '/api/facilities', { cookie: sessionFor({ mode: 'all' }) });
  assert.ok(all.json().some((f) => f.id === main.id));
  const limited = await inject('GET', '/api/facilities', { cookie: sessionFor({ mode: 'list', ids: [other.id] }) });
  assert.deepEqual(limited.json().map((f) => f.id), [other.id]);
  const forbidden = await inject('GET', q('/api/users', main.id), { cookie: sessionFor({ mode: 'list', ids: [other.id] }) });
  assert.notEqual(forbidden.statusCode, 200, 'よその事業所は見せない');
  assert.match(forbidden.json().hint ?? forbidden.json().message, /事業所/);
  const unknown = await inject('GET', '/api/facilities', { cookie: sessionFor({ mode: 'unknown' }) });
  assert.deepEqual(unknown.json(), [], '範囲が読めない人には何も見せない');
});

test('事業所を指定して利用者一覧が取れる (CPOS の master-users)', async () => {
  const res = await inject('GET', q('/api/users', main.id), { cookie: sessionFor({ mode: 'all' }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(res.json().every((u) => typeof u.masterUserId === 'string' && typeof u.name === 'string'));
});

test('メモは利用者 1 人に 1 件、直せて、取り消せて、別の事業所からは見えない', async (t) => {
  const cookie = sessionFor({ mode: 'all' });
  const users = (await inject('GET', q('/api/users', main.id), { cookie })).json();
  if (users.length === 0) return t.skip('この事業所に利用者がいない');
  const first = await inject('POST', '/api/notes', { cookie, body: { facilityId: main.id, masterUserId: users[0].masterUserId, text: '1 回目' } });
  if (env.external && first.statusCode === 403) return t.skip(`本物の CPOS が 403: ${first.body.slice(0, 120)}`);
  assert.equal(first.statusCode, 201, first.body);
  written.push(first.json().id);
  const second = await inject('POST', '/api/notes', { cookie, body: { facilityId: main.id, masterUserId: users[0].masterUserId, text: '2 回目' } });
  assert.equal(second.statusCode, 201);
  const mine = (await inject('GET', q('/api/notes', main.id), { cookie })).json().filter((n) => n.data.masterUserId === users[0].masterUserId);
  assert.equal(mine.length, 1, '同じ利用者に 2 回保存しても 1 件');
  assert.equal(mine[0].data.text, '2 回目');
  const id = mine[0].id;
  const updated = await inject('PUT', `/api/notes/${id}`, { cookie, body: { facilityId: main.id, text: '直した' } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal((await inject('GET', q(`/api/notes/${id}`, main.id), { cookie })).json().data.text, '直した');
  const theirs = (await inject('GET', q('/api/notes', other.id), { cookie })).json();
  assert.ok(!theirs.some((n) => n.data.masterUserId === users[0].masterUserId), '別の事業所からは見えない');
  assert.equal((await inject('DELETE', q(`/api/notes/${id}`, main.id), { cookie })).statusCode, 204);
  assert.ok(!(await inject('GET', q('/api/notes', main.id), { cookie })).json().some((n) => n.id === id));
  written.length = 0;
});

test('本文が壊れていれば 400 で、CPOS には行かない', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/notes', headers: { host: HOST, cookie: sessionFor({ mode: 'all' }), 'content-type': 'application/json' }, payload: '{' });
  assert.equal(res.statusCode, 400);
});
