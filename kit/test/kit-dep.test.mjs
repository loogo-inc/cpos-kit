// create が新しいアプリに書く @cpos/kit の依存は、この kit の版の系統 (0.x の間は ^0.<minor>)。
// ^0.1 と固定していたので、0.2.0 を出しても新しいアプリに 0.1 系が入るところだった (2026-09-27)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('create の既定の依存は kit の版の系統を指す (#semver:^0.<minor>)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpos-kit-dep-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'kit/bin/cpos-kit.mjs'), 'create', join(dir, 'a'), '--name', 'a', '--app-id', 'a', '--sample', 'none', '--yes'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const dep = JSON.parse(readFileSync(join(dir, 'a', 'package.json'), 'utf8')).dependencies['@cpos/kit'];
    const [maj, min] = pkg.version.split('.');
    assert.equal(dep.split('#semver:')[1], maj === '0' ? `^0.${min}` : `^${maj}`, dep);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
