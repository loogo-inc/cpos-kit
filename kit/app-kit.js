// ログインゲートウェイ。ブラウザの利用者を CPOS で認証し、このアプリ自身のセッションを発行する。
//
//   import { loginUrl, identityFromRequest, sealSession, unsealSession, requireLogin } from '@cpos/kit/app-kit';
//
// なぜ要るか: 見本サーバには利用者の認証が無い。App Token はサーバ間の鍵で、
// 「いま画面を見ているのが誰か」は答えない。**CPOS の利用者は CPOS がログインさせる**
// (独自のパスワード DB を作らない)。その受け口がこれ。
//
// 流れ (CPOS 共通ログインゲートウェイ方式。既存アプリの本番実装と同じ):
//
//   1. 未ログインなら  CPOS/api/auth/login?next=<自分の URL>  へ 302
//   2. CPOS が認証し、cpos_session cookie を CPOS のドメイン (例 .example.co.jp) に発行して戻す
//   3. アプリは **cpos_session だけ** を CPOS/api/auth/me に転送して「誰か」を聞く
//   4. 返ってきた身元で、アプリ自身の署名つきセッション cookie を発行する
//
// 守っていること:
//   - **App Token を cookie に入れない。** ブラウザに鍵を渡さない
//   - **転送するのは cpos_session だけ。** 自分のセッション cookie は CPOS に送らない
//   - **facilityScope が読めなければ unknown = 権限なし** として扱う (fail-close)。
//     「分からない = 全事業所」にすると、他の事業所のデータが見える事故になる
//
// 前提: アプリが CPOS と同じ cookie ドメイン (CPOS が cookie を発行するドメインのサブドメイン) にあること。
// 別ドメインに置くなら OAuth 2.1 (スキル §7.5) を使う。

import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const CPOS_COOKIE = 'cpos_session';

/** CPOS のログイン画面へ送る URL。戻り先 (next) は自分の URL。 */
export function loginUrl({ cposBaseUrl, next }) {
  if (!cposBaseUrl) throw new Error('cposBaseUrl がありません');
  if (!next) throw new Error('next (ログイン後の戻り先) がありません');
  const u = new URL(`${String(cposBaseUrl).replace(/\/+$/, '')}/api/auth/login`);
  u.searchParams.set('next', next);
  return u.toString();
}

/** Cookie ヘッダから 1 つだけ "name=value" の形で取り出す。他の cookie は持ち出さない。 */
export function pickCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(';')) {
    const t = part.trim();
    const eq = t.indexOf('=');
    if (eq > 0 && t.slice(0, eq) === name) return t;
  }
  return null;
}

/**
 * CPOS の /api/auth/me が返す事業所の範囲を読む。
 * **読めなければ unknown。** 呼び出し側は unknown を「権限なし」として扱うこと。
 * 「返ってこない = 制限なし」にしてはいけない (他事業所への漏えいになる)。
 */
export function facilityScopeOf(me) {
  const ids = (a) => a.filter((x) => typeof x === 'string');
  const raw = me?.facilityScope;
  if (raw && typeof raw === 'object') {
    if (raw.mode === 'all') return { mode: 'all' };
    // mode の名前は実装によって違う (KIT 模擬サーバは 'limited'、既存アプリは 'list' を期待)。
    // Cookie 系統の本物の形はまだ確認できていない (課題 #12) ので、**名前ではなく中身で判断する**:
    // 事業所 ID の配列があれば、それが見てよい範囲。無ければ unknown。
    if (Array.isArray(raw.allowedFacilityIds)) return { mode: 'list', ids: ids(raw.allowedFacilityIds) };
    return { mode: 'unknown' };
  }
  if (me?.allFacilities === true) return { mode: 'all' };
  if (Array.isArray(me?.allowedFacilityIds)) return { mode: 'list', ids: ids(me.allowedFacilityIds) };
  return { mode: 'unknown' };
}

/** その事業所を見てよいか。unknown は false (fail-close)。 */
export function canSeeFacility(scope, facilityId) {
  if (!scope || !facilityId) return false;
  if (scope.mode === 'all') return true;
  if (scope.mode === 'list') return scope.ids.includes(facilityId);
  return false;
}

/**
 * ブラウザの cpos_session を CPOS に転送して「誰か」を聞く。
 * @param {{ headers: Record<string, any> }} req
 * @param {{ cposBaseUrl: string, fetch?: typeof fetch, cookieName?: string }} o
 * @returns {Promise<{ user: { id, email, name, role }, organizationId: string, facilityScope: object } | null>} 未ログインなら null
 */
