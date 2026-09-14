// KIT 模擬サーバ。spec/cpos-api.yaml の 5 系統をメモリ上で実装する。依存ゼロ (node:http)。
//
//   npx cpos-kit fake                       # http://localhost:4300
//   import { startFakeCpos, createFakeCpos } from '@cpos/kit/fake';
//   const fake = await startFakeCpos({ port: 0 }); ... await fake.close();      // TCP で起動
//   const fake = createFakeCpos();  createCposClient({ baseUrl: 'http://fake', fetch: fake.fetch })   // ソケット無し
//
// ソケット無し (in-process) の形があるのは、AI エージェントのサンドボックスで TCP の listen が
// 禁止されていることがあるため (Codex で確認済み)。テストは in-process を既定にする。
//
// 本物との違いは「データが架空」「Google 認証の代わりに誰として入るか選ぶ画面」の 2 点だけを
// 目指す。応答の形は CPOS 本体の実装とステージングでの確認に合わせる (kit の保守者が追随する)。
// 未実装のパスは 501 で「何が無いか」を返す。黙って 404 にしない。
//
// 失敗の応答は必ず { ok: false, error, message, hint } にし、hint に次にやることを書く。
// エージェントはスキルを読まなくてもこの出力は読む。

import { createServer } from 'node:http';
import { validateAgainstSchema } from '../app-data-schema.js';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEED_PATH = resolve(here, 'seed.json');

function loadSeed(seed) {
  if (seed && typeof seed === 'object') return structuredClone(seed);
  return JSON.parse(readFileSync(seed ?? DEFAULT_SEED_PATH, 'utf8'));
}

function json(res, status, body) {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
// 本物の失敗応答は { error: "<日本語の文>" } (401 だけ ok:false 付き)。KIT 模擬サーバも同じ形にし、
// KIT 模擬サーバだけ hint を足す (本物には無い)。code は機械可読の補助 (本物には無い)。
function fail(res, status, code, message, hint, extra = {}) {
  json(res, status, { ...(status === 401 ? { ok: false } : {}), error: message, code, ...(hint ? { hint } : {}), ...extra });
}
function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function parseCookies(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}
async function readText(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
async function readBody(req) {
  const text = await readText(req);
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { __invalid: true }; }
}
// JSON でも application/x-www-form-urlencoded でも読む (OAuth の /oauth/token は form が標準)
async function readForm(req) {
  const text = await readText(req);
  if (!text) return {};
  if (/^\s*[{[]/.test(text)) { try { return JSON.parse(text); } catch { return { __invalid: true }; } }
  return Object.fromEntries(new URLSearchParams(text));
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * node:http の (req, res) ハンドラを fetch 互換の関数にする。ソケットを使わない。
 * KIT 模擬サーバにも、アプリ自身のテスト (inject) にも使える。
 * @param {(req: any, res: any) => Promise<void> | void} handle
 * @returns {typeof fetch}
 */
export function fetchFromHandler(handle) {
  return async function inProcessFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of new Headers(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const bodyBuf = init.body === undefined || init.body === null ? null : Buffer.from(typeof init.body === 'string' ? init.body : init.body);
    const req = Readable.from(bodyBuf ? [bodyBuf] : []);
    req.url = url.pathname + url.search;
    req.method = method;
    req.headers = headers;
    let status = 200;
    let resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(s, h = {}) { status = s; resHeaders = h; return res; },
      setHeader(k, v) { resHeaders[k] = v; },
      write(c) { if (c) chunks.push(Buffer.from(c)); },
      end(c) { if (c) chunks.push(Buffer.from(c)); }
    };
    await handle(req, res);
    const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
    return new Response(body, { status, headers: resHeaders });
  };
}

/**
 * KIT 模擬サーバをソケット無しで作る。`fake.fetch` を createCposClient({ fetch }) に渡す。
 * @param {{ seed?: string | object, log?: (line: string) => void, appTokenPrefixes?: string[] }} [opts]
 */
export function createFakeCpos(opts = {}) {
  const core = buildFakeCpos(opts);
  return { ...core, fetch: fetchFromHandler(core.handle), baseUrl: 'http://fake-cpos' };
}

/**
 * KIT 模擬サーバを TCP で起動する (npm run dev やブラウザ用)。
 * @param {{ port?: number, host?: string, seed?: string | object, log?: (line: string) => void, appTokenPrefixes?: string[] }} [opts]
 */
export async function startFakeCpos(opts = {}) {
  const core = buildFakeCpos(opts);
  const server = createServer((req, res) => {
    core.handle(req, res).catch((e) => fail(res, 500, 'fake_internal_error', e.message));
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `ポート ${opts.port ?? 4300} は使用中です。別の KIT 模擬サーバが動いていないか確かめるか、--port で変えてください` : e.code === 'EPERM' ? 'この環境では TCP の listen が禁止されています。テストなら createFakeCpos() (ソケット無し) を使ってください' : e.message)));
    server.listen(opts.port ?? 4300, opts.host ?? '127.0.0.1', resolve);
  });
  const addr = server.address();
  return {
    ...core,
    fetch: fetchFromHandler(core.handle),
    baseUrl: `http://${opts.host ?? '127.0.0.1'}:${addr.port}`,
    port: addr.port,
    close: () => new Promise((r) => server.close(r))
  };
}

// アプリの cpos.manifest.json から apiTokenScopes を読む (見つからなければ null)。
// 既定は実行時のカレント。テストなど manifest が無い場所では null を返す。
function readManifest(manifestPath) {
  const candidates = manifestPath ? [manifestPath] : [resolve(process.cwd(), 'cpos.manifest.json')];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* 無ければ次 */ }
  }
  return null;
}
function readManifestScopes(manifestPath) {
  const scopes = readManifest(manifestPath)?.apiTokenScopes;
  return Array.isArray(scopes) && scopes.length ? scopes : null;
}

