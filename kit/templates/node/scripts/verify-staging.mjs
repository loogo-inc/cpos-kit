// ステージング (本物の CPOS) で「このアプリが読み書きできるか」を件数だけで確かめ、書いたものは必ず消す。
//
//   npx cpos-kit connect            # .env に URL とトークンを書く
//   npm run verify:staging          # これ
//
// 出すのは件数と状態コードだけ。氏名などの中身は出さない (ステージングには本物に近いデータがある)。
// アプリの画面や HTTP は通さない (フレームワークに依らない)。画面まで含めた確認は test/ で
// {{APP}}_CPOS_BASE_URL と {{APP}}_CPOS_APP_TOKEN を渡して `npm test` を流す。
//
// 実験 12 (2026-09-13) で Claude と Codex の両方がこれを自作した。以後は雛形に入れておく。

import { readFileSync } from 'node:fs';
import { createCposClient, CposApiError } from '@cpos/kit/client';
import { configFromEnv } from '../server.mjs';

const cfg = configFromEnv();
const manifest = JSON.parse(readFileSync(new URL('../cpos.manifest.json', import.meta.url), 'utf8'));
const APP_ID = manifest.appId;
const appDataAppId = cfg.appDataAppId ?? APP_ID;

if (!/^https:\/\//.test(cfg.cposBaseUrl) || !cfg.cposToken) {
  console.error('{{APP}}_CPOS_BASE_URL (https://…) と {{APP}}_CPOS_APP_TOKEN が要ります。npx cpos-kit connect で .env に書いてください');
  process.exit(2);
}

const cpos = createCposClient({ baseUrl: cfg.cposBaseUrl, token: () => cfg.cposToken, clientName: `${APP_ID}/verify-staging` });
const appData = cpos.appData(appDataAppId);

let ok = 0, ng = 0;
const pass = (what, detail = '') => { ok++; console.log(`OK  ${what}${detail ? `  ${detail}` : ''}`); };
const fail = (what, e) => { ng++; console.log(`NG  ${what}  ${e instanceof CposApiError ? `${e.status} ${e.error}${e.requiredScope ? ` (scope ${e.requiredScope})` : ''}` : e?.message ?? e}`); };
const written = [];   // { resource, id, facilityId } 消すもの

try {
  // 1. 疎通とスコープ (manifest が要求するものがトークンにあるか)
  const me = await cpos.platform.me();
  const scopes = me?.token?.scopes ?? [];
  const has = (sc) => scopes.includes(sc) || scopes.includes('*') || scopes.some((x) => x.endsWith(':*') && sc.startsWith(x.slice(0, -1)));
  const want = (manifest.apiTokenScopes ?? []).map((sc) => sc.replace(`app-data:${APP_ID}:`, `app-data:${appDataAppId}:`));
  const missing = want.filter((sc) => !has(sc));
  pass('platform.me', `authMethod=${me.authMethod} scopes=${scopes.length}`);
  if (missing.length) fail('manifest の要求スコープ', new Error(`トークンに無い: ${missing.join(', ')} (CPOS 管理画面「設定 → API トークン」で付与)`));
  else pass('manifest の要求スコープ', `${want.length} 個すべてトークンにある`);
  if (appDataAppId !== APP_ID) console.log(`    (AppData は appId "${appDataAppId}" で確かめる: {{APP}}_APPDATA_APP_ID)`);

  // 2. 読み取り (件数だけ)
  const facilities = await cpos.facilities.list();
  pass('facilities.list', `${facilities.length} 件`);
  if (!facilities.length) throw new Error('見てよい事業所が 0 件。トークンの allowedFacilityIds を確かめてください');
  const fac = facilities[0];
  try { const users = await cpos.masterUsers.list({ facilityId: fac.id }); pass('masterUsers.list (先頭の事業所)', `${users.length} 人`); }
  catch (e) { fail('masterUsers.list', e); }

  // 3. AppData: manifest の resource ごとに 作る → 1 件取る → 一覧に載る → 消す (finally で必ず消す)
  for (const res of manifest.resources ?? []) {
    const name = res.name;
    try {
      const before = (await appData.list(name, { facilityId: fac.id })).length;
      const rec = await appData.create(name, { _verify: true, text: `verify ${new Date().toISOString()}` }, { facilityId: fac.id });
      written.push({ resource: name, id: rec.id, facilityId: fac.id });
      const got = await appData.get(name, rec.id, { facilityId: fac.id });
      const after = (await appData.list(name, { facilityId: fac.id })).length;
      if (got?.id !== rec.id || after !== before + 1) throw new Error(`作った 1 件が取れない/一覧に載らない (${before} → ${after})`);
      if (facilities[1]) {
        const theirs = await appData.list(name, { facilityId: facilities[1].id });
        if (theirs.some((r) => r.id === rec.id)) throw new Error('別の事業所から見える');
      }
      pass(`AppData ${name}: 作る → 取る → 一覧 → 別事業所から不可視`, `既存 ${before} 件`);
    } catch (e) { fail(`AppData ${name}`, e); }
  }
} catch (e) {
  fail('中断', e);
} finally {
  // 後片付け。ここで消せなかったものは id を出す (手で消せるように)
  for (const w of written) {
    try { await appData.remove(w.resource, w.id, { facilityId: w.facilityId }); }
    catch (e) { fail(`後片付け ${w.resource} ${w.id}`, e); }
  }
  if (written.length) pass('後片付け', `${written.length} 件消した`);
}
console.log(`\n結果: OK ${ok} / NG ${ng}`);
process.exit(ng ? 1 : 0);
