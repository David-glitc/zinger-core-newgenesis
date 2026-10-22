/** Public quote diagnostics only. No trading, wallet or storage dependencies. */
export interface QuoteLevel { price: number; size: number }
export interface QuoteFee { rate: number; exponent: number }
export interface QuoteLadder { bids: QuoteLevel[]; asks: QuoteLevel[] }
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
function validateFee(fee: QuoteFee) {
  if (!fee || !Number.isFinite(fee.rate) || fee.rate < 0 || fee.rate > 1 || !Number.isFinite(fee.exponent) || fee.exponent < 0 || fee.exponent > 5) throw Error('Unverified fee parameters');
}
function levels(rows: QuoteLevel[], ascending: boolean) {
  const byPrice = new Map<number, number>();
  for (const l of rows ?? []) {
    if (!Number.isFinite(l.price) || l.price <= 0 || l.price >= 1 || !Number.isFinite(l.size) || l.size <= 0) throw Error('Invalid quote level');
    byPrice.set(l.price, (byPrice.get(l.price) ?? 0) + l.size);
  }
  return [...byPrice].map(([price, size]) => ({ price, size })).sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
}
export function quoteFee(shares: number, price: number, fee: QuoteFee) {
  validateFee(fee);
  return round5(shares * fee.rate * (price * (1 - price)) ** fee.exponent);
}
export function walkQuote(rows: QuoteLevel[], shares: number, side: 'buy' | 'sell', fee: QuoteFee) {
  validateFee(fee);
  if (!Number.isFinite(shares) || shares <= 0) throw Error('Invalid share count');
  let remaining = shares, premiumUsd = 0, feeUsd = 0;
  const fills: { price: number; shares: number; feeUsd: number }[] = [];
  for (const l of levels(rows, side === 'buy')) {
    const take = Math.min(l.size, remaining);
    if (take <= 1e-9) break;
    const cost = quoteFee(take, l.price, fee);
    fills.push({ price: l.price, shares: take, feeUsd: cost });
    premiumUsd += take * l.price; feeUsd += cost; remaining -= take;
  }
  return { complete: remaining <= 1e-9, filledShares: shares - remaining, premiumUsd, feeUsd, fills };
}
export function sameTokenRoundTrip(book: QuoteLadder, shares: number, fee: QuoteFee, bufferUsdPerShare = .01) {
  if (!Number.isFinite(bufferUsdPerShare) || bufferUsdPerShare < 0) throw Error('Invalid cost buffer');
  const buy = walkQuote(book.asks, shares, 'buy', fee), sell = walkQuote(book.bids, shares, 'sell', fee);
  const complete = buy.complete && sell.complete;
  const netUsd = complete ? sell.premiumUsd - buy.premiumUsd - buy.feeUsd - sell.feeUsd : null;
  return { shares, complete, buy, sell, netUsd, bufferedNetUsd: netUsd == null ? null : netUsd - shares * bufferUsdPerShare, positiveAfterFees: netUsd != null && netUsd > 1e-8, positiveWithBuffer: netUsd != null && netUsd - shares * bufferUsdPerShare > 1e-8 };
}
export function completeSetQuote(up: QuoteLadder, down: QuoteLadder, shares: number, fee: QuoteFee, bufferUsdPerShare = .01) {
  if (!Number.isFinite(bufferUsdPerShare) || bufferUsdPerShare < 0) throw Error('Invalid cost buffer');
  const upBuy = walkQuote(up.asks, shares, 'buy', fee), downBuy = walkQuote(down.asks, shares, 'buy', fee);
  const complete = upBuy.complete && downBuy.complete;
  const netUsd = complete ? shares - upBuy.premiumUsd - downBuy.premiumUsd - upBuy.feeUsd - downBuy.feeUsd : null;
  return { shares, complete, upBuy, downBuy, netUsd, bufferedNetUsd: netUsd == null ? null : netUsd - shares * bufferUsdPerShare, positiveAfterFees: netUsd != null && netUsd > 1e-8, positiveWithBuffer: netUsd != null && netUsd - shares * bufferUsdPerShare > 1e-8 };
}
/** Max overlapping shares at quoted bid > ask, ignoring fees; a diagnostic ceiling only. */
export function crossedCapacity(book: QuoteLadder) {
  const asks = levels(book.asks, true), bids = levels(book.bids, false);
  let a = 0, b = 0, capacity = 0, askLeft = asks[0]?.size ?? 0, bidLeft = bids[0]?.size ?? 0;
  while (a < asks.length && b < bids.length && bids[b].price > asks[a].price) {
    const take = Math.min(askLeft, bidLeft); capacity += take; askLeft -= take; bidLeft -= take;
    if (askLeft <= 1e-9) { a++; askLeft = asks[a]?.size ?? 0; }
    if (bidLeft <= 1e-9) { b++; bidLeft = bids[b]?.size ?? 0; }
  }
  return capacity;
}