export async function identityFromRequest(req, o) {
  const name = o.cookieName ?? CPOS_COOKIE;
  const pair = pickCookie(req.headers?.cookie, name);
  if (!pair) return null;                       // まだログインしていない
  const f = o.fetch ?? fetch;
  const res = await f(`${String(o.cposBaseUrl).replace(/\/+$/, '')}/api/auth/me`, {
    headers: { Cookie: pair, Accept: 'application/json' }   // 転送するのはこの 1 つだけ
  });
  if (res.status === 401) return null;
  if (!res.ok) throw Object.assign(new Error(`CPOS /api/auth/me が ${res.status}`), { status: res.status });
  const me = await res.json();
  const organizationId = me?.organizationId ?? me?.user?.organizationId ?? null;
  if (!me?.user?.id || !organizationId) throw Object.assign(new Error('CPOS /api/auth/me の応答が不正です'), { status: 502 });
  return {
    user: { id: me.user.id, email: me.user.email ?? null, name: me.user.name ?? null, role: me.user.role ?? 'staff' },
    organizationId,
    facilityScope: facilityScopeOf(me)
  };
}

// ---- アプリ自身のセッション cookie (中身を読まれない・書き換えられない) ----
const key = (secret) => {
  // 長さは**バイト**で測る。文字数で測ると、日本語の 14 文字 (情報量は十分) を弾いて
  // "aaaaaaaaaaaaaaaa" (ほぼ情報量なし) を通してしまう。
  const n = secret ? Buffer.byteLength(String(secret), 'utf8') : 0;
  if (n < 16) throw new Error(`セッションの秘密が短すぎます (${n} バイト。16 バイト以上。env に置く。例: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")`);
  return createHash('sha256').update(String(secret)).digest();
};

