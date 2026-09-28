// {{name}} — Fastify の見本。依存は fastify と @cpos/kit。
//
// node の見本 (--sample node) との違いは 2 つ:
//   - Fastify (ルーティング・inject・JSON の扱いを任せる)
//   - **CPOS のログインが最初から付いている** (@cpos/kit/app-kit の fastifyLoginGate)。
//     見ている人が誰かを CPOS に聞き、その人が見てよい事業所しか出さない。だから本物に向けて公開できる。
//
// ログインの方式は 3 つあり、既定 (auto) は置き場所で自動で決まる (cookie か oauth):
//   - アプリが CPOS と同じ cookie ドメイン (<app>.<CPOS のドメイン>) → ゲートウェイ方式 (cpos_session を転送)
//   - それ以外 (手元の 127.0.0.1、別ドメイン)              → OAuth 2.1 (CPOS が Google ログイン → 同意 → 戻る)
//   - {{APP}}_LOGIN_MODE=token                              → /login に CPOS のトークン (PAT / App Token) を貼る。Google を通らない。
//     AI や CI が本物のログインまで検証するときと、Google アカウントの無い運用端末のため。人が使う本番は auto のまま。
//   手元でステージングにつないでも、ブラウザで本物の Google ログインを一巡できる (その CPOS に登録された Google アカウントで)。
//
// 見本がやること:
//   GET  /                          事業所を選び、利用者一覧と利用者ごとのメモ (AppData) を出す画面
//   GET  /api/me                    いま見ている人 (CPOS が答えた身元と事業所の範囲)
//   GET  /api/facilities            見てよい事業所 (App Token の範囲 ∩ ログインした人の範囲)
//   GET  /api/users?facilityId      利用者 (介護を受ける人。CPOS の master-users)
//   GET/POST /api/notes, GET/PUT/DELETE /api/notes/:id   メモ (AppData、利用者 1 人に 1 件)
//   GET  /oauth/callback, /logout, GET/POST /login   ログインの戻り・ログアウト・token モードの画面 (fastifyLoginGate が付ける)
//   GET  /cpos.manifest.json, /api/health   ログイン不要
//
// これは出発点で、全部消して作り直してよい。CPOS との約束は cpos.manifest.json の配信と、
// @cpos/kit/client で呼ぶこと、そして利用者の認証を外さないことの 3 つ。

import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createCposClient, CposApiError, CposClientError, tokenResolver } from '@cpos/kit/client';
import { fastifyLoginGate, canSeeFacility } from '@cpos/kit/app-kit';

const APP_ID = '{{appId}}';
const APP_NAME = '{{name}}';
const RESOURCE = 'notes'; // cpos.manifest.json の resources に宣言してある名前

// CPOS と同じ形の /api/health (CPOS の docs/APP_HEALTH.md)。デプロイの後に「どの版が配信されているか」を確かめる口。
// revision は Cloud Run のリビジョン名 (それ以外では null)。コミットの SHA は載せない
function health() {
  const e = String(process.env.APP_ENV ?? '').trim().toLowerCase();
  const appEnv = e === 'production' || e === 'prod' ? 'production' : e === 'staging' || e === 'stg' ? 'staging' : 'unknown';
  return { status: 'ok', app: APP_ID, appEnv, revision: process.env.K_REVISION?.trim() || null, timestamp: new Date().toISOString() };
}

