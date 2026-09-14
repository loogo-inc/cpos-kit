// operation の署名。パラメータ・スコープ・body の有無が変わったかを見る (summary の言い換えでは変わらない)。
// 生成器 (gen-api) と cpos-kit doctor (接続先との比較) が同じ計算を使う。
import { createHash } from 'node:crypto';
/** CPOS が返す revision を kit に書いてよい形にする。Cloud Run の revision 名 (<サービス名>-<番号>-<3 文字>) はサービス名に
 *  運営会社の名前や環境名を含むので末尾の番号だけ残す。git のコミット (main@<sha>) 等はそのまま。比較する側 (doctor / verify-live) も同じ関数を通す */
export function revisionLabel(rev) {
  if (rev == null) return null;
  const m = String(rev).match(/-(\d{5}-[a-z0-9]{3})$/);
  return m ? m[1] : String(rev);
}
export function signatureOf(op) {
  const params = (op.params ?? []).map((p) => [p.name, p.in, !!p.required]).sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha1').update(JSON.stringify([op.method, op.path, params, op.scope ?? null, !!op.hasBody, !!op.bodyRequired])).digest('hex').slice(0, 12);
}
/** 公式 OpenAPI (fetch したもの) から署名の表を作る。doctor が接続先と比べるとき用 */
export function signaturesFromOpenApi(src) {
  const out = new Map();
  for (const [path, item] of Object.entries(src.paths ?? {})) {
    for (const [m, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) continue;
      const params = (op.parameters ?? []).filter((p) => ['path', 'query', 'header'].includes(p.in)).map((p) => ({ name: p.name, in: p.in, required: !!p.required }));
      const e = { id: op.operationId, method: m.toUpperCase(), path, params, scope: op['x-cpos-scope'] ?? null, hasBody: !!op.requestBody, bodyRequired: !!op.requestBody?.required };
      out.set(e.id ?? `${e.method} ${e.path}`, { ...e, sig: signatureOf(e) });
    }
  }
  return out;
}
