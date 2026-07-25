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
  let lastDisplayed = null;
  let pulseTimer = null;
  let deltaTimer = null;
  let resizeObserver = null;

  function hudDisabled() {
    const root = document.documentElement;
    const body = document.body;
    return root?.dataset?.purseHud === 'off' || body?.dataset?.purseHud === 'off';
  }

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

  function syncHudMetrics() {
    const hud = document.getElementById('purseHud');
    if (!hud) return;
    const rect = hud.getBoundingClientRect();
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const rightInset = parseFloat(styles.getPropertyValue('--purse-hud-right')) || 10;
    const gap = parseFloat(styles.getPropertyValue('--purse-hud-gap')) || 10;
    root.style.setProperty('--purse-hud-width', `${Math.ceil(rect.width)}px`);
    root.style.setProperty('--purse-hud-height', `${Math.ceil(rect.height)}px`);
    root.style.setProperty('--purse-hud-clearance-right', `${Math.ceil(rect.width + rightInset + gap)}px`);
  }

  function flashDelta(delta) {
    const hud = document.getElementById('purseHud');
    const deltaEl = document.getElementById('purseHudDelta');
    if (!hud || !deltaEl || !delta) return;
    deltaEl.textContent = delta > 0 ? `+${fmt.format(delta)}` : `−${fmt.format(Math.abs(delta))}`;
    deltaEl.classList.toggle('is-up', delta > 0);
    deltaEl.classList.toggle('is-down', delta < 0);
    hud.classList.remove('show-delta');
    void hud.offsetWidth;
    hud.classList.add('show-delta');
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(() => hud.classList.remove('show-delta'), 920);
  }

  function pulseHud() {
    const hud = document.getElementById('purseHud');
    if (!hud) return;
    hud.classList.remove('pulse');
    void hud.offsetWidth;
    hud.classList.add('pulse');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => hud.classList.remove('pulse'), 440);
  }

  function updateDisplay() {
    const v = readRaw() == null ? DEFAULT : read();
    const el = document.getElementById('purseHudValue');
    const hud = document.getElementById('purseHud');
    if (el) el.textContent = fmt.format(v);
    if (hud) {
      hud.classList.toggle('empty', v <= 0);
      hud.classList.toggle('low', v > 0 && v < DEFAULT * 0.25);
      if (lastDisplayed != null && lastDisplayed !== v) {
        flashDelta(v - lastDisplayed);
        pulseHud();
      }
      syncHudMetrics();
    }
    lastDisplayed = v;
  }

  function mountHud() {
    if (hudDisabled()) return;
    if (document.getElementById('purseHud')) {
      document.body.classList.add('has-purse-hud');
      updateDisplay();
      syncHudMetrics();
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'purse-hud';
    wrap.id = 'purseHud';
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML = [
      '<span class="purse-hud-chip" aria-hidden="true"></span>',
      '<span class="purse-hud-body">',
      '<span class="purse-hud-label">Purse</span>',
      '<span class="purse-hud-value" id="purseHudValue"></span>',
      '<span class="purse-hud-delta" id="purseHudDelta" aria-hidden="true"></span>',
      '</span>'
    ].join('');
    document.body.appendChild(wrap);
    document.body.classList.add('has-purse-hud');
    updateDisplay();
    syncHudMetrics();
    if ('ResizeObserver' in global) {
      resizeObserver = new ResizeObserver(syncHudMetrics);
      resizeObserver.observe(wrap);
    } else {
      global.addEventListener('resize', syncHudMetrics);
    }
  }

  function getInsets() {
    const root = getComputedStyle(document.documentElement);
    const top = parseFloat(root.getPropertyValue('--purse-hud-top')) || 8;
    const right = parseFloat(root.getPropertyValue('--purse-hud-clearance-right')) || 104;
    const height = parseFloat(root.getPropertyValue('--purse-hud-height')) || 52;
    return { top, right, bottom: top + height, height, width: parseFloat(root.getPropertyValue('--purse-hud-width')) || 104 };
  }

  function canvasInset(canvas) {
    const insets = getInsets();
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect || !rect.width) {
      return {
        top: insets.top,
        right: insets.right,
        bottom: insets.bottom
      };
    }
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      top: insets.top * sy,
      right: insets.right * sx,
      bottom: insets.bottom * sy
    };
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
    getInsets,
    canvasInset,
    subscribe
  };
})(window);
