import { NO_LOWER, NO_UPPER, USDC_DECIMALS, WETH_DECIMALS, WETH_IS_CURRENCY0 } from "./deployment";

/**
 * Human price (USDC per 1 WETH) ↔ Uniswap v4 tick, for our demo pool.
 *
 * v4's raw price is always currency1-per-currency0 in smallest units: raw = 1.0001^tick.
 *   WETH = currency0 → raw = USDC_raw / WETH_raw → price = raw · 10^(18−6)
 *   USDC = currency0 → raw = WETH_raw / USDC_raw → price = 10^(18−6) / raw
 * So when USDC sorts first (as in the live pool), a FALLING WETH price means a RISING tick.
 */
const DEC_SHIFT = 10 ** (WETH_DECIMALS - USDC_DECIMALS); // 1e12
const LN_BASE = Math.log(1.0001);

export function tickToPrice(tick: number): number {
  const raw = Math.exp(tick * LN_BASE);
  return WETH_IS_CURRENCY0 ? raw * DEC_SHIFT : DEC_SHIFT / raw;
}

export function priceToTick(price: number): number {
  const raw = WETH_IS_CURRENCY0 ? price / DEC_SHIFT : DEC_SHIFT / price;
  return Math.floor(Math.log(raw) / LN_BASE);
}

/** Does the WETH price move in the same direction as the tick? */
export const PRICE_FOLLOWS_TICK = WETH_IS_CURRENCY0;

/**
 * Tick bounds for "fire when the WETH price is ≤ `price`" (falling) or "≥ `price`" (rising).
 * Mirrors the executor's rule: fires when tick <= lower || tick >= upper.
 */
export function boundsForPrice(price: number, whenPriceFalls: boolean): { lower: number; upper: number } {
  const t = priceToTick(price);
  const tickMustFall = whenPriceFalls === PRICE_FOLLOWS_TICK;
  return tickMustFall ? { lower: t, upper: NO_UPPER } : { lower: NO_LOWER, upper: t };
}

/** The price at which a rule with these bounds fires (for display). Returns [whenBelow, whenAbove]. */
export function boundsToPrices(lower: number, upper: number): { below?: number; above?: number } {
  const res: { below?: number; above?: number } = {};
  const lowerSet = lower !== NO_LOWER;
  const upperSet = upper !== NO_UPPER;
  if (PRICE_FOLLOWS_TICK) {
    if (lowerSet) res.below = tickToPrice(lower);
    if (upperSet) res.above = tickToPrice(upper);
  } else {
    if (lowerSet) res.above = tickToPrice(lower); // low tick = high WETH price
    if (upperSet) res.below = tickToPrice(upper);
  }
  return res;
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const raw = s * s;
  return WETH_IS_CURRENCY0 ? raw * DEC_SHIFT : DEC_SHIFT / raw;
}

export const fmtUsd = (n: number, digits = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtToken = (n: number, digits = 4) =>
  n.toLocaleString("en-US", { maximumFractionDigits: digits });