/** セッションの中身を封じる。CPOS のトークンは入れないこと。 */
export function sealSession(payload, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

/** 封を解く。壊れていれば null (例外にしない。壊れた cookie で画面が死なないように)。 */
export function unsealSession(sealed, secret) {
  try {
    const b = Buffer.from(String(sealed), 'base64url');
    if (b.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', key(secret), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const json = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    const o = JSON.parse(json);
    if (o.exp && Date.now() / 1000 > o.exp) return null;    // 期限切れ
    return o;
  } catch { return null; }
}

/** Set-Cookie の中身を作る。https では secure を付ける。 */
export function sessionCookie(name, sealed, { maxAgeSec = 12 * 3600, secure = true, path = '/' } = {}) {
  const parts = [`${name}=${sealed}`, `Path=${path}`, `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 消すための Set-Cookie。 */
export function clearCookie(name, { path = '/' } = {}) {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`;
}

/**
 * 「このリクエストの人は誰か」を返す。**フレームワークに依存しない。**
 * 返り値で次にやることが決まるので、node:http でも Fastify でも Express でも同じ形で使える。
 *
 * @returns {Promise<{ ok: true, session: object, setCookie?: string }              ログイン済み (setCookie があれば返す)
 *                  | { ok: false, redirectTo: string }>}                           未ログイン (ここへ送る)
 *
 *   const r = await resolveLogin({ cookie: req.headers.cookie, url: 現在のURL }, opts);
 *   if (!r.ok) return reply.redirect(302, r.redirectTo);
 *   if (r.setCookie) reply.header('Set-Cookie', r.setCookie);
 *   r.session.user / r.session.facilityScope
 */
export async function resolveLogin({ cookie, url }, o) {
  const name = o.sessionCookieName ?? 'app_session';
  const raw = pickCookie(cookie, name);
  const cur = unsealSession(raw ? raw.slice(name.length + 1) : null, o.secret);
  if (cur) return { ok: true, session: cur };

  const id = await identityFromRequest({ headers: { cookie } }, o);
  if (id) {
    const maxAgeSec = o.maxAgeSec ?? 12 * 3600;
    const session = { ...id, exp: Math.floor(Date.now() / 1000) + maxAgeSec };
    const secure = o.secure ?? !/^http:\/\/(127\.0\.0\.1|localhost)\b/.test(String(url ?? ''));
    return { ok: true, session, setCookie: sessionCookie(name, sealSession(session, o.secret), { maxAgeSec, secure }) };
  }
  return { ok: false, redirectTo: loginUrl({ cposBaseUrl: o.cposBaseUrl, next: o.appUrl ?? url }) };
}

/**
 * 素の node:http サーバ用の薄い包み。ログイン済みならセッションを返し、
 * 未ログインなら CPOS へ 302 を書いて null を返す (呼び出し側は return するだけ)。
 * Fastify / Express なら resolveLogin を直接使う (下の例)。
 *
 *   // Fastify
 *   app.addHook('onRequest', async (req, reply) => {
 *     if (req.url.startsWith('/api/health')) return;
 *     const r = await resolveLogin({ cookie: req.headers.cookie, url: `${base}${req.url}` }, opts);
 *     if (!r.ok) {
 *       if (req.url.startsWith('/api/')) return reply.code(401).send({ ok: false, error: 'ログインしてください' });
 *       return reply.redirect(302, r.redirectTo);
 *     }
 *     if (r.setCookie) reply.header('Set-Cookie', r.setCookie);
 *     req.session = r.session;
 *   });
 *
 *   // Express
 *   app.use(async (req, res, next) => {
 *     const r = await resolveLogin({ cookie: req.headers.cookie, url: `${base}${req.originalUrl}` }, opts);
 *     if (!r.ok) return res.redirect(302, r.redirectTo);
 *     if (r.setCookie) res.setHeader('Set-Cookie', r.setCookie);
 *     req.session = r.session; next();
 *   });
 */
export async function requireLogin(req, res, o) {
  const url = o.appUrl ?? `http://${req.headers?.host}${req.url}`;
  const r = await resolveLogin({ cookie: req.headers?.cookie, url }, { ...o, appUrl: url });
  if (r.ok) {
    if (r.setCookie) res.setHeader('Set-Cookie', r.setCookie);
    return r.session;
  }
  res.writeHead(302, { Location: r.redirectTo });
  res.end();
  return null;
}

// ---- OAuth 2.1 (CPOS が認可サーバ、認証は Google ログイン) ------------------------------
//
// 上のゲートウェイ方式は「アプリが CPOS と同じ cookie ドメインにある」ことが前提で、手元 (127.0.0.1) や
// 別ドメインからは本物のログインを一巡できない (実験 12: /api/auth/login の next は許可 origin だけ)。
// CPOS は OAuth 2.1 (認可コード + PKCE、公開クライアント) を持ち、redirect_uri に http://127.0.0.1 も
// 許す (docs/OAUTH.md、ステージングで /oauth/register を実測 2026-09-14)。**CPOS が推奨する Google
// ログインを、どこに置いたアプリからでも通す道**がこれ。
//
//   1. 未ログイン → PKCE と state を作り、封じて短命 cookie (app_login) に置き、CPOS/oauth/authorize へ 302
//   2. CPOS が Google ログイン (既存のまま) → 同意画面 → 認可コードを redirect_uri (このアプリ) へ返す
//   3. アプリは code + code_verifier で /oauth/token → アクセストークン (本人の代理、寿命 1 時間)
//   4. そのトークンで /api/platform/me を 1 回だけ呼んで「誰か」と事業所の範囲を取り、
//      アプリ自身の署名つきセッション cookie を発行する。**トークンは cookie にもセッションにも入れず**、
//      用が済んだら /oauth/revoke で失効させる (身元だけ持つ。ゲートウェイ方式と同じ約束)
//
// 事業所の範囲は /api/platform/me の token.allowedFacilityIds から読む。配列ならその範囲、
// null は「本人のトークンで user が返っている」ときだけ全事業所 (CPOS の仕様: 組織全体の管理者は限定なし)。
// それ以外は unknown = 見せない (fail-close)。

/** PKCE の verifier と S256 の challenge。 */
export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const trimSlash = (u) => String(u).replace(/\/+$/, '');

/**
 * 公開クライアントを動的登録して client_id を得る (RFC 7591)。秘密は無い (PKCE だけ)。
 * 起動ごとに登録すると台帳が増えるので、得た client_id は env (<APP>_OAUTH_CLIENT_ID) に置いて使い回す。
 */
export async function registerOAuthClient({ cposBaseUrl, redirectUri, clientName, fetch: f = fetch }) {
  const res = await f(`${trimSlash(cposBaseUrl)}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_name: clientName ?? 'cpos app', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.client_id) throw Object.assign(new Error(`OAuth クライアントを登録できません (${res.status} ${j.error ?? ''} ${j.error_description ?? ''})`.trim()), { status: res.status });
  return j.client_id;
}

/** CPOS の同意画面 (未ログインなら Google ログイン) へ送る URL。 */
export function oauthAuthorizeUrl({ cposBaseUrl, clientId, redirectUri, state, codeChallenge, scope }) {
  const u = new URL(`${trimSlash(cposBaseUrl)}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scope) u.searchParams.set('scope', Array.isArray(scope) ? scope.join(' ') : scope);
  return u.toString();
}

/** 認可コードをトークンに換える。 */
export async function oauthExchangeCode({ cposBaseUrl, clientId, redirectUri, code, codeVerifier, fetch: f = fetch }) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier });
  const res = await f(`${trimSlash(cposBaseUrl)}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
  const j = await res.json().catch(() => ({}));
  if (res.status === 429) throw Object.assign(new Error(`CPOS の OAuth が限速中です (429。Retry-After ${res.headers?.get?.('retry-after') ?? '?'} 秒)。限速は呼び出し元 IP 単位 (既定 60 回/分) で、ログイン 1 回が token + revoke の 2〜3 回を使います。同じ egress IP から多数のログインが集中するなら oauth.revoke: false か間隔を置いてください`), { status: 429, retryAfter: Number(res.headers?.get?.('retry-after')) || null });
  if (!res.ok || !j.access_token) throw Object.assign(new Error(`トークンに換えられません (${res.status} ${j.error ?? ''} ${j.error_description ?? ''})`.trim()), { status: res.status });
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresIn: j.expires_in ?? null, scope: j.scope ?? null };
}

/** 失効させる。有無は教えない (本物と同じ)。失敗しても例外にしない (ログイン自体は済んでいる)。 */
export async function revokeOAuthToken(token, { cposBaseUrl, fetch: f = fetch }) {
  try {
    await f(`${trimSlash(cposBaseUrl)}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
  } catch { /* 寿命で切れる */ }
}

