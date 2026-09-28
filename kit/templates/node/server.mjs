// {{name}} — 見本のサーバ。依存は @cpos/kit だけ (Node 組込みの http を使う)。
//
// 見本がやること:
//   GET  /?facilityId=…        事業所を選び、その利用者一覧と、利用者ごとのメモ (AppData) を出す画面
//   GET  /api/facilities       見てよい事業所の一覧 (CPOS から)
//   GET  /api/users?facilityId 利用者 (介護を受ける人) の一覧 (CPOS の master-users から)
//   GET  /api/notes?facilityId メモ一覧 (CPOS の AppData から)
//   POST /api/notes            メモを保存 { facilityId, masterUserId, text }。利用者 1 人に 1 件 (upsert)
//   GET  /api/notes/:id?facilityId   1 件
//   PUT  /api/notes/:id        変更 { facilityId, text }
//   DELETE /api/notes/:id?facilityId 取り消し
//   GET  /cpos.manifest.json   CPOS が登録時に読みに来る名札
//
// これは出発点で、全部消して作り直してよい。CPOS との約束は cpos.manifest.json の配信と、
// @cpos/kit/client で呼ぶことの 2 つだけ。
//
// 注意: この見本には利用者の認証が無い。KIT 模擬サーバ以外 (ステージング・本番) に向けて公開しない。
// main はそれを検知して起動を拒否する (下の startGuard)。公開するにはログインゲートウェイ (スキル §7) を先に入れる。

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createCposClient, CposApiError, CposClientError, tokenResolver } from '@cpos/kit/client';
import { fetchFromHandler } from '@cpos/kit/fake';

const APP_ID = '{{appId}}';
const RESOURCE = 'notes'; // cpos.manifest.json の resources に宣言してある名前

// CPOS と同じ形の /api/health (CPOS の docs/APP_HEALTH.md)。デプロイの後に「どの版が配信されているか」を確かめる口。
// revision は Cloud Run のリビジョン名 (それ以外では null)。コミットの SHA は載せない
function health() {
  const e = String(process.env.APP_ENV ?? '').trim().toLowerCase();
  const appEnv = e === 'production' || e === 'prod' ? 'production' : e === 'staging' || e === 'stg' ? 'staging' : 'unknown';
  return { status: 'ok', app: APP_ID, appEnv, revision: process.env.K_REVISION?.trim() || null, timestamp: new Date().toISOString() };
}

