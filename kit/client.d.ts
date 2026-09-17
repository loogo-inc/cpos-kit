export interface FacilityScope {
  mode: 'all' | 'limited' | 'unknown';
  allowedFacilityIds: string[] | null;
  managerFacilityIds: string[] | null;
}

export interface Me {
  ok: true;
  authMethod?: string;
  organizationId?: string;
  user: { id: string; email: string; name: string; role: string; organizationId?: string };
  facilityScope: FacilityScope;
  allFacilities?: boolean;
  allowedFacilityIds?: string[] | null;
}

export interface PlatformMe {
  ok: true;
  authMethod?: string;
  organizationId?: string;
  token?: { scopes: string[]; allowedFacilityIds: string[] | null };
}

export interface Facility {
  id: string;
  name: string;
  nameKana?: string;
  isActive?: boolean;
  serviceTypeCodes?: string[];
  facilityCategoryCode?: string;
  organizationId?: string;
  [extra: string]: unknown;
}

/** 利用者 (介護を受ける人)。本物の一意キーは masterUserId (id は無い)。 */
export interface MasterUser {
  masterUserId: string;
  insuredNumber: string;
  name: string;
  furigana?: string;
  birthDate?: string;
  careLevel?: string;
  isActive?: boolean;
  status?: string;
  facilityIds?: string[];
  [extra: string]: unknown;
}

export interface AppDataRecord<T = Record<string, unknown>> {
  id: string;
  organizationId?: string;
  facilityId?: string | null;
  createdBy?: string;
  status?: string;
  data: T;
  createdAt?: string;
  updatedAt?: string;
}

export class CposApiError extends Error {
  status: number;
  /** CPOS の error。本物は日本語の文 (スラッグではない) */
  error: string;
  /** KIT 模擬サーバだけが返す機械可読の補助 (本物では null) */
  code: string | null;
  /** 403 のとき、足りないスコープ (本物・偽ともに) */
  requiredScope: string | null;
  /** CPOS が返した JSON そのもの (reasonCode / allowedFacilityIds / issues など) */
  body: unknown;
  detail: string | null;
  hint: string | null;
  method: string;
  path: string;
}

export class CposClientError extends Error {
  hint: string | null;
}

export interface RawOptions {
  body?: unknown;
  facilityId?: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
}

/** 事業所境界: facilityId を付けるか、scope: 'organization' と明示するかのどちらかが必須 */
export type AppDataScope = { facilityId: string; scope?: undefined } | { facilityId?: undefined; scope: 'organization' };

export interface AppDataApi {
  list<T = Record<string, unknown>>(resource: string, p: AppDataScope & { paginated?: false }): Promise<AppDataRecord<T>[]>;
  list<T = Record<string, unknown>>(resource: string, p: AppDataScope & { paginated: true; cursor?: string; limit?: number }): Promise<{ items: AppDataRecord<T>[]; nextCursor: string | null }>;
  get<T = Record<string, unknown>>(resource: string, id: string, p: AppDataScope): Promise<AppDataRecord<T>>;
  create<T = Record<string, unknown>>(resource: string, data: T, p: AppDataScope): Promise<AppDataRecord<T>>;
  update<T = Record<string, unknown>>(resource: string, id: string, data: T, p: AppDataScope): Promise<AppDataRecord<T>>;
  remove(resource: string, id: string, p: AppDataScope): Promise<null>;
  /** data[keyField] が一致する 1 件を update、無ければ create。「利用者 1 人に 1 件」のような約束をここで守る */
  upsertBy<T extends Record<string, unknown>>(resource: string, keyField: keyof T & string, data: T, p: AppDataScope): Promise<AppDataRecord<T> & { duplicates?: string[] }>;
}

import type { CposApi_app, CposApi_session, CposApiGeneratedFrom } from './api.js';

export interface ApiOperation {
  id: string; ns: 'app' | 'session'; group: string; name: string; method: string; path: string;
  summary: string | null; tags: string[]; auth: 'bearer' | 'session' | 'both' | 'none'; scope: string | null;
  params: Array<{ name: string; in: 'path' | 'query' | 'header'; required: boolean; type: string; description?: string }>;
  hasBody: boolean; bodyRequired: boolean; facilityRequired: boolean; hasResponseSchema: boolean; fake: boolean; mcp: string | null; sig: string;
}

export interface CposClient {
  baseUrl: string;
  /** 生の呼び出し。生成されたメソッドで足りないときだけ。CPOS の OpenAPI に無いパスは呼べない */
  raw(method: string, path: string, o?: RawOptions): Promise<unknown>;
  /** 生成元 (OpenAPI の版・revision・取得日) と、method + path から operation を引く道具 */
  api: { generatedFrom: CposApiGeneratedFrom; lookup(method: string, path: string): ApiOperation | null };
  /** Bearer (App Token / PAT / OAuth) で呼べる全 operation + 認証なし。1 operation = 1 メソッド。戻り値は生の JSON */
  app: CposApi_app;
  /** 管理画面のセッション Cookie でしか呼べない operation。createCposClient({ cookie }) のときだけ使える */
  session: CposApi_session;
  auth: { me(): Promise<Me> };
  platform: { me(): Promise<PlatformMe>; capabilities(): Promise<{ server: string; features: Record<string, Record<string, boolean>> }> };
  facilities: { list(): Promise<Facility[]> };
  /** 利用者 (介護を受ける人)。facilityId は必須。渡さないと CposClientError。 */
  masterUsers: { list(p: { facilityId: string; q?: string; activeOnly?: boolean; limit?: number }): Promise<MasterUser[]> };
  /** 組織内のログインユーザー (職員のアカウント)。利用者ではない。 */
  staffAccounts: { list(): Promise<Array<{ id: string; email?: string; name?: string; role?: string }>> };
  appData(appId: string): AppDataApi;
}

export interface CreateCposClientOptions {
  baseUrl: string;
  /** App Token の文字列か、毎回解決する関数 (Secret Manager から読むなど)。 */
  token?: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  clientName?: string;
  /** ブラウザの Cookie を転送する場合 (ログインゲートウェイの callback で使う)。 */
  cookie?: string;
  timeoutMs?: number;
}

export function createCposClient(opts: CreateCposClientOptions): CposClient;

/** kit/api.json (生成された operation の表) を読む */
export function loadApi(): { generatedFrom: CposApiGeneratedFrom; operations: ApiOperation[] };
export function lookupOperation(method: string, path: string): ApiOperation | null;
export function pathMatches(pattern: string, path: string): boolean;
/** App Token の解決。file (Secret Manager の volume mount) があれば ttlMs ごとに読み直し、無ければ env のキーの値。トークン入替に追随する */
export function tokenResolver(o?: { file?: string; fallback?: () => string | null | undefined; env?: string; ttlMs?: number }): () => string | null;
/** いまの接続先: 'staging' (本物) / 'mock' (--mock か 127.0.0.1 の URL) / 'unset' (URL が無い) */
export function connectionMode(o?: { baseUrl?: string | null; argv?: string[] }): 'staging' | 'mock' | 'unset';
