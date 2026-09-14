// 配布物 (公開・private を問わず開発者に届くもの) に、CPOS の内部構造や秘密が混ざっていないことを検査する。
// 課題台帳 #1 #2 #5 #18。対象は package.json の files (kit/ skills/ spec/) と README・標準ブロック。
//
// CPOS_KIT_SCAN_ROOT=<dir> を渡すと、そのフォルダの全ファイル (.git / node_modules 以外) を対象にし、
// 公開リポに残してはいけない内部参照 (保守用のフォルダや引き継ぎファイルの名前) も禁止する。
// CPOS_KIT_EXTRA_FORBIDDEN=<正規表現> を渡すと、その 1 本も禁止に加える (公開したくない語をこのファイルに書かないため)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scanRoot = process.env.CPOS_KIT_SCAN_ROOT ? resolve(process.env.CPOS_KIT_SCAN_ROOT) : null;
const FORBIDDEN = [
  [/apps\/admin\//, 'CPOS のソースの場所'],
  [/\b[\w-]+\.ts:\d+/, 'CPOS のファイル名と行番号'],
  [/\b(auth-me|platform-read|platform-organizations|manifest-import|app-data\/routes)\.ts\b/, 'CPOS のファイル名'],
  [/cpos_(pat|app)_[A-Za-z0-9_-]{20,}/, 'トークンらしき文字列'],
  [/\btok_[A-Za-z0-9_-]{16,}/, 'トークン ID らしき文字列'],
  [/os\.stg\.|-staging-\d+\.|\.run\.app/, 'ステージングの URL / GCP プロジェクト'],
  [/\/Users\/[a-z]+\/|\/home\/[a-z]+\//, '手元の絶対パス'],
  [/\bsrc\/server\//, 'CPOS のソースの場所'],
  // 個人名・社名・private リポジトリ名の検査は、パターン自体を公開しないよう CPOS_KIT_EXTRA_FORBIDDEN で書き出し側から渡す
];
// 公開リポ全体を検査するときだけ (作業リポの README や保守の道具は内部参照を持ってよい)
const FORBIDDEN_PUBLIC = [
  [/\breviews\//, '内部の評価記録への参照'],
  [/\bNEXT\.md\b/, '内部の引き継ぎへの参照'],
  [/(?<![\w\/-])sync\//, '保守の道具への参照'],        // API のパス (…/sheet-sync/…) は除く
  [/(?<![\w\/(-])reports\//, '内部の生成物への参照'],   // API のパス (…/reports/…、summary の (reports/:id)) は除く
  [/\.claude\/skills\/cpos-kit-(sync|trial)|cpos-change-scout/, '保守用の skill / agent への参照'],
];
// 生成データ (spec/、kit/api.json、kit/api.d.ts) だけに適用する、より厳しい検査 (kit のソースは自分の .d.ts などに言及するので除く)
const FORBIDDEN_DATA = [
  [/\b(?!index\b)[\w-]+\.tsx?\b/, 'CPOS のファイル名 (.ts / .tsx)'],
  [/\b(docs\/)?[A-Z][A-Z0-9_]+\.md\b/, 'CPOS の docs のファイル名'],
  [/\b[A-Z][a-zA-Z]+(?<!List)Page\b/, '管理画面の部品名 (ListPage = 一覧の 1 ページは除く)'],
];
if (process.env.CPOS_KIT_EXTRA_FORBIDDEN) FORBIDDEN.push([new RegExp(process.env.CPOS_KIT_EXTRA_FORBIDDEN, 'i'), '公開したくない語 (CPOS_KIT_EXTRA_FORBIDDEN)']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
function walk(d) { const out = []; for (const n of readdirSync(d)) { if (SKIP_DIRS.has(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }
const base = scanRoot ?? root;
const dirs = ['kit', 'skills', 'spec'].filter((d) => existsSync(resolve(base, d)));
const files = scanRoot
  ? walk(scanRoot)
  : dirs.flatMap((d) => walk(resolve(root, d))).concat([resolve(root, 'README.md')]);

test('生成物 (generated / provisional) を spec/ に置かない (files に含まれて配布されるため。置き場は reports/)', () => {
  const bad = existsSync(resolve(base, 'spec')) ? walk(resolve(base, 'spec')).filter((f) => /\.(generated|provisional)\./.test(f)) : [];
  assert.deepEqual(bad.map((f) => relative(base, f)), []);
});

test(`配布物に CPOS の内部構造・秘密・手元のパスが無い${scanRoot ? ` (公開ツリー全体: ${scanRoot})` : ''}`, () => {
  const hits = [];
  const isText = (f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|gz)$/i.test(f);
  for (const f of files) {
    if (!isText(f)) continue;
    const rel = relative(base, f);
    // この検査ファイル自身は禁止パターンを文字列として持つので除く
    if (rel === join('kit', 'test', 'no-internal-leak.test.mjs')) continue;
    const text = readFileSync(f, 'utf8');
    for (const [re, why] of FORBIDDEN) { const m = text.match(re); if (m) hits.push(`${rel}: ${why} (${m[0]})`); }
    if (scanRoot) for (const [re, why] of FORBIDDEN_PUBLIC) { const m = text.match(re); if (m) hits.push(`${rel}: ${why} (${m[0]})`); }
    if (/^spec\/|^kit\/(api\.(json|d\.ts)|scopes\.json)$/.test(rel)) for (const [re, why] of FORBIDDEN_DATA) { const m = text.match(re); if (m) hits.push(`${rel}: ${why} (${m[0]})`); }
  }
  assert.deepEqual(hits, [], '混入:\n' + hits.join('\n'));
  console.log(`  検査したファイル: ${files.length} 件、混入 ${hits.length} 件`);
});
