// kit/tickets.js — 後から入れるチケット台帳 (npx cpos-kit tickets)。
//
// 正本は docs/tickets/TK-###.md (1 枚 1 ファイル、手で書く)。索引 docs/TICKETS.md は生成物 (手で触らない)。
// 解くのは 2 つの故障: 「AI は物忘れをする」(未完が次のセッションで消える) と「徐々に優先度を見失う」。
//   - 物忘れ    → 消えない台帳 + 索引が本文とズレたら赤
//   - 優先度    → 索引は 状態 → 重さ → 起票日 で並ぶ。同時に「進行中」にできる枚数を機械で縛る (葉のみ WIP_LIMIT 枚)
//   - 置き去り  → 親子 1 段。閉じていない子が残る親は閉じられない
// 設計の経緯: 2026-09-08 (社内の開発標準から「正本 + 生成索引 + --check」の型だけ持ち込み、承認樹・worktree・仮 ID・
// commit-msg hook・Stop hook は入れない。Node 組込みだけ。opt-in = `tickets init` を打つまで何も動かない)。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const STATUSES = ['進行中', '判断待ち', 'open', 'closed'];
export const WEIGHTS = ['A', 'B', 'C'];
export const WIP_LIMIT = 3;
export const STALE_DAYS = 14;
export const TICKETS_DIR = 'docs/tickets';
export const INDEX_FILE = 'docs/TICKETS.md';
const ID_RE = /^TK-\d{3,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 1 枚を読む。壊れていても落とさず errors に積む (索引は作れる範囲で作る)。
export function parseTicket(text, id) {
  const t = { id, status: '', weight: '', created: '', parent: '', title: '', checks: { open: 0, half: 0, done: 0 }, errors: [] };
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!fm) { t.errors.push(`${id}: 先頭に frontmatter (--- で囲んだ status / weight / created) が無い`); return t; }
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z]+)\s*:\s*(.*?)\s*(?:#.*)?$/);
    if (m && m[1] in t && typeof t[m[1]] === 'string') t[m[1]] = m[2];
  }
  const body = text.slice(fm[0].length);
  const tm = body.match(new RegExp(`^#\\s*${id}\\s*[:：]\\s*(.+?)\\s*$`, 'm'));
  t.title = tm ? tm[1] : '';
  if (!t.title) t.errors.push(`${id}: 見出し「# ${id}: タイトル」が無い`);
  if (!STATUSES.includes(t.status)) t.errors.push(`${id}: status は ${STATUSES.join(' / ')} のどれか (いま "${t.status}")`);
  if (!WEIGHTS.includes(t.weight)) t.errors.push(`${id}: weight は A (止まる) / B (困る) / C (あとで) のどれか (いま "${t.weight}")`);
  if (!DATE_RE.test(t.created)) t.errors.push(`${id}: created は YYYY-MM-DD (いま "${t.created}")`);
  if (t.parent && !ID_RE.test(t.parent)) t.errors.push(`${id}: parent は TK-### の形 (いま "${t.parent}")`);
  for (const m of body.matchAll(/^\s*- \[( |~|x|X)\] /gm)) {
    if (m[1] === ' ') t.checks.open++; else if (m[1] === '~') t.checks.half++; else t.checks.done++;
  }
  return t;
}

// 最後に触った日。git の最終コミット日 (未コミットなら mtime)。git が無い・リポジトリでないなら mtime。
function lastTouched(root, path) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!dirty) {
      const d = execFileSync('git', ['log', '-1', '--format=%as', '--', path], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (DATE_RE.test(d)) return d;
    }
  } catch {}
  return localDate(statSync(join(root, path)).mtime);
}

// 台帳が「入っている」= init が書いた docs/tickets/README.md がある。フォルダの有無で見ない:
// 既存プロジェクトが自前の docs/tickets/ (JIRA-101.md 等) と自前の docs/TICKETS.md を持っていることがあり、
// フォルダだけで判定すると `tickets` が自前の索引を黙って上書きする (2026-09-14 の適用検証で発生)。
export const README_HEAD = '# docs/tickets — チケット台帳';
export const INDEX_HEAD = '# TICKETS — チケット索引';
export function isInstalled(root) {
  const p = resolve(root, TICKETS_DIR, 'README.md');
  return existsSync(p) && readFileSync(p, 'utf8').startsWith(README_HEAD);
}
// 入れる前の障害物: kit のものではない docs/TICKETS.md (上書きしてはいけない) と、TK-###.md でないファイル (無視される)。
export function foreignFiles(root) {
  const out = { index: false, others: [] };
  const ip = resolve(root, INDEX_FILE);
  if (existsSync(ip) && !readFileSync(ip, 'utf8').startsWith(INDEX_HEAD)) out.index = true;
  const dir = resolve(root, TICKETS_DIR);
  if (existsSync(dir)) out.others = readdirSync(dir).filter((n) => n !== 'README.md' && !/^TK-\d{3,}\.md$/.test(n));
  return out;
}

export function loadTickets(root) {
  const dir = resolve(root, TICKETS_DIR);
  const tickets = [], errors = [];
  if (!existsSync(dir)) return { tickets, errors };
  for (const name of readdirSync(dir).sort()) {
    if (!/^TK-.*\.md$/.test(name)) continue;   // README.md 等は無視
    const id = name.slice(0, -3);
    if (!ID_RE.test(id)) { errors.push(`${TICKETS_DIR}/${name}: ファイル名は TK-001.md のように 3 桁以上の番号`); continue; }
    const t = parseTicket(readFileSync(join(dir, name), 'utf8'), id);
    t.touched = lastTouched(root, `${TICKETS_DIR}/${name}`);
    tickets.push(t);
    errors.push(...t.errors);
  }
  return { tickets, errors };
}

