(function (global) {
  'use strict';

  // ------------------------------------------------------------------ economy
  // Three wallets:
  //   digital — phone balance. All pay lands here. Can go NEGATIVE (debt).
  //   cash    — physical paper dollars. Floor of $0. Liquor + casino money.
  //   gold    — ounces. Bought at 5% over spot, sold at 5% under, for cash.
  // One shared price index drives gas price, gold spot, and every inflated
  // price. Inflation (+4%) and credit interest (+6%) are quoted per 10-week
  // period and compound as (1+rate)^(weeks/10). The price index is DERIVED
  // from elapsed calendar weeks so gold/gas always match the date (beer runs
  // can't leave spot stuck while the year races ahead). Credit interest still
  // applies to the phone balance when weeks advance. Gas visits jump one
  // full 10-week period; liquor beers advance one week.
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
  const RATE_PERIOD_WEEKS = 10;
  const INFLATION_PERIOD_RATE = 0.04; // +4% per 10 weeks (price index)
  const CREDIT_PERIOD_RATE = 0.06;    // +6% per 10 weeks (debt + debt menus)
  const CREDIT_INTEREST_RATE = CREDIT_PERIOD_RATE; // exported alias
  // Legacy export names — these are period rates, not annual APRs.
  const INFLATION_APR = INFLATION_PERIOD_RATE;
  const CREDIT_APR = CREDIT_PERIOD_RATE;
  const WEEKS_PER_YEAR = 52; // calendar only
  const VISIT_WEEKS_ADVANCE = RATE_PERIOD_WEEKS;
  const VISIT_RATE_BASE = INFLATION_PERIOD_RATE;
  const VISIT_RATE_STEP = 0;
  const VISIT_RATE_CAP = VISIT_RATE_BASE;
  const GAME_START_YEAR = 2022;
  const GAME_START_MONTH = 0; // January
  const GAME_START_DAY = 1;
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const GAME_START_MS = Date.UTC(GAME_START_YEAR, GAME_START_MONTH, GAME_START_DAY);

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
  let boardPlayer = null;
  let scorePostTimer = null;
  let scorePostChain = Promise.resolve();
  let boardOffline = false;

  function clampFuel(gallons) {
    return Math.max(0, Math.min(GAS_TANK_GAL, Number(gallons) || 0));
  }

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
          visits: Math.max(0, Math.round(Number(s.visits) || 0)),
          weeks: Math.max(0, Math.round(Number(s.weeks) || 0)),
          fuel: Math.round(clampFuel(s.fuel ?? GAS_TANK_GAL) * 100) / 100
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
    return { digital: DEFAULT_DIGITAL, cash, gold: 0, index: 1, visits: 0, weeks: 0, fuel: GAS_TANK_GAL };
  }

  let state = loadState();

  function totalWeeks() {
    return state.visits * VISIT_WEEKS_ADVANCE + (state.weeks || 0);
  }

  // Compound a period rate across weeks: (1+rate)^(weeks/10).
  function weekGrowth(periodRate, weeks) {
    const w = Math.max(0, Number(weeks) || 0);
    if (w <= 0) return 1;
    return Math.pow(1 + periodRate, w / RATE_PERIOD_WEEKS);
  }

  function weeklyRate(periodRate) {
    return weekGrowth(periodRate, 1) - 1;
  }

  // Prices always track the calendar — not a separately compounded store.
  function priceIndex() {
    return Math.max(1, Math.round(weekGrowth(INFLATION_PERIOD_RATE, totalWeeks()) * 1e6) / 1e6);
  }

  function syncIndexFromCalendar() {
    state.index = priceIndex();
    return state.index;
  }

  // Heal saves where weeks raced ahead of a stale stored index.
  syncIndexFromCalendar();

  function persist() {
    syncIndexFromCalendar();
    global.localStorage.setItem(STATE_KEY, JSON.stringify(state));
    // Keep the legacy key mirrored so old saves/tools don't explode.
    global.localStorage.setItem(LEGACY_PURSE_KEY, String(Math.max(0, state.cash)));
    updateDisplay();
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (_) { /* ignore listener errors */ }
    });
    scheduleScorePost();
  }

  function getState() {
    return {
      digital: state.digital,
      cash: state.cash,
      gold: state.gold,
      index: priceIndex(),
      visits: state.visits,
      weeks: state.weeks || 0,
      fuel: state.fuel
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
  function goldSpot() { return GOLD_BASE * priceIndex(); }
  function netWorth() {
    return Math.round(state.digital + state.cash + state.gold * goldSpot());
  }
  function goldBuyCost(oz, fee) {
    const f = fee == null ? GOLD_FEE : Number(fee);
    return Math.ceil(goldSpot() * (1 + f) * oz);
  }
  function goldCreditCost(oz, fee) {
    return Math.ceil(goldBuyCost(oz, fee) * (1 + GOLD_CREDIT_FEE));
  }
  function goldSellValue(oz) { return Math.floor(goldSpot() * (1 - GOLD_FEE) * oz); }

  function buyGold(oz, method, opts = {}) {
    const fee = opts.fee;
    const onCredit = method === 'credit' || method === 'phone';
    const cost = onCredit ? goldCreditCost(oz, fee) : goldBuyCost(oz, fee);
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
  function index() { return priceIndex(); }
  function fuel() { return state.fuel; }
  function setFuel(gallons) {
    state.fuel = Math.round(clampFuel(gallons) * 100) / 100;
    persist();
    return state.fuel;
  }
  function addFuel(gallons) {
    return setFuel(state.fuel + (Number(gallons) || 0));
  }
  function gasPrice() { return GAS_BASE * priceIndex(); }
  function gasFillGallons() {
    return Math.max(0, Math.round((GAS_TANK_GAL - state.fuel) * 100) / 100);
  }
  function gasFillCost(method) {
    const gal = gasFillGallons();
    const pump = gasPrice() * gal;
    if (method === 'cash') return Math.ceil(pump * (1 - GAS_CASH_DISCOUNT));
    return Math.ceil(pump);
  }
  function buyGasFill(method) {
    const gallons = gasFillGallons();
    if (gallons <= 0.05) return { ok: false, cost: 0, gallons: 0, reason: 'Tank full' };
    const cost = gasFillCost(method);
    if (method === 'cash') {
      if (!spendCash(cost)) return { ok: false, cost, gallons, reason: 'Not enough cash' };
    } else {
      takeDigital(cost);
    }
    setFuel(GAS_TANK_GAL);
    return { ok: true, cost, gallons };
  }
  function priceMult() { return priceIndex(); }             // general inflated prices
  function tipMult() { return priceIndex(); }               // tips ride full inflation
  function wageMult() { return 1 + (priceIndex() - 1) / 2; } // wages lag at half inflation
  function goldScaled(base) {
    return Math.max(1, Math.round(Number(base) * priceIndex()));
  }
  function debtCostMult() { return priceIndex(); }
  function debtScaled(base) { return goldScaled(base); }
  function visits() { return state.visits; }

  // Menu prices that track the credit period rate over elapsed game weeks.
  function debtPriceMult() {
    return Math.round(weekGrowth(CREDIT_PERIOD_RATE, totalWeeks()) * 1e6) / 1e6;
  }
  function debtPriceScaled(base) {
    return Math.max(1, Math.round(Number(base) * debtPriceMult()));
  }

  function gameDate() {
    const ms = GAME_START_MS + totalWeeks() * MS_PER_WEEK;
    const d = new Date(ms);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      day: d.getUTCDate()
    };
  }

  function formatGameDate() {
    const { year, month, day } = gameDate();
    return `${MONTH_NAMES[month]} ${day}, ${year}`;
  }

  function tickCalendar() {
    const cal = document.getElementById('gameCalendar');
    if (!cal) return;
    cal.classList.remove('is-tick');
    void cal.offsetWidth;
    cal.classList.add('is-tick');
  }

  // Apply credit interest for elapsed weeks. Price index follows the calendar.
  function applyEconomyWeeks(weeks) {
    const steps = Math.max(0, Math.round(Number(weeks) || 0));
    const indexBefore = priceIndex();
    if (!steps) {
      return {
        weeks: 0, indexMult: 1, creditMult: 1,
        creditBefore: state.digital, creditAfter: state.digital, indexBefore, indexAfter: indexBefore
      };
    }
    const creditMult = weekGrowth(CREDIT_PERIOD_RATE, steps);
    const creditBefore = state.digital;
    let creditAfter = creditBefore;
    if (creditBefore < 0) {
      creditAfter = Math.round(creditBefore * creditMult);
      state.digital = creditAfter;
    }
    // Calendar weeks are updated by the caller before/with this; recompute index after.
    const indexAfter = priceIndex();
    return {
      weeks: steps,
      indexMult: indexBefore > 0 ? indexAfter / indexBefore : 1,
      creditMult,
      creditBefore,
      creditAfter,
      indexBefore,
      indexAfter
    };
  }

  // Liquor beers drunk — +N calendar weeks; prices snap to the new date.
  function advanceWeek(n = 1) {
    const steps = Math.max(0, Math.round(Number(n) || 0));
    if (!steps) return { weeks: state.weeks || 0, date: formatGameDate() };
    const indexBefore = priceIndex();
    state.weeks = Math.max(0, (state.weeks || 0) + steps);
    const eco = applyEconomyWeeks(steps);
    persist();
    tickCalendar();
    const indexAfter = priceIndex();
    return {
      weeks: state.weeks,
      date: formatGameDate(),
      gameDate: gameDate(),
      index: indexAfter,
      goldSpot: goldSpot(),
      inflationPct: (indexAfter / indexBefore - 1) * 100,
      creditInterestPct: eco.creditBefore < 0 ? (eco.creditMult - 1) * 100 : 0,
      creditInterestApplied: eco.creditBefore < 0,
      creditBefore: eco.creditBefore,
      creditAfter: eco.creditAfter
    };
  }

  function nextVisitRate() {
    return Math.min(VISIT_RATE_BASE + VISIT_RATE_STEP * (state.visits + 1), VISIT_RATE_CAP);
  }

  function recordGasVisit() {
    const indexBefore = priceIndex();
    state.visits += 1;
    const eco = applyEconomyWeeks(VISIT_WEEKS_ADVANCE);
    persist();
    tickCalendar();
    const indexAfter = priceIndex();
    return {
      visits: state.visits,
      ratePct: (indexAfter / indexBefore - 1) * 100,
      index: indexAfter,
      gasPrice: gasPrice(),
      goldSpot: goldSpot(),
      creditBefore: eco.creditBefore,
      creditAfter: eco.creditAfter,
      creditInterestPct: eco.creditBefore < 0 ? (eco.creditMult - 1) * 100 : 0,
      creditInterestApplied: eco.creditBefore < 0,
      weeksAdvanced: VISIT_WEEKS_ADVANCE
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
    state.fuel = GAS_TANK_GAL;
    persist();
    return getState();
  }

  function resetTimeline() {
    state.visits = 0;
    state.weeks = 0;
    state.index = 1;
    state.digital = DEFAULT_DIGITAL;
    state.cash = 0;
    state.fuel = GAS_TANK_GAL;
    // gold is kept — bullion survives the rewind
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

  function mountLogo() {
    if (document.getElementById('gameLogo')) {
      document.body.classList.add('has-game-logo');
      return;
    }
    const img = document.createElement('img');
    img.className = 'game-logo';
    img.id = 'gameLogo';
    img.src = 'assets/cash-4-copper-logo.png';
    img.alt = 'Cash 4 Copper';
    img.draggable = false;
    img.setAttribute('aria-hidden', 'false');
    document.body.appendChild(img);
    document.body.classList.add('has-game-logo');
  }

  function syncHudMetrics() {
    const cluster = document.getElementById('purseHudCluster');
    const hud = document.getElementById('purseHud');
    if (!hud && !cluster) return;
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const rightInset = parseFloat(styles.getPropertyValue('--purse-hud-right')) || 10;
    const gap = parseFloat(styles.getPropertyValue('--purse-hud-gap')) || 10;

    // Clearance must stay based on the collapsed purse so expand overlays instead of pushing UI.
    const wasExpanded = !!(hud && hud.classList.contains('is-expanded'));
    if (wasExpanded) hud.classList.remove('is-expanded');

    const panelRect = hud ? hud.getBoundingClientRect() : null;
    if (panelRect) {
      root.style.setProperty('--purse-panel-width', `${Math.ceil(panelRect.width)}px`);
      root.style.setProperty('--purse-panel-height', `${Math.ceil(panelRect.height)}px`);
    }

    const el = cluster || hud;
    const rect = el.getBoundingClientRect();
    root.style.setProperty('--purse-hud-width', `${Math.ceil(rect.width)}px`);
    root.style.setProperty('--purse-hud-height', `${Math.ceil(rect.height)}px`);
    root.style.setProperty('--purse-hud-clearance-right', `${Math.ceil(rect.width + rightInset + gap)}px`);

    if (wasExpanded) hud.classList.add('is-expanded');
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
    deltaTimer = setTimeout(() => hud.classList.remove('show-delta'), 2450);
  }

  function pulseHud() {
    const hud = document.getElementById('purseHud');
    if (!hud) return;
    hud.classList.remove('pulse');
    void hud.offsetWidth;
    hud.classList.add('pulse');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => hud.classList.remove('pulse'), 800);
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
    lastShown = { digital: state.digital, cash: state.cash, gold: state.gold, index: priceIndex() };
  }

  function toggleHudExpanded(force) {
    const hud = document.getElementById('purseHud');
    if (!hud) return;
    const expanded = force != null ? force : !hud.classList.contains('is-expanded');
    hud.classList.toggle('is-expanded', expanded);
    hud.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    syncHudMetrics();
  }

  function onHudClick() {
    toggleHudExpanded();
  }

  function wireHudInteractions(hud) {
    if (!hud || hud.dataset.wired) return;
    hud.dataset.wired = '1';
    hud.setAttribute('aria-expanded', hud.classList.contains('is-expanded') ? 'true' : 'false');
    hud.addEventListener('click', onHudClick);
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
    mountLogo();
    mountBoard();
    if (hudDisabled()) return;
    if (document.getElementById('purseHud')) {
      document.body.classList.add('has-purse-hud');
      const hud = document.getElementById('purseHud');
      if (!document.getElementById('purseHudNetWorth')) {
        const row = document.createElement('span');
        row.className = 'purse-hud-networth';
        row.innerHTML =
          '<span class="purse-hud-networth-label">Net worth</span>' +
          '<span class="purse-hud-value purse-hud-networth-value" id="purseHudNetWorth"></span>';
        const delta = document.getElementById('purseHudDelta');
        hud.insertBefore(row, delta);
      }
      wireHudInteractions(hud);
      ensureCalendar();
      document.getElementById('purseHudPanel')?.remove();
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
    wrap.setAttribute('aria-expanded', 'false');
    wrap.innerHTML = [
      '<span class="purse-hud-slots">',
      '<span class="purse-hud-slot purse-hud-slot--credit">',
      '<span class="purse-hud-icon purse-hud-icon--credit" aria-hidden="true">',
      '<img src="assets/visa-platinum.png" alt="" width="62" height="39" draggable="false">',
      '</span>',
      '<span class="purse-hud-value purse-hud-digital" id="purseHudDigital"></span>',
      '</span>',
      '<span class="purse-hud-slot purse-hud-slot--cash">',
      '<span class="purse-hud-icon purse-hud-icon--cash" aria-hidden="true">',
      '<img src="assets/hundred-dollar.jpg" alt="" width="62" height="26" draggable="false">',
      '</span>',
      '<span class="purse-hud-value purse-hud-cash" id="purseHudCash"></span>',
      '</span>',
      '<span class="purse-hud-slot purse-hud-slot--gold">',
      '<span class="purse-hud-icon purse-hud-icon--gold" aria-hidden="true">',
      '<img src="assets/krugerrand-reverse.png" alt="" width="26" height="26" draggable="false">',
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
    wireHudInteractions(wrap);
    cluster.appendChild(buildCalendar());
    cluster.appendChild(wrap);
    document.body.appendChild(cluster);
    document.getElementById('purseHudPanel')?.remove();
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
    const height = parseFloat(root.getPropertyValue('--purse-hud-height')) || 84;
    return { top, right, bottom: top + height, height, width: parseFloat(root.getPropertyValue('--purse-hud-width')) || 168 };
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

  const BOARD_ERRORS = {
    taken: 'That name is taken.',
    credentials: 'That name and password do not match.',
    name: 'Use 2–16 letters, numbers, or spaces.',
    password: 'Password needs at least 4 characters.',
    offline: 'The board is offline.',
    score: 'That score could not be posted.',
    google: 'Google sign-in did not finish. Try again.'
  };

  function dateFromWeeks(weeks) {
    const ms = GAME_START_MS + (Number(weeks) || 0) * MS_PER_WEEK;
    const d = new Date(ms);
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }

  function boardError(code) {
    return BOARD_ERRORS[code] || BOARD_ERRORS.offline;
  }

  function scheduleScorePost() {
    if (!boardPlayer || boardOffline) return;
    clearTimeout(scorePostTimer);
    scorePostTimer = setTimeout(() => {
      scorePostChain = scorePostChain.then(postScore).catch(() => {});
    }, 800);
  }

  async function postScore() {
    if (!boardPlayer || boardOffline) return;
    const worth = netWorth();
    const weeks = totalWeeks();
    if (boardPlayer.best != null && worth <= boardPlayer.best) return;
    let response;
    try {
      response = await fetch('/api/best', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ netWorth: worth, weeks })
      });
    } catch (_) {
      boardOffline = true;
      return;
    }
    if (response.status === 503) {
      boardOffline = true;
      return;
    }
    if (!response.ok) return;
    const data = await response.json();
    if (!boardPlayer || data.best == null) return;
    boardPlayer.best = data.best;
    boardPlayer.weeks = data.weeks;
    const sheet = document.getElementById('boardSheet');
    if (data.improved && sheet && !sheet.hidden) loadBoard();
    if (netWorth() > data.best) scheduleScorePost();
  }

  function placeBoardChip() {
    const chip = document.getElementById('boardChip');
    if (!chip) return;
    const anchor = document.querySelector('.world-nav summary, .game-guide summary');
    if (!anchor) {
      chip.style.top = '';
      chip.style.left = '';
      return;
    }
    const rect = anchor.getBoundingClientRect();
    chip.style.left = `${Math.round(rect.left)}px`;
    chip.style.top = `${Math.round(rect.bottom + 6)}px`;
    const menu = anchor.closest('details');
    chip.hidden = !!(menu && menu.open);
    if (menu && !menu.dataset.boardToggle) {
      menu.dataset.boardToggle = '1';
      menu.addEventListener('toggle', placeBoardChip);
    }
  }

  function paintSession() {
    const form = document.getElementById('boardForm');
    const signed = document.getElementById('boardSigned');
    const chip = document.getElementById('boardChip');
    if (!form || !signed || !chip) return;
    if (boardPlayer) {
      form.hidden = true;
      signed.hidden = false;
      document.getElementById('boardSignedAs').textContent = `Signed in as ${boardPlayer.name}`;
      chip.textContent = 'Leaderboard';
    } else {
      form.hidden = false;
      signed.hidden = true;
      chip.textContent = 'Leaderboard';
    }
    placeBoardChip();
  }

  function paintBoard(data) {
    const list = document.getElementById('boardList');
    const youEl = document.getElementById('boardYou');
    if (!list) return;
    list.replaceChildren();
    const leaders = (data && data.leaders) || [];
    if (!leaders.length) {
      const empty = document.createElement('li');
      empty.className = 'board-empty';
      empty.textContent = 'No scores yet.';
      list.appendChild(empty);
    } else {
      leaders.forEach((row) => {
        const li = document.createElement('li');
        li.className = 'board-row' + (row.you ? ' is-you' : '');
        const rank = document.createElement('span');
        rank.className = 'board-rank';
        rank.textContent = String(row.rank);
        const who = document.createElement('span');
        who.className = 'board-who';
        const name = document.createElement('span');
        name.className = 'board-name';
        name.textContent = row.name;
        const date = document.createElement('span');
        date.className = 'board-date';
        date.textContent = dateFromWeeks(row.weeks);
        who.append(name, date);
        const worth = document.createElement('span');
        worth.className = 'board-worth';
        worth.textContent = fmt.format(row.netWorth);
        li.append(rank, who, worth);
        list.appendChild(li);
      });
    }
    const you = data && data.you;
    const onBoard = leaders.some((row) => row.you);
    if (you && you.rank && !onBoard) {
      youEl.hidden = false;
      youEl.textContent = `You are ${you.rank} · ${fmt.format(you.netWorth)}`;
    } else if (you && you.netWorth == null) {
      youEl.hidden = false;
      youEl.textContent = 'Your best net worth posts from this phone.';
    } else if (youEl) {
      youEl.hidden = true;
    }
  }

  async function loadBoard() {
    const list = document.getElementById('boardList');
    if (!list) return;
    let response;
    try {
      response = await fetch('/api/board', { credentials: 'same-origin' });
    } catch (_) {
      boardOffline = true;
      paintBoard({ leaders: [] });
      list.firstChild.textContent = boardError('offline');
      return;
    }
    if (response.status === 503) {
      boardOffline = true;
      paintBoard({ leaders: [] });
      list.firstChild.textContent = boardError('offline');
      return;
    }
    boardOffline = false;
    const data = await response.json();
    paintBoard(data);
  }

  function setBoardOpen(open) {
    const sheet = document.getElementById('boardSheet');
    if (!sheet) return;
    sheet.hidden = !open;
    if (open) {
      boardOffline = false;
      loadBoard();
      ensureGoogleButton();
      const field = boardPlayer
        ? document.getElementById('boardLogout')
        : document.querySelector('#boardForm input[name="name"]');
      field?.focus();
    }
  }

  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (loadGsi.pending) return loadGsi.pending;
    loadGsi.pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('gsi'));
      document.head.appendChild(script);
    });
    return loadGsi.pending;
  }

  async function onGoogleCredential(response) {
    const error = document.getElementById('boardError');
    if (error) error.textContent = '';
    try {
      const res = await fetch('/api/google', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: response && response.credential })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (error) error.textContent = boardError(data.error || 'google');
        return;
      }
      boardPlayer = { name: data.name, best: data.best, weeks: data.weeks };
      boardOffline = false;
      paintSession();
      postScore().then(loadBoard);
    } catch (_) {
      if (error) error.textContent = boardError('offline');
    }
  }

  function ensureGoogleButton() {
    const form = document.getElementById('boardForm');
    const slot = document.getElementById('boardGoogle');
    if (!form || form.hidden || !slot || slot.dataset.ready === '1' || slot.dataset.loading === '1') return;
    slot.dataset.loading = '1';
    const task = slot.dataset.config
      ? Promise.resolve(JSON.parse(slot.dataset.config))
      : fetch('/api/google-config', { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    task.then(async (config) => {
      if (!config || !config.clientId) return;
      slot.dataset.config = JSON.stringify({ clientId: config.clientId });
      await loadGsi();
      if (!window.google || !window.google.accounts || !window.google.accounts.id) return;
      const divider = document.getElementById('boardOr');
      slot.hidden = false;
      if (divider) divider.hidden = false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.google.accounts.id.initialize({
        client_id: config.clientId,
        callback: onGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: true
      });
      if (window.google.accounts.id.disableAutoSelect) window.google.accounts.id.disableAutoSelect();
      slot.replaceChildren();
      const card = slot.closest('.board-card');
      const width = Math.max(200, Math.min(280, (card ? card.clientWidth : 320) - 32));
      window.google.accounts.id.renderButton(slot, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        logo_alignment: 'left',
        width
      });
      slot.dataset.ready = '1';
    }).catch(() => {}).finally(() => {
      delete slot.dataset.loading;
    });
  }

  async function sendAuth(route) {
    const form = document.getElementById('boardForm');
    const error = document.getElementById('boardError');
    const name = form.querySelector('[name="name"]').value;
    const password = form.querySelector('[name="password"]').value;
    const named = normalizeBoardName(name);
    const secret = String(password || '');
    if (!named.ok) {
      error.textContent = boardError('name');
      return;
    }
    if (secret.length < 4 || secret.length > 64) {
      error.textContent = boardError('password');
      return;
    }
    error.textContent = '';
    const buttons = form.querySelectorAll('button');
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/api/' + route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: named.name, password: secret })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        error.textContent = boardError(data.error || (response.status === 503 ? 'offline' : 'credentials'));
        return;
      }
      boardPlayer = { name: data.name, best: data.best, weeks: data.weeks };
      boardOffline = false;
      paintSession();
      postScore().then(loadBoard);
    } catch (_) {
      error.textContent = boardError('offline');
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function normalizeBoardName(raw) {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    const chars = Array.from(name);
    if (chars.length < 2 || chars.length > 16 || !/^[\p{L}\p{N} ]+$/u.test(name)) return { ok: false };
    return { ok: true, name };
  }

  async function loadSession() {
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      if (!response.ok) return;
      const data = await response.json();
      if (data && data.name) {
        boardPlayer = { name: data.name, best: data.best, weeks: data.weeks };
        paintSession();
        scheduleScorePost();
      }
    } catch (_) { /* the board can wait until it is opened */ }
  }

  function mountBoard() {
    if (document.getElementById('boardChip')) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'board-chip';
    chip.id = 'boardChip';
    chip.textContent = 'Leaderboard';
    chip.setAttribute('aria-label', 'Leaderboard');
    const sheet = document.createElement('div');
    sheet.className = 'board-sheet';
    sheet.id = 'boardSheet';
    sheet.hidden = true;
    sheet.innerHTML = [
      '<div class="board-card" role="dialog" aria-modal="true" aria-labelledby="boardTitle">',
      '<div class="board-card-head">',
      '<h2 id="boardTitle">Leaderboard</h2>',
      '<button type="button" class="board-close" id="boardClose" aria-label="Close">×</button>',
      '</div>',
      '<p class="board-lead">Best net worth. Your purse stays on this phone.</p>',
      '<ol class="board-list" id="boardList"></ol>',
      '<p class="board-you" id="boardYou" hidden></p>',
      '<form class="board-form" id="boardForm">',
      '<div class="board-google" id="boardGoogle" hidden></div>',
      '<p class="board-or" id="boardOr" hidden>or</p>',
      '<label>Name <input name="name" autocomplete="username" maxlength="16" required></label>',
      '<label>Password <input name="password" type="password" autocomplete="current-password" maxlength="64" required></label>',
      '<p class="board-error" id="boardError" role="alert"></p>',
      '<div class="board-actions">',
      '<button type="submit">Sign in</button>',
      '<button type="button" id="boardCreate">Create account</button>',
      '</div>',
      '</form>',
      '<div class="board-signed" id="boardSigned" hidden>',
      '<p id="boardSignedAs"></p>',
      '<button type="button" id="boardLogout">Sign out</button>',
      '</div>',
      '</div>'
    ].join('');
    const nav = document.querySelector('.world-nav');
    if (nav) nav.insertAdjacentElement('afterend', chip);
    else document.body.appendChild(chip);
    document.body.appendChild(sheet);
    chip.addEventListener('click', () => setBoardOpen(true));
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) setBoardOpen(false);
    });
    sheet.querySelector('.board-card').addEventListener('click', (event) => event.stopPropagation());
    document.getElementById('boardClose').addEventListener('click', () => setBoardOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !sheet.hidden) setBoardOpen(false);
    });
    document.getElementById('boardForm').addEventListener('submit', (event) => {
      event.preventDefault();
      sendAuth('login');
    });
    document.getElementById('boardCreate').addEventListener('click', () => sendAuth('register'));
    document.getElementById('boardLogout').addEventListener('click', async () => {
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) { /* still sign out on this phone */ }
      boardPlayer = null;
      paintSession();
      loadBoard();
      ensureGoogleButton();
    });
    window.addEventListener('resize', placeBoardChip);
    window.addEventListener('load', placeBoardChip);
    placeBoardChip();
    loadSession();
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
    index, gasPrice, fuel, setFuel, addFuel, gasFillGallons, gasFillCost, buyGasFill,
    priceMult, tipMult, wageMult, goldScaled, debtCostMult, debtScaled, debtPriceMult, debtPriceScaled,
    visits, nextVisitRate, recordGasVisit, CREDIT_INTEREST_RATE,
    INFLATION_APR, CREDIT_APR, INFLATION_PERIOD_RATE, CREDIT_PERIOD_RATE,
    RATE_PERIOD_WEEKS, WEEKS_PER_YEAR, VISIT_WEEKS_ADVANCE,
    weeks: () => state.weeks || 0, totalWeeks, advanceWeek, weeklyRate, weekGrowth, priceIndex,
    gameDate, formatGameDate, GAME_START_YEAR,
    GAS_TANK_GAL, GAS_EMPTY_SEC, GAS_CASH_DISCOUNT,
    // plumbing
    snapshot, restore, getState, reincarnate, resetTimeline,
    migrateTips, mountHud, mountLogo, updateDisplay, toggleHudExpanded,
    getInsets, canvasInset, subscribe
  };
})(window);