/**
 * 本人の代理トークンで /api/platform/me を呼び、身元と事業所の範囲を取る。
 * 管理者が発行した PAT / App Token には user が無い (ステージングで確認) → その場合は例外 (ログインには使えない)。
 */
export async function identityFromAccessToken(accessToken, { cposBaseUrl, fetch: f = fetch, allowAppToken = false } = {}) {
  const res = await f(`${trimSlash(cposBaseUrl)}/api/platform/me`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error(`CPOS /api/platform/me が ${res.status}`), { status: res.status });
  const me = await res.json();
  if (!me?.organizationId) throw Object.assign(new Error('CPOS /api/platform/me の応答に organizationId がありません'), { status: 502 });
  const ids = me.token?.allowedFacilityIds;
  const facilityScope = Array.isArray(ids) ? { mode: 'list', ids: ids.filter((x) => typeof x === 'string') }
    : ids === null ? { mode: 'all' }            // 本人のトークンで限定なし = 組織全体 (CPOS docs/OAUTH.md §4)
    : { mode: 'unknown' };
  if (me.user?.id) {
    return { user: { id: me.user.id, email: me.user.email ?? null, name: me.user.name ?? null, role: me.user.role ?? 'staff' }, organizationId: me.organizationId, facilityScope };
  }
  // 管理者が発行した App Token / PAT には本人 (user) がいない (ステージングで確認)。
  // allowAppToken のときだけ「そのトークン」を身元にする (人ではない。role は 'app-token'。検証・運用端末向け)
  if (!allowAppToken) throw Object.assign(new Error('このトークンには本人 (user) がいません。OAuth で本人が同意して得たトークンだけがログインに使えます'), { status: 502 });
  const t = me.token ?? {};
  return { user: { id: `token:${t.id ?? 'unknown'}`, email: null, name: t.name ?? 'App Token', role: 'app-token' }, organizationId: me.organizationId, facilityScope };
}

/**
 * アプリと CPOS が同じ cookie ドメインか (= ゲートウェイ方式が使えるか)。
 * cpos.example.co.jp と app.example.co.jp は同じ (登録可能ドメイン example.co.jp)。
 * 127.0.0.1 / localhost は host が完全に同じときだけ。
 */
export function sameCookieDomain(appUrl, cposBaseUrl) {
  let a, c;
  try { a = new URL(appUrl).hostname; c = new URL(cposBaseUrl).hostname; } catch { return false; }
  if (a === c) return true;
  const ip = (h) => /^[\d.]+$/.test(h) || h === 'localhost' || h.includes(':');
  if (ip(a) || ip(c)) return false;
  const reg = (h) => { const p = h.split('.'); const n = p.length >= 3 && p.at(-1).length === 2 && p.at(-2).length <= 3 ? 3 : 2; return p.slice(-n).join('.'); };
  return reg(a) === reg(c);
}