function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
const sortKey = (t) => [STATUSES.indexOf(t.status), WEIGHTS.indexOf(t.weight), t.created, t.id];
function byKey(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

// 親子を組む (1 段まで)。検査 5 (親が無い / 孫) はここで出る。
export function buildTree(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const errors = [];
  const children = new Map();
  for (const t of tickets) {
    if (!t.parent) continue;
    const p = byId.get(t.parent);
    if (!p) { errors.push(`5: ${t.id} の parent ${t.parent} が無い (迷子)`); continue; }
    if (p.parent) { errors.push(`5: ${t.id} → ${p.id} → ${p.parent} と 3 段になっている (親子は 1 段まで。${t.id} をチェックリスト行にするか、parent を ${p.parent} にする)`); continue; }
    if (!children.has(p.id)) children.set(p.id, []);
    children.get(p.id).push(t);
  }
  const roots = tickets.filter((t) => !t.parent || !byId.get(t.parent) || byId.get(t.parent).parent).sort(byKey)
    .map((t) => ({ ...t, children: (children.get(t.id) || []).sort(byKey) }));
  return { roots, errors };
}

const leaves = (roots) => roots.flatMap((r) => (r.children.length ? r.children : [r]));

export function renderIndex(tickets, { today = localDate() } = {}) {
  const { roots } = buildTree(tickets);
  const wip = leaves(roots).filter((t) => t.status === '進行中').length;
  const lines = [
    '# TICKETS — チケット索引 (自動生成。手で編集しない。`npx cpos-kit tickets` で作り直す)',
    '',
    '正本は `docs/tickets/TK-###.md`。上から順に次にやることが並ぶ (状態 → 重さ → 起票日)。',
    '起票: `npx cpos-kit tickets new <タイトル>`  検査: `npx cpos-kit tickets --check`',
    '',
    `進行中 ${wip} / ${WIP_LIMIT} 枚 (葉のみ計上)`,
    ''
  ];
  if (!roots.length) { lines.push('(チケットは無い)', ''); return lines.join('\n'); }
  lines.push('| ID | 重さ | 状態 | 残 | タイトル |', '|---|---|---|---|---|');
  const row = (t, child) => {
    let title = t.status === 'closed' ? `~~${t.title}~~` : t.title;
    if (t.status === '判断待ち' && t.touched && daysBetween(t.touched, today) >= STALE_DAYS) title += `（${daysBetween(t.touched, today)} 日停滞）`;
    const total = t.checks.open + t.checks.half + t.checks.done;
    const rest = t.children?.length ? `子 ${t.children.filter((c) => c.status !== 'closed').length}/${t.children.length}` : total ? `${t.checks.open + t.checks.half}/${total}` : '—';
    return `| ${child ? '└ ' : ''}[${t.id}](tickets/${t.id}.md) | ${t.weight} | ${t.status} | ${rest} | ${child ? '　' : ''}${title} |`;
  };
  for (const r of roots) { lines.push(row(r, false)); for (const c of r.children) lines.push(row(c, true)); }
  lines.push('');
  return lines.join('\n');
}

// 停滞の印は日付で変わるので、索引の一致検査からは外す (時計で CI が落ちると外される)。
const stripStale = (s) => s.replace(/（\d+ 日停滞）/g, '');

export function checkTickets(root, { today = localDate() } = {}) {
  if (!isInstalled(root)) return { ok: true, installed: false, problems: [], tickets: 0 };
  const { tickets, errors } = loadTickets(root);
  const problems = errors.map((e) => `形式: ${e}`);
  const { roots, errors: treeErrors } = buildTree(tickets);
  problems.push(...treeErrors);
  const indexPath = resolve(root, INDEX_FILE);
  if (!existsSync(indexPath)) problems.push(`1: ${INDEX_FILE} が無い (npx cpos-kit tickets で作る)`);
  else if (stripStale(readFileSync(indexPath, 'utf8')) !== stripStale(renderIndex(tickets, { today }))) problems.push(`1: ${INDEX_FILE} が本文とズレている (npx cpos-kit tickets で作り直す)`);
  const wip = leaves(roots).filter((t) => t.status === '進行中');
  if (wip.length > WIP_LIMIT) problems.push(`2: 進行中が ${wip.length} 枚 (上限 ${WIP_LIMIT})。先に閉じるか open に戻す: ${wip.map((t) => t.id).join(', ')}`);
  for (const t of tickets) {
    if (t.status === 'closed' && t.checks.open + t.checks.half > 0) problems.push(`3: ${t.id} は closed なのにチェックリストに [ ] / [~] が ${t.checks.open + t.checks.half} 件残っている`);
  }
  for (const r of roots) {
    const left = r.children.filter((c) => c.status !== 'closed');
    if (r.status === 'closed' && left.length) problems.push(`4: ${r.id} は closed なのに子が閉じていない (置き去り): ${left.map((c) => c.id).join(', ')}`);
  }
  return { ok: problems.length === 0, installed: true, problems, tickets: tickets.length };
}

export function nextId(tickets) {
  const n = Math.max(0, ...tickets.map((t) => Number(t.id.slice(3))));
  return `TK-${String(n + 1).padStart(3, '0')}`;
}

export function newTicketText({ id, title, weight = 'B', parent = '', created = localDate() }) {
  return `---
status: open
weight: ${weight}
created: ${created}
${parent ? `parent: ${parent}\n` : ''}---
# ${id}: ${title}

背景: (1〜3 行。なぜやるか)

## 受入条件
- 正常系: (何ができれば終わりか)
- 失敗経路: (壊れた入力・権限の無い事業所で何が起きるべきか。無いなら「なし + 理由」)

## チェックリスト
- [ ] T1: 
`;
}
