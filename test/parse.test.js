import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegimeResponse } from '../src/ai/regime.js';

test('parses clean raw JSON', () => {
  const out = parseRegimeResponse(
    '{"regime":"bullish","confidence":72,"trade_allowed":true,"reasoning":"Uptrend intact."}',
  );
  assert.deepEqual(out, {
    regime: 'bullish',
    confidence: 72,
    trade_allowed: true,
    reasoning: 'Uptrend intact.',
  });
});

test('strips markdown code fences', () => {
  const out = parseRegimeResponse(
    '```json\n{"regime":"chop","confidence":40,"trade_allowed":false,"reasoning":"Range-bound."}\n```',
  );
  assert.equal(out.regime, 'chop');
  assert.equal(out.trade_allowed, false);
});

test('extracts JSON embedded in surrounding prose', () => {
  const out = parseRegimeResponse(
    'Here is my analysis: {"regime":"bearish","confidence":80,"trade_allowed":false,"reasoning":"Breakdown."} Hope this helps!',
  );
  assert.equal(out.regime, 'bearish');
});

test('clamps confidence into [0, 100]', () => {
  const out = parseRegimeResponse('{"regime":"bullish","confidence":250,"trade_allowed":true,"reasoning":"Strong trend."}');
  assert.equal(out.confidence, 100);
});

test('strips a <thinking> block before parsing', () => {
  const out = parseRegimeResponse(
    '<thinking>Step 1: price above all EMAs. Step 2: RSI healthy. So bullish.</thinking>\n' +
    '{"regime":"bullish","confidence":68,"trade_allowed":true,"reasoning":"Trend and momentum align."}',
  );
  assert.equal(out.regime, 'bullish');
  assert.equal(out.confidence, 68);
});

test('strict schema: non-integer confidence and empty reasoning are rejected', () => {
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72.5,"trade_allowed":true,"reasoning":"x"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72,"trade_allowed":true,"reasoning":""}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":72,"trade_allowed":true}'), null);
  // long reasoning is truncated to 200 chars rather than rejected
  const long = parseRegimeResponse(`{"regime":"chop","confidence":40,"trade_allowed":false,"reasoning":"${'a'.repeat(300)}"}`);
  assert.equal(long.reasoning.length, 200);
});

test('rejects malformed and schema-invalid output', () => {
  assert.equal(parseRegimeResponse('not json at all'), null);
  assert.equal(parseRegimeResponse(''), null);
  assert.equal(parseRegimeResponse(null), null);
  assert.equal(parseRegimeResponse('{"regime":"moonish","confidence":50,"trade_allowed":true}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":"high","trade_allowed":true}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":50,"trade_allowed":"yes"}'), null);
  assert.equal(parseRegimeResponse('{"regime":"bullish","confidence":50'), null);
  assert.equal(parseRegimeResponse('[1,2,3]'), null);
});
