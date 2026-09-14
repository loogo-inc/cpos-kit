// tickets: 後から入れるチケット台帳。正本 = docs/tickets/TK-###.md、索引 = 生成物、--check が 5 つの決まりを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTicket, renderIndex, checkTickets, nextId, WIP_LIMIT } from '../tickets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const cli = resolve(root, 'kit', 'bin', 'cpos-kit.mjs');
const run = (cwd, ...a) => execFileSync('node', [cli, 'tickets', ...a], { cwd, encoding: 'utf8' });
const fails = (cwd, ...a) => { try { run(cwd, ...a); } catch (e) { return String(e.stdout) + String(e.stderr); } assert.fail(`tickets ${a.join(' ')} が通ってしまった`); };
const ticket = (dir, id, fm, body = '') => writeFileSync(join(dir, 'docs/tickets', `${id}.md`), `---\n${fm}\n---\n# ${id}: ${id} の題\n\n${body}`);
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'cpos-kit-tk-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, '.github/workflows/ci.yml'), readFileSync(resolve(root, 'kit/templates/base/.github/workflows/ci.yml'), 'utf8'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }, null, 2));
  return dir;
}

test('tickets init は一覧を出すだけ。--apply で台帳・索引・CI の 1 行・npm script を足し、2 回目は何も足さない', () => {
  const dir = fresh();
  try {
    const preview = run(dir, 'init');
    assert.match(preview, /docs\/tickets\/README\.md/);
    assert.ok(!existsSync(join(dir, 'docs/tickets')), '--apply なしで書いてしまった');

    const applied = run(dir, 'init', '--apply');
    assert.match(applied, /書きました: docs\/tickets\/README\.md/);
    assert.ok(existsSync(join(dir, 'docs/tickets/README.md')));
    assert.match(readFileSync(join(dir, 'docs/TICKETS.md'), 'utf8'), /チケットは無い/);
    const ci = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /- run: npx cpos-kit validate\n      - run: npx cpos-kit tickets --check\n/, 'CI の行が validate の直後に無い');
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts.tickets, 'cpos-kit tickets');

    const again = run(dir, 'init', '--apply');
    assert.match(again, /もう入っています/);
    assert.equal((readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8').match(/tickets --check/g) || []).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('入れていないプロジェクトでは --check は何もせず通る (CI に入れても害が無い)。new と索引の再生成は init を案内して止まる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpos-kit-tk-'));
  try {
    assert.match(run(dir, '--check'), /入っていない/);
    assert.deepEqual(checkTickets(dir), { ok: true, installed: false, problems: [], tickets: 0 });
    assert.match(fails(dir, 'new', 'x'), /tickets init --apply/);
    assert.match(fails(dir), /tickets init --apply/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tickets new は番号を採って起票し、索引を作り直す。親子は 1 段まで。--check が通る', () => {
  const dir = fresh();
  try {
    run(dir, 'init', '--apply');
    run(dir, 'new', '送迎メモの一覧画面', '--weight', 'A');
    run(dir, 'new', 'PDF', '出力');
    run(dir, 'new', '一覧の画面', '--parent', 'TK-001', '--weight', 'C');
    const t1 = readFileSync(join(dir, 'docs/tickets/TK-001.md'), 'utf8');
    assert.match(t1, /^---\nstatus: open\nweight: A\ncreated: \d{4}-\d{2}-\d{2}\n---\n# TK-001: 送迎メモの一覧画面\n/);
    assert.match(t1, /- 失敗経路:/);
    assert.match(readFileSync(join(dir, 'docs/tickets/TK-002.md'), 'utf8'), /^# TK-002: PDF 出力$/m);
    assert.match(readFileSync(join(dir, 'docs/tickets/TK-003.md'), 'utf8'), /^parent: TK-001$/m);
    const idx = readFileSync(join(dir, 'docs/TICKETS.md'), 'utf8');
    const rows = idx.split('\n').filter((l) => l.startsWith('| ') && l.includes('TK-'));
    assert.deepEqual(rows.map((r) => r.split(' | ')[0].replace('| ', '')), ['[TK-001](tickets/TK-001.md)', '└ [TK-003](tickets/TK-003.md)', '[TK-002](tickets/TK-002.md)'], '親の下に子、その後に他の親');
    assert.match(rows[0], /\| 子 1\/1 \|/);
    assert.match(fails(dir, 'new', '孫', '--parent', 'TK-003'), /1 段まで/);
    assert.match(fails(dir, 'new', 'x', '--weight', 'D'), /--weight は/);
    assert.match(run(dir, '--check'), /OK \(3 枚\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--check の 5 つの決まり: 索引ズレ / 進行中の上限 (葉のみ) / closed に未完 / closed の親に未完の子 / 親が無い・孫', () => {
  const dir = fresh();
  try {
    run(dir, 'init', '--apply');
    const today = '2026-09-14';
    // 親 P (進行中、数えない) と子 4 枚が進行中 → 2 に該当。親は葉でないので枠を食わない
    ticket(dir, 'TK-001', `status: 進行中\nweight: A\ncreated: ${today}`);
    for (const n of [2, 3, 4, 5]) ticket(dir, `TK-00${n}`, `status: 進行中\nweight: B\ncreated: ${today}\nparent: TK-001`, '- [ ] T1: x\n');
    // closed なのに [ ] と [~] が残る → 3
    ticket(dir, 'TK-006', `status: closed\nweight: C\ncreated: ${today}`, '- [ ] T1: a\n- [~] T2: b\n- [x] T3: c\n');
    // closed の親に open の子 → 4
    ticket(dir, 'TK-007', `status: closed\nweight: B\ncreated: ${today}`);
    ticket(dir, 'TK-008', `status: open\nweight: B\ncreated: ${today}\nparent: TK-007`);
    // 親が無い → 5、孫 → 5
    ticket(dir, 'TK-009', `status: open\nweight: B\ncreated: ${today}\nparent: TK-999`);
    ticket(dir, 'TK-010', `status: open\nweight: B\ncreated: ${today}\nparent: TK-008`);
    // 形式: status が変
    ticket(dir, 'TK-011', `status: done\nweight: B\ncreated: ${today}`);
    const r = checkTickets(dir, { today });
    assert.equal(r.ok, false);
    const has = (prefix, re) => assert.ok(r.problems.some((p) => p.startsWith(prefix) && re.test(p)), `${prefix} ${re} が無い:\n${r.problems.join('\n')}`);
    has('1:', /ズレている/);
    has('2:', new RegExp(`進行中が 4 枚 \\(上限 ${WIP_LIMIT}\\)`));
    has('3:', /TK-006 .* 2 件/);
    has('4:', /TK-007 .*TK-008/);
    has('5:', /TK-009 の parent TK-999 が無い/);
    has('5:', /TK-010 → TK-008 → TK-007/);
    has('形式:', /TK-011: status/);
    assert.match(fails(dir, '--check'), /tickets --check: 7 件/);

    // 直す: 索引を作り直し、進行中を 3 枚に、closed の未完を消し、親を開け直し、迷子と孫と形式を直す
    ticket(dir, 'TK-005', `status: open\nweight: B\ncreated: ${today}\nparent: TK-001`, '- [ ] T1: x\n');
    ticket(dir, 'TK-006', `status: closed\nweight: C\ncreated: ${today}`, '- [x] T1: a\n- [x] T2: b\n');
    ticket(dir, 'TK-007', `status: 判断待ち\nweight: B\ncreated: ${today}`);
    ticket(dir, 'TK-009', `status: open\nweight: B\ncreated: ${today}`);
    ticket(dir, 'TK-010', `status: open\nweight: B\ncreated: ${today}\nparent: TK-007`);
    ticket(dir, 'TK-011', `status: open\nweight: B\ncreated: ${today}`);
    assert.match(run(dir), /作り直しました: docs\/TICKETS\.md \(11 枚\)/);
    assert.match(run(dir, '--check'), /OK \(11 枚\)/);
    assert.match(readFileSync(join(dir, 'docs/TICKETS.md'), 'utf8'), /進行中 3 \/ 3 枚/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('索引は 状態 → 重さ → 起票日 で並び、closed は打ち消し、判断待ちの停滞は印だけ (14 日以上)', () => {
  const mk = (id, fm, body = '', touched = '2026-09-14') => Object.assign(parseTicket(`---\n${fm}\n---\n# ${id}: 題${id}\n${body}`, id), { touched });
  const tickets = [
    mk('TK-001', 'status: open\nweight: B\ncreated: 2026-09-01'),
    mk('TK-002', 'status: 進行中\nweight: B\ncreated: 2026-09-01', '- [ ] a\n- [x] b\n- [~] c\n'),
    mk('TK-003', 'status: 進行中\nweight: A\ncreated: 2026-09-02'),
    mk('TK-004', 'status: 判断待ち\nweight: A\ncreated: 2026-08-01', '', '2026-08-20'),
    mk('TK-005', 'status: closed\nweight: C\ncreated: 2026-09-01'),
    mk('TK-006', 'status: open\nweight: A\ncreated: 2026-09-05')
  ];
  const idx = renderIndex(tickets, { today: '2026-09-14' });
  const ids = idx.split('\n').filter((l) => l.startsWith('| [')).map((l) => l.slice(3, 9));
  assert.deepEqual(ids, ['TK-003', 'TK-002', 'TK-004', 'TK-006', 'TK-001', 'TK-005']);
  assert.match(idx, /\| \[TK-002\]\(tickets\/TK-002\.md\) \| B \| 進行中 \| 2\/3 \|/);
  assert.match(idx, /\| ~~題TK-005~~ \|/);
  assert.match(idx, /題TK-004（25 日停滞）/);
  assert.match(idx, /進行中 2 \/ 3 枚/);
  assert.equal(nextId(tickets), 'TK-007');
  // 13 日なら印は出ない
  assert.doesNotMatch(renderIndex(tickets, { today: '2026-09-02' }), /停滞/);
});

test('自前の docs/tickets/ と docs/TICKETS.md を持つ既存プロジェクト: init は自前の索引を上書きせず止まり、退かせば入る。フォルダの有無だけで「入っている」と見ない', () => {
  const dir = fresh();
  try {
    mkdirSync(join(dir, 'docs/tickets'), { recursive: true });
    writeFileSync(join(dir, 'docs/tickets/JIRA-101.md'), '# JIRA-101\n自前形式\n');
    writeFileSync(join(dir, 'docs/TICKETS.md'), '# 自前のチケット一覧\n- JIRA-101\n');
    // 入っていない扱い: --check は通り、索引の再生成は init を案内して止まる (自前の索引を書き換えない)
    assert.match(run(dir, '--check'), /入っていない/);
    assert.match(fails(dir), /tickets init --apply/);
    assert.equal(readFileSync(join(dir, 'docs/TICKETS.md'), 'utf8'), '# 自前のチケット一覧\n- JIRA-101\n');
    // init は自前の索引の上には入れない
    assert.match(fails(dir, 'init', '--apply'), /kit の索引ではありません/);
    assert.ok(!existsSync(join(dir, 'docs/tickets/README.md')));
    // 退かせば入る。TK-###.md でないファイルは名指しで知らせ、無視する
    writeFileSync(join(dir, 'docs/TICKETS-old.md'), readFileSync(join(dir, 'docs/TICKETS.md'))); rmSync(join(dir, 'docs/TICKETS.md'));
    const applied = run(dir, 'init', '--apply');
    assert.match(applied, /JIRA-101\.md/);
    assert.match(run(dir, '--check'), /OK \(0 枚\)/);
    run(dir, 'new', '後から入れた');
    assert.match(run(dir, '--check'), /OK \(1 枚\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