export function createApp({ cposBaseUrl, cposToken, defaultFacilityId, cposFetch, appDataAppId }) {
  // cposFetch: テストでソケット無しのKIT 模擬サーバ(createFakeCpos().fetch) を差し込む。省略時は本物の fetch。
  const cpos = createCposClient({ baseUrl: cposBaseUrl, token: tokenResolver({ file: process.env.{{APP}}_CPOS_APP_TOKEN_FILE, fallback: () => cposToken }) /* ファイル (Secret Manager の mount) があれば 60 秒ごとに読み直す。トークン入替に追随 */, clientName: `${APP_ID}/0.1.0`, fetch: cposFetch });
  // AppData の appId は、ふつう manifest の appId と同じ。受け取ったトークンが別の appId のスコープ
  // (app-data:<別名>:*) しか持たないとき (登録前にステージングで試すときに起きる) だけ env で切り替える。
  const notes = cpos.appData(appDataAppId ?? APP_ID);
  const manifest = readFileSync(new URL('./cpos.manifest.json', import.meta.url), 'utf8');
  const cposUiCss = readFileSync(new URL(import.meta.resolve('@cpos/kit/ui/cpos-ui.css')), 'utf8');
  const cposUiJs = readFileSync(new URL(import.meta.resolve('@cpos/kit/ui/cpos-ui.js')), 'utf8');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 事業所は「指定があればそれ、無ければ見てよい事業所の先頭」。固定値を持たない。
  async function resolveFacility(requested) {
    const facilities = await cpos.facilities.list();
    const id = requested || defaultFacilityId || facilities[0]?.id;
    const facility = facilities.find((f) => f.id === id);
    if (!facility) {
      throw Object.assign(new CposClientError(`事業所 ${id ?? '(なし)'} は見てよい事業所の中にありません`, '画面の事業所の一覧から選んでください。トークンの allowedFacilityIds も確かめてください'), { status: 403, error: 'facility_forbidden' });
    }
    return { facility, facilities };
  }

  // 渡された masterUserId が、その事業所の利用者か確かめる。よその事業所の人・存在しない人の
  // メモを作らない (CPOS は受け取った利用者の参照を、本人に着地しなくてもそのまま行に付けてしまう)。
  async function userInFacility(facilityId, masterUserId) {
    if (typeof masterUserId !== 'string' || !masterUserId) return false;
    return (await cpos.masterUsers.list({ facilityId })).some((u) => u.masterUserId === masterUserId);
  }

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { __invalid: true }; }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': type });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/cpos.manifest.json') return send(200, manifest);
      // 画面の共通スタイル (規約の実体)。@cpos/kit を上げれば中身も上がる
      if (req.method === 'GET' && url.pathname === '/cpos-ui.css') return send(200, cposUiCss, 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/cpos-ui.js') return send(200, cposUiJs, 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, health());
      if (req.method === 'GET' && url.pathname === '/api/facilities') {
        return send(200, (await cpos.facilities.list()).map((f) => ({ id: f.id, name: f.name })));
      }
      if (req.method === 'GET' && url.pathname === '/api/users') {
        const { facility } = await resolveFacility(url.searchParams.get('facilityId'));
        return send(200, await cpos.masterUsers.list({ facilityId: facility.id }));
      }
      if (req.method === 'GET' && url.pathname === '/api/notes') {
        const { facility } = await resolveFacility(url.searchParams.get('facilityId'));
        return send(200, await notes.list(RESOURCE, { facilityId: facility.id }));
      }
      if (req.method === 'POST' && url.pathname === '/api/notes') {
        const body = await readJson(req);
        if (body.__invalid) return send(400, { ok: false, error: 'JSON として読めません' });
        if (!body.masterUserId || typeof body.text !== 'string') return send(400, { ok: false, error: 'masterUserId と text が必要です' });
        const { facility } = await resolveFacility(body.facilityId);
        if (!(await userInFacility(facility.id, body.masterUserId))) return send(400, { ok: false, error: 'この事業所の利用者に masterUserId が見つかりません' });
        // user: 行を本人に紐づける (CPOS の利用者ごとの画面・統合・番号変更の追随は、data の中ではなくこちらを見る)
        const rec = await notes.upsertBy(RESOURCE, 'masterUserId', { masterUserId: body.masterUserId, text: body.text.slice(0, 500) }, { facilityId: facility.id, user: body.masterUserId });
        return send(201, rec);
      }
      // 1 件 / 変更 / 取り消し。保存できるものは直せるようにする (現場で決めっぱなしは使えない)
      const one = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (one && req.method === 'GET') {
        const { facility } = await resolveFacility(url.searchParams.get('facilityId'));
        const rec = await notes.get(RESOURCE, decodeURIComponent(one[1]), { facilityId: facility.id });
        return send(200, rec);
      }
      if (one && req.method === 'PUT') {
        const body = await readJson(req);
        if (body.__invalid) return send(400, { ok: false, error: 'JSON として読めません' });
        if (typeof body.text !== 'string') return send(400, { ok: false, error: 'text が必要です' });
        const { facility } = await resolveFacility(body.facilityId ?? url.searchParams.get('facilityId'));
        // data は丸ごと置き換わる。消したくない項目は読んでから混ぜる
        const cur = await notes.get(RESOURCE, decodeURIComponent(one[1]), { facilityId: facility.id });
        const rec = await notes.update(RESOURCE, decodeURIComponent(one[1]), { ...cur.data, text: body.text.slice(0, 500) }, { facilityId: facility.id });
        return send(200, rec);
      }
      if (one && req.method === 'DELETE') {
        const { facility } = await resolveFacility(url.searchParams.get('facilityId'));
        await notes.remove(RESOURCE, decodeURIComponent(one[1]), { facilityId: facility.id });
        return send(204, null);
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const { facility, facilities } = await resolveFacility(url.searchParams.get('facilityId'));
        const saved = url.searchParams.get('saved');
        const q = (url.searchParams.get('q') ?? '').trim();
        const only = url.searchParams.get('only') === 'none';   // メモが無い人だけ
        const [allUsers, list] = await Promise.all([cpos.masterUsers.list({ facilityId: facility.id }), notes.list(RESOURCE, { facilityId: facility.id })]);
        const noteOf = new Map(list.map((n) => [n.data.masterUserId, n.data.text]));
        const users = allUsers
          .filter((u) => !q || `${u.name ?? ''}${u.furigana ?? ''}`.includes(q))
          .filter((u) => !only || !noteOf.get(u.masterUserId));
        // 事業所は「名前は常に見える / 切り替えは一覧から選ぶ」(決め 10)。JS 無しで動く details + リンク
    const facilityList = facilities.map((f) => `<a href="/?facilityId=${encodeURIComponent(f.id)}"${f.id === facility.id ? ' aria-current="true"' : ''}>${esc(f.name)}</a>`).join('');
        const keep = `<input type="hidden" name="facilityId" value="${esc(facility.id)}">`;
        // 1 行 1 フォーム。直すと保存バーが出る (規約: 保存は保存バー、押し忘れと誤離脱を防ぐ)
        const rows = users.map((u) => {
          const text = noteOf.get(u.masterUserId) ?? '';
          return `<tr><td data-label="利用者">${esc(u.name)}</td>
<td data-label="要介護度">${esc(u.careLevel ?? '未設定')}</td>
<td data-label="メモ"><form class="cpos-memo" method="post" action="/notes">${keep}<input type="hidden" name="masterUserId" value="${esc(u.masterUserId)}">
<label class="cpos-sr" for="memo-${esc(u.masterUserId)}">${esc(u.name)} のメモ</label>
<input id="memo-${esc(u.masterUserId)}" name="text" value="${esc(text)}" data-initial="${esc(text)}" placeholder="訪問時に気をつけること">
<button class="cpos-btn primary cpos-memo-save" type="submit">保存</button></form></td></tr>`;
        }).join('');
        const body = users.length
          ? `<table class="cpos-table"><thead><tr><th>利用者</th><th>要介護度</th><th>メモ (利用者 1 人に 1 件)</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="cpos-empty"><p>${q || only ? '条件に合う利用者はいません。' : 'この事業所には利用者がいません。'}</p><a class="cpos-btn" href="/?facilityId=${encodeURIComponent(facility.id)}">絞り込みをやめる</a></div>`;
        return send(200, `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{{name}}</title>
<link rel="stylesheet" href="/cpos-ui.css">
<script src="/cpos-ui.js" defer></script>
</head><body>
<div class="cpos-savebar" id="savebar" hidden><span>未保存の変更があります</span><span class="cpos-actions"><button class="cpos-btn" type="button" id="discard">破棄</button><button class="cpos-btn primary" type="button" id="saveall">保存</button></span></div>
<header class="cpos-appbar{{appbarClass}}"><h1>{{name}}</h1>
<details class="cpos-facility"><summary title="事業所を切り替える"><span class="cpos-sr">事業所: </span>${esc(facility.name)}</summary>
<div class="cpos-facility-list">${facilityList}</div></details></header>
<main class="cpos-page">
  <form class="cpos-search" method="get" action="/" id="searchform">${keep}<label class="cpos-sr" for="q">利用者を探す</label><input id="q" name="q" value="${esc(q)}" placeholder="氏名・ふりがなで探す" autocomplete="off"><noscript><button class="cpos-btn" type="submit">探す</button></noscript></form>
  <div class="cpos-chips"><a class="cpos-chip${only ? ' on' : ''}" href="/?facilityId=${encodeURIComponent(facility.id)}${q ? `&q=${encodeURIComponent(q)}` : ''}${only ? '' : '&only=none'}">メモがまだの人</a>
  <span class="cpos-chip" aria-disabled="true">${users.length} 人</span></div>
  <div class="cpos-card">${body}</div>
  <p class="cpos-sub">接続先 CPOS: <code>${esc(cposBaseUrl)}</code></p>
</main>
${saved ? '<div class="cpos-snackbar" id="snack"><span>メモを保存しました</span></div>' : ''}
<script>
 // 直したら保存バーを出す。保存するまで消えない (規約: 保存は保存バー)
 const bar = document.getElementById('savebar');
 const dirty = () => [...document.querySelectorAll('.cpos-memo input[name=text]')].filter((i) => i.value !== i.dataset.initial);
 const sync = () => { bar.hidden = dirty().length === 0; };
 document.addEventListener('input', (e) => { if (e.target.matches('.cpos-memo input[name=text]')) sync(); });
 document.getElementById('discard').addEventListener('click', () => { document.querySelectorAll('.cpos-memo input[name=text]').forEach((i) => { i.value = i.dataset.initial; }); sync(); });
 document.getElementById('saveall').addEventListener('click', () => { const f = dirty()[0]?.closest('form'); if (f) f.submit(); });
 addEventListener('beforeunload', (e) => { if (dirty().length) { e.preventDefault(); e.returnValue = ''; } });
 const snack = document.getElementById('snack'); if (snack) setTimeout(() => snack.remove(), 5000);
 // 決め 3: 打つたびに絞り込む (検索ボタンを置かない)。Enter も同じ結果。未保存があるときは邪魔しない
 const qi = document.getElementById('q'); let t;
 qi.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { if (!dirty().length) document.getElementById('searchform').submit(); }, 300); });
</script>
</body></html>`, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/notes') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const { facility } = await resolveFacility(form.get('facilityId'));
        const masterUserId = form.get('masterUserId') ?? '';
        if (!(await userInFacility(facility.id, masterUserId))) return send(400, { ok: false, error: 'この事業所の利用者に masterUserId が見つかりません' });
        await notes.upsertBy(RESOURCE, 'masterUserId', { masterUserId, text: (form.get('text') ?? '').slice(0, 500) }, { facilityId: facility.id, user: masterUserId });
        res.writeHead(303, { Location: `/?facilityId=${encodeURIComponent(facility.id)}&saved=1` });
        return res.end();
      }
      return send(404, { ok: false, error: 'not_found' });
    } catch (e) {
      if (e instanceof CposApiError || e instanceof CposClientError) {
        // hint をそのまま返す。開発中はこれが一番の手がかりになる。
        return send(e.status ?? 500, { ok: false, error: e.error ?? e.message, message: e.message, hint: e.hint });
      }
      return send(500, { ok: false, error: 'internal', message: e.message });
    }
  }

  const server = createServer((req, res) => { handle(req, res); });
  const inject = fetchFromHandler(handle);
  return {
    server,
    /** ソケットを使わずにこのアプリを呼ぶ (テスト用)。inject('GET', '/api/users') */
    inject: (method, path, init = {}) => inject(`http://app${path}`, { ...init, method }),
    // Cloud Run など外から届く必要があるときは host に '0.0.0.0' を渡す (main では既定でそうする)。テストは 127.0.0.1。
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `ポート ${port} は使用中です (PORT で変えられます)` : e.message)));
      server.listen(port, host, () => resolve(server.address().port));
    }),
    close: () => new Promise((r) => server.close(r))
  };
}

