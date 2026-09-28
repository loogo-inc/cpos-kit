// 端末の選択肢 (↑↓ で選んで Enter)。依存ゼロ (node:readline の keypress と raw mode だけ)。
// 端末でない・raw mode が使えないときは呼ぶ側が文字の入力に倒す (select は呼ばれない)。
import { emitKeypressEvents } from 'node:readline';

const ESC = '\x1b[';
// 上へ n 行。0 を渡すと多くの端末が 1 行上がる (CSI 0 A = CSI 1 A) ので書かない
const up = (n) => (n > 0 ? `${ESC}${n}A` : '');

// 全角 (日本語など) は 2 桁。折り返しの行数を数えるのに使う (数え違えると描き直しで行が残る)
export function width(s) {
  let w = 0;
  for (const ch of String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) {
    const c = ch.codePointAt(0);
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f300) ? 2 : 1;
  }
  return w;
}

export function rows(text, columns = 80) {
  return String(text).split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(width(line) / Math.max(1, columns))), 0);
}

// キー → 動作。数字キーは n 番目へ飛んで決める
export function action(str, key = {}, count = 0) {
  if (key.ctrl && key.name === 'c') return 'abort';
  if (key.name === 'escape') return 'abort';
  if (key.name === 'up' || key.name === 'k' || (key.name === 'tab' && key.shift)) return 'up';
  if (key.name === 'down' || key.name === 'j' || key.name === 'tab') return 'down';
  if (key.name === 'return' || key.name === 'enter') return 'enter';
  const n = Number(str);
  if (Number.isInteger(n) && n >= 1 && n <= count) return { pick: n - 1 };
  return null;
}

export function frame(question, choices, index) {
  const labelW = Math.max(...choices.map((c) => width(c.value)));
  const lines = [`? ${question}`];
  choices.forEach((c, i) => {
    const on = i === index;
    const pad = ' '.repeat(labelW - width(c.value));
    const text = `${on ? '●' : '○'} ${c.value}${pad}${c.label ? `  ${c.label}` : ''}`;
    lines.push(on ? `❯ ${ESC}36m${text}${ESC}0m` : `  ${text}`);
  });
  lines.push(`  ${ESC}2m(↑↓ で選ぶ、Enter で決定。番号でも選べる)${ESC}0m`);
  return lines.join('\n');
}

// choices: [{ value, label }]。initial は value。決まった value を返す。Ctrl+C / Esc は process.exit(130)
export function select(question, choices, initial, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    let index = Math.max(0, choices.findIndex((c) => c.value === initial));
    let drawn = 0;
    const columns = () => output.columns || 80;
    const draw = () => {
      if (drawn) output.write(`${up(drawn - 1)}\r${ESC}0J`);
      const f = frame(question, choices, index);
      output.write(f);
      drawn = rows(f, columns());
    };
    const done = (value) => {
      input.off('keypress', onKey);
      if (input.isTTY && input.setRawMode) input.setRawMode(false);
      input.pause();
      output.write(`${up(drawn - 1)}\r${ESC}0J? ${question} ${ESC}36m${value}${ESC}0m\n${ESC}?25h`);
    };
    const onKey = (str, key) => {
      const a = action(str, key, choices.length);
      if (a === 'abort') { done('(中止)'); process.exit(130); }
      if (a === 'up') index = (index + choices.length - 1) % choices.length;
      else if (a === 'down') index = (index + 1) % choices.length;
      else if (a === 'enter' || (a && a.pick !== undefined)) {
        if (a !== 'enter') index = a.pick;
        const v = choices[index].value;
        done(v);
        return resolve(v);
      } else return;
      draw();
    };
    emitKeypressEvents(input);
    if (input.isTTY && input.setRawMode) input.setRawMode(true);
    input.on('keypress', onKey);
    input.resume();
    output.write(`${ESC}?25l`);
    draw();
  });
}