/**
 * ログインの関門を 1 つに束ねる。**フレームワークに依存しない。**
 *
 *   const gate = createLoginGate({ cposBaseUrl, secret, appUrl, mode: 'auto', fetch, oauth: { clientName: 'my-app' } });
 *   const r = await gate.resolve({ url: 現在の絶対URL, cookie: req.headers.cookie });
 *   // r = { ok: true, session, setCookie? } | { ok: false, redirectTo, setCookie? }
 *   // OAuth の戻り (gate.callbackPath) では:
 *   const c = await gate.callback({ url, cookie });   // { ok: true, session, setCookie: [...], redirectTo } | { ok: false, error }
 *
 * mode:
 *   'cookie' = ゲートウェイ方式 (cpos_session を転送)。アプリが CPOS と同じ cookie ドメインにあるとき
 *   'oauth'  = OAuth 2.1 (CPOS が Google ログイン → 同意 → コード)。手元 (127.0.0.1) や別ドメインでも一巡する
 *   'token'  = **CPOS が発行したトークンで入る** (Google を通らない)。画面 (loginPath、既定 /login) に PAT (cpos_pat_…) か
 *              App Token (cpos_app_…) を貼る → アプリが CPOS の /api/platform/me で検証 → 自分のセッションを発行し、トークンは捨てる。
 *              PAT なら本人、App Token なら「そのトークン」(role 'app-token') が身元。Google ログインを自動化できない検証 (AI・CI) と、
 *              Google アカウントを持たない運用端末のため。人が使う本番は cookie / oauth
 *   'auto'   = appUrl (無ければその要求の URL) と cposBaseUrl が同じ cookie ドメインなら cookie、違えば oauth
 *
 * @param {{ cposBaseUrl: string, secret: string, appUrl?: string, mode?: 'auto'|'cookie'|'oauth'|'token', fetch?: typeof fetch,
 *           sessionCookieName?: string, maxAgeSec?: number, loginPath?: string, appName?: string,
 *           oauth?: { clientId?: string, clientName?: string, callbackPath?: string, scope?: string | string[], revoke?: boolean } }} o
 */
