// docs: kit の OpenAPI の写しを Redoc の画面で出す (ログイン不要)。サーバが立ち、spec を配ることを確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cpos-kit.mjs');

test('docs --port --no-open: / は Redoc の HTML、/openapi.json は kit の OpenAPI の写し', async () => {
  const port = 4390 + Math.floor(Math.random() * 100);
  const p = spawn(process.execPath, [cli, 'docs', '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/`); ready = r.ok; } catch {} if (!ready) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(ready, 'docs が起動しない');
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /<redoc spec-url="\/openapi\.json"/); assert.match(html, /redoc\.standalone\.js/);
    const spec = await (await fetch(`http://127.0.0.1:${port}/openapi.json`)).json();
    assert.ok(Object.keys(spec.paths).length > 1000); assert.ok(spec['x-cpos-kit'].revision);
    assert.ok(!/"x-cpos-source"\s*:/.test(JSON.stringify(spec)), '内部情報 (x-cpos-source のキー) は落ちている');
  } finally { p.kill('SIGKILL'); }
});
