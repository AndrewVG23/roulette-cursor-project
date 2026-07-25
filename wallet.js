(function (global) {
  'use strict';

  // ------------------------------------------------------------------ economy
  // Three wallets:
  //   digital — phone balance. All pay lands here. Can go NEGATIVE (debt).
  //   cash    — physical paper dollars. Floor of $0. Liquor + casino money.
  //   gold    — ounces. Bought at 5% over spot, sold at 5% under, for cash.
  // One shared price index drives gas price, gold spot, and every inflated
  // price. Each gas-station visit compounds the index by 4%, advances the
  // calendar one month from a January 2022 start, and applies debt interest.
  const STATE_KEY = 'walletV3';
  const LEGACY_PURSE_KEY = 'casinoPurse';
  const LEGACY_STATE_KEYS = ['walletV2'];
  const GRILL_TIPS_KEY = 'grillTipsPending';
  const DEFAULT_CASH = 100;
  const DEFAULT_DIGITAL = -10000; // start in the hole on the phone
  const DEFAULT = DEFAULT_CASH;   // legacy alias

  const GAS_BASE = 2.00;      // $/gal at index 1.0
  const GAS_TANK_GAL = 20;    // night-drive tank size
  const GAS_EMPTY_SEC = 45;   // full tank lasts this long at cruise
  const GAS_CASH_DISCOUNT = 0.10; // 10% off pump price when paying cash
  const GOLD_BASE = 2000;     // $/oz at index 1.0 — roughly real spot
  const GOLD_FEE = 0.05;      // cash buy 5% over spot, sell 5% under
  const GOLD_CREDIT_FEE = 0.10; // credit ask is 10% over the cash ask
  const VISIT_RATE_BASE = 0.04;  // +4% inflation per gas visit
  const VISIT_RATE_STEP = 0;
  const VISIT_RATE_CAP = 0.04;
  const CREDIT_INTEREST_RATE = 0.06; // credit balance compounds +6% every gas visit
  const GAME_START_YEAR = 2022;
  const GAME_START_MONTH = 0; // January

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

  // Paper cash → phone credit. Used at the bank teller window to chip away
  // at debt (or park surplus on the phone). 1:1, no fee.
  function payCashTowardCredit(amount) {
    const n = Math.round(amount);
    if (n <= 0) return { ok: false, paid: 0, reason: 'Bad amount' };
    if (state.cash < n) return { ok: false, paid: 0, reason: 'Not enough cash' };
    state.cash = Math.max(0, state.cash - n);
    state.digital = Math.round(state.digital + n);
    persist();
    return { ok: true, paid: n, digital: state.digital, cash: state.cash };
  }

  // ------------------------------------------------------------------ gold
  function gold() { return state.gold; }
  function setGold(oz) { state.gold = Math.max(0, Math.round(oz * 100) / 100); persist(); return state.gold; }
  function goldSpot() { return GOLD_BASE * state.index; }
  function netWorth() {
    return Math.round(state.digital + state.cash + state.gold * goldSpot());
  }
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
  function gasFillGallons() { return GAS_TANK_GAL; }
  function gasFillCost(method) {
    const pump = gasPrice() * GAS_TANK_GAL;
    if (method === 'cash') return Math.ceil(pump * (1 - GAS_CASH_DISCOUNT));
    return Math.ceil(pump);
  }
  function buyGasFill(method) {
    const cost = gasFillCost(method);
    if (method === 'cash') {
      if (!spendCash(cost)) return { ok: false, cost, reason: 'Not enough cash' };
    } else {
      takeDigital(cost);
    }
    return { ok: true, cost, gallons: GAS_TANK_GAL };
  }
  function priceMult() { return state.index; }             // general inflated prices
  function tipMult() { return state.index; }               // tips ride full inflation
  function wageMult() { return 1 + (state.index - 1) / 2; } // wages lag at half inflation
  function goldScaled(base) {
    return Math.max(1, Math.round(Number(base) * state.index));
  }
  function debtCostMult() { return state.index; }
  function debtScaled(base) { return goldScaled(base); }
  // Menu prices that compound at the credit-debt rate (6% per gas visit).
  function debtPriceMult() {
    return Math.round(Math.pow(1 + CREDIT_INTEREST_RATE, state.visits) * 10000) / 10000;
  }
  function debtPriceScaled(base) {
    return Math.max(1, Math.round(Number(base) * debtPriceMult()));
  }
  function visits() { return state.visits; }

  function gameDate() {
    const totalMonths = GAME_START_MONTH + state.visits;
    return {
      year: GAME_START_YEAR + Math.floor(totalMonths / 12),
      month: totalMonths % 12
    };
  }

  function formatGameDate() {
    const { year, month } = gameDate();
    return `${MONTH_NAMES[month]} ${year}`;
  }

  function nextVisitRate() {
    return Math.min(VISIT_RATE_BASE + VISIT_RATE_STEP * (state.visits + 1), VISIT_RATE_CAP);
  }

  function recordGasVisit() {
    state.visits += 1;
    const rate = Math.min(VISIT_RATE_BASE + VISIT_RATE_STEP * state.visits, VISIT_RATE_CAP);
    state.index = Math.round(state.index * (1 + rate) * 10000) / 10000;
    const creditBefore = state.digital;
    let creditAfter = creditBefore;
    let creditInterestPct = 0;
    if (creditBefore < 0) {
      creditAfter = Math.round(creditBefore * (1 + CREDIT_INTEREST_RATE));
      state.digital = creditAfter;
      creditInterestPct = CREDIT_INTEREST_RATE * 100;
    }
    persist();
    return {
      visits: state.visits,
      ratePct: rate * 100,
      index: state.index,
      gasPrice: gasPrice(),
      goldSpot: goldSpot(),
      creditBefore,
      creditAfter,
      creditInterestPct,
      creditInterestApplied: creditBefore < 0
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

  function reincarnate() {
    state.digital = DEFAULT_DIGITAL;
    state.cash = 0;
    state.gold = 0;
    persist();
    return getState();
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
    const cluster = document.getElementById('purseHudCluster');
    const hud = document.getElementById('purseHud');
    const el = cluster || hud;
    if (!el) return;
    const rect = el.getBoundingClientRect();
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
    const nwEl = document.getElementById('purseHudNetWorth');
    const calEl = document.getElementById('gameCalendarDate');
    if (calEl) calEl.textContent = formatGameDate();
    if (dEl) dEl.textContent = fmt.format(state.digital);
    if (cEl) cEl.textContent = fmt.format(state.cash);
    if (gEl) gEl.textContent = formatGold(state.gold);
    const nw = netWorth();
    if (nwEl) nwEl.textContent = fmt.format(nw);
    if (hud) {
      hud.classList.toggle('debt', state.digital < 0);
      hud.classList.toggle('negative-net', nw < 0);
      hud.classList.toggle('empty', state.digital + state.cash <= 0 && state.gold <= 0);
      hud.classList.toggle('low', nw > 0 && nw < DEFAULT * 0.25);
      if (lastShown) {
        const prevNw = Math.round(
          lastShown.digital + lastShown.cash + lastShown.gold * GOLD_BASE * lastShown.index
        );
        const nwDelta = nw - prevNw;
        if (nwDelta !== 0) {
          flashDelta(nwDelta > 0 ? `+${fmt.format(nwDelta)}` : `−${fmt.format(Math.abs(nwDelta))}`, nwDelta > 0);
          pulseHud();
        }
      }
      syncHudMetrics();
    }
    updatePanel();
    lastShown = { digital: state.digital, cash: state.cash, gold: state.gold, index: state.index };
  }

  // -------------------------------------------------------- exchange panel
  const BUY_SIZES = [0.1, 0.25, 1];

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
  }

  function togglePanel(force) {
    const panel = panelEl();
    if (!panel) return;
    panel.hidden = force != null ? !force : !panel.hidden;
    updatePanel();
  }

  const CALENDAR_ICON = [
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">',
    '<rect x="3" y="4.5" width="18" height="16.5" rx="2" stroke="currentColor" stroke-width="1.5"/>',
    '<path d="M3 9.5h18" stroke="currentColor" stroke-width="1.5"/>',
    '<path d="M8 2.5v3M16 2.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    '</svg>'
  ].join('');

  function buildCalendar() {
    const cal = document.createElement('div');
    cal.className = 'game-calendar';
    cal.id = 'gameCalendar';
    cal.setAttribute('aria-label', 'Game calendar');
    cal.innerHTML = [
      `<span class="game-calendar-icon" aria-hidden="true">${CALENDAR_ICON}</span>`,
      '<span class="game-calendar-date" id="gameCalendarDate"></span>'
    ].join('');
    return cal;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'purse-hud-panel';
    panel.id = 'purseHudPanel';
    panel.hidden = true;
    const rows = [];
    rows.push('<div class="purse-hud-panel-econ" data-role="econ"></div>');
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
      btn.blur();
      updatePanel();
    });
    return panel;
  }

  function ensureCalendar() {
    if (document.getElementById('gameCalendar')) return;
    const hud = document.getElementById('purseHud');
    if (!hud) return;
    let cluster = document.getElementById('purseHudCluster');
    if (!cluster) {
      cluster = document.createElement('div');
      cluster.className = 'purse-hud-cluster';
      cluster.id = 'purseHudCluster';
      hud.parentNode.insertBefore(cluster, hud);
      cluster.appendChild(hud);
    }
    cluster.insertBefore(buildCalendar(), hud);
  }

  function mountHud() {
    if (hudDisabled()) return;
    if (document.getElementById('purseHud')) {
      document.body.classList.add('has-purse-hud');
      if (!document.getElementById('purseHudNetWorth')) {
        const hud = document.getElementById('purseHud');
        const row = document.createElement('span');
        row.className = 'purse-hud-networth';
        row.innerHTML =
          '<span class="purse-hud-networth-label">Net worth</span>' +
          '<span class="purse-hud-value purse-hud-networth-value" id="purseHudNetWorth"></span>';
        const delta = document.getElementById('purseHudDelta');
        hud.insertBefore(row, delta);
      }
      ensureCalendar();
      updateDisplay();
      syncHudMetrics();
      return;
    }
    const cluster = document.createElement('div');
    cluster.className = 'purse-hud-cluster';
    cluster.id = 'purseHudCluster';
    const wrap = document.createElement('div');
    wrap.className = 'purse-hud';
    wrap.id = 'purseHud';
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML = [
      '<span class="purse-hud-slots">',
      '<span class="purse-hud-slot purse-hud-slot--credit">',
      '<span class="purse-hud-icon purse-hud-icon--credit" aria-hidden="true">',
      '<svg viewBox="0 0 48 32" width="34" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">',
      '<rect x="1" y="1" width="46" height="30" rx="4" fill="#1a2848" stroke="#6eb5ff" stroke-width="1.5"/>',
      '<rect x="1" y="8" width="46" height="7" fill="#243868"/>',
      '<rect x="6" y="20" width="16" height="3" rx="1" fill="#c9d8f0" opacity="0.85"/>',
      '<rect x="6" y="25" width="10" height="2" rx="1" fill="#8faee0" opacity="0.55"/>',
      '</svg>',
      '</span>',
      '<span class="purse-hud-value purse-hud-digital" id="purseHudDigital"></span>',
      '</span>',
      '<span class="purse-hud-slot purse-hud-slot--cash">',
      '<span class="purse-hud-icon purse-hud-icon--cash" aria-hidden="true">',
      '<img src="assets/hundred-dollar.jpg" alt="" width="38" height="16" draggable="false">',
      '</span>',
      '<span class="purse-hud-value purse-hud-cash" id="purseHudCash"></span>',
      '</span>',
      '<span class="purse-hud-slot purse-hud-slot--gold">',
      '<span class="purse-hud-icon purse-hud-icon--gold" aria-hidden="true">',
      '<img src="assets/krugerrand-reverse.png" alt="" width="24" height="24" draggable="false">',
      '</span>',
      '<span class="purse-hud-value purse-hud-gold" id="purseHudGold"></span>',
      '</span>',
      '</span>',
      '<span class="purse-hud-networth">',
      '<span class="purse-hud-networth-label">Net worth</span>',
      '<span class="purse-hud-value purse-hud-networth-value" id="purseHudNetWorth"></span>',
      '</span>',
      '<span class="purse-hud-title">Purse</span>',
      '<span class="purse-hud-delta" id="purseHudDelta" aria-hidden="true"></span>'
    ].join('');
    wrap.addEventListener('click', () => togglePanel());
    cluster.appendChild(buildCalendar());
    cluster.appendChild(wrap);
    document.body.appendChild(cluster);
    document.body.appendChild(buildPanel());
    document.body.classList.add('has-purse-hud');
    updateDisplay();
    syncHudMetrics();
    if ('ResizeObserver' in global) {
      resizeObserver = new ResizeObserver(syncHudMetrics);
      resizeObserver.observe(cluster);
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
    DEFAULT_DIGITAL,
    format: fmt.format,
    formatGas: gasFmt.format,
    formatGold,
    // phone / digital (legacy aliases included)
    read, set: write, add, take,
    digital, setDigital, addDigital, takeDigital,
    // paper cash
    cash, setCash, addCash, takeCash, spendCash, payCashTowardCredit,
    // gold
    gold, goldSpot, goldBuyCost, goldCreditCost, goldSellValue, buyGold, sellGold, netWorth,
    // economy
    index, gasPrice, gasFillGallons, gasFillCost, buyGasFill,
    priceMult, tipMult, wageMult, goldScaled, debtCostMult, debtScaled, debtPriceMult, debtPriceScaled,
    visits, nextVisitRate, recordGasVisit, CREDIT_INTEREST_RATE,
    gameDate, formatGameDate, GAME_START_YEAR,
    GAS_TANK_GAL, GAS_EMPTY_SEC, GAS_CASH_DISCOUNT,
    // plumbing
    snapshot, restore, getState, reincarnate,
    migrateTips, mountHud, updateDisplay, togglePanel,
    getInsets, canvasInset, subscribe
  };
})(window);