export function createLoginGate(o) {
  if (!o?.cposBaseUrl) throw new Error('cposBaseUrl がありません');
  key(o.secret);   // 秘密の長さをここで確かめる (起動時に落ちる方がよい)
  const f = o.fetch ?? fetch;
  const sessionName = o.sessionCookieName ?? 'app_session';
  const loginName = `${sessionName}_login`;   // OAuth の途中状態 (PKCE verifier / state / 戻り先)。10 分で捨てる
  const callbackPath = o.oauth?.callbackPath ?? '/oauth/callback';
  const loginPath = o.loginPath ?? '/login';
  const cposBaseUrl = trimSlash(o.cposBaseUrl);
  let clientId = o.oauth?.clientId ?? null;
  let clientFor = null;   // 登録した redirect_uri (origin が変わったら登録し直す)

  const modeFor = (url) => (o.mode && o.mode !== 'auto') ? o.mode : (sameCookieDomain(o.appUrl ?? url, cposBaseUrl) ? 'cookie' : 'oauth');
  const originOf = (url) => (o.appUrl ? new URL(o.appUrl).origin : new URL(url).origin);
  const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost)\b/.test(String(url));
  const sessionOf = (cookie) => { const raw = pickCookie(cookie, sessionName); return unsealSession(raw ? raw.slice(sessionName.length + 1) : null, o.secret); };

  async function ensureClient(url) {
    const redirectUri = `${originOf(url)}${callbackPath}`;
    if (clientId && (clientFor === null || clientFor === redirectUri)) { clientFor = redirectUri; return { clientId, redirectUri }; }
    clientId = await registerOAuthClient({ cposBaseUrl, redirectUri, clientName: o.oauth?.clientName ?? 'cpos app', fetch: f });
    clientFor = redirectUri;
    return { clientId, redirectUri };
  }

  const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sameOriginPath = (next, url) => { try { const u = new URL(next, originOf(url)); return u.origin === originOf(url) ? u.pathname + u.search : '/'; } catch { return '/'; } };

  return {
    mode: o.mode ?? 'auto',
    modeFor,
    callbackPath,
    loginPath,
    sessionCookieName: sessionName,
    /** いまの client_id (OAuth で登録済みなら)。env に置いて使い回すために読める */
    get clientId() { return clientId; },

    /** 通常の要求。ログイン済みなら session、未ログインなら送る先。 */
    async resolve({ url, cookie }) {
      const cur = sessionOf(cookie);
      if (cur) return { ok: true, session: cur };
      if (modeFor(url) === 'token') {
        const u = new URL(url);
        return { ok: false, redirectTo: `${originOf(url)}${loginPath}?next=${encodeURIComponent(u.pathname + u.search)}` };
      }
      if (modeFor(url) === 'cookie') return resolveLogin({ cookie, url }, { ...o, fetch: f, sessionCookieName: sessionName, appUrl: o.appUrl ? `${trimSlash(o.appUrl)}${new URL(url).pathname}${new URL(url).search}` : undefined });
      // OAuth: 途中状態を封じて cookie に置き、同意画面へ
      const { clientId: cid, redirectUri } = await ensureClient(url);
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(16).toString('base64url');
      const pending = sealSession({ v: verifier, s: state, next: url, exp: Math.floor(Date.now() / 1000) + 600 }, o.secret);
      return {
        ok: false,
        redirectTo: oauthAuthorizeUrl({ cposBaseUrl, clientId: cid, redirectUri, state, codeChallenge: challenge, scope: o.oauth?.scope ?? 'facilities:read' }),   // scope を省略すると CPOS は MCP の読み取り全部を付けて広い同意を求める。身元を取るだけなので最小にする
        setCookie: sessionCookie(loginName, pending, { maxAgeSec: 600, secure: !isLocal(url) })
      };
    },

    /** OAuth の戻り (callbackPath)。code を身元に換えて、アプリのセッションを発行する。 */
    async callback({ url, cookie }) {
      const u = new URL(url);
      const code = u.searchParams.get('code'), state = u.searchParams.get('state');
      if (u.searchParams.get('error')) return { ok: false, status: 403, error: `CPOS がログインを拒みました: ${u.searchParams.get('error')} ${u.searchParams.get('error_description') ?? ''}`.trim() };
      const raw = pickCookie(cookie, loginName);
      const pending = unsealSession(raw ? raw.slice(loginName.length + 1) : null, o.secret);
      if (!pending || !code || !state || pending.s !== state) {
        return { ok: false, status: 400, error: 'ログインの途中状態が合いません (10 分以内にやり直してください)' };
      }
      let id;
      try {
        const { clientId: cid, redirectUri } = await ensureClient(url);
        const tok = await oauthExchangeCode({ cposBaseUrl, clientId: cid, redirectUri, code, codeVerifier: pending.v, fetch: f });
        try { id = await identityFromAccessToken(tok.accessToken, { cposBaseUrl, fetch: f }); }
        finally { if (o.oauth?.revoke !== false) for (const t of [tok.accessToken, tok.refreshToken].filter(Boolean)) await revokeOAuthToken(t, { cposBaseUrl, fetch: f }); }   // 身元を取ったらトークンは捨てる (access と refresh の両方。refresh だけの失効で access が消えるかは未確認)。限速に当たるなら oauth.revoke: false (寿命 1 時間で切れる)
      } catch (e) {
        return { ok: false, status: e.status === 400 ? 400 : 502, error: `ログインを完了できません: ${e.message}` };
      }
      const maxAgeSec = o.maxAgeSec ?? 12 * 3600;
      const session = { ...id, via: 'oauth', exp: Math.floor(Date.now() / 1000) + maxAgeSec };
      return {
        ok: true, session,
        setCookie: [sessionCookie(sessionName, sealSession(session, o.secret), { maxAgeSec, secure: !isLocal(url) }), clearCookie(loginName)],
        redirectTo: pending.next || originOf(url)
      };
    },

    /** token モードのログイン画面 (HTML)。トークンは表示しない・URL に載せない (POST の本文だけ)。 */
    loginPage({ url, next, error } = {}) {
      const n = sameOriginPath(next ?? '/', url ?? originOf('http://127.0.0.1'));
      const title = escapeHtml(o.appName ?? 'CPOS アプリ');
      return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} ログイン</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}input{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}button{padding:.6rem 1.2rem;font-size:1rem}p.err{color:#b00020}small{color:#666}</style>
<h1>${title}</h1>
<p>CPOS が発行したトークン (PAT <code>cpos_pat_…</code> または App Token <code>cpos_app_…</code>) で入ります。Google ログインは通りません。</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(loginPath)}" autocomplete="off">
  <input type="hidden" name="next" value="${escapeHtml(n)}">
  <p><label>トークン<br><input type="password" name="token" required autofocus placeholder="cpos_pat_… / cpos_app_…"></label></p>
  <p><button type="submit">CPOS で検証して入る</button></p>
