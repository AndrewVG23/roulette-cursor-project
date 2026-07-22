(function (global) {
  'use strict';

  const PURSE_KEY = 'casinoPurse';
  const GRILL_TIPS_KEY = 'grillTipsPending';
  const DEFAULT = 100;
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  });
  const listeners = new Set();

  function readRaw() {
    const raw = global.localStorage.getItem(PURSE_KEY);
    if (raw == null) return null;
    return Math.max(0, Math.round(Number(raw) || 0));
  }

  function read() {
    const v = readRaw();
    if (v == null) return write(DEFAULT);
    return v;
  }

  function write(n) {
    const v = Math.max(0, Math.round(n));
    global.localStorage.setItem(PURSE_KEY, String(v));
    updateDisplay();
    listeners.forEach((fn) => {
      try { fn(v); } catch (_) { /* ignore listener errors */ }
    });
    return v;
  }

  function add(n) {
    return write(read() + n);
  }

  function take(n) {
    return write(read() - n);
  }

  function migrateTips() {
    const tips = Math.max(0, Math.round(Number(global.localStorage.getItem(GRILL_TIPS_KEY) || 0)));
    if (tips > 0) {
      global.localStorage.setItem(GRILL_TIPS_KEY, '0');
      add(tips);
    }
    return tips;
  }

  function updateDisplay() {
    const v = readRaw() == null ? DEFAULT : read();
    const el = document.getElementById('purseHudValue');
    const hud = document.getElementById('purseHud');
    if (el) el.textContent = fmt.format(v);
    if (hud) {
      hud.classList.toggle('empty', v <= 0);
      hud.classList.toggle('low', v > 0 && v < DEFAULT * 0.25);
    }
  }

  function mountHud() {
    if (document.getElementById('purseHud')) {
      updateDisplay();
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'purse-hud';
    wrap.id = 'purseHud';
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML = '<span class="purse-hud-label">Purse</span><span class="purse-hud-value" id="purseHudValue"></span>';
    document.body.appendChild(wrap);
    updateDisplay();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  migrateTips();
  if (readRaw() == null) write(DEFAULT);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountHud);
  } else {
    mountHud();
  }

  global.Wallet = {
    PURSE_KEY,
    GRILL_TIPS_KEY,
    DEFAULT,
    format: fmt.format,
    read,
    set: write,
    add,
    take,
    migrateTips,
    mountHud,
    updateDisplay,
    subscribe
  };
})(window);
