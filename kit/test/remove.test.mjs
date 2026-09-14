// remove: adopt / create の裏返し。kit が置いたものを取り除き、人が書いた部分・コード・manifest・依存には触らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = resolve(root, 'kit', 'bin', 'cpos-kit.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [cli, ...a], { cwd, encoding: 'utf8' });

test('remove: create したものは全部消え、人が書いた部分と manifest・コード・依存は残る。既定は一覧だけ', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cpos-kit-remove-')), 'app');
  assert.equal(run(tmpdir(), 'create', dir, '--name', 'rm', '--app-id', 'rm', '--sample', 'node', '--yes', '--kit-dep', 'github:example/cpos-kit').status, 0);
  // 人が書いたものを足す: AGENTS.md の外、settings.json の別の hook
  const agents = join(dir, 'AGENTS.md');
  writeFileSync(agents, readFileSync(agents, 'utf8') + '\n## 自分のルール\n\n- 残るはず\n');
  const sp = join(dir, '.claude/settings.json'); const s = JSON.parse(readFileSync(sp, 'utf8')); s.hooks.Extra = [{ hooks: [{ type: 'command', command: 'echo mine' }] }]; writeFileSync(sp, JSON.stringify(s, null, 2));
  // 既定は一覧だけ
  let r = run(dir, 'remove'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--apply/); assert.ok(existsSync(join(dir, '.claude/skills/cpos/SKILL.md')), '書き換えていない');
  r = run(dir, 'remove', '--apply'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = readFileSync(agents, 'utf8');
  assert.ok(!after.includes('cpos-kit:begin') && !after.includes('cpos-kit:discipline'), 'マーカーの間は消える');
  assert.match(after, /## 自分のルール/, '人が書いた部分は残る');
  for (const f of ['.claude/skills/cpos/SKILL.md', '.agents/skills/cpos/SKILL.md', '.github/skills/cpos/SKILL.md', '.cursor/rules/cpos.mdc', '.github/copilot-instructions.md', '.github/workflows/ci.yml']) assert.ok(!existsSync(join(dir, f)), `${f} は消える`);
  const s2 = JSON.parse(readFileSync(sp, 'utf8')); assert.ok(!s2.hooks.Stop, 'Stop hook は消える'); assert.ok(s2.hooks.Extra, '他の hook は残る');
  for (const f of ['cpos.manifest.json', 'server.mjs', 'package.json', 'docs/cpos/README.md', 'CLAUDE.md']) assert.ok(existsSync(join(dir, f)), `${f} は残る`);
  assert.ok(JSON.stringify(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).includes('@cpos/kit'), '依存は残る');
  // もう一度回しても壊れない
  r = run(dir, 'remove', '--apply'); assert.equal(r.status, 0); assert.match(r.stdout, /見つからない|触らない/);
});
