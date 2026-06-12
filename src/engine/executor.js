// Order execution interface. PAPER ONLY.
//
// There is intentionally NO live executor in this codebase. The rule engine
// talks to this interface so a live executor could be added later, but no code
// path here (or anywhere else) places a real order.
import { config } from '../config.js';

/**
 * Executor interface:
 *   buy(pair, qty, marketPrice)  -> { fillPrice, fee, notional }
 *   sell(pair, qty, marketPrice) -> { fillPrice, fee, proceeds }
 */
export class PaperExecutor {
  constructor({ slippage = config.slippage, takerFee = config.takerFee } = {}) {
    this.slippage = slippage;
    this.takerFee = takerFee;
  }

  // Slippage always works against you; taker fee charged per side.
  buy(pair, qty, marketPrice) {
    const fillPrice = marketPrice * (1 + this.slippage);
    const notional = fillPrice * qty;
    const fee = notional * this.takerFee;
    return { pair, fillPrice, fee, notional };
  }

  sell(pair, qty, marketPrice) {
    const fillPrice = marketPrice * (1 - this.slippage);
    const proceeds = fillPrice * qty;
    const fee = proceeds * this.takerFee;
    return { pair, fillPrice, fee, proceeds };
  }
}
