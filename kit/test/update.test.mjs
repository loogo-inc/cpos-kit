// update: kit が置いたファイル (標準ブロック、skills、Stop hook、ci.yml) を今の kit の版に合わせる。人が書いた部分は触らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = resolve(root, 'kit', 'bin', 'cpos-kit.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [cli, ...a], { cwd, encoding: 'utf8' });

test('update: マーカーの間・skills・Stop hook・ci.yml を戻し、マーカーの外と自前のファイルは触らない。--check は差分で非 0', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cpos-kit-update-')), 'app');
  const c = run(tmpdir(), 'create', dir, '--name', 'upd', '--app-id', 'upd', '--sample', 'none', '--yes', '--kit-dep', 'github:example/cpos-kit');
  assert.equal(c.status, 0, c.stderr);
  // 直後は差分なし
  let r = run(dir, 'update', '--check'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /差分があるもの \(0\)/);
  // 人が AGENTS.md のマーカーの外に書いたものは残り、中を壊しても戻る
  const agents = join(dir, 'AGENTS.md');
  const mine = '\n## 自分のルール\n\n- ここは人が書いた\n';
  writeFileSync(agents, readFileSync(agents, 'utf8').replace('### 覚える言葉は 5 つ', '### 壊した見出し') + mine);
  // skills を古い版に見立てて書き換え、ci.yml も壊す、settings の審査文も古くする
  writeFileSync(join(dir, '.claude/skills/cpos/SKILL.md'), '# old skill (@cpos/kit の旧版)\n');   // kit のスキルには必ず @cpos/kit がある (所有の印)
  writeFileSync(join(dir, '.github/workflows/ci.yml'), '# cpos-kit が所有する (update で置き換わる)。\nname: OLD\n');
  const sp = join(dir, '.claude/settings.json'); const s = JSON.parse(readFileSync(sp, 'utf8')); s.hooks.Stop[0].hooks[0].prompt = '古い審査文 stop_hook_active'; s.hooks.Extra = [{ hooks: [{ type: 'command', command: 'echo mine' }] }]; writeFileSync(sp, JSON.stringify(s, null, 2));
  // 自前の CI に見せかけたファイル (kit 所有の印なし) は触らない
  writeFileSync(join(dir, '.agents/skills/cpos/SKILL.md'), '# old skill 2\n');
  r = run(dir, 'update', '--check'); assert.equal(r.status, 1, '差分があれば非 0'); assert.match(r.stdout, /AGENTS\.md/); assert.match(r.stdout, /\.claude\/skills\/cpos\/SKILL\.md/); assert.match(r.stdout, /ci\.yml/); assert.match(r.stdout, /settings\.json/);
  assert.equal(readFileSync(join(dir, '.claude/skills/cpos/SKILL.md'), 'utf8'), '# old skill (@cpos/kit の旧版)\n', '--check は書き換えない');
  r = run(dir, 'update'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = readFileSync(agents, 'utf8');
  assert.match(after, /### 覚える言葉は 5 つ/, 'マーカーの中は戻る'); assert.ok(after.endsWith(mine), 'マーカーの外 (人が書いたもの) は残る');
  assert.match(readFileSync(join(dir, '.claude/skills/cpos/SKILL.md'), 'utf8'), /^---\nname: cpos/);
  assert.match(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'), /name: CI/);
  const s2 = JSON.parse(readFileSync(sp, 'utf8')); assert.match(s2.hooks.Stop[0].hooks[0].prompt, /審査役/); assert.ok(s2.hooks.Extra, '他の hooks は残る');
  r = run(dir, 'update', '--check'); assert.equal(r.status, 0, '更新後は差分なし');
  // マーカーが無い AGENTS.md (手書き) は触らない
  writeFileSync(agents, '# 手書きの AGENTS\n');
  r = run(dir, 'update'); assert.equal(r.status, 0); assert.match(r.stdout, /AGENTS\.md  \(kit のマーカーが無い/); assert.equal(readFileSync(agents, 'utf8'), '# 手書きの AGENTS\n');
  assert.ok(existsSync(dir));
});

test('update: 自前の同名スキル (中に @cpos/kit が無い) と、symlink でプロジェクトの外を指すスキルは触らない。adopt 直後は差分なし', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cpos-kit-update-')), 'app');
  const shared = mkdtempSync(join(tmpdir(), 'cpos-kit-shared-'));
  mkdirSync(join(dir, '.claude/skills/cpos'), { recursive: true });
  writeFileSync(join(dir, '.claude/skills/cpos/SKILL.md'), '---\nname: cpos\n---\n自前の古いメモ\n');
  mkdirSync(join(shared, 'cpos'), { recursive: true });
  writeFileSync(join(shared, 'cpos/SKILL.md'), '---\nname: cpos\n---\n共有 @cpos/kit の古い写し\n');
  mkdirSync(join(dir, '.agents/skills'), { recursive: true });
  symlinkSync(join(shared, 'cpos'), join(dir, '.agents/skills/cpos'));
  let r = run(dir, 'adopt', '--app-id', 'own', '--name', 'own', '--apply'); assert.equal(r.status, 0, r.stderr);
  // adopt が書いたもの (.github/skills/cpos) は appId 埋め込み済みなので、直後の --check は差分なし
  r = run(dir, 'update', '--check'); assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /\.claude\/skills\/cpos\/SKILL\.md  \(kit 所有の印が無い = 自前/);
  assert.match(r.stdout, /\.agents\/skills\/cpos\/SKILL\.md  \(symlink でプロジェクトの外/);
  r = run(dir, 'update'); assert.equal(r.status, 0);
  assert.equal(readFileSync(join(dir, '.claude/skills/cpos/SKILL.md'), 'utf8'), '---\nname: cpos\n---\n自前の古いメモ\n');
  assert.equal(readFileSync(join(shared, 'cpos/SKILL.md'), 'utf8'), '---\nname: cpos\n---\n共有 @cpos/kit の古い写し\n');
  assert.match(readFileSync(join(dir, '.github/skills/cpos/SKILL.md'), 'utf8'), /^---\nname: cpos/);
});
