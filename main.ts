// Dip-harvest mean-reversion bot for the BTC 24h race.
//
// Idea: on one-minute bars this market snaps back after a wash-out, while
// chasing every small move bleeds the account dry on fees. So the bot only
// ever buys one thing — a deep dip off the running high — and only ever
// sells into a real recovery (or a hard stop). Long-only, one position at a
// time, whole cash in, whole position out, at most one order per batch.
//
// Why the numbers below are what they are: on the previous race's dev day
// (BTC drifting down ~2.8% over 24h) shallow dips lost money once the ~30
// bps round-trip cost was paid, while the 2.2-2.5% dip region with a
// 1.0-2.0% take was profitable, peaking at dip 2.5% / take 1.5%. A buy in
// the last hour was a trap (a dip with 8 bars left was flattened at a
// loss), so entries stop after bar 1380. And a position that grinds for a
// long time before bouncing runs further when it finally does, so a hold
// older than 150 bars waits for a 2.5% recovery instead of 1.5%. Those
// rules sit on plateaus, not knife edges — neighbouring parameters grade
// nearly the same — which is what makes them worth carrying into a new
// day rather than re-fitting to noise.
//
// Everything here is a pure function of the bars the harness sends: no
// clock, no environment, no randomness, so a replay is byte-identical.
// The parameter block at the top is the tuning surface: a sweep varies
// those numbers against the practice bars and the best set is written
// back here.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Tunable parameters, in basis points unless noted.
 *
 * Tuned on THIS race's dev window (rising +3.64%, 1,440 bars): the race #2
 * set (dip 2.5%) never fires here — the price never pulls back 2.5% from
 * its running high, so it makes 0 trades and fails the dev gate (verified
 * by grade-local: net PnL $0.00). A 1.0% dip fires twice, both wins; the
 * 3.0% patient take after 50 bars lets the second leg ride the rise instead
 * of exiting at +2.5%. Neighbours grade close (dip 0.8% -> $25.90, dip
 * 1.0% -> $28.03, take 2.1-2.9% identical), so this sits on a plateau,
 * not a knife edge. 2x-fee robustness: $24.27. */
const PARAMS = {
  /** Buy when the close is this far below the highest close seen. */
  dipBps: 100,
  /** Sell when the close is this far above the buy close. */
  takeBps: 250,
  /** Sell target for a position held longer than patientAfterBars. */
  patientTakeBps: 300,
  /** Bars of holding after which the patient take replaces the take. */
  patientAfterBars: 50,
  /** Sell when the close is this far below the buy close. */
  stopBps: 500,
  /** No new entries after this many bars have been seen. */
  lastEntryBar: 1380,
  /** Reject a fill more than this far past the decision close, in bps. */
  maxSlippageBps: 100,
} as const;

/** True when `price` is at least `bps` below `ref` (integer math). */
function downAtLeast(price: bigint, ref: bigint, bps: number): boolean {
  return price * 10000n <= ref * BigInt(10000 - bps);
}

/** True when `price` is at least `bps` above `ref` (integer math). */
function upAtLeast(price: bigint, ref: bigint, bps: number): boolean {
  return price * 10000n >= ref * BigInt(10000 + bps);
}

interface OpenPosition {
  /** Close the buy was decided on, in the bar's raw price units. */
  entryClose: bigint;
  /** Bars since the buy was decided on. */
  ageBars: number;
  /** True when the exit in flight is a stop rather than a take. */
  exitIsStop: boolean;
}

let peakClose: bigint | null = null;
let barsSeen = 0;
let position: OpenPosition | null = null;
/** Set once a stop-loss exit has filled: one bad day costs at most one stop. */
let lockedOut = false;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    barsSeen += 1;
    if (peakClose === null || close > peakClose) peakClose = close;
    if (state.warmingUp) return [];

    const holding = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (holding !== undefined && position !== null) {
      // We hold a position: age it and watch for the exit.
      position.ageBars += 1;
      const takeBps =
        position.ageBars > PARAMS.patientAfterBars ? PARAMS.patientTakeBps : PARAMS.takeBps;
      const takeHit = upAtLeast(close, position.entryClose, takeBps);
      const stopHit = downAtLeast(close, position.entryClose, PARAMS.stopBps);
      if (takeHit || stopHit) {
        // Send the exit on every bar the condition holds: a sell refused
        // for max slippage is simply sent again next bar, instead of
        // stranding the position with no exit left.
        position.exitIsStop = stopHit && !takeHit;
        orders.push({ side: 'sell', symbol: SYMBOL, qty: holding.qty, max_slippage_bps: PARAMS.maxSlippageBps });
      }
      return orders;
    }

    // Flat here. If we were tracking a position, its sell has filled.
    if (position !== null) {
      if (position.exitIsStop) lockedOut = true;
      position = null;
    }

    // Flat and not locked out: buy a genuine dip, with the whole cash
    // balance, while there is still time in the window for a bounce.
    if (!lockedOut && peakClose !== null && barsSeen <= PARAMS.lastEntryBar) {
      const dipped = downAtLeast(close, peakClose, PARAMS.dipBps);
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (dipped && state.cash >= minNotional) {
        position = { entryClose: close, ageBars: 0, exitIsStop: false };
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: PARAMS.maxSlippageBps });
      }
    }
    return orders;
  },
});
