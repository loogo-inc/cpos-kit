// 画面の規約 (kit/agents/design.md) と共通 CSS が、雛形と create/adopt/update/remove に効いているか。
// 「揃えたい N の形」のうち機械で見えるものを固定する。ガイドラインなので、検査するのは kit の配るものだけ (アプリは落とさない)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const kitRoot = resolve(import.meta.dirname, '..', '..');
const cli = join(kitRoot, 'kit', 'bin', 'cpos-kit.mjs');
const run = (args, cwd) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const tmp = () => mkdtempSync(join(tmpdir(), 'cpos-design-'));

test('共通 CSS: 16px 未満の文字指定・px 固定の本文が無く、押せるものは 44px', () => {
  const css = readFileSync(join(kitRoot, 'kit', 'ui', 'cpos-ui.css'), 'utf8');
  const small = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter((m) => Number(m[1]) < 16);
  assert.equal(small.length, 0, `16px 未満の font-size がある: ${small.map((m) => m[0]).join(', ')}`);
  assert.match(css, /--cpos-tap:\s*44px/);
  assert.match(css, /\.cpos-appbar \.cpos-usermenu \{ margin-inline-start: auto/, '右上を自分の場所にしていない (決め 10 / 14)');
  // 決め 10: 固定は規約ではない。app bar は既定で貼り付かず、欲しいアプリだけ .cpos-pinned を付ける
  const appbar = css.slice(css.indexOf('.cpos-appbar {'), css.indexOf('.cpos-appbar h1'));
  assert.ok(!/position:\s*sticky/.test(appbar), 'app bar を既定で上に貼り付けている (固定はアプリの判断)');
  assert.match(css, /\.cpos-appbar\.cpos-pinned \{ position: sticky/, '貼り付けたいアプリ向けの .cpos-pinned が無い');
  assert.match(css, /--cpos-font-size-body:\s*1rem/);
  assert.match(css, /-apple-system-body/);            // 端末の文字サイズ設定に追随
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});

test('ガイドラインの本文: 推奨と書いてあり、表の数が見出しと一致する', () => {
  const md = readFileSync(join(kitRoot, 'kit', 'agents', 'design.md'), 'utf8');
  assert.match(md, /^<!-- cpos-kit:design:begin/);
  // 見出しの数と、表の行数が一致していること (表示の数字がずれない)
  assert.match(md, /これは推奨で、強制ではない/, '強制でないと書いていない (鉄の掟にしない)');
  assert.match(md, /色・フォント・角丸・ロゴは自由/, 'テーマで自由にできることを書いていない');
  const n = Number(md.match(/### 揃えたい (\d+) の形/)?.[1]);
  const rows = (md.match(/^\| \d+b? \|/gm) || []).length;
  assert.equal(rows, n, `見出しは ${n} の形だが表は ${rows} 行`);
  assert.match(md.trimEnd(), /<!-- cpos-kit:design:end -->$/);
  for (const key of ['意思決定', '検索の起動', '必須の表し方', '保存バー', 'window.confirm', '未設定', 'グローバルナビ', 'ログアウト', '設定', '事業所に関係ない画面', '文字の大きさ', '多言語', '置き場と固定はアプリが決めてよい']) {
    assert.ok(md.includes(key), `規約に「${key}」が無い`);
  }
});

test('create: 既定で AGENTS.md に規約が入り、--design no なら入らない', () => {
  for (const [flag, want] of [[[], true], [['--design', 'no'], false]]) {
    const dir = tmp();
    run(['create', 'app', '--name', 'テスト', '--app-id', 'demo', '--sample', 'node', '--discipline', 'no', '--connect', 'mock', '--yes', ...flag], dir);
    const agents = readFileSync(join(dir, 'app', 'AGENTS.md'), 'utf8');
    assert.equal(agents.includes('<!-- cpos-kit:design:begin'), want);
    assert.equal(agents.includes('揃えたい 19 の形'), want);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('雛形の画面: viewport がある / 共通 CSS を読む / window.confirm を使わない / px の文字指定が無い', () => {
  for (const sample of ['node', 'fastify']) {
    const src = readFileSync(join(kitRoot, 'kit', 'templates', sample, 'server.mjs'), 'utf8');
    assert.match(src, /<meta name="viewport" content="width=device-width,initial-scale=1/, `${sample}: viewport が無い`);
    assert.match(src, /<link rel="stylesheet" href="\/cpos-ui\.css">/, `${sample}: 共通 CSS を読んでいない`);
    assert.match(src, /pathname === '\/cpos-ui\.css'|get\('\/cpos-ui\.css'/, `${sample}: 共通 CSS を配信していない`);
    assert.ok(!/window\.confirm|\balert\(|\bprompt\(/.test(src), `${sample}: window.confirm / alert / prompt を使っている`);
    assert.ok(!/font-size:\s*\d+px/.test(src), `${sample}: px の文字指定がある`);
    assert.match(src, /cpos-savebar/, `${sample}: 保存バーが無い`);
    assert.match(src, /cpos-empty/, `${sample}: 0 件のときの表示が無い`);
    assert.match(src, /未設定/, `${sample}: 値が無い項目の表記が無い`);
    assert.ok(!/<button[^>]*>探す<\/button>/.test(src.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')), `${sample}: 検索ボタンを置いている (決め 3 は即時絞り込み)`);
  }
});

test('adopt: --design no で規約を足さず、既定なら足す。update で今の版に、remove で消える', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'x'), { recursive: true });
  const cwd = join(dir, 'x');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }) + '\n');
  run(['adopt', '--apply', '--discipline', 'no'], cwd);
  const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('<!-- cpos-kit:design:begin'), 'adopt で規約が入らない');
  // update: マーカーの間を今の版に (中を汚してから戻ることを見る)
  writeFileSync(join(cwd, 'AGENTS.md'), agents.replace('揃えたい 19 の形', 'よごした'));
  run(['update', '--no-install', '--no-test', '--no-ai', '--allow-dirty'], cwd);
  assert.ok(readFileSync(join(cwd, 'AGENTS.md'), 'utf8').includes('揃えたい 19 の形'), 'update がガイドラインを戻さない');
  run(['remove', '--apply'], cwd);
  // remove は kit だけで出来ているファイルは消す。残った場合はマーカーが消えていること
  const left = existsSync(join(cwd, 'AGENTS.md')) ? readFileSync(join(cwd, 'AGENTS.md'), 'utf8') : '';
  assert.ok(!left.includes('cpos-kit:design:begin'), 'remove が規約を消さない');
  rmSync(dir, { recursive: true, force: true });
});

test('見本: 規約どおり (viewport / 共通 CSS / confirm 無し / 必須の文字 / 保存バー)', () => {
  for (const f of ['users.html', 'record.html', 'today.html', 'user.html', 'settings.html']) {
    const html = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8');
    assert.match(html, /<meta name="viewport"/, `${f}: viewport が無い`);
    assert.match(html, /href="\.\.\/cpos-ui\.css"/, `${f}: 共通 CSS を読んでいない`);
    assert.ok(!/window\.confirm|\balert\(|\bprompt\(/.test(html), `${f}: window.confirm を使っている`);
    if (f !== 'today.html' && f !== 'user.html') assert.match(html, /cpos-savebar/, `${f}: 保存バーが無い`);
  }
  // 決め 13・14: 行き先は 5 つまで・いまいる所が分かる / 右上に自分とログアウト
  for (const f of ['today.html', 'user.html', 'settings.html']) {
    const html = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8');
    const links = [...html.matchAll(/<a [^>]*class="cpos-nav-[^"]*"|<nav class="cpos-nav"[\s\S]*?<\/nav>/g)];
    const nav = html.match(/<nav class="cpos-nav"[\s\S]*?<\/nav>/);
    assert.ok(nav, `${f}: 行き先 (.cpos-nav) が無い`);
    const items = [...nav[0].matchAll(/<a /g)].length;
    assert.ok(items >= 2 && items <= 5, `${f}: 行き先は 2〜5 つ (いま ${items})`);
    // 設定はユーザーメニューから開く画面なので、行き先の現在地は持たない
    if (f !== 'settings.html') assert.match(nav[0], /aria-current="page"/, `${f}: いまいる所が分からない`);
    assert.match(html, /class="cpos-usermenu"/, `${f}: 右上の自分のメニューが無い`);
    assert.match(html, /href="\/logout"/, `${f}: ログアウトが無い`);
  }
  // 決め 10: 事業所 (作業対象) は左 = HTML で自分のメニューより前にある
  for (const f of ['today.html', 'user.html']) {
    const html = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8');
    assert.ok(html.indexOf('cpos-facility') < html.indexOf('cpos-usermenu'), `${f}: 事業所が自分のメニューより後ろにある (決め 10: 事業所は左、右上は自分)`);
  }
  // 決め 10: 切り替えは 2 手 (固定バーに 1 タップで変わる select を置かない)
  for (const f of ['today.html', 'user.html']) {
    const html = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8');
    assert.match(html, /<details class="cpos-facility">/, `${f}: 事業所が 2 手の切り替えになっていない`);
    assert.ok(!/<select[^>]*name="facilityId"/.test(html), `${f}: 固定バーに select がある (1 タップで別事業所に変わる)`);
  }
  for (const s of ['node', 'fastify']) {
    const src = readFileSync(join(kitRoot, 'kit', 'templates', s, 'server.mjs'), 'utf8');
    assert.match(src, /<details class="cpos-facility">/, `${s}: 雛形の事業所が 2 手の切り替えになっていない`);
    assert.ok(!/<select id="fac"/.test(src), `${s}: 雛形の固定バーに select がある`);
  }
  // 決め 10b: 事業所に関係ない画面は事業所を出さず、範囲を書く
  const st = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', 'settings.html'), 'utf8');
  assert.ok(!/class="cpos-facility"/.test(st), '設定 (事業所に関係ない画面) に事業所の選択がある (決め 10b)');
  // 範囲の札は誤解されそうなときだけ。設定のように見出しで明らかな画面には足さない
  assert.ok(!/class="cpos-scope"/.test(st), '設定に範囲の札を足している (決め 10b: 画面名で明らかなら足さない)');
  const set = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', 'settings.html'), 'utf8');
  const setBody = set.replace(/<!--[\s\S]*?-->/g, '');   // 説明のコメントは除く
  assert.ok(!/type="password"|パスワードを変更|パスワードの変更/.test(setBody), '設定にパスワードの入力・変更を置いている (決め 15: CPOS が持つ)');
  assert.match(set, /端末の文字サイズ/, '設定に「文字サイズは端末の設定」の案内が無い');
  const rec = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', 'record.html'), 'utf8');
  assert.match(rec, /class="cpos-required">必須</, '必須の表し方 (赤い「必須」の文字) が見本に無い');
  assert.match(rec, /class="cpos-error"/, '欄の直下のエラーが見本に無い');
  assert.match(rec, /<dialog class="cpos-dialog"/, '確認ダイアログが見本に無い');
  assert.match(rec, /削除する<\/button>/, '確認のボタンが動詞になっていない');
});

test('文字の大きさ (決め 16): CSS に 3 段階があり、cpos-ui.js が端末に覚える。見本に置き場がある', () => {
  const css = readFileSync(join(kitRoot, 'kit', 'ui', 'cpos-ui.css'), 'utf8');
  assert.match(css, /html\[data-cpos-text="large"\]/, 'CSS に「大」が無い');
  assert.match(css, /html\[data-cpos-text="xlarge"\]/, 'CSS に「特大」が無い');
  const js = readFileSync(join(kitRoot, 'kit', 'ui', 'cpos-ui.js'), 'utf8');
  assert.match(js, /localStorage/, '選んだ大きさを覚えていない');
  assert.match(js, /data-cpos-text-size/, '置き場 (data-cpos-text-size) を見ていない');
  assert.match(js, /aria-pressed/, 'いま選ばれている大きさが読み上げに出ない');
  const set = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', 'settings.html'), 'utf8');
  assert.match(set, /<div data-cpos-text-size><\/div>/, '設定の見本に文字の大きさの置き場が無い');
  for (const f of ['today.html', 'user.html', 'record.html', 'settings.html']) {
    assert.match(readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8'), /src="\.\.\/cpos-ui\.js"/, `${f}: cpos-ui.js を読んでいない`);
  }
  for (const s of ['node', 'fastify']) {
    const src = readFileSync(join(kitRoot, 'kit', 'templates', s, 'server.mjs'), 'utf8');
    assert.match(src, /cpos-ui\.js/, `${s}: 雛形が cpos-ui.js を配信・読み込みしていない`);
  }
});

test('多言語 (決め 17): CSS は左右でなく inline-start / inline-end で書く', () => {
  const css = readFileSync(join(kitRoot, 'kit', 'ui', 'cpos-ui.css'), 'utf8');
  const physical = [...css.matchAll(/^\s*(margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*(left|right))[^;]*;/gm)];
  assert.equal(physical.length, 0, `左右で書いている所がある: ${physical.map((m) => m[0].trim()).join(' / ')}`);
  for (const f of ['today.html', 'user.html', 'settings.html', 'record.html']) {
    assert.match(readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8'), /<html lang="ja">/, `${f}: lang が無い`);
  }
});

test('update: 規約が変わった回だけ「基礎 UI に合わせますか」と聞く。外した人には聞かない', () => {
  const dir = tmp();
  const cwd = join(dir, 'x');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }) + '\n');
  run(['adopt', '--apply', '--discipline', 'no'], cwd);
  const upd = () => run(['update', '--no-install', '--no-test', '--no-ai', '--allow-dirty'], cwd);
  const stale = (from) => writeFileSync(join(cwd, 'AGENTS.md'), readFileSync(join(cwd, 'AGENTS.md'), 'utf8').replace(from, 'むかしの決め'));

  stale('意思決定のボタン');
  assert.match(upd(), /基礎 UI/, '規約が古いのに聞かない');
  assert.ok(!/基礎 UI/.test(upd()), '規約が最新なのに毎回聞いている');
  stale('検索の起動');
  assert.match(upd(), /基礎 UI/, '規約がまた変わったのに聞かない (断っても次の変更では聞く)');

  // 規約を外した人には聞かない
  const dir2 = tmp();
  const cwd2 = join(dir2, 'y');
  mkdirSync(cwd2, { recursive: true });
  writeFileSync(join(cwd2, 'package.json'), JSON.stringify({ name: 'y', type: 'module' }) + '\n');
  run(['adopt', '--apply', '--discipline', 'no', '--design', 'no'], cwd2);
  assert.ok(!/基礎 UI に合わせますか/.test(upd2(cwd2)), '規約を入れていない人に聞いている');
  function upd2(d) { return run(['update', '--no-install', '--no-test', '--no-ai', '--allow-dirty'], d); }
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test('create: 事業所の選択をヘッダで行うか / 貼り付けるかを聞く (規約では決めない = アプリの判断)', () => {
  const make = (flags) => {
    const dir = tmp();
    run(['create', 'app', '--name', 'テスト', '--app-id', 'demo', '--sample', 'node', '--discipline', 'no', '--connect', 'mock', '--yes', ...flags], dir);
    const src = readFileSync(join(dir, 'app', 'server.mjs'), 'utf8');
    rmSync(dir, { recursive: true, force: true });
    return src;
  };
  const yesPinned = make(['--facility-in-header', 'yes', '--facility-pinned', 'yes']);
  assert.match(yesPinned, /const FACILITY_IN_HEADER = true;/, 'ヘッダで選ぶ設定になっていない');
  assert.match(yesPinned, /class="cpos-appbar cpos-pinned"/, '貼り付けの指定が反映されていない');

  const no = make(['--facility-in-header', 'no']);
  assert.match(no, /const FACILITY_IN_HEADER = false;/, 'ヘッダに出さない設定になっていない');
  assert.match(no, /class="cpos-appbar"/, 'no なのに貼り付けている');

  const def = make([]);
  assert.match(def, /const FACILITY_IN_HEADER = true;/, '既定はヘッダで選ぶ');
  assert.match(def, /class="cpos-appbar"/, '既定は貼り付けない');
  for (const src of [yesPinned, no, def]) {
    assert.ok(!/\{\{appbarClass\}\}|\{\{facilityInHeader\}\}/.test(src), '雛形の置き換えが残っている');
  }
});

test('アプリ名とロゴはヘッダに 1 回だけ (決め 12b)', () => {
  const css = readFileSync(join(kitRoot, 'kit', 'ui', 'cpos-ui.css'), 'utf8');
  assert.match(css, /\.cpos-brand \{/, 'ロゴ + アプリ名の枠 (.cpos-brand) が無い');
  // 広い幅で左のレールはヘッダの下から始まる (アプリ名を 2 回出さない)
  const wide = css.slice(css.indexOf('@media (min-width: 900px)'));
  assert.match(wide, /\.cpos-nav \{ position: fixed; top: var\(--cpos-appbar-h/, '左のレールがヘッダに重なっている');
  for (const f of ['today.html', 'user.html', 'settings.html', 'record.html']) {
    const html = readFileSync(join(kitRoot, 'kit', 'ui', 'examples', f), 'utf8');
    assert.match(html, /<span class="cpos-brand">/, `${f}: ロゴ + アプリ名の枠が無い`);
    assert.equal((html.match(/<h1>/g) || []).length, 1, `${f}: アプリ名が 2 回出ている`);
  }
  for (const s of ['node', 'fastify']) {
    const src = readFileSync(join(kitRoot, 'kit', 'templates', s, 'server.mjs'), 'utf8');
    assert.match(src, /logo\.svg/, `${s}: ロゴ (任意) を配信していない`);
  }
});

test('実験 16 で見つかった 3 つを直した (ヘッダのずれ / primary の数 / 自分の保存で離脱を止めない)', () => {
  const css = readFileSync(join(kitRoot, 'kit', 'ui', 'cpos-ui.css'), 'utf8');
  // 1. 左レールが無い画面でヘッダを左にずらさない (画面外に出ていた: 実測 -208px)
  assert.match(css, /body:has\(\.cpos-nav\) \.cpos-appbar \{ margin-inline-start: -13rem/, '左レールが無い画面でもヘッダをずらしている');
  // 2. チェック・ラジオも 44px の的 (決め 3)
  assert.match(css, /\.cpos-check \{[^}]*min-height: var\(--cpos-tap\)/, 'チェックの的が 44px でない');
  for (const s of ['node', 'fastify']) {
    const src = readFileSync(join(kitRoot, 'kit', 'templates', s, 'server.mjs'), 'utf8');
    // 3. 1 画面に primary は 1 つ = 行ごとの保存ボタンは primary にしない (決め 2)
    assert.ok(!/cpos-btn primary[^"]*" type="submit"/.test(src), `${s}: 行ごとの保存ボタンが primary になっている`);
    assert.equal((src.match(/cpos-btn primary/g) || []).length, 1, `${s}: primary が 1 つでない (保存バーだけのはず)`);
    // 4. 自分の保存では「このページを離れますか」を出さない
    assert.match(src, /if \(!saving && dirty\(\)\.length\)/, `${s}: 自分の保存でも離脱を止めてしまう`);
    // 5. 保存バーは変わった行を全部送る
    assert.match(src, /for \(const input of rows\)/, `${s}: 保存バーが 1 行しか送らない`);
  }
});

test('guide: 先頭に「打つコマンド」の一覧があり、--commands はそれだけを出す', () => {
  const dir = tmp();
  run(['create', 'app', '--name', 'テスト', '--app-id', 'demo', '--sample', 'node', '--discipline', 'no', '--connect', 'mock', '--yes'], dir);
  const app = join(dir, 'app');
  const full = run(['guide'], app);
  const head = full.split('\n').slice(0, 14).join('\n');
  for (const cmd of ['npm run dev', 'npm test', 'validate', 'connect', 'update']) {
    assert.ok(head.includes(cmd), `guide の先頭 14 行に ${cmd} が無い`);
  }
  const only = run(['guide', '--commands'], app);
  assert.ok(only.includes('npm run dev'), '--commands にコマンドが無い');
  assert.ok(!only.includes('【1】'), '--commands なのに詳しい話まで出ている');
  assert.ok(only.split('\n').length < 20, `--commands が長すぎる (${only.split('\n').length} 行)`);
  rmSync(dir, { recursive: true, force: true });
});

test('ui コマンド: 見本の場所と作り方を出す。guide の一覧にも載っている', () => {
  const dir = tmp();
  run(['create', 'app', '--name', 'テスト', '--app-id', 'demo', '--sample', 'node', '--discipline', 'no', '--connect', 'mock', '--yes'], dir);
  const app = join(dir, 'app');
  const o = run(['ui'], app);
  for (const key of ['examples', 'cpos-ui.css', 'cpos-ui.js', 'logo.svg', 'theme.css', 'FACILITY_IN_HEADER', 'primary は 1 つ']) {
    assert.ok(o.includes(key), `ui の出力に「${key}」が無い`);
  }
  assert.ok(run(['guide', '--commands'], app).includes('cpos-kit ui'), 'guide のコマンド一覧に ui が無い');
  assert.ok(run(['help'], app).includes('ui [--open]'), 'help に ui が無い');
  rmSync(dir, { recursive: true, force: true });
});

test('外れ方: cpos-ui.css を手で直していたら update が知らせる (上書きされると教える)', () => {
  const dir = tmp();
  const cwd = join(dir, 'x');
  mkdirSync(join(cwd, 'public'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }) + '\n');
  run(['adopt', '--apply', '--discipline', 'no'], cwd);
  const upd = () => run(['update', '--no-install', '--no-test', '--no-ai', '--allow-dirty'], cwd);
  const stale = () => writeFileSync(join(cwd, 'AGENTS.md'), readFileSync(join(cwd, 'AGENTS.md'), 'utf8').replace('揃えたい 19 の形', 'よごした'));

  writeFileSync(join(cwd, 'public', 'cpos-ui.css'), '/* 手で直した */\n');
  stale();
  const o = upd();
  assert.match(o, /public\/cpos-ui\.css が kit のものと違います/, '手で直した CSS を知らせていない');
  assert.match(o, /上書きされて消えます/, '上書きされると教えていない');
  assert.match(o, /theme\.css/, 'テーマで変える道を示していない');
  assert.match(o, /cpos-kit:design:end/, 'ガイドラインの外し方 (節ごと消す) を示していない');

  // 写しが kit と同じなら黙る
  rmSync(join(cwd, 'public', 'cpos-ui.css'));
  stale();
  assert.ok(!/kit のものと違います/.test(upd()), '写しが無いのに知らせている');
  rmSync(dir, { recursive: true, force: true });
});

test('ガイドラインの本文に「外れるときの作法」がある (update が使えなくなる外れ方を避ける)', () => {
  const md = readFileSync(join(kitRoot, 'kit', 'agents', 'design.md'), 'utf8');
  assert.match(md, /### 外れるときの作法/, '外れ方の節が無い');
  // マーカーの文字列を本文に書くと注入が壊れる (2026-09-28 に踏んだ)
  assert.equal((md.match(/cpos-kit:design:(begin|end)/g) || []).length, 2, 'マーカーの文字列が本文にも書かれている (注入が壊れる)');
  assert.match(md, /節ごと消す/, 'ガイドラインを外す方法を書いていない');
  assert.match(md, /次の `update` で\*\*上書きされて消える\*\*/, 'CSS を直接書き換えた場合の結末を書いていない');
});
