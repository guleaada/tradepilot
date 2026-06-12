// Monte Carlo resampling of the closed-trade P&L distribution.
//
//   npm run monte-carlo
//
// Draws N trades (with replacement, N = number of closed trades) from the
// live DB's P&L distribution, 10,000 times, and reports the spread of
// outcomes: median final equity, 5th percentile (risk-of-ruin boundary),
// probability of a 20% drawdown, probability of doubling.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { getDb } from './db.js';

// Pure simulation core (rng injectable for tests).
export function runMonteCarlo(pnls, { sims = 10_000, start = config.startBalance, rng = Math.random } = {}) {
  if (!Array.isArray(pnls) || pnls.length === 0) throw new Error('runMonteCarlo needs at least one trade P&L');
  const finals = new Array(sims);
  let drawdown20Count = 0;
  let doubleCount = 0;
  for (let s = 0; s < sims; s++) {
    let equity = start;
    let peak = start;
    let maxDd = 0;
    for (let i = 0; i < pnls.length; i++) {
      equity += pnls[Math.floor(rng() * pnls.length)];
      if (equity > peak) peak = equity;
      if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
    }
    finals[s] = equity;
    if (maxDd >= 0.2) drawdown20Count++;
    if (equity >= 2 * start) doubleCount++;
  }
  const sorted = [...finals].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    sims,
    trades: pnls.length,
    start,
    medianFinalEquity: pick(0.5),
    p5FinalEquity: pick(0.05),
    probDrawdown20: drawdown20Count / sims,
    probDouble: doubleCount / sims,
    finals,
  };
}

function histogramSvg(finals, start, width = 720, height = 240, bins = 30) {
  const min = Math.min(...finals);
  const max = Math.max(...finals);
  const span = max - min || 1;
  const counts = new Array(bins).fill(0);
  for (const f of finals) {
    counts[Math.min(bins - 1, Math.floor(((f - min) / span) * bins))]++;
  }
  const maxCount = Math.max(...counts);
  const pad = 36;
  const barW = (width - 2 * pad) / bins;
  const bars = counts
    .map((c, i) => {
      const h = maxCount > 0 ? (c / maxCount) * (height - 2 * pad) : 0;
      const x = pad + i * barW;
      const y = height - pad - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="#2563eb"/>`;
    })
    .join('');
  const startX = pad + ((start - min) / span) * (width - 2 * pad);
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#fafafa" stroke="#ddd"/>
  ${bars}
  <line x1="${startX.toFixed(1)}" y1="${pad}" x2="${startX.toFixed(1)}" y2="${height - pad}" stroke="#dc2626" stroke-dasharray="4 3"/>
  <text x="${pad}" y="${height - 10}" font-family="monospace" font-size="11">$${min.toFixed(0)}</text>
  <text x="${width - pad - 60}" y="${height - 10}" font-family="monospace" font-size="11">$${max.toFixed(0)}</text>
  <text x="${(startX + 4).toFixed(1)}" y="${pad + 12}" font-family="monospace" font-size="11" fill="#dc2626">start</text>
</svg>`;
}

function main() {
  const db = getDb();
  const pnls = db
    .prepare("SELECT pnl FROM trades WHERE status = 'closed' AND pnl IS NOT NULL")
    .all()
    .map((r) => r.pnl);
  if (pnls.length < 5) {
    console.log(`Monte Carlo needs at least 5 closed trades (have ${pnls.length}). Run the agent longer or backtest first.`);
    return;
  }
  const result = runMonteCarlo(pnls);
  const usd = (v) => `$${v.toFixed(2)}`;
  console.log(`── Monte Carlo (${result.sims.toLocaleString()} sims × ${result.trades} trades) ──`);
  console.log(`median final equity   ${usd(result.medianFinalEquity)}`);
  console.log(`5th percentile        ${usd(result.p5FinalEquity)}  (risk-of-ruin boundary)`);
  console.log(`P(drawdown >= 20%)    ${(result.probDrawdown20 * 100).toFixed(1)}%`);
  console.log(`P(double equity)      ${(result.probDouble * 100).toFixed(1)}%`);

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(config.reportsDir, `montecarlo_${date}.html`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Monte Carlo ${date}</title>
<style>body{font-family:system-ui;margin:2rem}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 10px;font-size:13px;text-align:right}th{background:#f3f4f6;text-align:left}</style>
</head><body><h1>TradePilot Monte Carlo — ${date}</h1>
<p>${result.sims.toLocaleString()} simulations of ${result.trades} resampled trades (with replacement) from the live closed-trade P&amp;L distribution. Starting equity $${result.start.toFixed(2)}.</p>
<table>
<tr><th>Median final equity</th><td>${usd(result.medianFinalEquity)}</td></tr>
<tr><th>5th percentile final equity</th><td>${usd(result.p5FinalEquity)}</td></tr>
<tr><th>Probability of ≥20% drawdown</th><td>${(result.probDrawdown20 * 100).toFixed(1)}%</td></tr>
<tr><th>Probability of doubling equity</th><td>${(result.probDouble * 100).toFixed(1)}%</td></tr>
</table>
<h2>Final equity distribution</h2>
${histogramSvg(result.finals, result.start)}
</body></html>`;
  fs.mkdirSync(config.reportsDir, { recursive: true });
  fs.writeFileSync(file, html);
  console.log(`report: ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