function buildFakeCpos(opts = {}) {
  const seed = loadSeed(opts.seed);
  const log = opts.log ?? (() => {});
  const tokenPrefixes = opts.appTokenPrefixes ?? ['cpos_app_', 'cpos_pat_'];
  // seed に無いトークンに与えるスコープ。本物のトークンには manifest で宣言したスコープしか付かないので、
  // アプリの cpos.manifest.json があればそれに合わせる (宣言漏れを本物ではなくここで落とすため)。
  // manifest が無いときだけ全スコープ (kit 自身のテスト用)。opts.scopes で上書きできる。
  const defaultScopes = opts.scopes ?? readManifestScopes(opts.manifest) ?? ['*'];
  // manifest の resources[].schema (data の形の宣言)。本物は既定「報告のみ」だが、模擬サーバは常に 400 にして宣言のずれを手元で落とす
  const manifestResources = Array.isArray(readManifest(opts.manifest)?.resources) ? readManifest(opts.manifest).resources : [];
  const schemaMismatch = (res, appId, resource, data) => {
    const schema = manifestResources.find((r) => r && r.name === resource)?.schema;
    if (!schema) return false;
    const issues = validateAgainstSchema(data, schema);
    if (!issues.length) return false;
    fail(res, 400, 'schema_mismatch', `data が ${appId}/${resource} の Manifest 宣言と合いません`, 'cpos.manifest.json の resources[].schema と data の形を揃えてください (本物は既定で報告のみ、APP_DATA_SCHEMA_ENFORCE=true で 400)', { issues: issues.slice(0, 20) });
    return true;
  };
  const state = {
    appData: new Map(), // key `${appId}/${resource}` → Map<id, record>
    requests: [],
    shifts: { plans: new Map(), assignments: new Map(), history: new Map(), shiftTypes: new Map(), requirements: new Map(), preferences: new Map() },   // シフト (起動のたびに空。POST で作る)
    oauth: { clients: new Map(), codes: new Map(), tokens: new Map() }   // OAuth 2.1 (本物と同じ流れを手元で通すため)
  };

  const facilityById = new Map(seed.facilities.map((f) => [f.id, f]));
  const accountById = new Map(seed.accounts.map((a) => [a.id, a]));
  const tokenByValue = new Map((seed.appTokens ?? []).filter((t) => t.token).map((t) => [t.token, t]));

  // 本物と同じ文面でスコープ不足を返す (platform 系の 403)
  function requireScope(actor, res, scope) {
    const have = actor.scopes ?? [];
    const ok = have.includes('*') || have.includes(scope) || have.some((s) => s.endsWith(':*') && scope.startsWith(s.slice(0, -1)));
    if (ok) return true;
    fail(res, 403, 'scope_missing', `この API トークンにスコープ「${scope}」がありません。CPOS 管理画面の「設定 → API トークン」(/app-tokens) で対象トークンに 「${scope}」または該当ワイルドカード (例: 「${scope.split(':')[0]}:*」/「*」) を付与してください。`,
      'cpos.manifest.json の apiTokenScopes にこのスコープを足し、再登録してトークンを再発行する', { requiredScope: scope, have });
    return false;
  }

  // ---- 認証 --------------------------------------------------------------
  function actorOf(req) {
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (!tokenPrefixes.some((p) => token.startsWith(p))) {
        return { error: [401, 'invalid_token', 'Bearer トークンの形式が違います', `KIT 模擬サーバは ${tokenPrefixes.join(' / ')} で始まるトークンを受け付けます (中身は何でもよい)。本物では管理画面 /app-tokens で発行したものを使います`] };
      }
      const known = tokenByValue.get(token);
      // OAuth 2.1 で発行したアクセストークン (cpos_pat_…、本物と同じ tokenType 'personal')。
      // 本物の /api/platform/me は authMethod 'personal_access_token' で user (本人) を返す (routes/platform-me.ts)
      const oa = state.oauth.tokens.get(token);
      if (oa) {
        const acc = accountById.get(oa.accountId);
        return {
          authMethod: 'personal_access_token', organizationId: seed.organizationId,
          user: { id: acc.id, email: acc.email, name: acc.name, role: acc.role },
          tokenType: 'personal', scopes: oa.scopes, allowedFacilityIds: acc.allowedFacilityIds
        };
      }
      // 本物は管理者が発行した PAT / App Token では user が null (ステージングで確認)
      return {
        authMethod: 'api_token',
        organizationId: seed.organizationId,
        user: null,
        tokenType: token.startsWith('cpos_pat_') ? 'personal' : 'app',
        scopes: known ? known.scopes : defaultScopes,
        allowedFacilityIds: known ? (known.allowedFacilityIds ?? null) : null
      };
    }
    const cookies = parseCookies(req.headers.cookie);
    const acc = cookies.cpos_session ? accountById.get(cookies.cpos_session) : null;
    if (acc) {
      return {
        authMethod: 'session',
        organizationId: seed.organizationId,
        user: { id: acc.id, email: acc.email, name: acc.name, role: acc.role },
        scopes: ['*'],
        allowedFacilityIds: acc.allowedFacilityIds
      };
    }
    return { error: [401, 'unauthenticated', 'ログインしていません', 'サーバ間なら Authorization: Bearer cpos_app_... を付けてください。ブラウザなら /api/auth/login?next=<戻り先> でログインしてください (KIT 模擬サーバでは誰として入るか選ぶだけ)'] };
  }

  function facilityCheck(actor, req, { required }) {
    const fid = req.headers['x-cpos-facility-id'] || new URL(req.url, 'http://x').searchParams.get('facilityId');
    if (!fid) {
      if (!required && Array.isArray(actor.allowedFacilityIds) && actor.authMethod !== 'session') {   // Cookie セッションは割り当て事業所だけを返す (本物と同じ)。400 になるのはトークンだけ
        // 本物 (2026-09 横断精査): 事業所限定トークンは facilityId 無しの一覧を 400 にする
        return { error: [400, 'facility-id-required', 'このトークンは事業所限定です。facilityId を指定してください', 'cpos.masterUsers.list({ facilityId }) のように渡してください。許可された事業所は allowedFacilityIds', { reasonCode: 'facility-id-required', allowedFacilityIds: actor.allowedFacilityIds }] };
      }
      if (!required) return { facilityId: null };
      return { error: [400, 'facility_required', 'X-Cpos-Facility-Id ヘッダがありません', 'CPOS のデータは事業所単位です。@cpos/kit/client なら cpos.masterUsers.list({ facilityId }) のように facilityId を渡すとヘッダが付きます。事業所 ID は cpos.facilities.list() で取れます'] };
    }
    if (!facilityById.has(fid)) {
      // 本物: { error: "facility <id> が見つかりません" } の 404
      return { error: [404, 'facility_not_found', `facility ${fid} が見つかりません`, 'cpos.facilities.list() の id を使ってください'] };
    }
    if (Array.isArray(actor.allowedFacilityIds) && !actor.allowedFacilityIds.includes(fid)) {
      return { error: [403, 'facility_forbidden', `事業所 ${fid} はこのトークン (またはユーザー) に許可されていません`, '許可された事業所は /api/auth/me の facilityScope.allowedFacilityIds か /api/platform/me の token.allowedFacilityIds にあります。null なら全事業所です'] };
    }
    return { facilityId: fid };
  }

  function scopeOf(actor) {
    const ids = actor.allowedFacilityIds;
    return { mode: ids === null ? 'all' : 'limited', allowedFacilityIds: ids, managerFacilityIds: actor.user?.role === 'manager' ? ids : null };
  }

  // ---- ルート ------------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const m = req.method;
    state.requests.push({ method: m, path, at: new Date().toISOString() });
    log(`${m} ${path}`);

    // 偽ログイン画面 (Google 認証の代わり)
    if (m === 'GET' && path === '/api/auth/login') {
      const next = url.searchParams.get('next') ?? '/';
      const rows = seed.accounts.map((a) => {
        const scope = a.allowedFacilityIds === null ? '全事業所' : a.allowedFacilityIds.length ? a.allowedFacilityIds.map((id) => facilityById.get(id)?.name ?? id).join('、') : '事業所なし';
        return `<li><a href="/api/auth/login/as/${esc(a.id)}?next=${encodeURIComponent(next)}">${esc(a.name)}</a> <small>(${esc(a.role)} / ${esc(scope)})</small></li>`;
      }).join('');
      return html(res, 200, `<!doctype html><meta charset="utf-8"><title>KIT 模擬サーバログイン</title>
<style>body{font-family:sans-serif;max-width:40em;margin:3em auto;line-height:1.7}small{color:#666}.b{background:#fde68a;padding:.5em 1em;border-radius:4px}</style>
<p class="b">これはKIT 模擬サーバです。本物では Google ログインになります。</p>
<h1>誰としてログインしますか</h1><ul>${rows}</ul>
<p><small>権限なしで入ると一覧が空になります。それが正しい動きです。</small></p>`);
    }
    const asMatch = path.match(/^\/api\/auth\/login\/as\/([^/]+)$/);
    if (m === 'GET' && asMatch) {
      const acc = accountById.get(decodeURIComponent(asMatch[1]));
      if (!acc) return fail(res, 404, 'no_such_account', 'そのアカウントは seed にありません');
      const next = url.searchParams.get('next') ?? '/';
      res.writeHead(302, { 'Set-Cookie': `cpos_session=${encodeURIComponent(acc.id)}; Path=/; HttpOnly; SameSite=Lax`, Location: next });
      return res.end();
    }
    if (m === 'POST' && path === '/api/auth/logout') {
      res.writeHead(204, { 'Set-Cookie': 'cpos_session=; Path=/; Max-Age=0' });
      return res.end();
    }

    // ---- OAuth 2.1 (認可コード + PKCE、公開クライアント)。本物 (docs/OAUTH.md) と同じ 4 本 + メタデータ。
    // 本物では /oauth/authorize が Google ログインに飛ばす。ここでは「誰として入るか」を選ぶだけ。
    if (m === 'GET' && path === '/.well-known/oauth-authorization-server') {
      const base = `http://${req.headers.host ?? 'fake-cpos'}`;
      return json(res, 200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, revocation_endpoint: `${base}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    }
    if (m === 'POST' && path === '/oauth/register') {
      const body = await readBody(req);
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
      if (!uris.length) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris が要ります' });
      if (uris.some((u) => !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:|\/|$))/.test(u))) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uri は https か http://localhost / 127.0.0.1 だけ' });
      const client = { client_id: `cpos_oc_fake_${randomUUID().slice(0, 8)}`, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: String(body.client_name ?? 'app'), redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      state.oauth.clients.set(client.client_id, client);
      return json(res, 201, client);
    }
    if (m === 'GET' && path === '/oauth/authorize') {
      const q = url.searchParams;
      const client = state.oauth.clients.get(q.get('client_id') ?? '');
      if (!client) return html(res, 400, '<p>client_id が登録されていません (POST /oauth/register)</p>');
      if (!client.redirect_uris.includes(q.get('redirect_uri') ?? '')) return html(res, 400, '<p>redirect_uri が登録と一致しません</p>');
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return html(res, 400, '<p>PKCE (S256) が要ります</p>');
      const rows = seed.accounts.map((a) => {
        const scope = a.allowedFacilityIds === null ? '全事業所' : a.allowedFacilityIds.length ? a.allowedFacilityIds.map((id) => facilityById.get(id)?.name ?? id).join('、') : '事業所なし';
        return `<li><a href="/oauth/authorize/as/${esc(a.id)}?${esc(q.toString())}">${esc(a.name)}</a> <small>(${esc(a.role)} / ${esc(scope)})</small></li>`;
      }).join('');
      return html(res, 200, `<!doctype html><meta charset="utf-8"><title>KIT 模擬サーバ OAuth</title>
<style>body{font-family:sans-serif;max-width:40em;margin:3em auto;line-height:1.7}small{color:#666}.b{background:#fde68a;padding:.5em 1em;border-radius:4px}</style>
<p class="b">これはKIT 模擬サーバです。本物では Google ログインのあと「${esc(client.client_name)} に許可しますか」の同意画面になります。</p>
<h1>誰としてログインしますか</h1><ul>${rows}</ul>`);
    }
    const oaAs = path.match(/^\/oauth\/authorize\/as\/([^/]+)$/);
    if (m === 'GET' && oaAs) {
      const acc = accountById.get(decodeURIComponent(oaAs[1]));
      const q = url.searchParams;
      if (!acc) return fail(res, 404, 'no_such_account', 'そのアカウントは seed にありません');
      const code = `code_${randomUUID()}`;
      state.oauth.codes.set(code, { accountId: acc.id, clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), challenge: q.get('code_challenge'), scopes: (q.get('scope') ?? '').split(/\s+/).filter(Boolean), exp: Date.now() + 10 * 60 * 1000 });
      const to = new URL(q.get('redirect_uri'));
      to.searchParams.set('code', code);
      if (q.get('state')) to.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: to.toString() });
      return res.end();
    }
    if (m === 'POST' && path === '/oauth/token') {
      const b = await readForm(req);
      if (b.grant_type === 'refresh_token') {
        const old = [...state.oauth.tokens.entries()].find(([, t]) => t.refresh === b.refresh_token);
        if (!old) return json(res, 400, { error: 'invalid_grant' });
        state.oauth.tokens.delete(old[0]);
        const access = `cpos_pat_fake_${randomUUID()}`, refresh = `cpos_rt_fake_${randomUUID()}`;
        state.oauth.tokens.set(access, { ...old[1], refresh });
        return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: old[1].scopes.join(' ') });
      }
      if (b.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
      const c = state.oauth.codes.get(b.code ?? '');
      state.oauth.codes.delete(b.code ?? '');   // 1 回限り
      if (!c || c.exp < Date.now()) return json(res, 400, { error: 'invalid_grant', error_description: '認可コードが無効か期限切れ (10 分・1 回限り)' });
      if (c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'client_id / redirect_uri が認可時と違う' });
      const expect = createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url');
      if (expect !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'code_verifier が code_challenge と合わない (PKCE S256)' });
      const scopes = c.scopes.length ? c.scopes : ['facilities:read', 'master-users:read'];
      const access = `cpos_pat_fake_${randomUUID()}`, refresh = `cpos_rt_fake_${randomUUID()}`;
      state.oauth.tokens.set(access, { accountId: c.accountId, scopes, refresh });
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: scopes.join(' ') });
    }
    if (m === 'POST' && path === '/oauth/revoke') {
      const b = await readForm(req);
      for (const [k, t] of state.oauth.tokens) if (k === b.token || t.refresh === b.token) state.oauth.tokens.delete(k);
      return json(res, 200, {});   // 有無は教えない (本物と同じ)
    }

    // デバッグ
    if (path === '/__fake/state') return json(res, 200, { seed: { organizationId: seed.organizationId, facilities: seed.facilities.length, users: seed.users.length, accounts: seed.accounts.map((a) => a.id) }, appData: [...state.appData.entries()].map(([k, v]) => ({ key: k, count: v.size })), requests: state.requests.slice(-50) });
    if (m === 'POST' && path === '/__fake/reset') { state.appData.clear(); state.requests.length = 0; return json(res, 200, { ok: true }); }
    if (path === '/api/health') return json(res, 200, { ok: true, fake: true });

    // 以下は認証必須
    const actor = actorOf(req);
    if (actor.error) return fail(res, ...actor.error);

    if (m === 'GET' && path === '/api/auth/me') {
      if (!actor.user) return fail(res, 401, 'unauthenticated', 'App Token ではユーザーがいません', 'App Token の確認は /api/platform/me を使ってください。ユーザーの確認はブラウザの Cookie を転送して /api/auth/me です');
      const scope = scopeOf(actor);
      return json(res, 200, { ok: true, authMethod: actor.authMethod, organizationId: actor.organizationId, user: { ...actor.user, organizationId: actor.organizationId }, token: null, facilityScope: scope, allFacilities: scope.mode === 'all', allowedFacilityIds: scope.allowedFacilityIds, managerFacilityIds: scope.managerFacilityIds, appPermissions: [], recordPermissions: [] });
    }
    if (m === 'GET' && path === '/api/platform/me') {
      return json(res, 200, { ok: true, authMethod: actor.authMethod, organizationId: actor.organizationId, token: actor.authMethod === 'session' ? null : { authMethod: 'api_token', id: 'tok_fake', name: 'fake token', tokenType: actor.tokenType, audience: null, tokenPreview: '****', scopes: actor.scopes, allowedFacilityIds: actor.allowedFacilityIds, expiresAt: null, lastUsedAt: null }, user: actor.user });
    }
    if (m === 'GET' && path === '/api/capabilities') {
      // 本物 (ステージングで確認) と同じ形。値は seed の capabilities があればそれ、無ければ本物の 2026-09-07 時点の既定
      return json(res, 200, seed.capabilities ?? { server: 'cpos', features: { careSchedules: { coVisitors: true, occurrences: true, cancel: true }, careDocuments: { revertCanonical: true, templates: true }, appData: { ownerOnly: true, userRef: true, attachments: true, confidential: true }, masterUsers: { masterUserId: true, identifierAliases: true, merge: true, changeInsuredNumber: true }, formTemplates: { importExport: true, serviceTypeFiltering: true }, externalPartners: { ensureOverwrite: true }, filing: { masterUserUpsert: true } } });
    }
    if (m === 'GET' && path === '/api/platform/facilities') {
      if (!requireScope(actor, res, 'facilities:read')) return;
      const ids = actor.allowedFacilityIds;
      return json(res, 200, seed.facilities.filter((f) => ids === null || ids.includes(f.id)));
    }
    if (m === 'GET' && path === '/api/platform/master-users') {
      // 利用者 (介護を受ける人)。本物は facilityId 省略時に「許可された全事業所」を返す (ステージングで確認)。
      if (!requireScope(actor, res, 'master-users:read')) return;
      const fc = facilityCheck(actor, req, { required: false });
      if (fc.error) return fail(res, ...fc.error);
      const q = (url.searchParams.get('query') ?? url.searchParams.get('q') ?? '').trim();
      const allowed = actor.allowedFacilityIds;
      let items = seed.users.filter((u) => (fc.facilityId ? u.facilityIds.includes(fc.facilityId) : allowed === null || u.facilityIds.some((id) => allowed.includes(id))));
      if (q) items = items.filter((u) => u.name.includes(q) || (u.furigana ?? '').includes(q));
      const limit = Number(url.searchParams.get('limit'));
      if (limit > 0) items = items.slice(0, limit);
      return json(res, 200, items);
    }
    // 事業所の職員。profession に職種が入る (nurse / care_manager / physical_therapist / care_worker …)。
    // 「看護師が誰か」はここで分かる。項目名はステージングの実測に合わせている。
    // 2 本ある (/api/platform/facility-staff と /api/facilities/:facilityId/staff)。本物はどちらも observed で同じ形 (実験 13 で片方が 501 と指摘された)。
    const staffRows = (facilityId) => seed.staff.filter((st) => (st.facilityIds ?? []).includes(facilityId)).map((st) => ({
      id: st.id, facilityId, userId: st.userId ?? null, name: st.name, nameKana: st.nameKana ?? null,
      displayName: st.displayName ?? st.name, normalizedNameKey: (st.name ?? '').replace(/[\s\u3000]/g, ''),
      profession: st.profession ?? null, professions: st.professions ?? [], qualifiedPersonId: st.qualifiedPersonId ?? null,
      employeeId: st.employeeId ?? null, aliases: st.aliases ?? [], organizationId: seed.organizationId,
      role: st.role ?? null, status: st.status ?? 'active', email: st.email ?? null, phone: st.phone ?? null, displayOrder: st.displayOrder ?? 0,
      createdAt: st.createdAt ?? '2026-01-01T00:00:00.000Z', updatedAt: st.updatedAt ?? '2026-01-01T00:00:00.000Z', createdBy: null, updatedBy: null
    }));
    if (m === 'GET' && path === '/api/platform/facility-staff') {
      if (!requireScope(actor, res, 'facility-staff:read')) return;
      const fc = facilityCheck(actor, req, { required: true });
      if (fc.error) return fail(res, ...fc.error);
      const rows = staffRows(fc.facilityId);
      return json(res, 200, { items: rows, staff: rows });
    }
    const facStaff = path.match(/^\/api\/facilities\/([^/]+)\/staff(?:\/([^/]+))?$/);
    if (m === 'GET' && facStaff) {
      if (!requireScope(actor, res, 'facility-staff:read')) return;
      const fid = decodeURIComponent(facStaff[1]);
      const fc = facilityCheck(actor, { headers: { 'x-cpos-facility-id': fid }, url: req.url }, { required: true });
      if (fc.error) return fail(res, ...fc.error);
      const rows = staffRows(fid);
      if (facStaff[2]) {
        const one = rows.find((r) => r.id === decodeURIComponent(facStaff[2]));
        return one ? json(res, 200, one) : fail(res, 404, 'staff_not_found', `職員 ${facStaff[2]} が見つかりません`);
      }
      return json(res, 200, { items: rows, staff: rows });
    }
    if (m === 'GET' && path === '/api/care-schedules/occurrences') {
      // 予定を日付に展開したもの。occurrenceDate + assignedStaffId があるので、
      // facility-staff の profession と突き合わせれば「看護師が出勤している日」が出せる。
      // 項目名と必須パラメータはステージングの実測に合わせている (dateFrom / dateTo が無ければ 400)。
      if (!requireScope(actor, res, 'care-schedules:read')) return;
      const fc = facilityCheck(actor, req, { required: true });
      if (fc.error) return fail(res, ...fc.error);
      const dateFrom = url.searchParams.get('dateFrom'), dateTo = url.searchParams.get('dateTo');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo ?? '')) {
        return fail(res, 400, 'invalid-range', 'dateFrom / dateTo (YYYY-MM-DD) が必要です', '例: ?facilityId=...&dateFrom=2026-09-01&dateTo=2026-09-30');
      }
      const staffId = url.searchParams.get('assignedStaffId');
      let items = (seed.careScheduleOccurrences ?? []).filter((o) => o.facilityId === fc.facilityId && o.occurrenceDate >= dateFrom && o.occurrenceDate <= dateTo);
      if (staffId) items = items.filter((o) => o.assignedStaffId === staffId);
      return json(res, 200, { dateFrom, dateTo, items });
    }
    if (m === 'GET' && path === '/api/care-service-actuals/v1') {
      // サービス提供実績。「この利用者に過去の利用があったか」はここで分かる。
      if (!requireScope(actor, res, 'care-service-actuals:read')) return;
      const fc = facilityCheck(actor, req, { required: true });
      if (fc.error) return fail(res, ...fc.error);
      const ins = url.searchParams.get('insuredNumber');
      let items = (seed.careServiceActuals ?? []).filter((r) => r.facilityId === fc.facilityId);
      if (ins) items = items.filter((r) => r.insuredNumber === ins);
      return json(res, 200, { items });
    }
    // ---- シフト (shifts) ---------------------------------------------------
    // 形は 2026-09-14 のステージング実測 (実験 14) と CPOS 本体の shifts ルートの実装に合わせている。
    //   GET  /api/shifts/shift-types                   → 配列 (facilityId null = 組織共通。?facilityId= で事業所固有も含む)
    //   GET  /api/shifts/plans[?facilityId&targetMonth] → 配列。同じ事業所・同じ月の計画を複数作れる (本物は重複を止めない)
    //   POST /api/shifts/plans { facilityId, targetMonth } → 計画 1 件 (status draft, revision 1)。無ければ 400
    //   GET  /api/shifts/plans/:id                     → { plan, assignments, conflicts }
    //   PUT  /api/shifts/plans/:id/assignments { assignments: [{ userId, date, startTime, endTime, shiftType?, roleRequired?, notes? }], reason? }
    //        → { assignments, conflicts }。1 計画分を丸ごと置換。id は振り直す。revision +1、history に 1 件。
    //        **本物は userId / date / startTime / endTime の無い項目を 400 にせず黙って捨てる** (実験 14 で総当たりが要った)。
    //        模擬サーバは同じ項目を 400 で止め、hint に形を書く (推測で画面を作らせないため。本物との差はこの 1 点)。
    //   GET  /api/shifts/plans/:id/history             → 配列 (新しい順) { id, planId, changedBy, changedAt, reason, before: {count}, after: {count} }
    //   POST /api/shifts/shift-types { code, name, startTime?, endTime?, color?, facilityId? } → 201 / DELETE /api/shifts/shift-types/:id
    //   GET/POST /api/shifts/staffing-requirements { role, requiredCount, dayOfWeek?, startTime?, endTime?, facilityId? } / DELETE …/:id
    //   GET/POST /api/shifts/preferences { facilityId, targetMonth, userId, preferredDays[], unavailableDays[], note } → draft / POST …/:id/submit → submitted
    //        (これらの body は CPOS 本体の shifts ルートの実装から。ステージングでは 0 件だったので応答は実測していない)
    //   計画の DELETE は本物に無い (作った計画は消せない。検証は専用の事業所・月で)。
    if (path.startsWith('/api/shifts/')) {
      const write = m !== 'GET';
      if (!requireScope(actor, res, write ? 'shifts:write' : 'shifts:read')) return;
      const nowIso = () => new Date().toISOString();
      const plansOf = () => [...state.shifts.plans.values()];
      if (m === 'GET' && path === '/api/shifts/shift-types') {
        const fid = url.searchParams.get('facilityId');
        const rows = [...(seed.shiftTypes ?? []).map((t) => ({ id: t.id, organizationId: seed.organizationId, ...t, createdAt: t.createdAt ?? '2026-01-01T00:00:00.000Z', updatedAt: t.updatedAt ?? '2026-01-01T00:00:00.000Z' })), ...state.shifts.shiftTypes.values()]
          .filter((t) => t.facilityId === null || !fid || t.facilityId === fid);
        return json(res, 200, rows);
      }
      // 勤務区分 (事業所固有) の登録 { code, name, startTime?, endTime?, breakMinutes?, color?, facilityId? } と削除。seed の組織共通は消せない
      if (m === 'POST' && path === '/api/shifts/shift-types') {
        const body = await readBody(req);
        if (body.__invalid || !body.code || !body.name) return fail(res, 400, 'invalid_body', 'code と name は必須です', '例: { code: "N", name: "夜勤", startTime: "17:00", endTime: "09:00", facilityId }');
        if (body.facilityId) { const fc = facilityCheck(actor, { headers: { 'x-cpos-facility-id': body.facilityId }, url: req.url }, { required: true }); if (fc.error) return fail(res, ...fc.error); }
        const existing = body.id ? state.shifts.shiftTypes.get(body.id) : null;
        const t = nowIso();
        const row = { id: existing?.id ?? `shtype_${randomUUID()}`, organizationId: seed.organizationId, facilityId: body.facilityId !== undefined ? body.facilityId : existing?.facilityId ?? null, code: body.code, name: body.name, category: body.category ?? 'other', startTime: body.startTime ?? existing?.startTime ?? null, endTime: body.endTime ?? existing?.endTime ?? null, breakMinutes: body.breakMinutes ?? existing?.breakMinutes ?? null, workHours: body.workHours ?? null, color: body.color ?? existing?.color ?? null, sortOrder: body.sortOrder ?? null, isActive: body.isActive ?? true, note: body.note ?? null, createdAt: existing?.createdAt ?? t, updatedAt: t };
        state.shifts.shiftTypes.set(row.id, row);
        return json(res, existing ? 200 : 201, row);
      }
      const stm = path.match(/^\/api\/shifts\/shift-types\/([^/]+)$/);
      if (m === 'DELETE' && stm) {
        if (!state.shifts.shiftTypes.delete(decodeURIComponent(stm[1]))) return fail(res, 404, 'not_found', '勤務区分が見つかりません (seed の組織共通は消せない)');
        return json(res, 200, { ok: true });
      }
      // 必要人員 (曜日別) { role, requiredCount, dayOfWeek? (0-6 | null = 毎日), startTime?, endTime?, facilityId? } と削除
      if (m === 'POST' && path === '/api/shifts/staffing-requirements') {
        const body = await readBody(req);
        if (body.__invalid || !body.role || typeof body.requiredCount !== 'number') return fail(res, 400, 'invalid_body', 'role と requiredCount は必須です', '例: { facilityId, role: "nurse", requiredCount: 2, dayOfWeek: 1, startTime: "09:00", endTime: "18:00" }');
        if (body.dayOfWeek !== undefined && body.dayOfWeek !== null && !(Number.isInteger(body.dayOfWeek) && body.dayOfWeek >= 0 && body.dayOfWeek <= 6)) return fail(res, 400, 'invalid_body', 'dayOfWeek は 0 (日) 〜 6 (土) または null (毎日) です');
        if (body.facilityId) { const fc = facilityCheck(actor, { headers: { 'x-cpos-facility-id': body.facilityId }, url: req.url }, { required: true }); if (fc.error) return fail(res, ...fc.error); }
        const t = nowIso();
        const row = { id: body.id ?? `shreq_${randomUUID()}`, organizationId: seed.organizationId, facilityId: body.facilityId ?? null, dayOfWeek: body.dayOfWeek ?? null, startTime: body.startTime ?? null, endTime: body.endTime ?? null, timeBandLabel: body.timeBandLabel ?? null, role: body.role, requiredCount: body.requiredCount, isActive: body.isActive ?? true, note: body.note ?? null, createdAt: t, updatedAt: t };
        state.shifts.requirements.set(row.id, row);
        return json(res, state.shifts.requirements.has(body.id) && body.id ? 200 : 201, row);
      }
      const rqm = path.match(/^\/api\/shifts\/staffing-requirements\/([^/]+)$/);
      if (m === 'DELETE' && rqm) {
        if (!state.shifts.requirements.delete(decodeURIComponent(rqm[1]))) return fail(res, 404, 'not_found', '必要人員が見つかりません');
        return json(res, 200, { ok: true });
      }
      if (m === 'GET' && path === '/api/shifts/staffing-requirements') {
        const fid = url.searchParams.get('facilityId');
        return json(res, 200, [...state.shifts.requirements.values()].filter((r) => !fid || r.facilityId === fid));
      }
      // 勤務希望 { facilityId, targetMonth, userId (トークン経由では必須), preferredDays[], unavailableDays[], constraints[], note } → draft。/:id/submit で submitted
      if (m === 'GET' && path === '/api/shifts/preferences') {
        const fid = url.searchParams.get('facilityId'), month = url.searchParams.get('targetMonth') ?? url.searchParams.get('month');
        return json(res, 200, [...state.shifts.preferences.values()].filter((r) => (!fid || r.facilityId === fid) && (!month || r.targetMonth === month)));
      }
      if (m === 'POST' && path === '/api/shifts/preferences') {
        const body = await readBody(req);
        if (body.__invalid || !body.facilityId || !/^\d{4}-\d{2}$/.test(body.targetMonth ?? '')) return fail(res, 400, 'invalid_body', 'facilityId と targetMonth は必須です');
        const userId = actor.user?.id ?? (typeof body.userId === 'string' && body.userId ? body.userId : null);
        if (!userId) return fail(res, 400, 'invalid_body', 'API トークン経由では userId が必須です', '本人の代わりに出すときは body.userId に職員の userId');
        const fc = facilityCheck(actor, { headers: { 'x-cpos-facility-id': body.facilityId }, url: req.url }, { required: true }); if (fc.error) return fail(res, ...fc.error);
        const existing = body.id ? state.shifts.preferences.get(body.id) : null;
        const t = nowIso();
        const row = { id: existing?.id ?? `shpref_${randomUUID()}`, organizationId: seed.organizationId, facilityId: body.facilityId, userId: existing?.userId ?? userId, targetMonth: body.targetMonth, preferredDays: Array.isArray(body.preferredDays) ? body.preferredDays : existing?.preferredDays ?? [], unavailableDays: Array.isArray(body.unavailableDays) ? body.unavailableDays : existing?.unavailableDays ?? [], constraints: Array.isArray(body.constraints) ? body.constraints : existing?.constraints ?? [], note: body.note ?? existing?.note ?? null, status: existing?.status ?? 'draft', submittedAt: existing?.submittedAt ?? null, createdAt: existing?.createdAt ?? t, updatedAt: t };
        state.shifts.preferences.set(row.id, row);
        return json(res, existing ? 200 : 201, row);
      }
      const pfm = path.match(/^\/api\/shifts\/preferences\/([^/]+)\/submit$/);
      if (m === 'POST' && pfm) {
        const row = state.shifts.preferences.get(decodeURIComponent(pfm[1]));
        if (!row) return fail(res, 404, 'not_found', '勤務希望が見つかりません');
        Object.assign(row, { status: 'submitted', submittedAt: nowIso(), updatedAt: nowIso() });
        return json(res, 200, row);
      }
      if (path === '/api/shifts/plans') {
        if (m === 'GET') {
          const fid = url.searchParams.get('facilityId'), month = url.searchParams.get('targetMonth');
          let rows = plansOf();
          if (Array.isArray(actor.allowedFacilityIds)) rows = rows.filter((p) => p.facilityId === null || actor.allowedFacilityIds.includes(p.facilityId));
          if (fid) rows = rows.filter((p) => p.facilityId === fid);
          if (month) rows = rows.filter((p) => p.targetMonth === month);
          return json(res, 200, rows);
        }
        if (m === 'POST') {
          const body = await readBody(req);
          if (body.__invalid || !/^\d{4}-\d{2}$/.test(body.targetMonth ?? '') || body.facilityId === undefined) {
            return fail(res, 400, 'invalid_body', 'targetMonth と facilityId (事業所計画) または facilityId=null (会社全体計画) は必須です', '例: cpos.app.shifts.postPlans({ facilityId, body: { facilityId, targetMonth: "2026-11" } })');
          }
          if (body.facilityId !== null) {
            const fc = facilityCheck(actor, { headers: { 'x-cpos-facility-id': body.facilityId }, url: req.url }, { required: true });
            if (fc.error) return fail(res, ...fc.error);
          }
          const t = nowIso();
          const plan = { id: `shplan_${randomUUID()}`, organizationId: seed.organizationId, facilityId: body.facilityId, targetMonth: body.targetMonth, status: 'draft', revision: 1, createdBy: actor.user?.id ?? 'api-token', finalizedBy: null, finalizedAt: null, publishedAt: null, createdAt: t, updatedAt: t };
          state.shifts.plans.set(plan.id, plan); state.shifts.assignments.set(plan.id, []); state.shifts.history.set(plan.id, []);
          return json(res, 201, plan);
        }
      }
      const pm = path.match(/^\/api\/shifts\/plans\/([^/]+)(?:\/(assignments|history|finalize|publish))?$/);
      if (pm) {
        const plan = state.shifts.plans.get(decodeURIComponent(pm[1]));
        if (!plan) return fail(res, 404, 'not_found', `シフト計画 ${pm[1]} が見つかりません`, 'GET /api/shifts/plans で id を確かめてください (KIT 模擬サーバは起動のたびに空。POST /api/shifts/plans で作る)');
        if (plan.facilityId && Array.isArray(actor.allowedFacilityIds) && !actor.allowedFacilityIds.includes(plan.facilityId)) return fail(res, 403, 'facility_forbidden', `事業所 ${plan.facilityId} はこのトークン (またはユーザー) に許可されていません`);
        const asg = state.shifts.assignments.get(plan.id) ?? [];
        // 衝突の形は CPOS 本体の rules (kind / userId / date / message / assignmentIds)。時刻が HH:MM でない ("-" の休みも) は invalid-time-range になる (本物と同じ。保存はされる)
        const mins = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(String(t ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
        const conflictsOf = (rows) => {
          const out = [];
          for (const a of rows) {
            const st = mins(a.startTime), en = mins(a.endTime);
            if (st === null || en === null || st >= en) out.push({ kind: 'invalid-time-range', userId: a.userId, date: a.date, message: `不正な時間帯: ${a.startTime}-${a.endTime}`, assignmentIds: [a.id] });
          }
          for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
            const a = rows[i], b = rows[j];
            if (a.userId !== b.userId || a.date !== b.date) continue;
            const as = mins(a.startTime), ae = mins(a.endTime), bs = mins(b.startTime), be = mins(b.endTime);
            if (as === null || ae === null || bs === null || be === null) continue;
            if (as < be && bs < ae) out.push({ kind: 'double-booking', userId: a.userId, date: a.date, message: '同一職員が同日に重複した時間帯で割り当てられています', assignmentIds: [a.id, b.id] });
          }
          return out;
        };
        if (m === 'GET' && !pm[2]) return json(res, 200, { plan, assignments: asg, conflicts: conflictsOf(asg) });
        if (m === 'GET' && pm[2] === 'history') return json(res, 200, [...(state.shifts.history.get(plan.id) ?? [])].reverse());
        if (m === 'PUT' && pm[2] === 'assignments') {
          if (plan.status === 'archived') return fail(res, 409, 'archived', 'archived な計画は編集できません');
          const body = await readBody(req);
          const incoming = Array.isArray(body.assignments) ? body.assignments : null;
          if (body.__invalid || !incoming) return fail(res, 400, 'assignments_required', 'assignments (配列) が必要です', '本文は { assignments: [{ userId, date: "YYYY-MM-DD", startTime: "HH:MM", endTime: "HH:MM", shiftType?: string, roleRequired?, notes? }], reason?: string }。1 計画分を丸ごと置換します (送らなかった割当は消える)');
          const bad = incoming.findIndex((a) => !a || !a.userId || !/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? '') || !a.startTime || !a.endTime);
          if (bad !== -1) return fail(res, 400, 'assignment_invalid', `assignments[${bad}] に userId / date / startTime / endTime のどれかがありません`, '本物の CPOS はこの項目を 400 にせず黙って捨てます (保存されたように見えて消える)。KIT 模擬サーバは止めます。休みは startTime / endTime に "-" を入れるか、その日の割当を送らない');
          const saved = incoming.map((a) => ({ id: a.id ?? `shasg_${randomUUID()}`, planId: plan.id, organizationId: seed.organizationId, facilityId: a.facilityId !== undefined ? a.facilityId : plan.facilityId, userId: a.userId, date: a.date, startTime: a.startTime, endTime: a.endTime, shiftType: a.shiftType ?? 'day', roleRequired: a.roleRequired ?? null, notes: a.notes ?? null }));
          const t = nowIso();
          state.shifts.assignments.set(plan.id, saved);
          plan.revision += 1; plan.updatedAt = t;
          (state.shifts.history.get(plan.id) ?? state.shifts.history.set(plan.id, []).get(plan.id)).push({ id: `shlog_${randomUUID()}`, planId: plan.id, changedBy: actor.user?.id ?? 'api-token', changedAt: t, reason: typeof body.reason === 'string' ? body.reason : null, before: { count: asg.length }, after: { count: saved.length } });
          return json(res, 200, { assignments: saved, conflicts: conflictsOf(saved) });
        }
        if (m === 'POST' && (pm[2] === 'finalize' || pm[2] === 'publish')) {
          const t = nowIso();
          if (pm[2] === 'finalize') Object.assign(plan, { status: 'finalized', finalizedBy: actor.user?.id ?? 'api-token', finalizedAt: t, updatedAt: t });
          else {
            if (plan.status !== 'finalized') return fail(res, 409, 'not_finalized', '確定 (finalized) 済の計画のみ公開できます', '先に POST /api/shifts/plans/:id/finalize');
            Object.assign(plan, { status: 'published', publishedAt: t, updatedAt: t });
          }
          return json(res, 200, plan);
        }
      }
      return fail(res, 501, 'not_implemented', `KIT 模擬サーバは ${m} ${path} の応答をまだ持っていません (本物の形が未確認のため)`, 'ステージングで形を確認し、kit の保守者に seed への追加を頼んでください。推測で画面を作らないでください');
    }
    // ---- 人事系 (読み取りだけ。形は 2026-09-14 のステージング実測) --------------------
    //   GET /api/platform/employees[?facilityId]        → { employees: [...] } (従業員台帳。職員 facility-staff とは別。突合は authUserId / email / 氏名)
    //   GET /api/platform/qualified-persons[?facilityId] → { qualifiedPersons: [...] }
    //   GET /api/trainings?facilityId                   → { items: [] }  (ステージングでも 0 件。項目名は未確認)
    //   GET /api/platform/fte?facilityId&month           → { facilityId, month, fteEntries: [], summary: { totalFte, careWorkerFte, nurseFte, ptOtStFte, careWorkerCertifiedRatio } }
    //   GET /api/staffing-standards?facilityId           → { items: [] }  (ステージングでも 0 件)
    if (m === 'GET' && (path === '/api/platform/employees' || path === '/api/platform/qualified-persons')) {
      if (!requireScope(actor, res, path.endsWith('employees') ? 'employees:read' : 'qualified-persons:read')) return;
      const fc = facilityCheck(actor, req, { required: false });
      if (fc.error) return fail(res, ...fc.error);
      let emps = (seed.employees ?? []).map((e) => ({ ...e, organizationId: seed.organizationId }));
      if (fc.facilityId) emps = emps.filter((e) => (e.facilityIds ?? []).includes(fc.facilityId));
      if (path.endsWith('employees')) return json(res, 200, { employees: emps });
      return json(res, 200, { qualifiedPersons: emps.map((e) => ({ id: e.id, displayName: e.name, personType: 'employee', qualifications: e.qualifications ?? [], facilityIds: e.facilityIds ?? [], active: e.active !== false, validFrom: null, validTo: null })) });
    }
    if (m === 'GET' && path === '/api/trainings') {
      if (!requireScope(actor, res, 'trainings:read')) return;
      const fc = facilityCheck(actor, req, { required: true });
      if (fc.error) return fail(res, ...fc.error);
      return json(res, 200, { items: [] });
    }
    if (m === 'GET' && path === '/api/platform/fte') {
      if (!requireScope(actor, res, 'fte:read')) return;
      const fc = facilityCheck(actor, req, { required: true });
      if (fc.error) return fail(res, ...fc.error);
      return json(res, 200, { facilityId: fc.facilityId, month: url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7), fteEntries: [], summary: { totalFte: 0, careWorkerFte: 0, nurseFte: 0, ptOtStFte: 0, careWorkerCertifiedRatio: 0 } });
    }
    if (m === 'GET' && path === '/api/staffing-standards') {
      if (!requireScope(actor, res, 'staffing-standards:read')) return;
      const fc = facilityCheck(actor, req, { required: false });
      if (fc.error) return fail(res, ...fc.error);
      return json(res, 200, { items: [] });
    }
    if (m === 'GET' && path === '/api/platform/users') {
      // 組織内のログインユーザー (職員のアカウント)。利用者ではない。間違えやすいので応答にも書く。
      if (!requireScope(actor, res, 'users:read')) return;
      return json(res, 200, { ok: true, organizationId: seed.organizationId, users: seed.accounts.map((a) => ({ id: a.id, email: a.email, name: a.name, role: a.role })), note: 'これは職員のアカウント一覧です。利用者 (介護を受ける人) は /api/platform/master-users です' });
    }

    const ad = path.match(/^\/api\/app-data\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (ad) {
      const [, appId, resource, id] = ad.map((s) => (s === undefined ? s : decodeURIComponent(s)));
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(appId)) return fail(res, 400, 'invalid_app_id', `appId ${appId} の形式が違います`, '英小文字・数字・_・- で 64 字まで。cpos.manifest.json の appId と同じものを使ってください');
      // 本物 (ステージングで確認): resource は a-z 0-9 ハイフンのみ。camelCase は 400
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(resource)) return fail(res, 400, 'invalid_resource', 'resource の形式が不正です (許可: a-z 0-9 ハイフン, 1-64 文字, 先頭は英数字)', `resource 名を英小文字とハイフンにしてください (例 transport-plans)。cpos.manifest.json の resources と揃えます`);
      if (!requireScope(actor, res, `app-data:${appId}:${m === 'GET' ? 'read' : 'write'}`)) return;
      const fc = facilityCheck(actor, req, { required: false });
      if (fc.error) return fail(res, ...fc.error);
      const key = `${appId}/${resource}`;
      if (!state.appData.has(key)) state.appData.set(key, new Map());
      const store = state.appData.get(key);
      const visible = () => [...store.values()].filter((r) => !fc.facilityId || r.facilityId === fc.facilityId || r.facilityId === null);
      if (!id && m === 'GET') {
        const items = visible();
        const paginated = url.searchParams.get('paginated') === 'true' || url.searchParams.has('cursor');
        if (!paginated) return json(res, 200, items);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const offset = Number(url.searchParams.get('cursor')) || 0;
        const slice = items.slice(offset, offset + limit);
        return json(res, 200, { items: slice, nextCursor: offset + slice.length < items.length ? String(offset + slice.length) : null });
      }
      if (!id && m === 'POST') {
        const body = await readBody(req);
        if (body.__invalid || !body.data || typeof body.data !== 'object') return fail(res, 400, 'data_required', 'data (object) が必要です', 'POST の本文は { "data": { ... } } です。cpos.appData(appId).create(resource, data) を使えば形は合います');
        if (schemaMismatch(res, appId, resource, body.data)) return;
        const now = new Date().toISOString();
        const rec = { id: randomUUID(), organizationId: actor.organizationId, facilityId: body.facilityId ?? fc.facilityId ?? '' /* 本物は組織単位の記録を facilityId: "" で返す (2026-09-08 ステージング確認) */, createdBy: actor.user?.id ?? 'api-token', status: 'active', data: body.data, createdAt: now, updatedAt: now };
        store.set(rec.id, rec);
        return json(res, 201, rec);
      }
      if (id && m === 'GET') {
        const rec = store.get(id);
        if (!rec || !visible().includes(rec)) return fail(res, 404, 'not_found', `${resource}/${id} はありません`);
        return json(res, 200, rec);
      }
      if (id && m === 'PUT') {
        const rec = store.get(id);
        if (!rec) return fail(res, 404, 'not_found', `${resource}/${id} はありません`);
        const body = await readBody(req);
        if (body.__invalid || !body.data || typeof body.data !== 'object') return fail(res, 400, 'data_required', 'data (object) が必要です');
        if (schemaMismatch(res, appId, resource, body.data)) return;
        rec.data = body.data; rec.updatedAt = new Date().toISOString();
        return json(res, 200, rec);
      }
      if (id && m === 'DELETE') {
        if (!store.delete(id)) return fail(res, 404, 'not_found', `${resource}/${id} はありません`);
        res.writeHead(204); return res.end();
      }
    }

    // 本物は知らないパスに 404 の HTML を返す。KIT 模擬サーバは「何が無いか」を JSON で言う (501)。
    return fail(res, 501, 'not_implemented', `KIT 模擬サーバには ${m} ${path} の応答がありません`, 'CPOS には有る API です (kit/api.d.ts)。本物 (ステージング) につないで確かめ、それまで画面は「CPOS 接続待ち」にします。応答の形は実物を見てから決めてください (本物は無いパスに 404 の HTML を返す)');
  }

  return { handle, seed, state };
}
