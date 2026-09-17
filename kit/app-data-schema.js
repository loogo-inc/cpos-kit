// AppData の `data` の形の宣言 (manifest の resources[].schema) と、その照合。
// CPOS 本体の app-data/schema-validate と同じ規則・同じ文言 (2026-09-14、CPOS 2e5b91d5)。
//   - 使えるキーワードは 8 つだけ。それ以外は manifest の取込で落ちる (書いても効かないものを黙って受けない)。
//   - トップは type: 'object' で、properties を 1 つ以上。
//   - 書込の照合は CPOS では既定「報告のみ」、APP_DATA_SCHEMA_ENFORCE=true で 400。KIT 模擬サーバは常に 400 (宣言のずれを手元で落とす)。
export const SUPPORTED_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
export const SUPPORTED_KEYWORDS = ['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'description', 'format'];
export const SUPPORTED_FORMATS = ['date', 'date-time'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)?$/;
const join = (path, key) => (path ? `${path}.${key}` : key);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}
const typeMatches = (value, expected) => { const a = typeOf(value); return a === expected || (expected === 'number' && a === 'integer'); };

/** 宣言そのものが CPOS で効く書き方か。効かないキーワードは issue にする。 */
export function checkSchemaSupported(schema, path = '') {
  const issues = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [{ path: path || '(全体)', message: 'スキーマはオブジェクトで書いてください' }];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) issues.push({ path: join(path, key), message: `このキーワードは CPOS が検証しません (対応: ${SUPPORTED_KEYWORDS.join(', ')})。書いても効かないので、外すか、検証側を先に拡張してください` });
  }
  if (schema.type !== undefined) for (const t of (Array.isArray(schema.type) ? schema.type : [schema.type])) if (!SUPPORTED_TYPES.includes(t)) issues.push({ path: join(path, 'type'), message: `未対応の型: ${String(t)}` });
  if (schema.format !== undefined && !SUPPORTED_FORMATS.includes(schema.format)) issues.push({ path: join(path, 'format'), message: `未対応の format: ${String(schema.format)} (対応: ${SUPPORTED_FORMATS.join(', ')})` });
  if (schema.required !== undefined && !Array.isArray(schema.required)) issues.push({ path: join(path, 'required'), message: '配列で書いてください' });
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) issues.push({ path: join(path, 'enum'), message: '配列で書いてください' });
  if (schema.properties !== undefined) {
    if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) issues.push({ path: join(path, 'properties'), message: 'オブジェクトで書いてください' });
    else for (const [key, sub] of Object.entries(schema.properties)) issues.push(...checkSchemaSupported(sub, join(join(path, 'properties'), key)));
  }
  if (schema.items !== undefined) issues.push(...checkSchemaSupported(schema.items, join(path, 'items')));
  return issues;
}

/** リソース宣言としての妥当性。トップは object で properties を 1 つ以上。 */
export function checkResourceSchema(schema) {
  const issues = checkSchemaSupported(schema);
  if (issues.length) return issues;
  if (schema.type !== 'object') issues.push({ path: '(全体)', message: "トップレベルは type: 'object' にしてください" });
  if (!schema.properties || Object.keys(schema.properties).length === 0) issues.push({ path: 'properties', message: '少なくとも 1 項目は宣言してください' });
  return issues;
}

/** data を宣言に照らす。値は issue に載せない (個人情報がそのまま出るため)… CPOS と同じく enum と型名だけ。 */
export function validateAgainstSchema(value, schema, path = '') {
  if (!schema) return [];
  const issues = [];
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(value, t))) { issues.push({ path: path || '(全体)', message: `型が ${expected.join(' | ')} のはずですが ${typeOf(value)} でした` }); return issues; }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) issues.push({ path: path || '(全体)', message: `${JSON.stringify(schema.enum)} のいずれかのはずですが ${JSON.stringify(value)} でした` });
  if (schema.format && typeof value === 'string') {
    if (schema.format === 'date' && !DATE_RE.test(value)) issues.push({ path: path || '(全体)', message: 'YYYY-MM-DD の形ではありません' });
    if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) issues.push({ path: path || '(全体)', message: 'ISO 8601 の日時ではありません' });
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => issues.push(...validateAgainstSchema(v, schema.items, `${path}[${i}]`)));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (value[key] === undefined) issues.push({ path: join(path, key), message: '必須ですが入っていません' });
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (value[key] !== undefined) issues.push(...validateAgainstSchema(value[key], sub, join(path, key)));
    if (schema.additionalProperties === false && schema.properties) for (const key of Object.keys(value)) if (!(key in schema.properties)) issues.push({ path: join(path, key), message: '宣言に無い項目です' });
  }
  return issues;
}