export function createApp({ cposBaseUrl, cposToken, cposFetch, appDataAppId, sessionSecret, appUrl, loginMode, oauthClientId, defaultFacilityId, logger = false }) {
  // cposFetch: テストでソケット無しの KIT 模擬サーバ (createFakeCpos().fetch) を差し込む。省略時は本物の fetch。
  const cpos = createCposClient({ baseUrl: cposBaseUrl, token: tokenResolver({ file: process.env.{{APP}}_CPOS_APP_TOKEN_FILE, fallback: () => cposToken }) /* ファイル (Secret Manager の mount) があれば 60 秒ごとに読み直す。トークン入替に追随 */, clientName: `${APP_ID}/0.1.0`, fetch: cposFetch });
  // AppData の appId は、ふつう manifest の appId と同じ。受け取ったトークンが別 appId のスコープしか持たないときだけ env で切り替える
  const notes = cpos.appData(appDataAppId ?? APP_ID);
  const manifest = readFileSync(new URL('./cpos.manifest.json', import.meta.url), 'utf8');
  // 画面の共通スタイル (規約の実体)。@cpos/kit を上げれば中身も上がる
  const cposUiCss = readFileSync(new URL(import.meta.resolve('@cpos/kit/ui/cpos-ui.css')), 'utf8');
  const cposUiJs = readFileSync(new URL(import.meta.resolve('@cpos/kit/ui/cpos-ui.js')), 'utf8');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const app = Fastify({ logger });
  app.decorate('cpos', cpos);

  // ログインの関門。ここより下のルートは全部ログイン済み (request.session に身元) で呼ばれる
  const gate = fastifyLoginGate(app, {
    cposBaseUrl, secret: sessionSecret, appUrl, mode: loginMode ?? 'auto', fetch: cposFetch, appName: APP_NAME,
    oauth: { clientName: APP_NAME, clientId: oauthClientId },
    publicPaths: ['/api/health', '/cpos.manifest.json', '/cpos-ui.css', '/cpos-ui.js']
  });
  app.decorate('loginGate', gate);

  // 見てよい事業所 = App Token で見える事業所 ∩ ログインした人の範囲 (範囲が読めない人には 0 件)
  async function visibleFacilities(session) {
    return (await cpos.facilities.list()).filter((f) => canSeeFacility(session.facilityScope, f.id));
  }
  async function resolveFacility(session, requested) {
    const facilities = await visibleFacilities(session);
    const id = requested || defaultFacilityId || facilities[0]?.id;
    const facility = facilities.find((f) => f.id === id);
    // 403 で返す (500 にしない。実験 13 で「範囲外の事業所が 500 になる」と指摘された)
    if (!facility) throw Object.assign(new CposClientError(`事業所 ${id ?? '(なし)'} は見てよい事業所の中にありません`, '画面の事業所の一覧から選んでください。ログインした人の事業所の範囲と、トークンの allowedFacilityIds も確かめてください'), { status: 403, error: 'facility_forbidden' });
    return { facility, facilities };
  }

  // 渡された masterUserId が、その事業所の利用者か確かめる。よその事業所の人・存在しない人の
  // メモを作らない (CPOS は受け取った利用者の参照を、本人に着地しなくてもそのまま行に付けてしまう)。
  async function userInFacility(facilityId, masterUserId) {
    if (typeof masterUserId !== 'string' || !masterUserId) return false;
    return (await cpos.masterUsers.list({ facilityId })).some((u) => u.masterUserId === masterUserId);
  }

  // CPOS の失敗は hint ごとそのまま返す (開発中はこれが一番の手がかり)
  app.setErrorHandler((e, req, reply) => {
    if (e instanceof CposApiError || e instanceof CposClientError) return reply.code(e.status ?? 500).send({ ok: false, error: e.error ?? e.message, message: e.message, hint: e.hint, requiredScope: e.requiredScope });
    if (e.validation || e.statusCode === 400) return reply.code(400).send({ ok: false, error: 'bad_request', message: e.message });
    req.log.error(e);
    return reply.code(500).send({ ok: false, error: 'internal', message: e.message });
  });

  app.get('/cpos.manifest.json', async (req, reply) => reply.type('application/json; charset=utf-8').send(manifest));
  app.get('/cpos-ui.css', async (req, reply) => reply.type('text/css; charset=utf-8').send(cposUiCss));
  app.get('/cpos-ui.js', async (req, reply) => reply.type('text/javascript; charset=utf-8').send(cposUiJs));
  app.get('/api/health', async () => health());
  app.get('/api/me', async (req) => ({ ok: true, user: req.session.user, organizationId: req.session.organizationId, facilityScope: req.session.facilityScope, via: req.session.via ?? 'cookie' }));
  app.get('/api/facilities', async (req) => (await visibleFacilities(req.session)).map((f) => ({ id: f.id, name: f.name })));
  app.get('/api/users', async (req) => {
    const { facility } = await resolveFacility(req.session, req.query.facilityId);
    return cpos.masterUsers.list({ facilityId: facility.id });
  });
  app.get('/api/notes', async (req) => {
    const { facility } = await resolveFacility(req.session, req.query.facilityId);
    return notes.list(RESOURCE, { facilityId: facility.id });
  });
  app.post('/api/notes', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.masterUserId || typeof body.text !== 'string') return reply.code(400).send({ ok: false, error: 'masterUserId と text が必要です' });
    const { facility } = await resolveFacility(req.session, body.facilityId);
    if (!(await userInFacility(facility.id, body.masterUserId))) return reply.code(400).send({ ok: false, error: 'この事業所の利用者に masterUserId が見つかりません' });
    // user: 行を本人に紐づける (CPOS の利用者ごとの画面・統合・番号変更の追随は、data の中ではなくこちらを見る)
    const rec = await notes.upsertBy(RESOURCE, 'masterUserId', { masterUserId: body.masterUserId, text: body.text.slice(0, 500) }, { facilityId: facility.id, user: body.masterUserId });
    return reply.code(201).send(rec);
  });
  app.get('/api/notes/:id', async (req) => {
    const { facility } = await resolveFacility(req.session, req.query.facilityId);
    return notes.get(RESOURCE, req.params.id, { facilityId: facility.id });
  });
  app.put('/api/notes/:id', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.text !== 'string') return reply.code(400).send({ ok: false, error: 'text が必要です' });
    const { facility } = await resolveFacility(req.session, body.facilityId ?? req.query.facilityId);
    const cur = await notes.get(RESOURCE, req.params.id, { facilityId: facility.id });   // data は丸ごと置き換わる。読んでから混ぜる
    return notes.update(RESOURCE, req.params.id, { ...cur.data, text: body.text.slice(0, 500) }, { facilityId: facility.id });
  });
  app.delete('/api/notes/:id', async (req, reply) => {
    const { facility } = await resolveFacility(req.session, req.query.facilityId);
    await notes.remove(RESOURCE, req.params.id, { facilityId: facility.id });
    return reply.code(204).send();
  });

  // 画面 (サーバで HTML を作る。form の POST → 303 で戻る。JS 無しで動く)
  app.get('/', async (req, reply) => {
    const { facility, facilities } = await resolveFacility(req.session, req.query.facilityId);
    const q = String(req.query.q ?? '').trim();
    const only = req.query.only === 'none';
    const [allUsers, list] = await Promise.all([cpos.masterUsers.list({ facilityId: facility.id }), notes.list(RESOURCE, { facilityId: facility.id })]);
    const noteOf = new Map(list.map((n) => [n.data.masterUserId, n.data.text]));
    const users = allUsers
      .filter((u) => !q || `${u.name ?? ''}${u.furigana ?? ''}`.includes(q))
      .filter((u) => !only || !noteOf.get(u.masterUserId));
    // 事業所は「名前は常に見える / 切り替えは一覧から選ぶ」(決め 10)。JS 無しで動く details + リンク
    const facilityList = facilities.map((f) => `<a href="/?facilityId=${encodeURIComponent(f.id)}"${f.id === facility.id ? ' aria-current="true"' : ''}>${esc(f.name)}</a>`).join('');
    const keep = `<input type="hidden" name="facilityId" value="${esc(facility.id)}">`;
    const rows = users.map((u) => {
      const text = noteOf.get(u.masterUserId) ?? '';
      return `<tr><td data-label="利用者">${esc(u.name)}</td>
<td data-label="要介護度">${esc(u.careLevel ?? '未設定')}</td>
<td data-label="メモ"><form class="cpos-memo" method="post" action="/notes">${keep}<input type="hidden" name="masterUserId" value="${esc(u.masterUserId)}">
<label class="cpos-sr" for="memo-${esc(u.masterUserId)}">${esc(u.name)} のメモ</label>
<input id="memo-${esc(u.masterUserId)}" name="text" value="${esc(text)}" data-initial="${esc(text)}" placeholder="訪問時に気をつけること">
<button class="cpos-btn primary" type="submit">保存</button></form></td></tr>`;
    }).join('');
    const body = users.length
      ? `<table class="cpos-table"><thead><tr><th>利用者</th><th>要介護度</th><th>メモ (利用者 1 人に 1 件)</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="cpos-empty"><p>${q || only ? '条件に合う利用者はいません。' : 'この事業所には利用者がいません。'}</p><a class="cpos-btn" href="/?facilityId=${encodeURIComponent(facility.id)}">絞り込みをやめる</a></div>`;
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(APP_NAME)}</title>
<link rel="stylesheet" href="/cpos-ui.css">
<script src="/cpos-ui.js" defer></script>
</head><body>
<div class="cpos-savebar" id="savebar" hidden><span>未保存の変更があります</span><span class="cpos-actions"><button class="cpos-btn" type="button" id="discard">破棄</button><button class="cpos-btn primary" type="button" id="saveall">保存</button></span></div>
<header class="cpos-appbar{{appbarClass}}"><h1>${esc(APP_NAME)}</h1>
<details class="cpos-facility"><summary title="事業所を切り替える"><span class="cpos-sr">事業所: </span>${esc(facility.name)}</summary>
<div class="cpos-facility-list">${facilityList}</div></details>
<details class="cpos-usermenu"><summary>${esc(req.session.user?.name ?? req.session.user?.id)}</summary>
  <div class="cpos-usermenu-list"><a href="/logout">ログアウト</a></div></details></header>
<main class="cpos-page">
  <form class="cpos-search" method="get" action="/" id="searchform">${keep}<label class="cpos-sr" for="q">利用者を探す</label><input id="q" name="q" value="${esc(q)}" placeholder="氏名・ふりがなで探す" autocomplete="off"><noscript><button class="cpos-btn" type="submit">探す</button></noscript></form>
  <div class="cpos-chips"><a class="cpos-chip${only ? ' on' : ''}" href="/?facilityId=${encodeURIComponent(facility.id)}${q ? `&q=${encodeURIComponent(q)}` : ''}${only ? '' : '&only=none'}">メモがまだの人</a>
  <span class="cpos-chip" aria-disabled="true">${users.length} 人</span></div>
  <div class="cpos-card">${body}</div>
  <p class="cpos-sub">接続先 CPOS: <code>${esc(cposBaseUrl)}</code></p>
</main>
${req.query.saved ? '<div class="cpos-snackbar" id="snack"><span>メモを保存しました</span></div>' : ''}
<script>
 const bar = document.getElementById('savebar');
 const dirty = () => [...document.querySelectorAll('.cpos-memo input[name=text]')].filter((i) => i.value !== i.dataset.initial);
 const sync = () => { bar.hidden = dirty().length === 0; };
 document.addEventListener('input', (e) => { if (e.target.matches('.cpos-memo input[name=text]')) sync(); });
 document.getElementById('discard').addEventListener('click', () => { document.querySelectorAll('.cpos-memo input[name=text]').forEach((i) => { i.value = i.dataset.initial; }); sync(); });
 document.getElementById('saveall').addEventListener('click', () => { const f = dirty()[0]?.closest('form'); if (f) f.submit(); });
 addEventListener('beforeunload', (e) => { if (dirty().length) { e.preventDefault(); e.returnValue = ''; } });
 const snack = document.getElementById('snack'); if (snack) setTimeout(() => snack.remove(), 5000);
 const qi = document.getElementById('q'); let t;
 qi.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { if (!dirty().length) document.getElementById('searchform').submit(); }, 300); });
