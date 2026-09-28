import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { action, frame, rows, select, width } from '../bin/select.mjs';

const CHOICES = [
  { value: 'fastify', label: 'Fastify + CPOS ログイン付き' },
  { value: 'node', label: '依存ゼロの最小サーバ' },
  { value: 'none', label: '入れない' }
];

// 端末の代わり: keypress を流せる入力と、書かれたものを溜める出力
function term() {
  const input = new PassThrough();
  input.isTTY = true;
  const raw = [];
  input.setRawMode = (on) => raw.push(on);
  const output = new PassThrough();
  let written = '';
  output.on('data', (d) => { written += d; });
  return { input, output, raw, text: () => written };
}

const DOWN = '\x1b[B', UP = '\x1b[A', ENTER = '\r';

test('select: Enter だけなら既定の値', async () => {
  const t = term();
  const p = select('見本のコードを入れますか', CHOICES, 'fastify', t);
  t.input.write(ENTER);
  assert.equal(await p, 'fastify');
  assert.deepEqual(t.raw, [true, false], 'raw mode を戻す');
});

test('select: ↓↓ Enter で 3 つ目、↑ は先頭から末尾へ回る', async () => {
  let t = term();
  let p = select('q', CHOICES, 'fastify', t);
  t.input.write(DOWN); t.input.write(DOWN); t.input.write(ENTER);
  assert.equal(await p, 'none');
  t = term();
  p = select('q', CHOICES, 'fastify', t);
  t.input.write(UP); t.input.write(ENTER);
  assert.equal(await p, 'none');
});

test('select: 既定が途中の値なら、そこから始まる。番号キーで直接決まる', async () => {
  let t = term();
  let p = select('q', CHOICES, 'node', t);
  t.input.write(ENTER);
  assert.equal(await p, 'node');
  t = term();
  p = select('q', CHOICES, 'fastify', t);
  t.input.write('3');
  assert.equal(await p, 'none');
});

test('select: 決まったら選択肢を消して 1 行に畳む', async () => {
  const t = term();
  const p = select('接続先', CHOICES, 'fastify', t);
  t.input.write(DOWN); t.input.write(ENTER);
  await p;
  const last = t.text().split('\x1b[0J').pop();
  assert.match(last, /^\? 接続先 .*node/);
  assert.ok(!last.includes('○'), '選択肢が残らない');
  assert.ok(t.text().endsWith('\x1b[?25h'), 'カーソルを戻す');
});

test('select: 描き直しは描いた行数だけ上がる (0 行上がる CSI 0 A を書かない)', async () => {
  const t = term();
  const p = select('q', CHOICES, 'fastify', t);
  t.input.write(DOWN); t.input.write(ENTER);
  await p;
  assert.ok(!t.text().includes('\x1b[0A'));
  assert.ok(t.text().includes(`\x1b[${rows(frame('q', CHOICES, 0)) - 1}A`));
});

test('select: 全角は 2 桁で数え、折り返しを行数に入れる', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('事業所'), 6);
  assert.equal(width('\x1b[36m事\x1b[0m'), 2);
  assert.equal(rows('あ'.repeat(50), 80), 2);
  assert.equal(rows('a\nb', 80), 2);
});

test('select: キーの読み方', () => {
  assert.equal(action('', { name: 'down' }), 'down');
  assert.equal(action('', { name: 'up' }), 'up');
  assert.equal(action('j', { name: 'j' }), 'down');
  assert.equal(action('\r', { name: 'return' }), 'enter');
  assert.equal(action('', { name: 'c', ctrl: true }), 'abort');
  assert.deepEqual(action('2', { name: '2' }, 3), { pick: 1 });
  assert.equal(action('4', { name: '4' }, 3), null, '範囲外の番号は無視');
  assert.equal(action('x', { name: 'x' }, 3), null);
});