</form>
<p><small>トークンは CPOS の <code>/api/platform/me</code> で検証したあと捨てます (このアプリには保存しません)。PAT は CPOS 管理画面の「個人アクセストークン」で発行します。</small></p>`;
    },

    /** token モードのログイン。CPOS で検証し、通ればアプリのセッションを発行する。トークンは保存しない。 */
    async tokenLogin({ token, next, url }) {
      const t = String(token ?? '').trim();
      if (!/^cpos_(pat|app)_[A-Za-z0-9_-]+$/.test(t)) return { ok: false, status: 400, error: 'トークンの形が違います (cpos_pat_… か cpos_app_…)' };
      let id;
      try { id = await identityFromAccessToken(t, { cposBaseUrl, fetch: f, allowAppToken: true }); }
      catch (e) { return { ok: false, status: e.status === 401 || e.status === 403 ? 401 : 502, error: e.status === 401 || e.status === 403 ? 'CPOS がこのトークンを認めませんでした (失効・誤り)' : `CPOS に確かめられません: ${e.message}` }; }
      const maxAgeSec = o.maxAgeSec ?? 12 * 3600;
      const session = { ...id, via: 'token', exp: Math.floor(Date.now() / 1000) + maxAgeSec };
      return {
        ok: true, session,
        setCookie: [sessionCookie(sessionName, sealSession(session, o.secret), { maxAgeSec, secure: !isLocal(url) })],
        redirectTo: `${originOf(url)}${sameOriginPath(next ?? '/', url)}`
      };
    },

    /** ログアウト (自分のセッションを消す)。CPOS 側のログインはそのまま。 */
    logout() { return { setCookie: [clearCookie(sessionName), clearCookie(loginName)] }; }
  };
}

/** 要求の絶対 URL。appUrl があればその origin、無ければ Host と x-forwarded-proto から。 */
export function requestUrl(req, appUrl) {
  const path = req.originalUrl ?? req.url ?? '/';
  if (appUrl) return `${new URL(appUrl).origin}${path}`;
  const host = req.headers?.host ?? '127.0.0.1';
  const proto = req.headers?.['x-forwarded-proto'] ?? (/^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}${path}`;
}

/**
 * Fastify 用。hook と OAuth の戻り (callbackPath) と /logout を登録する。ログイン後は request.session に身元。
 *
 *   import Fastify from 'fastify';
 *   import { fastifyLoginGate } from '@cpos/kit/app-kit';
 *   const app = Fastify();
 *   fastifyLoginGate(app, { cposBaseUrl, secret, appUrl, oauth: { clientName: '送迎表' }, publicPaths: ['/api/health', '/cpos.manifest.json'] });
 *   app.get('/api/me', async (req) => req.session.user);
 *
 * 未ログイン: 画面は 302 (CPOS へ)、/api/ 配下は 401 { ok: false, error: 'login_required', loginUrl }。
 */
