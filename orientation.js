(function (global) {
  'use strict';

  // Self-configuring rotate hint.
  //
  // Each game declares its shape by the intrinsic size of its #game canvas
  // (frogger is 480x600 portrait, burger and hospital are 560x420 landscape).
  // Pages whose canvas has no intrinsic size — the WebGL and DOM screens —
  // reflow on their own, so this stays out of their way entirely.
  //
  // Override per page with <html data-orient="portrait|landscape|none">.

  const DISMISS_KEY = 'rotate-hint-dismissed';
  const SEVERITY = 1.6;   // only nag when the squash is this bad or worse
  const MAX_SHORT_EDGE = 820; // phones and small tablets, not desktop windows

  let hintEl = null;
  let dismissed = false;

  function preferred() {
    const declared = document.documentElement.getAttribute('data-orient');
    if (declared === 'none') return null;
    if (declared === 'portrait' || declared === 'landscape') return declared;

    const canvas = document.getElementById('game');
    if (!canvas) return null;
    // Intrinsic size only — a canvas sized in script has no useful attribute.
    const w = Number(canvas.getAttribute('width'));
    const h = Number(canvas.getAttribute('height'));
    if (!w || !h) return null;
    if (Math.abs(w / h - 1) < 0.15) return null; // square-ish: plays either way
    return w >= h ? 'landscape' : 'portrait';
  }

  function handheld() {
    const short = Math.min(global.innerWidth, global.innerHeight);
    if (short > MAX_SHORT_EDGE) return false;
    return global.matchMedia('(pointer: coarse)').matches;
  }

  function mismatch() {
    const want = preferred();
    if (!want) return 0;
    const vw = global.innerWidth;
    const vh = global.innerHeight;
    if (!vw || !vh) return 0;
    const have = vw >= vh ? 'landscape' : 'portrait';
    if (have === want) return 0;
    // How badly the game would be squashed if stretched to fit.
    const canvas = document.getElementById('game');
    const cw = Number(canvas.getAttribute('width'));
    const ch = Number(canvas.getAttribute('height'));
    const target = vw / vh;
    const native = cw / ch;
    return Math.max(target / native, native / target);
  }

  function ensureHint() {
    if (hintEl) return hintEl;
    const style = document.createElement('style');
    style.textContent = [
      '.rotate-hint{position:fixed;inset:0;z-index:10050;display:flex;',
      'align-items:center;justify-content:center;flex-direction:column;gap:14px;',
      'padding:24px;text-align:center;background:rgba(7,12,10,.92);',
      'backdrop-filter:blur(6px);color:#f0e6d2;',
      "font-family:'General Sans','Nunito',system-ui,sans-serif;}",
      '.rotate-hint[hidden]{display:none;}',
      '.rotate-hint-icon{font-size:44px;line-height:1;animation:rotate-hint-tip 1.8s ease-in-out infinite;}',
      '.rotate-hint-text{font-size:1rem;font-weight:600;max-width:22ch;line-height:1.4;}',
      '.rotate-hint-sub{font-size:.8rem;color:#9a9079;max-width:26ch;line-height:1.4;}',
      '.rotate-hint-btn{margin-top:6px;padding:10px 18px;border-radius:4px;',
      'border:1px solid rgba(238,194,97,.3);background:rgba(20,53,40,.9);',
      'color:#d0a23a;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;',
      'min-height:44px;min-width:44px;}',
      '@keyframes rotate-hint-tip{0%,100%{transform:rotate(-12deg);}50%{transform:rotate(72deg);}}',
      '@media (prefers-reduced-motion: reduce){.rotate-hint-icon{animation:none;}}'
    ].join('');
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.className = 'rotate-hint';
    el.id = 'rotateHint';
    el.hidden = true;
    el.setAttribute('role', 'status');
    const want = preferred();
    el.innerHTML = [
      '<div class="rotate-hint-icon" aria-hidden="true">📱</div>',
      '<div class="rotate-hint-text">Turn your phone ',
      want === 'landscape' ? 'sideways' : 'upright',
      '</div>',
      '<div class="rotate-hint-sub">This one is built ',
      want === 'landscape' ? 'wide' : 'tall',
      ' — rotating keeps it from squashing.</div>',
      '<button class="rotate-hint-btn" type="button">Play anyway</button>'
    ].join('');
    el.querySelector('.rotate-hint-btn').addEventListener('click', () => {
      dismissed = true;
      try { global.sessionStorage.setItem(DISMISS_KEY, '1'); } catch (_) { /* private mode */ }
      el.hidden = true;
    });
    document.body.appendChild(el);
    hintEl = el;
    return el;
  }

  function update() {
    if (dismissed) return;
    const bad = handheld() && mismatch() >= SEVERITY;
    if (!bad) {
      if (hintEl) hintEl.hidden = true;
      return;
    }
    ensureHint().hidden = false;
  }

  function start() {
    if (!preferred()) return;
    try { dismissed = global.sessionStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { /* private mode */ }
    update();
    global.addEventListener('resize', update);
    global.addEventListener('orientationchange', update);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.RotateHint = { update, preferred };
})(window);
