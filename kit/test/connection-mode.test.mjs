// 接続先: 原則はステージング (本物)。模擬サーバは自分で選んだときだけ。create が .env を書き、dev.mjs がモードを出す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { connectionMode } from '../client.js';


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = resolve(root, 'kit', 'bin', 'cpos-kit.mjs');
const run = (cwd, ...a) => spawnSync(process.execPath, [cli, ...a], { cwd, encoding: 'utf8' });
const linkKit = (dir) => { mkdirSync(join(dir, 'node_modules', '@cpos'), { recursive: true }); symlinkSync(root, join(dir, 'node_modules', '@cpos', 'kit')); };
const devLog = (dir, ...extra) => new Promise((res) => {
  const p = spawn(process.execPath, ['--env-file-if-exists=.env', 'dev.mjs', ...extra], { cwd: dir, env: { ...process.env, PORT: '0', FAKE_PORT: '4397' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', settled = false; const timer = setTimeout(() => done('timeout'), 8000);
  const done = (code) => { if (settled) return; settled = true; clearTimeout(timer); try { p.kill('SIGKILL'); } catch {} res({ out, code }); };
  p.stdout.on('data', (d) => { out += d; if (/接続先:/.test(out) && /http:\/\/127\.0\.0\.1:\d+/.test(out.split('接続先:')[1] ?? '')) setTimeout(() => done(null), 200); });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => done(code));
});

test('connectionMode: https はステージング、127.0.0.1 / localhost は模擬、--mock は常に模擬、空は unset', () => {
  assert.equal(connectionMode({ baseUrl: 'https://cpos.example', argv: [] }), 'staging');
  assert.equal(connectionMode({ baseUrl: 'http://127.0.0.1:4300', argv: [] }), 'mock');
  assert.equal(connectionMode({ baseUrl: 'http://localhost:4311/', argv: [] }), 'mock');
  assert.equal(connectionMode({ baseUrl: 'https://cpos.example', argv: ['node', 'dev.mjs', '--mock'] }), 'mock');
  assert.equal(connectionMode({ baseUrl: '', argv: [] }), 'unset');
});

test('create --yes (URL 無し) は模擬を選び、.env に模擬の接続先と「後で connect」の案内を書く', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cpos-kit-mode-')), 'app');
  const r = run(tmpdir(), 'create', dir, '--name', 'm', '--app-id', 'm', '--sample', 'node', '--yes', '--kit-dep', 'github:example/cpos-kit');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /接続先: 模擬サーバ/); assert.match(r.stdout, /connect → npm run dev/);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  assert.match(env, /^M_CPOS_BASE_URL=http:\/\/127\.0\.0\.1:4300$/m); assert.match(env, /connect/);
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"dev:mock"/);
});

// 模擬サーバは別プロセスで (テストプロセス内で起動すると、spawnSync の間に応答できず固まる)
async function fakeProcess(port) {
  const p = spawn(process.execPath, [cli, 'fake', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${baseUrl}/api/platform/me`, { headers: { Authorization: 'Bearer cpos_app_x' } }); if (r.ok) return { baseUrl, close: () => { try { p.kill('SIGKILL'); } catch {} } }; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  try { p.kill('SIGKILL'); } catch {}
  throw new Error('模擬サーバが起動しない');
}

test('create --url --token-file はステージングを .env に書く (疎通とスコープを確かめてから)。dev.mjs はモードを出す', async () => {
  const fake = await fakeProcess(4398);
  try {
    const base = join(mkdtempSync(join(tmpdir(), 'cpos-kit-mode-')));
    const tf = join(base, 'tk.txt'); writeFileSync(tf, 'cpos_app_stagingtest\n');
    const dir = join(base, 'app');
    const r = run(base, 'create', dir, '--name', 's', '--app-id', 's', '--sample', 'node', '--yes', '--kit-dep', 'github:example/cpos-kit', '--url', fake.baseUrl, '--token-file', tf);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /つながりました/); assert.match(r.stdout, /接続先: ステージング/);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    assert.match(env, new RegExp(`^S_CPOS_BASE_URL=${fake.baseUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
    assert.ok(!/cpos_app_stagingtest/.test(r.stdout), 'トークンの値は画面に出さない');
    // dev.mjs: 127.0.0.1 の URL なので (テストでは) 模擬扱いになる。--mock は常に模擬。
    linkKit(dir);
    const a = await devLog(dir, '--mock'); assert.match(a.out, /接続先: 模擬サーバ/, a.out);
    // ステージングの URL に見せかけると (実在しない host)、模擬サーバを起動せずステージング表示で起動する
    writeFileSync(join(dir, '.env'), `S_CPOS_BASE_URL=https://cpos.invalid\nS_CPOS_APP_TOKEN=cpos_app_x\nS_ALLOW_UNAUTHENTICATED=1\n`);
    const b = await devLog(dir); assert.match(b.out, /接続先: ステージング https:\/\/cpos\.invalid/, b.out); assert.ok(!/接続先: 模擬サーバ/.test(b.out), '模擬サーバは起動していない');
    // .env が無い → 案内して止まる
    writeFileSync(join(dir, '.env'), 'PORT=0\n');
    const c = await devLog(dir); assert.match(c.out, /接続先が未設定/); assert.equal(c.code, 2);
    assert.ok(existsSync(dir));
  } finally { fake.close(); }
});

test('create: staging を選んでも URL が無ければ模擬に倒す。URL が間違っていてもアプリは残り、.env は書かず、次の手を案内する', () => {
  const base = mkdtempSync(join(tmpdir(), 'cpos-kit-mode-'));
  // 非対話 (ask は既定値 = 空) で staging → 模擬に倒す
  let r = run(base, 'create', join(base, 'a1'), '--name', 'a', '--app-id', 'a1', '--sample', 'node', '--yes', '--connect', 'staging', '--kit-dep', 'github:example/cpos-kit');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /模擬サーバで作ります/); assert.match(readFileSync(join(base, 'a1', '.env'), 'utf8'), /127\.0\.0\.1:4300/);
  // つながらない URL → アプリは残る、.env は無い、終了コード 0、connect の案内
  const tf = join(base, 'tk.txt'); writeFileSync(tf, 'cpos_app_x\n');
  r = run(base, 'create', join(base, 'a2'), '--name', 'a', '--app-id', 'a2', '--sample', 'node', '--yes', '--url', 'http://127.0.0.1:1', '--token-file', tf, '--kit-dep', 'github:example/cpos-kit');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /接続できませんでした/); assert.match(r.stdout, /connect/); assert.match(r.stdout, /接続先: 未設定/);
  assert.ok(existsSync(join(base, 'a2', 'cpos.manifest.json'))); assert.ok(!existsSync(join(base, 'a2', '.env')));
  // 中身のあるフォルダには作らず、消し方を案内
  r = run(base, 'create', join(base, 'a2'), '--name', 'a', '--app-id', 'a2', '--yes', '--kit-dep', 'github:example/cpos-kit');
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /空ではありません/); assert.match(r.stdout + r.stderr, /rm -rf/);
});
