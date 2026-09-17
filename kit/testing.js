// テストのための小さな補助。テストで事業所 ID を固定しないためにある。
//
//   import { createFakeCpos } from '@cpos/kit/fake';
//   import { pickFacilities } from '@cpos/kit/testing';
//   const fake = createFakeCpos();
//   const cpos = createCposClient({ baseUrl: fake.baseUrl, token: 'cpos_app_test', fetch: fake.fetch });
//   const [main, other] = await pickFacilities(cpos, 2);   // KIT 模擬サーバでもステージングでも動く
//
// KIT 模擬サーバの seed の ID (fac_sakura など) をテストに書くと、本物の CPOS では 404 になって
// そのテストは二度と本物で流せない (2026-09-04 の実験で 2 つの AI が両方ともそうした)。

import { CposClientError } from './client.js';

/**
 * 呼び出し側が見てよい事業所を n 件返す。足りなければ例外 (黙って減らさない)。
 * @param {{ facilities: { list(): Promise<Array<{ id: string, name?: string }>> } }} cpos
 * @param {number} [n]
 * @param {{ prefer?: RegExp }} [o]  名前がこの正規表現に合うものを先頭にする (例 /デイ/)
 */
export async function pickFacilities(cpos, n = 1, o = {}) {
  const all = await cpos.facilities.list();
  if (all.length < n) {
    throw new CposClientError(`事業所が ${n} 件必要ですが ${all.length} 件しか見えません`, 'トークンの allowedFacilityIds か、KIT 模擬サーバの seed を確かめてください');
  }
  const sorted = o.prefer ? [...all].sort((a, b) => (o.prefer.test(b.name ?? '') ? 1 : 0) - (o.prefer.test(a.name ?? '') ? 1 : 0)) : all;
  return sorted.slice(0, n);
}

/**
 * 「テストに必要なデータが実際にある事業所」を探す。
 *
 * 実害 (実験 10、2026-09-13): ステージングで 9 件のテストが「看護師の予定がある事業所が
 * 見てよい範囲に無い」で skip した。実際には 8 事業所のうち 1 つ (看護師 7 人・看護師担当の予定
 * 87 件) に必要なデータがあり、先頭から順に見ていたので見つけられていなかっただけだった。
 * skip は「確かめていない」であって「通った」ではないので、探せるようにする。
 *
 *   const f = await findFacilityWith(cpos, async (fac) => {
 *     const r = await cpos.raw('GET', '/api/platform/facility-staff', { facilityId: fac.id });
 *     return (r.items ?? []).some((s) => s.profession === 'nurse');
 *   });
 *   if (!f) return t.skip('どの事業所にも看護師がいない');
 *
 * @param {{ facilities: { list(): Promise<Array<{ id: string, name?: string }>> } }} cpos
 * @param {(facility: { id: string, name?: string }) => Promise<boolean> | boolean} has 条件
 * @param {{ limit?: number }} [o] 見る事業所の上限 (既定 20。本番で全件舐めないように)
 * @returns {Promise<{ id: string, name?: string } | null>} 見つからなければ null
 */
export async function findFacilityWith(cpos, has, o = {}) {
  const all = await cpos.facilities.list();
  for (const f of all.slice(0, o.limit ?? 20)) {
    try { if (await has(f)) return f; } catch { /* この事業所では確かめられない。次へ */ }
  }
  return null;
}

/**
 * 環境変数があれば本物 (ステージング等)、無ければ KIT 模擬サーバ、という切り替えを 1 か所にする。
 * 雛形のテストが使う。
 * @param {{ envPrefix: string, createFakeCpos: () => { baseUrl: string, fetch: typeof fetch }, token?: string }} p
 * @returns {{ external: boolean, baseUrl: string, token: string, fetch?: typeof fetch }}
 */
export function cposForTests(p) {
  const base = process.env[`${p.envPrefix}_CPOS_BASE_URL`];
  const token = process.env[`${p.envPrefix}_CPOS_APP_TOKEN`];
  // AppData の appId の切替 (<APP>_APPDATA_APP_ID)。トークンが別 appId のスコープしか持たないときだけ使う
  const appDataAppId = process.env[`${p.envPrefix}_APPDATA_APP_ID`] || undefined;
  if (base && token) return { external: true, baseUrl: base, token, fetch: undefined, appDataAppId };
  const fake = p.createFakeCpos();
  return { external: false, baseUrl: fake.baseUrl, token: p.token ?? 'cpos_app_test', fetch: fake.fetch, fake, appDataAppId: undefined };
}
