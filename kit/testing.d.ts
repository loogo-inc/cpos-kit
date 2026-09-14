import type { CposClient, Facility } from './client';
import type { FakeCposInProcess } from './fake/server';

/** 見てよい事業所を n 件。足りなければ例外。テストで事業所 ID を固定しないために使う */
export function pickFacilities(cpos: Pick<CposClient, 'facilities'>, n?: number, o?: { prefer?: RegExp }): Promise<Facility[]>;

/** 環境変数があれば本物、無ければ KIT 模擬サーバ*/
export function cposForTests(p: {
  envPrefix: string;
  createFakeCpos: () => FakeCposInProcess;
  token?: string;
}): { external: boolean; baseUrl: string; token: string; fetch?: typeof fetch; fake?: FakeCposInProcess; /** <APP>_APPDATA_APP_ID。トークンが別 appId のスコープしか持たないときだけ */ appDataAppId?: string };

/** テストに必要なデータが実際にある事業所を探す。無ければ null。 */
export function findFacilityWith(
  cpos: { facilities: { list(): Promise<Array<{ id: string; name?: string }>> } },
  has: (facility: { id: string; name?: string }) => boolean | Promise<boolean>,
  o?: { limit?: number }
): Promise<{ id: string; name?: string } | null>;