</script>
</body></html>`);
  });
  app.post('/notes', async (req, reply) => {
    const form = req.body ?? {};
    const { facility } = await resolveFacility(req.session, form.facilityId);
    if (!(await userInFacility(facility.id, form.masterUserId))) return reply.code(400).send({ ok: false, error: 'この事業所の利用者に masterUserId が見つかりません' });
    await notes.upsertBy(RESOURCE, 'masterUserId', { masterUserId: form.masterUserId, text: String(form.text ?? '').slice(0, 500) }, { facilityId: facility.id, user: form.masterUserId });
    return reply.redirect(`/?facilityId=${encodeURIComponent(facility.id)}&saved=1`, 303);
  });
  // form の POST を読む (Fastify は JSON しか既定で読まない)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));

  return app;
}

export function configFromEnv(env = process.env) {
  return {
    cposBaseUrl: env.{{APP}}_CPOS_BASE_URL ?? '',   // 既定は無し (黙って模擬サーバに落ちない。dev.mjs が「接続先が未設定」と案内する)
    cposToken: env.{{APP}}_CPOS_APP_TOKEN ?? '',
    appDataAppId: env.{{APP}}_APPDATA_APP_ID || undefined,   // トークンのスコープが別 appId のときだけ (npx cpos-kit connect が教える)
    sessionSecret: env.{{APP}}_SESSION_SECRET || undefined,   // 16 バイト以上。本物に向けるなら必須
    appUrl: env.{{APP}}_APP_URL || undefined,                  // 公開 URL。無ければ要求の Host から組み立てる
    loginMode: env.{{APP}}_LOGIN_MODE || 'auto',               // auto | cookie | oauth | token (Google を通らない。検証・運用端末向け)
    oauthClientId: env.{{APP}}_OAUTH_CLIENT_ID || undefined,   // OAuth の client_id (無ければ起動時に動的登録し、ログに出す)
    defaultFacilityId: env.{{APP}}_FACILITY_ID || undefined,
    port: Number(env.PORT) || 3000
  };
}

/** 本物に向けるときの関門: セッションの秘密が無ければ起動しない (起動ごとに変わる秘密で公開しない)。 */
export function startGuard(cfg) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.cposBaseUrl);
  if (local || cfg.sessionSecret) return null;
  return [
    `起動を止めました: ${cfg.cposBaseUrl} は KIT 模擬サーバではないのに {{APP}}_SESSION_SECRET がありません。`,
    'ログイン後のセッション cookie を封じる秘密です。16 バイト以上の値を .env (本番は Secret Manager) に置いてください:',
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
  ].join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cfg = configFromEnv();
  const stop = startGuard(cfg);
  if (stop) { console.error(stop); process.exit(2); }
  if (!cfg.sessionSecret) { cfg.sessionSecret = randomBytes(32).toString('base64url'); console.warn('警告: {{APP}}_SESSION_SECRET が無いので起動ごとに変わる秘密を使います (再起動でログインし直し)。'); }
  if (!cfg.cposToken) console.warn('警告: {{APP}}_CPOS_APP_TOKEN が空です。CPOS の呼び出しは 401 になります (登録前なら正常)。');
  if (cfg.appDataAppId && cfg.appDataAppId !== APP_ID) console.warn(`注意: AppData は appId "${cfg.appDataAppId}" に読み書きします (トークンのスコープに合わせた暫定。本登録後は {{APP}}_APPDATA_APP_ID を消す)。`);
  const app = createApp({ ...cfg, logger: true });
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port: cfg.port, host });
  const me = await app.cpos.platform.me().catch((e) => ({ error: e.message }));
  console.log(`${APP_NAME}: http://127.0.0.1:${cfg.port}  (CPOS: ${cfg.cposBaseUrl}${me.error ? `、疎通NG: ${me.error}` : `、スコープ ${me.token?.scopes?.length ?? 0} 個`})`);
  console.log(`ログイン: ${cfg.loginMode}${cfg.loginMode === 'auto' ? ` (${cfg.appUrl ?? '要求の Host'} と CPOS が同じ cookie ドメインなら cookie、違えば oauth)` : ''}`);
}
