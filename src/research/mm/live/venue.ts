/**
 * Venue boundary for MM execution. The executor only talks to an MmVenue, so the same
 * order lifecycle runs against the in-memory dry-run venue (default) or the CLOB adapter.
 */
export type Side = 'BUY' | 'SELL';
export type TickSize = '0.1' | '0.01' | '0.005' | '0.0025' | '0.001' | '0.0001';

export interface PlaceRequest {
  clientKey: string; tokenId: string; side: Side; price: number; shares: number;
  tickSize: TickSize; negRisk: boolean;
}
export interface PlaceResult { ok: boolean; venueOrderId?: string; error?: string }
export interface VenueOrder {
  id: string; tokenId: string; side: Side; price: number; originalShares: number; matchedShares: number;
  status: 'open' | 'filled' | 'cancelled' | 'unknown'; createdAt?: number;
}
/** One maker fill, already reduced to our order. `failed` reverses an earlier match. */
export interface VenueFill {
  tradeId: string; venueOrderId: string; tokenId: string; side: Side; price: number; shares: number;
  status: 'matched' | 'confirmed' | 'failed'; at: number;
}

export interface MmVenue {
  readonly kind: 'dry-run' | 'clob';
  place(request: PlaceRequest): Promise<PlaceResult>;
  cancel(ids: string[]): Promise<{ cancelled: string[]; failed: string[] }>;
  cancelAll(): Promise<void>;
  openOrders(): Promise<VenueOrder[]>;
  getOrder(id: string): Promise<VenueOrder | null>;
  /** Dead-man switch. False (or a throw) counts as a missed heartbeat. */
  heartbeat(): Promise<boolean>;
  /** Venue-side token balances, for drift checks. Optional. */
  positions?(): Promise<Map<string, number>>;
}

/**
 * In-memory venue. Orders rest until cancelled or until `touch()` reports a book that
 * trades through them (price-through rule: a resting bid fills only when the best ask
 * drops below it). Failure hooks exist for tests.
 */
export class DryRunVenue implements MmVenue {
  readonly kind = 'dry-run' as const;
  private orders = new Map<string, VenueOrder & { closed?: boolean }>();
  private seq = 0;
  private fillSeq = 0;
  private held = new Map<string, number>();
  readonly sent: PlaceRequest[] = [];
  failNextPlace: string | null = null;
  throwNextPlace = false;
  /** Accept the order but throw before returning, as a lost acknowledgement would. */
  loseNextAck = false;
  heartbeatOk = true;
  onFill: (fill: VenueFill) => void = () => {};

  constructor(private clock: () => number = Date.now) {}

  async place(r: PlaceRequest): Promise<PlaceResult> {
    this.sent.push(r);
    if (this.throwNextPlace) { this.throwNextPlace = false; throw new Error('network: request timed out'); }
    if (this.failNextPlace) { const error = this.failNextPlace; this.failNextPlace = null; return { ok: false, error }; }
    const id = `dry-${++this.seq}`;
    this.orders.set(id, { id, tokenId: r.tokenId, side: r.side, price: r.price, originalShares: r.shares, matchedShares: 0, status: 'open', createdAt: this.clock() });
    if (this.loseNextAck) { this.loseNextAck = false; throw new Error('network: connection reset after send'); }
    return { ok: true, venueOrderId: id };
  }

  async cancel(ids: string[]) {
    const cancelled: string[] = [], failed: string[] = [];
    for (const id of ids) {
      const o = this.orders.get(id);
      if (o && o.status === 'open') { o.status = 'cancelled'; cancelled.push(id); } else failed.push(id);
    }
    return { cancelled, failed };
  }

  async cancelAll() { for (const o of this.orders.values()) if (o.status === 'open') o.status = 'cancelled'; }
  async openOrders() { return [...this.orders.values()].filter((o) => o.status === 'open').map((o) => ({ ...o })); }
  async getOrder(id: string) { const o = this.orders.get(id); return o ? { ...o } : null; }
  async heartbeat() { if (!this.heartbeatOk) await this.cancelAll(); return this.heartbeatOk; }
  async positions() { return new Map(this.held); }

  /** Feed a public book top; fills our resting orders that the book has traded through. */
  touch(tokenId: string, bestBid: number, bestAsk: number, maxShares = Infinity) {
    for (const o of this.orders.values()) {
      if (o.status !== 'open' || o.tokenId !== tokenId) continue;
      const through = o.side === 'BUY' ? bestAsk < o.price - 1e-9 : bestBid > o.price + 1e-9;
      if (!through) continue;
      this.fillOrder(o.id, Math.min(maxShares, o.originalShares - o.matchedShares));
    }
  }

  /** Fill part or all of a resting order directly (tests, replay). */
  fillOrder(id: string, shares: number, status: VenueFill['status'] = 'matched') {
    const o = this.orders.get(id);
    if (!o || shares <= 0) return;
    o.matchedShares = Math.min(o.originalShares, o.matchedShares + shares);
    if (o.matchedShares >= o.originalShares - 1e-9) o.status = 'filled';
    const sign = o.side === 'BUY' ? 1 : -1;
    this.held.set(o.tokenId, (this.held.get(o.tokenId) ?? 0) + sign * shares);
    this.onFill({ tradeId: `dry-trade-${++this.fillSeq}`, venueOrderId: id, tokenId: o.tokenId, side: o.side, price: o.price, shares, status, at: this.clock() });
  }
}