export function fastifyLoginGate(app, o) {
  const gate = createLoginGate(o);
  const publicPaths = new Set([...(o.publicPaths ?? ['/api/health', '/cpos.manifest.json']), gate.callbackPath, gate.loginPath, o.logoutPath ?? '/logout']);
  const apiPrefix = o.apiPrefix ?? '/api/';
  if (typeof app.hasRequestDecorator === 'function' && !app.hasRequestDecorator('session')) app.decorateRequest('session', null);
  // token モードのログイン画面と受け口 (どのモードでも登録しておく。token 以外のモードでは画面を出さず / へ)。
  // form の parser は子のコンテキストに閉じる (アプリが自分で addContentTypeParser しても衝突しない。Fastify の encapsulation)
  app.register(async (sub) => {
    if (typeof sub.hasContentTypeParser === 'function' && !sub.hasContentTypeParser('application/x-www-form-urlencoded')) {
      sub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));
    }
    sub.get(gate.loginPath, async (req, reply) => {
      const url = requestUrl(req, o.appUrl);
      if (gate.modeFor(url) !== 'token') return reply.redirect('/', 302);   // token 以外のモードでは関門が CPOS へ送る
      return reply.type('text/html; charset=utf-8').send(gate.loginPage({ url, next: req.query?.next, error: req.query?.error }));
    });
    sub.post(gate.loginPath, async (req, reply) => {
      const url = requestUrl(req, o.appUrl);
      if (gate.modeFor(url) !== 'token') return reply.code(404).send({ ok: false, error: 'login_mode', message: 'このアプリのログインは token モードではありません' });
      const r = await gate.tokenLogin({ token: req.body?.token, next: req.body?.next, url });
      if (!r.ok) return reply.code(r.status).type('text/html; charset=utf-8').send(gate.loginPage({ url, next: req.body?.next, error: r.error }));
      return reply.header('set-cookie', r.setCookie).redirect(r.redirectTo, 302);
    });
  });
  app.get(gate.callbackPath, async (req, reply) => {
    const r = await gate.callback({ url: requestUrl(req, o.appUrl), cookie: req.headers.cookie });
    if (!r.ok) return reply.code(r.status ?? 400).type('text/plain; charset=utf-8').send(r.error);
    return reply.header('set-cookie', r.setCookie).redirect(r.redirectTo, 302);
  });
  app.get(o.logoutPath ?? '/logout', async (req, reply) => reply.header('set-cookie', gate.logout().setCookie).redirect(o.afterLogout ?? '/', 302));
  app.addHook('onRequest', async (req, reply) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (publicPaths.has(path)) return;
    const r = await gate.resolve({ url: requestUrl(req, o.appUrl), cookie: req.headers.cookie });
    if (r.setCookie) reply.header('set-cookie', r.setCookie);
    if (!r.ok) {
      if (path.startsWith(apiPrefix)) return reply.code(401).send({ ok: false, error: 'login_required', message: 'ログインしてください', loginUrl: r.redirectTo });
      return reply.redirect(r.redirectTo, 302);
    }
    req.session = r.session;
  });
  return gate;
}

/**
 * Express 用 middleware。使い方は fastifyLoginGate と同じ (app.use(expressLoginGate({...})))。
 */
export function expressLoginGate(o) {
  const gate = createLoginGate(o);
  const publicPaths = new Set(o.publicPaths ?? ['/api/health', '/cpos.manifest.json']);
  const apiPrefix = o.apiPrefix ?? '/api/';
  const logoutPath = o.logoutPath ?? '/logout';
  const mw = async (req, res, next) => {
    try {
      const url = requestUrl(req, o.appUrl);
      const path = new URL(url).pathname;
      if (path === gate.callbackPath) {
        const r = await gate.callback({ url, cookie: req.headers.cookie });
        if (!r.ok) return res.status(r.status ?? 400).type('text/plain').send(r.error);
        res.setHeader('Set-Cookie', r.setCookie);
        return res.redirect(302, r.redirectTo);
      }
      if (path === logoutPath) { res.setHeader('Set-Cookie', gate.logout().setCookie); return res.redirect(302, o.afterLogout ?? '/'); }
      if (path === gate.loginPath && gate.modeFor(url) === 'token') {
        if (req.method === 'GET') { const q = new URL(url).searchParams; return res.status(200).type('html').send(gate.loginPage({ url, next: q.get('next'), error: q.get('error') })); }
        if (req.method === 'POST') {
          const body = req.body && typeof req.body === 'object' ? req.body : Object.fromEntries(new URLSearchParams(await readRawBody(req)));
          const r = await gate.tokenLogin({ token: body.token, next: body.next, url });
          if (!r.ok) return res.status(r.status).type('html').send(gate.loginPage({ url, next: body.next, error: r.error }));
          res.setHeader('Set-Cookie', r.setCookie);
          return res.redirect(302, r.redirectTo);
        }
      }
      if (publicPaths.has(path)) return next();
      const r = await gate.resolve({ url, cookie: req.headers.cookie });
      if (r.setCookie) res.setHeader('Set-Cookie', r.setCookie);
      if (!r.ok) {
        if (path.startsWith(apiPrefix)) return res.status(401).json({ ok: false, error: 'login_required', message: 'ログインしてください', loginUrl: r.redirectTo });
        return res.redirect(302, r.redirectTo);
      }
      req.session = r.session;
      next();
    } catch (e) { next(e); }
  };
  mw.gate = gate;
  return mw;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => { let b = ''; req.setEncoding?.('utf8'); req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); req.on('error', reject); });
}
