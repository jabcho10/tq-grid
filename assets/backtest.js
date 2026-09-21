/* TQQQ · QQQ 중심주가 동적 그리드 — 백테스트 엔진 (engine.py 이식)
 *
 * 규칙은 방법론 v1.2 를 그대로 따른다. 파이썬 엔진과 같은 입력에 대해
 * 같은 결과를 내야 하며, 이는 tools/verify_js.js 로 대조 검증한다.
 * 브라우저에서는 window.GridBacktest, node 에서는 module.exports 로 노출된다. */
(function (root) {
  'use strict';

  var BOTTOM = 'bottom', MIDDLE = 'middle', TOP = 'top';

  var DEFAULT_PARAMS = {
    bottom: { buy: 0.050, tp: 0.1100, moc: 50, w: [.07, .11, .22, .22, .16, .11, .11] },
    middle: { buy: 0.015, tp: 0.0125, moc: 50, w: [.07, .11, .11, .20, .20, .20, .11] },
    top:    { buy: 0.020, tp: 0.0275, moc: 7,  w: [.07, .11, .22, .22, .16, .11, .11],
              buy1: -0.0165, tp1: 0.008 }
  };

  var FEE_BUY = 0.0007, FEE_SELL = 0.0007, SEC_FEE = 0.0000278, MAX_TIER = 7;

  function round8(x) { return Math.round(x * 1e8) / 1e8; }
  function floorCent(x) { return Math.floor(round8(x) * 100 + 1e-9) / 100; }
  function ceilCent(x) { return Math.ceil(round8(x) * 100 - 1e-9) / 100; }

  function centerPrice(y, m, intercept, growth) {
    return (intercept || 100.31) * Math.pow(growth || 1.0132, (y - 2016) * 12 + m);
  }

  /* ISO 주차 — 파이썬 dt.isocalendar() 과 같은 값을 준다 */
  function isoWeekKey(y, m, d) {
    var t = Date.UTC(y, m, d);
    var dt = new Date(t);
    var day = (dt.getUTCDay() + 6) % 7;             // 월=0
    dt.setUTCDate(dt.getUTCDate() - day + 3);       // 그 주의 목요일
    var isoYear = dt.getUTCFullYear();
    var jan4 = new Date(Date.UTC(isoYear, 0, 4));
    var j4day = (jan4.getUTCDay() + 6) % 7;
    jan4.setUTCDate(jan4.getUTCDate() - j4day + 3);
    var week = 1 + Math.round((dt - jan4) / 604800000);
    return isoYear * 100 + week;
  }

  /* 직전 완료 주의 마지막 QQQ 종가로 이번 주 모드를 확정한다 */
  function assignModes(hist, opt) {
    opt = opt || {};
    var lo = opt.lo == null ? 0.05 : opt.lo;
    var hi = opt.hi == null ? 0.15 : opt.hi;
    var n = hist.dates.length;
    var wk = new Array(n), ys = new Array(n), ms = new Array(n), ds = new Array(n);
    var i;
    for (i = 0; i < n; i++) {
      var s = hist.dates[i];
      var y = +s.slice(0, 4), mo = +s.slice(5, 7) - 1, da = +s.slice(8, 10);
      ys[i] = y; ms[i] = mo; ds[i] = da;
      wk[i] = isoWeekKey(y, mo, da);
    }
    // 주별 마지막 거래일 인덱스 (등장 순서 유지)
    var order = [], lastIdx = {};
    for (i = 0; i < n; i++) {
      if (lastIdx[wk[i]] === undefined) order.push(wk[i]);
      lastIdx[wk[i]] = i;
    }
    var modeOfWeek = {};
    var prev = null;
    for (var k = 0; k < order.length; k++) {
      var w = order[k], j = lastIdx[w];
      modeOfWeek[w] = prev;                          // 이번 주 = 직전 주 판정값
      var c = centerPrice(ys[j], ms[j], opt.intercept, opt.growth);
      var dev = hist.qqq[j] / c - 1;
      prev = dev < lo ? BOTTOM : (dev <= hi ? MIDDLE : TOP);
    }
    var modes = new Array(n);
    for (i = 0; i < n; i++) modes[i] = modeOfWeek[wk[i]];
    return modes;
  }

  function backtest(hist, cfg) {
    cfg = cfg || {};
    var P = cfg.params || DEFAULT_PARAMS;
    var seed0 = cfg.seed == null ? 10000 : cfg.seed;
    var feeBuy = cfg.feeBuy == null ? FEE_BUY : cfg.feeBuy;
    var feeSell = cfg.feeSell == null ? FEE_SELL : cfg.feeSell;
    var secFee = cfg.secFee == null ? SEC_FEE : cfg.secFee;
    var start = cfg.start || hist.dates[0];
    var end = cfg.end || hist.dates[hist.dates.length - 1];
    var modes = cfg.modes || assignModes(hist, cfg);

    var lo = 0, hi = hist.dates.length - 1;
    while (lo <= hi && hist.dates[lo] < start) lo++;
    while (hi >= lo && hist.dates[hi] > end) hi--;
    var n = hi - lo + 1;
    if (n < 2) return null;

    var cash = seed0, seed = seed0;
    var pos = [], trades = [];
    var equity = new Float64Array(n);
    var dates = new Array(n), closes = new Float64Array(n), dmode = new Array(n);
    var modeDays = { bottom: 0, middle: 0, top: 0 };

    for (var i = 0; i < n; i++) {
      var g = lo + i;                                 // 전역 인덱스
      var px = hist.tqqq[g], mode = modes[g];
      dates[i] = hist.dates[g]; closes[i] = px; dmode[i] = mode;
      if (mode) modeDays[mode]++;

      /* 장 시작 전: 전일 종가로 주문 계획 */
      var plan = null;
      if (i > 0 && mode && pos.length < MAX_TIER) {
        var tier = pos.length + 1, pp = P[mode];
        var buyRate = (mode === TOP && tier === 1) ? pp.buy1 : pp.buy;
        var tpRate  = (mode === TOP && tier === 1) ? pp.tp1  : pp.tp;
        var limit = floorCent(hist.tqqq[g - 1] * (1 + buyRate));
        var ok = true, j;

        // §6.3 천장 MOC 예정일에는 신규 매수 금지
        if (mode === TOP) {
          for (j = 0; j < pos.length; j++) if (pos[j].mocI === i) { ok = false; break; }
        }
        // §6.1 바닥·천장 매도일 신규매수 제한.
        // 참조 엔진(engine.py)과 같이 여기서는 센트 정규화를 하지 않는다.
        // 0.47 - 0.01 이 0.45999999999999996 이 되어 종가 0.46 체결을 막는
        // 부동소수 거동까지 그대로 재현해야 문서 수치와 일치한다.
        if (ok && (mode === BOTTOM || mode === TOP) && pos.length) {
          var minTp = Infinity;
          for (j = 0; j < pos.length; j++) if (pos[j].tp < minTp) minTp = pos[j].tp;
          if (minTp - 0.01 < limit) limit = minTp - 0.01;
        }
        if (ok && limit > 0) {
          plan = { tier: tier, mode: mode, limit: limit, tpRate: tpRate,
                   alloc: seed * pp.w[tier - 1], moc: pp.moc };
        }
      }

      /* 종가: MOC 우선 */
      var keep = [], p;
      for (var a = 0; a < pos.length; a++) {
        p = pos[a];
        if (p.mocI === i) {
          var pr = p.qty * px * (1 - feeSell - secFee);
          cash += pr; var pnl = pr - p.cost; seed += pnl;
          trades.push({ i: i, kind: 'MOC', mode: p.mode, tier: p.tier, qty: p.qty,
                        buy: p.price, sell: px, pnl: pnl });
        } else keep.push(p);
      }
      pos = keep;

      /* 종가: 익절 LOC (매수 다음날 ~ MOC 직전일) */
      keep = [];
      for (var b = 0; b < pos.length; b++) {
        p = pos[b];
        if (p.entryI < i && i < p.mocI && px >= p.tp) {
          var pr2 = p.qty * px * (1 - feeSell - secFee);
          cash += pr2; var pnl2 = pr2 - p.cost; seed += pnl2;
          trades.push({ i: i, kind: 'TP', mode: p.mode, tier: p.tier, qty: p.qty,
                        buy: p.price, sell: px, pnl: pnl2 });
        } else keep.push(p);
      }
      pos = keep;

      /* 종가: 신규 매수 LOC — 수량은 배정금액 ÷ 지정가 내림 */
      if (plan && px <= plan.limit && pos.length < MAX_TIER) {
        var qty = plan.limit > 0 ? Math.floor(plan.alloc / plan.limit) : 0;
        var maxq = px > 0 ? Math.floor(cash / (px * (1 + feeBuy))) : 0;
        if (qty > maxq) qty = maxq;
        if (qty > 0) {
          var cost = qty * px * (1 + feeBuy);
          cash -= cost;
          pos.push({ tier: plan.tier, mode: plan.mode, qty: qty, price: px, cost: cost,
                     tp: ceilCent(px * (1 + plan.tpRate)),
                     mocI: i + plan.moc, entryI: i });
        }
      }

      var mv = 0;
      for (var c2 = 0; c2 < pos.length; c2++) mv += pos[c2].qty * closes[i];
      equity[i] = cash + mv;
    }

    return { dates: dates, equity: equity, closes: closes, modes: dmode,
             trades: trades, modeDays: modeDays, seed0: seed0 };
  }

  function metrics(r) {
    if (!r) return null;
    var e = r.equity, n = e.length;
    var d0 = Date.parse(r.dates[0]), d1 = Date.parse(r.dates[n - 1]);
    var years = (d1 - d0) / 86400000 / 365.25;
    var cagr = Math.pow(e[n - 1] / e[0], 1 / years) - 1;
    var peak = e[0], mdd = 0, dd = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      if (e[i] > peak) peak = e[i];
      dd[i] = e[i] / peak - 1;
      if (dd[i] < mdd) mdd = dd[i];
    }
    var wins = 0;
    for (var t = 0; t < r.trades.length; t++) if (r.trades[t].pnl > 0) wins++;
    return { cagr: cagr, mdd: mdd, dd: dd, final: e[n - 1], years: years,
             trades: r.trades.length,
             winrate: r.trades.length ? wins / r.trades.length : 0,
             calmar: mdd < 0 ? cagr / Math.abs(mdd) : null };
  }

  /* Buy & Hold 비교 — 같은 시드로 정수 주식 1회 매수 후 보유 */
  function buyHold(r, feeBuy) {
    feeBuy = feeBuy == null ? FEE_BUY : feeBuy;
    var q = Math.floor(r.seed0 / (r.closes[0] * (1 + feeBuy)));
    var rest = r.seed0 - q * r.closes[0] * (1 + feeBuy);
    var out = new Float64Array(r.equity.length);
    for (var i = 0; i < out.length; i++) out[i] = rest + q * r.closes[i];
    return out;
  }

  function annual(r) {
    var out = [], cur = null;
    for (var i = 0; i < r.dates.length; i++) {
      var y = r.dates[i].slice(0, 4);
      if (!cur || cur.year !== y) { cur = { year: y, first: r.equity[i], last: r.equity[i], peak: r.equity[i], mdd: 0 }; out.push(cur); }
      cur.last = r.equity[i];
      if (r.equity[i] > cur.peak) cur.peak = r.equity[i];
      var d = r.equity[i] / cur.peak - 1;
      if (d < cur.mdd) cur.mdd = d;
    }
    out.forEach(function (o) { o.ret = o.last / o.first - 1; });
    return out;
  }

  function rolling(hist, years, cfg) {
    var res = [], modes = (cfg && cfg.modes) || assignModes(hist, cfg || {});
    var yN = +hist.dates[hist.dates.length - 1].slice(0, 4);
    var y0 = (cfg && cfg.start) ? +cfg.start.slice(0, 4) : +hist.dates[0].slice(0, 4);
    var endCap = (cfg && cfg.end) ? +cfg.end.slice(0, 4) : yN;
    for (var y = y0; y + years - 1 <= endCap; y++) {
      var c = Object.assign({}, cfg, { start: y + '-01-01', end: (y + years - 1) + '-12-31', modes: modes });
      var m = metrics(backtest(hist, c));
      if (m) res.push({ start: y, cagr: m.cagr, mdd: m.mdd });
    }
    return res;
  }

  var api = { BOTTOM: BOTTOM, MIDDLE: MIDDLE, TOP: TOP,
              DEFAULT_PARAMS: DEFAULT_PARAMS, FEE_BUY: FEE_BUY, FEE_SELL: FEE_SELL,
              SEC_FEE: SEC_FEE, MAX_TIER: MAX_TIER,
              floorCent: floorCent, ceilCent: ceilCent, centerPrice: centerPrice,
              assignModes: assignModes, backtest: backtest, metrics: metrics,
              buyHold: buyHold, annual: annual, rolling: rolling };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GridBacktest = api;
})(typeof self !== 'undefined' ? self : this);
