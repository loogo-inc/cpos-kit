export interface FakeCposOptions {
  /** 0 なら空いているポート。既定 4300。 */
  port?: number;
  host?: string;
  /** seed.json のパスか、同じ形のオブジェクト。 */
  seed?: string | Record<string, unknown>;
  log?: (line: string) => void;
  /** 受け付ける Bearer の接頭辞。既定 ['cpos_app_', 'cpos_pat_']。 */
  appTokenPrefixes?: string[];
}

export interface FakeCpos {
  baseUrl: string;
  port: number;
  seed: Record<string, unknown>;
  state: { appData: Map<string, Map<string, unknown>>; requests: Array<{ method: string; path: string; at: string }> };
  close(): Promise<void>;
}

export interface FakeCposInProcess {
  /** createCposClient({ fetch: fake.fetch }) に渡す。ソケットを使わない */
  fetch: typeof fetch;
  baseUrl: string;
  seed: Record<string, unknown>;
  state: FakeCpos['state'];
  handle: (req: unknown, res: unknown) => Promise<void>;
}

export const DEFAULT_SEED_PATH: string;
/** node:http のハンドラを fetch 互換にする (ソケット無し)。アプリ自身の inject にも使える */
export function fetchFromHandler(handle: (req: unknown, res: unknown) => Promise<void> | void): typeof fetch;
/** ソケット無しのKIT 模擬サーバ。テストの既定 */
export function createFakeCpos(opts?: Omit<FakeCposOptions, 'port' | 'host'>): FakeCposInProcess;
/** TCP で起動するKIT 模擬サーバ(npm run dev、ブラウザ用) */
export function startFakeCpos(opts?: FakeCposOptions): Promise<FakeCpos & FakeCposInProcess>;
