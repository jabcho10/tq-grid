// JS 엔진이 engine.py 와 같은 결과를 내는지 대조한다.
const fs = require('fs');
const B = require('../assets/backtest.js');
const hist = JSON.parse(fs.readFileSync(__dirname + '/../data/history.json', 'utf8'));
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const c of cases) {
  const cfg = { start: c.start, end: c.end, seed: c.seed };
  if (c.params) cfg.params = c.params;
  const m = B.metrics(B.backtest(hist, cfg));
  const got = { cagr: m.cagr, mdd: m.mdd, final: m.final, trades: m.trades, winrate: m.winrate };
  const d = {
    cagr: Math.abs(got.cagr - c.expect.cagr),
    mdd: Math.abs(got.mdd - c.expect.mdd),
    final: Math.abs(got.final - c.expect.final) / c.expect.final,
    trades: Math.abs(got.trades - c.expect.trades),
    winrate: Math.abs(got.winrate - c.expect.winrate),
  };
  const ok = d.cagr < 1e-9 && d.mdd < 1e-9 && d.final < 1e-9 && d.trades === 0 && d.winrate < 1e-12;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${c.name}`);
  console.log(`      py  CAGR ${(c.expect.cagr*100).toFixed(6)}%  MDD ${(c.expect.mdd*100).toFixed(6)}%  $${c.expect.final.toFixed(4)}  ${c.expect.trades}건  ${(c.expect.winrate*100).toFixed(6)}%`);
  console.log(`      js  CAGR ${(got.cagr*100).toFixed(6)}%  MDD ${(got.mdd*100).toFixed(6)}%  $${got.final.toFixed(4)}  ${got.trades}건  ${(got.winrate*100).toFixed(6)}%`);
}
console.log(bad ? `\n불일치 ${bad}건` : `\n전부 일치 (${cases.length}건)`);
process.exit(bad ? 1 : 0);
