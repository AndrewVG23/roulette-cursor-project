(function (global) {
  'use strict';

  // ------------------------------------------------------------------ economy
  // Three wallets:
  //   digital — phone balance. All pay lands here. Can go NEGATIVE (debt).
  //   cash    — physical paper dollars. Floor of $0. Liquor + casino money.
  //   gold    — ounces. Bought at 5% over spot, sold at 5% under, for cash.
  // One shared price index drives gas price, gold spot, and every inflated
  // price. Each gas-station visit compounds the index at a rate that rises
  // one point per visit.
  const STATE_KEY = 'walletV3';
  const LEGACY_PURSE_KEY = 'casinoPurse';
  const LEGACY_STATE_KEYS = ['walletV2'];
  const GRILL_TIPS_KEY = 'grillTipsPending';
  const DEFAULT_CASH = 100;
  const DEFAULT_DIGITAL = -10000; // start in the hole on the phone
  const DEFAULT = DEFAULT_CASH;   // legacy alias

  const GAS_BASE = 3.89;      // $/gal at index 1.0
  const GOLD_BASE = 2000;     // $/oz at index 1.0 — roughly real spot
  const GOLD_FEE = 0.05;      // cash buy 5% over spot, sell 5% under
  const GOLD_CREDIT_FEE = 0.10; // credit ask is 10% over the cash ask
  const CASH_OUT_FEE = 0.10;  // phone → cash at casino/liquor: 10% haircut
  const VISIT_RATE_BASE = 0.02;  // first visit: +3% (base + step)
  const VISIT_RATE_STEP = 0.01;  // each visit inflates harder than the last
  const VISIT_RATE_CAP = 0.25;
  const CASH_OUT_AMOUNTS = [20, 50, 100];

  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  });
  const gasFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const listeners = new Set();
  let lastShown = null;
  let pulseTimer = null;
  let deltaTimer = null;
  let resizeObserver = null;

  function loadState() {
    try {
      const raw = global.localStorage.getItem(STATE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return {
          digital: Math.round(Number(s.digital) || 0),
          cash: Math.max(0, Math.round(Number(s.cash) || 0)),
          gold: Math.max(0, Math.round((Number(s.gold) || 0) * 100) / 100),
          index: Math.max(1, Number(s.index) || 1),
          visits: Math.max(0, Math.round(Number(s.visits) || 0))
        };
      }
    } catch (_) { /* fall through to migration */ }

    // Pull cash forward from older wallet versions / legacy purse; reset
    // phone debt and gold spot baseline for the new economy.
    let cash = DEFAULT_CASH;
    for (const key of LEGACY_STATE_KEYS) {
      try {
        const raw = global.localStorage.getItem(key);
        if (!raw) continue;
        const s = JSON.parse(raw);
        if (s && Number.isFinite(Number(s.cash))) {
          cash = Math.max(0, Math.round(Number(s.cash)));
          break;
        }
      } catch (_) { /* ignore */ }
    }
    if (cash === DEFAULT_CASH) {
      const legacy = Number(global.localStorage.getItem(LEGACY_PURSE_KEY));
      if (Number.isFinite(legacy) && legacy >= 0) cash = Math.round(legacy);
    }
    return { digital: DEFAULT_DIGITAL, cash, gold: 0, index: 1, visits: 0 };
  }

  let state = loadState();

  function persist() {
    global.localStorage.setItem(STATE_KEY, JSON.stringify(state));
    // Keep the legacy key mirrored so old saves/tools don't explode.
    global.localStorage.setItem(LEGACY_PURSE_KEY, String(Math.max(0, state.cash)));
    updateDisplay();
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (_) { /* ignore listener errors */ }
    });
  }

  function getState() {
    return {
      digital: state.digital,
      cash: state.cash,
      gold: state.gold,
      index: state.index,
      visits: state.visits
    };
  }

  // ------------------------------------------------------------------ digital
  // (phone — pay lands here; balance may go negative = debt)
  function digital() { return state.digital; }
  function setDigital(n) { state.digital = Math.round(n); persist(); return state.digital; }
  function addDigital(n) { return setDigital(state.digital + n); }
  function takeDigital(n) { return setDigital(state.digital - n); }

  // ------------------------------------------------------------------ cash
  function cash() { return state.cash; }
  function setCash(n) { state.cash = Math.max(0, Math.round(n)); persist(); return state.cash; }
  function addCash(n) { return setCash(state.cash + n); }
  function takeCash(n) { return setCash(state.cash - n); }
  function spendCash(n) {
    const cost = Math.round(n);
    if (state.cash < cost) return false;
    setCash(state.cash - cost);
    return true;
  }

  // Phone → paper cash. Casino cage / liquor counter only (UI-gated).
  // Requires a positive phone balance — debt can't be cashed out.
  function cashOutPayout(amount) {
    return Math.floor(Math.max(0, Math.round(amount)) * (1 - CASH_OUT_FEE));
  }
  function cashOut(amount) {
    if (state.digital <= 0) {
      return { ok: false, reason: 'Need a positive phone balance' };
    }
    const n = Math.round(amount);
    if (n <= 0) return { ok: false, reason: 'Bad amount' };
    if (state.digital < n) return { ok: false, reason: 'Not enough on phone' };
    const payout = cashOutPayout(n);
    takeDigital(n);
    addCash(payout);
    return { ok: true, taken: n, cash: payout, fee: n - payout };
  }
  function cashOutAll() {
    if (state.digital <= 0) {
      return { ok: false, reason: 'Need a positive phone balance' };
    }
    return cashOut(state.digital);
  }

  // ------------------------------------------------------------------ gold
  function gold() { return state.gold; }
  function setGold(oz) { state.gold = Math.max(0, Math.round(oz * 100) / 100); persist(); return state.gold; }
  function goldSpot() { return GOLD_BASE * state.index; }
  function goldBuyCost(oz) { return Math.ceil(goldSpot() * (1 + GOLD_FEE) * oz); }
  function goldCreditCost(oz) { return Math.ceil(goldBuyCost(oz) * (1 + GOLD_CREDIT_FEE)); }
  function goldSellValue(oz) { return Math.floor(goldSpot() * (1 - GOLD_FEE) * oz); }

  function buyGold(oz, method) {
    const onCredit = method === 'credit' || method === 'phone';
    const cost = onCredit ? goldCreditCost(oz) : goldBuyCost(oz);
    if (method === 'cash') {
      if (!spendCash(cost)) return { ok: false, cost, reason: 'Not enough cash' };
    } else {
      takeDigital(cost); // credit / phone can run negative — that's the debt
    }
    setGold(state.gold + oz);
    return { ok: true, cost };
  }

  function sellGold(oz) {
    if (state.gold + 1e-9 < oz) return { ok: false, value: 0, reason: 'Not enough gold' };
    const value = goldSellValue(oz);
    setGold(state.gold - oz);
    addCash(value);
    return { ok: true, value };
  }

  // ------------------------------------------------------------------ prices
  function index() { return state.index; }
  function gasPrice() { return GAS_BASE * state.index; }
  function priceMult() { return state.index; }             // general inflated prices
  function tipMult() { return state.index; }               // tips ride full inflation
  function wageMult() { return 1 + (state.index - 1) / 2; } // wages lag at half inflation
  function visits() { return state.visits; }
  function nextVisitRate() {
    return Math.min(VISIT_RATE_BASE + VISIT_RATE_STEP * (state.visits + 1), VISIT_RATE_CAP);
  }

  function recordGasVisit() {
    state.visits += 1;
    const rate = Math.min(VISIT_RATE_BASE + VISIT_RATE_STEP * state.visits, VISIT_RATE_CAP);
    state.index = Math.round(state.index * (1 + rate) * 10000) / 10000;
    persist();
    return {
      visits: state.visits,
      ratePct: rate * 100,
      index: state.index,
      gasPrice: gasPrice(),
      goldSpot: goldSpot()
    };
  }

  // ---------------------------------------------------------- legacy aliases
  // Old single-purse API now points at the phone: pay arrives digitally and
  // bills hit the phone (which is what lets debt happen).
  function read() { return state.digital; }
  function write(n) { return setDigital(n); }
  function add(n) { return addDigital(n); }
  function take(n) { return takeDigital(n); }

  function snapshot() {
    return { d: state.digital, c: state.cash, g: state.gold };
  }
  function restore(snap) {
    if (snap == null) return;
    if (typeof snap === 'number') { setDigital(snap); return; }
    state.digital = Math.round(Number(snap.d) || 0);
    state.cash = Math.max(0, Math.round(Number(snap.c) || 0));
    state.gold = Math.max(0, Math.round((Number(snap.g) || 0) * 100) / 100);
    persist();
  }

  function migrateTips() {
    const tips = Math.max(0, Math.round(Number(global.localStorage.getItem(GRILL_TIPS_KEY) || 0)));
    if (tips > 0) {
      global.localStorage.setItem(GRILL_TIPS_KEY, '0');
      addDigital(tips);
    }
    return tips;
  }

  function formatGold(oz) {
    return `${(Math.round(oz * 100) / 100).toFixed(2)} oz`;
  }

  // ------------------------------------------------------------------ HUD
  function hudDisabled() {
    const root = document.documentElement;
    const body = document.body;
    return root?.dataset?.purseHud === 'off' || body?.dataset?.purseHud === 'off';
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

  function flashDelta(text, up) {
    const hud = document.getElementById('purseHud');
    const deltaEl = document.getElementById('purseHudDelta');
    if (!hud || !deltaEl || !text) return;
    deltaEl.textContent = text;
    deltaEl.classList.toggle('is-up', !!up);
    deltaEl.classList.toggle('is-down', !up);
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
    const hud = document.getElementById('purseHud');
    const dEl = document.getElementById('purseHudDigital');
    const cEl = document.getElementById('purseHudCash');
    const gEl = document.getElementById('purseHudGold');
    if (dEl) dEl.textContent = fmt.format(state.digital);
    if (cEl) cEl.textContent = fmt.format(state.cash);
    if (gEl) gEl.textContent = formatGold(state.gold);
    if (hud) {
      hud.classList.toggle('debt', state.digital < 0);
      hud.classList.toggle('empty', state.digital + state.cash <= 0);
      hud.classList.toggle('low', state.digital + state.cash > 0 && state.digital + state.cash < DEFAULT * 0.25);
      if (lastShown) {
        const moneyDelta = (state.digital - lastShown.digital) + (state.cash - lastShown.cash);
        const goldDelta = state.gold - lastShown.gold;
        if (moneyDelta !== 0) {
          flashDelta(moneyDelta > 0 ? `+${fmt.format(moneyDelta)}` : `−${fmt.format(Math.abs(moneyDelta))}`, moneyDelta > 0);
          pulseHud();
        } else if (Math.abs(goldDelta) >= 0.005) {
          flashDelta(goldDelta > 0 ? `+${formatGold(goldDelta)}` : `−${formatGold(Math.abs(goldDelta))}`, goldDelta > 0);
          pulseHud();
        }
      }
      syncHudMetrics();
    }
    updatePanel();
    lastShown = { digital: state.digital, cash: state.cash, gold: state.gold };
  }

  // -------------------------------------------------------- exchange panel
  const BUY_SIZES = [0.1, 0.25, 1];

  function cashDeskAllowed() {
    const root = document.documentElement;
    const body = document.body;
    return root?.dataset?.cashDesk === 'on' || body?.dataset?.cashDesk === 'on';
  }

  function panelEl() { return document.getElementById('purseHudPanel'); }

  function updatePanel() {
    const panel = panelEl();
    if (!panel || panel.hidden) return;
    const spot = goldSpot();
    const econ = panel.querySelector('[data-role="econ"]');
    if (econ) {
      econ.innerHTML =
        `GAS <b>${gasFmt.format(gasPrice())}</b>/gal · PRICES ×${state.index.toFixed(2)} · SPOT <b>${fmt.format(Math.round(spot))}</b>/oz`;
    }
    panel.querySelectorAll('[data-buy]').forEach((btn) => {
      const oz = Number(btn.dataset.buy);
      const onCredit = btn.dataset.method === 'credit' || btn.dataset.method === 'phone';
      const cost = onCredit ? goldCreditCost(oz) : goldBuyCost(oz);
      btn.querySelector('[data-role="price"]').textContent = fmt.format(cost);
      if (btn.dataset.method === 'cash') btn.disabled = state.cash < cost;
    });
    panel.querySelectorAll('[data-sell]').forEach((btn) => {
      const oz = Number(btn.dataset.sell);
      btn.querySelector('[data-role="price"]').textContent = fmt.format(goldSellValue(oz));
      btn.disabled = state.gold + 1e-9 < oz;
    });
    const canCashOut = state.digital > 0;
    panel.querySelectorAll('[data-cashout]').forEach((btn) => {
      const all = btn.dataset.cashout === 'all';
      const amt = all ? state.digital : Number(btn.dataset.cashout);
      const payout = cashOutPayout(Math.max(0, amt));
      const priceEl = btn.querySelector('[data-role="price"]');
      if (priceEl) {
        priceEl.textContent = all
          ? (canCashOut ? `→ ${fmt.format(payout)}` : '—')
          : `→ ${fmt.format(cashOutPayout(Number(btn.dataset.cashout)))}`;
      }
      btn.disabled = !canCashOut || (!all && state.digital < Number(btn.dataset.cashout));
    });
    const cashNote = panel.querySelector('[data-role="cashdesk-note"]');
    if (cashNote) {
      cashNote.textContent = canCashOut
        ? 'Cage takes 10%. Positive phone balance only — debt stays on the phone.'
        : 'Cash desk closed — phone needs a positive balance (debt can\'t walk out as paper).';
    }
  }

  function togglePanel(force) {
    const panel = panelEl();
    if (!panel) return;
    panel.hidden = force != null ? !force : !panel.hidden;
    updatePanel();
  }

  function buildCashDeskRows() {
    if (!cashDeskAllowed()) return [];
    const rows = ['<div class="purse-hud-panel-section">Cash desk</div>'];
    rows.push(
      '<div class="purse-hud-panel-row purse-hud-panel-row--wrap">' +
      CASH_OUT_AMOUNTS.map((n) =>
        `<button type="button" data-cashout="${n}">${fmt.format(n)} <span data-role="price"></span></button>`
      ).join('') +
      '<button type="button" data-cashout="all">All <span data-role="price"></span></button>' +
      '</div>'
    );
    rows.push('<div class="purse-hud-panel-note" data-role="cashdesk-note"></div>');
    return rows;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'purse-hud-panel';
    panel.id = 'purseHudPanel';
    panel.hidden = true;
    const rows = [];
    rows.push('<div class="purse-hud-panel-econ" data-role="econ"></div>');
    rows.push(...buildCashDeskRows());
    rows.push('<div class="purse-hud-panel-section">Gold</div>');
    for (const oz of BUY_SIZES) {
      rows.push(
        `<div class="purse-hud-panel-row"><span class="purse-hud-panel-lbl">Buy ${oz} oz</span>` +
        `<button type="button" data-buy="${oz}" data-method="cash"><span data-role="price"></span> cash</button>` +
        `<button type="button" data-buy="${oz}" data-method="credit"><span data-role="price"></span> credit</button></div>`
      );
    }
    for (const oz of BUY_SIZES) {
      rows.push(
        `<div class="purse-hud-panel-row"><span class="purse-hud-panel-lbl">Sell ${oz} oz</span>` +
        `<button type="button" data-sell="${oz}"><span data-role="price"></span> → cash</button></div>`
      );
    }
    rows.push('<div class="purse-hud-panel-note">Cash ask is +5% over spot. Credit is +10% over the cash ask and can go into debt.</div>');
    panel.innerHTML = rows.join('');
    panel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      ev.stopPropagation();
      if (btn.dataset.buy) buyGold(Number(btn.dataset.buy), btn.dataset.method);
      else if (btn.dataset.sell) sellGold(Number(btn.dataset.sell));
      else if (btn.dataset.cashout != null) {
        if (!cashDeskAllowed()) return;
        if (btn.dataset.cashout === 'all') cashOutAll();
        else cashOut(Number(btn.dataset.cashout));
      }
      btn.blur();
      updatePanel();
    });
    return panel;
  }

  // Casino floor keeps the full HUD off — mount a slim cash-desk trigger instead.
  function mountCashDeskButton() {
    if (!cashDeskAllowed() || document.getElementById('purseCashDeskBtn')) return;
    if (!panelEl()) document.body.appendChild(buildPanel());
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'purseCashDeskBtn';
    btn.className = 'purse-cash-desk-btn';
    btn.textContent = 'Cash desk';
    btn.title = 'Turn phone money into paper — 10% fee, positive balance only';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePanel();
    });
    document.body.appendChild(btn);
    document.body.classList.add('has-cash-desk');
  }

  function mountHud() {
    if (hudDisabled()) {
      mountCashDeskButton();
      return;
    }
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
      '<span class="purse-hud-row"><span class="purse-hud-label">Phone</span><span class="purse-hud-value purse-hud-digital" id="purseHudDigital"></span></span>',
      '<span class="purse-hud-row"><span class="purse-hud-label">Cash</span><span class="purse-hud-value purse-hud-cash" id="purseHudCash"></span></span>',
      '<span class="purse-hud-row"><span class="purse-hud-label">Gold</span><span class="purse-hud-value purse-hud-gold" id="purseHudGold"></span></span>',
      '<span class="purse-hud-delta" id="purseHudDelta" aria-hidden="true"></span>',
      '</span>'
    ].join('');
    wrap.addEventListener('click', () => togglePanel());
    document.body.appendChild(wrap);
    document.body.appendChild(buildPanel());
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
    const right = parseFloat(root.getPropertyValue('--purse-hud-clearance-right')) || 148;
    const height = parseFloat(root.getPropertyValue('--purse-hud-height')) || 78;
    return { top, right, bottom: top + height, height, width: parseFloat(root.getPropertyValue('--purse-hud-width')) || 148 };
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
  persist();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountHud);
  } else {
    mountHud();
  }

  global.Wallet = {
    PURSE_KEY: LEGACY_PURSE_KEY,
    GRILL_TIPS_KEY,
    DEFAULT,
    format: fmt.format,
    formatGas: gasFmt.format,
    formatGold,
    // phone / digital (legacy aliases included)
    read, set: write, add, take,
    digital, setDigital, addDigital, takeDigital,
    // paper cash
    cash, setCash, addCash, takeCash, spendCash,
    cashOut, cashOutAll, cashOutPayout, cashDeskAllowed,
    // gold
    gold, goldSpot, goldBuyCost, goldCreditCost, goldSellValue, buyGold, sellGold,
    // economy
    index, gasPrice, priceMult, tipMult, wageMult,
    visits, nextVisitRate, recordGasVisit,
    // plumbing
    snapshot, restore, getState,
    migrateTips, mountHud, updateDisplay, togglePanel,
    getInsets, canvasInset, subscribe
  };
})(window);
