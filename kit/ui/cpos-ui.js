// cpos-ui.js — 画面の規約のうち、CSS だけでは足りない部分 (依存なし・ビルド不要)。
// いま入っているのは「文字の大きさ 3 段階」(決め 16) だけ。読み込むだけで効く。
//   <script src="/cpos-ui.js" defer></script>
//   <div data-cpos-text-size></div>   ← ここに 標準 / 大 / 特大 のボタンが入る (省略可)
// 端末 (iPhone の文字サイズ / Android のフォントサイズ / ブラウザの拡大) の設定に追随した上に掛かる。
(() => {
  const KEY = 'cpos.textSize';
  const SIZES = [['normal', '標準'], ['large', '大'], ['xlarge', '特大']];
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* 保存できない環境でも画面は動く */ } };

  function apply(size) {
    const el = document.documentElement;
    if (size && size !== 'normal') el.setAttribute('data-cpos-text', size);
    else el.removeAttribute('data-cpos-text');
    for (const b of document.querySelectorAll('[data-cpos-text-size] button')) {
      b.setAttribute('aria-pressed', String(b.dataset.size === (size || 'normal')));
    }
  }

  function mount() {
    for (const host of document.querySelectorAll('[data-cpos-text-size]')) {
      if (host.dataset.mounted) continue;
      host.dataset.mounted = '1';
      host.classList.add('cpos-chips');
      host.setAttribute('role', 'group');
      if (!host.getAttribute('aria-label')) host.setAttribute('aria-label', '文字の大きさ');
      for (const [size, label] of SIZES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cpos-chip';
        b.dataset.size = size;
        b.textContent = label;
        b.addEventListener('click', () => { write(size); apply(size); });
        host.append(b);
      }
    }
    apply(read());
  }

  // 画面が描かれる前に大きさを当てる (ちらつかせない)
  apply(read());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.cposTextSize = { get: () => read() || 'normal', set: (v) => { write(v); apply(v); } };
})();
