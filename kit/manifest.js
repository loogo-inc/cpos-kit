// cpos.manifest.json の検証。spec/manifest.schema.json (正本) を読んで、
// JSON Schema のうち使っている範囲 (type / required / properties / items / enum /
// pattern / minLength / additionalProperties) だけを実装する。依存ゼロ。
//
//   import { validateManifest, readManifest } from '@cpos/kit/manifest';
//   const { ok, errors } = validateManifest(manifestObject);

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import { checkResourceSchema } from './app-data-schema.js';

export const SCHEMA_PATH = resolve(here, '..', 'spec', 'manifest.schema.json');
export const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string / number / boolean / object
}

function check(value, node, path, errors) {
  if (node.type) {
    const allowed = Array.isArray(node.type) ? node.type : [node.type];
    const t = typeOf(value);
    const okType = allowed.includes(t) || (t === 'number' && allowed.includes('integer') && Number.isInteger(value));
    if (!okType) {
      errors.push(`${path || '(root)'}: ${allowed.join(' か ')} であるべきところ ${t} です`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: ${node.enum.map((e) => JSON.stringify(e)).join(' / ')} のどれかにしてください (いま ${JSON.stringify(value)})`);
  }
  if (typeof value === 'string') {
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: 形式が違います (${node.pattern})。いま ${JSON.stringify(value)}`);
    }
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(`${path}: 空にできません`);
    }
  }
  if (typeOf(value) === 'object') {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path ? path + '.' : ''}${key}: 必須です`);
    }
    for (const [key, sub] of Object.entries(node.properties ?? {})) {
      if (key in value) check(value[key], sub, path ? `${path}.${key}` : key, errors);
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (node.properties ?? {}))) errors.push(`${path ? path + '.' : ''}${key}: 知らない項目です`);
      }
    }
  }
  if (Array.isArray(value) && node.items) {
    value.forEach((item, i) => check(item, node.items, `${path}[${i}]`, errors));
  }
}

/**
 * @param {unknown} manifest
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  check(manifest, schema, '', errors);
  if (errors.length === 0 && manifest && typeof manifest === 'object') {
    const m = /** @type {Record<string, unknown>} */ (manifest);
    if (!m.apiTokenScopes && !m.requiredPermissions) {
      warnings.push('apiTokenScopes も requiredPermissions も無いので、App Token に何のスコープを許すか CPOS 側で決められません');
    }
    if (typeof m.url === 'string' && !m.url.startsWith('https://')) {
      warnings.push(`url は https で始めてください (いま ${m.url})。CPOS は https でしか manifest を取りに来ません`);
    }
    if (Array.isArray(m.apiTokenScopes)) {
      for (const s of m.apiTokenScopes) {
        if (s === '*' || /:\*$/.test(String(s))) warnings.push(`apiTokenScopes の ${s} は広すぎます (ワイルドカード)。必要なスコープだけを列挙してください。事故のときの被害が全機能に及びます`);
      }
    }
    if (Array.isArray(m.apiTokenScopes) && m.apiTokenScopes.includes('apps:admin')) {
      errors.push('apiTokenScopes の apps:admin は管理者の PAT 専用で、App Token には付けられません (CPOS は候補から除外する)。外してください');
    }
    if (m.isPublic === true) warnings.push('isPublic は初回登録時にだけ使われます。再取込では上書きされません (以後は CPOS 管理画面の設定が正)');
    if (Array.isArray(m.resources)) {
      m.resources.forEach((r, i) => {
        if (r && r.schema !== undefined) for (const it of checkResourceSchema(r.schema)) errors.push(`resources[${i}].schema ${it.path}: ${it.message}`);
      });
    }
    if (Array.isArray(m.apiTokenScopes) && typeof m.appId === 'string') {
      for (const s of m.apiTokenScopes) {
        if (typeof s === 'string' && s.startsWith('app-data:') && !s.startsWith(`app-data:${m.appId}:`)) {
          warnings.push(`apiTokenScopes の ${s} は自分の appId (${m.appId}) 以外の AppData を指しています。意図していなければ直してください`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** ファイルを読んで検証する。JSON として壊れていればそれも errors に入れる。 */
export function readManifest(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, manifest: null, errors: [`${path}: ファイルがありません`], warnings: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    return { ok: false, manifest: null, errors: [`${path}: JSON として読めません (${e.message})`], warnings: [] };
  }
  return { manifest, ...validateManifest(manifest) };
}
