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

export function createApp({ cposBaseUrl, cposToken, defaultFacilityId, cposFetch, appDataAppId }) {
  // cposFetch: テストでソケット無しのKIT 模擬サーバ(createFakeCpos().fetch) を差し込む。省略時は本物の fetch。
  const cpos = createCposClient({ baseUrl: cposBaseUrl, token: tokenResolver({ file: process.env.{{APP}}_CPOS_APP_TOKEN_FILE, fallback: () => cposToken }) /* ファイル (Secret Manager の mount) があれば 60 秒ごとに読み直す。トークン入替に追随 */, clientName: `${APP_ID}/0.1.0`, fetch: cposFetch });
  // AppData の appId は、ふつう manifest の appId と同じ。受け取ったトークンが別の appId のスコープ
  // (app-data:<別名>:*) しか持たないとき (登録前にステージングで試すときに起きる) だけ env で切り替える。
  const notes = cpos.appData(appDataAppId ?? APP_ID);
  const manifest = readFileSync(new URL('./cpos.manifest.json', import.meta.url), 'utf8');
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
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true });
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
        const rec = await notes.upsertBy(RESOURCE, 'masterUserId', { masterUserId: body.masterUserId, text: body.text.slice(0, 500) }, { facilityId: facility.id });
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
        const [users, list] = await Promise.all([cpos.masterUsers.list({ facilityId: facility.id }), notes.list(RESOURCE, { facilityId: facility.id })]);
        const noteOf = new Map(list.map((n) => [n.data.masterUserId, n.data.text]));
        const options = facilities.map((f) => `<option value="${esc(f.id)}"${f.id === facility.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
        const rows = users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.careLevel)}</td>
<td><form method="post" action="/notes" style="display:flex;gap:4px"><input type="hidden" name="facilityId" value="${esc(facility.id)}"><input type="hidden" name="masterUserId" value="${esc(u.masterUserId)}"><input name="text" value="${esc(noteOf.get(u.masterUserId))}" placeholder="メモ"><button>保存</button></form></td></tr>`).join('');
        return send(200, `<!doctype html><meta charset="utf-8"><title>{{name}}</title>
<style>body{font-family:sans-serif;max-width:60em;margin:2em auto;line-height:1.6}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}input{padding:4px}select{padding:4px}</style>
<h1>{{name}}</h1>
<form method="get" action="/">事業所: <select name="facilityId" onchange="this.form.submit()">${options}</select> <small>CPOS: <code>${esc(cposBaseUrl)}</code></small></form>
<table><thead><tr><th>利用者</th><th>要介護度</th><th>メモ (利用者 1 人に 1 件)</th></tr></thead><tbody>${rows}</tbody></table>`, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/notes') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const { facility } = await resolveFacility(form.get('facilityId'));
        await notes.upsertBy(RESOURCE, 'masterUserId', { masterUserId: form.get('masterUserId'), text: (form.get('text') ?? '').slice(0, 500) }, { facilityId: facility.id });
        res.writeHead(303, { Location: `/?facilityId=${encodeURIComponent(facility.id)}` });
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