export function configFromEnv(env = process.env) {
  return {
    cposBaseUrl: env.{{APP}}_CPOS_BASE_URL ?? '',   // 既定は無し (黙って模擬サーバに落ちない。dev.mjs が「接続先が未設定」と案内する)
    cposToken: env.{{APP}}_CPOS_APP_TOKEN ?? '',
    appDataAppId: env.{{APP}}_APPDATA_APP_ID || undefined,   // トークンのスコープが別 appId のときだけ (npx cpos-kit connect が教える)
    defaultFacilityId: env.{{APP}}_FACILITY_ID || undefined,
    port: Number(env.PORT) || 3000
  };
}

/** 認証の無いこの見本を、KIT 模擬サーバ以外に向けて公開しないための関門。 */
export function startGuard(cfg, env = process.env) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.cposBaseUrl);
  if (local || env.{{APP}}_ALLOW_UNAUTHENTICATED === '1') return null;
  return [
    `起動を止めました: ${cfg.cposBaseUrl} はKIT 模擬サーバではありません。`,
    'この見本には利用者の認証が無いので、そのまま公開すると URL を知る誰でも App Token 経由で利用者データを読めます。',
    '公開するにはログインゲートウェイ (スキル cpos の §7) を先に入れてください。',
    '手元での確認だけなら {{APP}}_ALLOW_UNAUTHENTICATED=1 を付けると起動します (127.0.0.1 にだけ bind します)。'
  ].join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cfg = configFromEnv();
  const stop = startGuard(cfg);
  if (stop) { console.error(stop); process.exit(2); }
  if (!cfg.cposToken) console.warn('警告: {{APP}}_CPOS_APP_TOKEN が空です。CPOS の呼び出しは 401 になります (登録前なら正常)。');
  if (cfg.appDataAppId && cfg.appDataAppId !== APP_ID) console.warn(`注意: AppData は appId "${cfg.appDataAppId}" に読み書きします (トークンのスコープに合わせた暫定。本登録後は {{APP}}_APPDATA_APP_ID を消す)。`);
  const app = createApp(cfg);
  const host = process.env.HOST ?? (process.env.{{APP}}_ALLOW_UNAUTHENTICATED === '1' ? '127.0.0.1' : '0.0.0.0');
  const port = await app.listen(cfg.port, host);
  console.log(`{{name}}: http://127.0.0.1:${port}  (接続先: ${/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.cposBaseUrl) ? '模擬サーバ' : 'ステージング'} ${cfg.cposBaseUrl})`);
}
