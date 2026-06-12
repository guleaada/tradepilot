import test from 'node:test';
import assert from 'node:assert/strict';
import { runMonteCarlo } from '../src/montecarlo.js';

// Deterministic rng for reproducible tests.
function cyclingRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('monte carlo output shape and invariants', () => {
  const result = runMonteCarlo([10, -5, 20, -8, 15], {
    sims: 500,
    start: 1000,
    rng: cyclingRng([0.05, 0.35, 0.65, 0.95, 0.5]),
  });
  assert.equal(result.sims, 500);
  assert.equal(result.trades, 5);
  assert.equal(result.start, 1000);
  assert.equal(result.finals.length, 500);
  assert.ok(Number.isFinite(result.medianFinalEquity));
  assert.ok(Number.isFinite(result.p5FinalEquity));
  assert.ok(result.p5FinalEquity <= result.medianFinalEquity);
  assert.ok(result.probDrawdown20 >= 0 && result.probDrawdown20 <= 1);
  assert.ok(result.probDouble >= 0 && result.probDouble <= 1);
});

test('all-identical winning trades produce a deterministic outcome', () => {
  // every draw adds +5; 10 trades -> final is always start + 50
  const result = runMonteCarlo(Array(10).fill(5), { sims: 200, start: 1000, rng: cyclingRng([0.1, 0.7]) });
  assert.equal(result.medianFinalEquity, 1050);
  assert.equal(result.p5FinalEquity, 1050);
  assert.equal(result.probDrawdown20, 0); // equity only rises
  assert.equal(result.probDouble, 0); // +50 never doubles 1000
});

test('rejects an empty distribution', () => {
  assert.throws(() => runMonteCarlo([], { sims: 10 }), /at least one trade/);
});
