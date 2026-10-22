export interface DepthLevel { price: number; size: number }
interface Ladder { bids: Map<number, number>; asks: Map<number, number>; serverAt: number; receivedAt: number; seeded: boolean; issue: string | null; revision: number }

/** Full depth reconstruction for research. A trade never makes an old depth snapshot fresh. */
export class DepthState {
  private books = new Map<string, Ladder>();
  private ladder(id: string): Ladder {
    if (!this.books.has(id)) this.books.set(id, { bids: new Map(), asks: new Map(), serverAt: 0, receivedAt: 0, seeded: false, issue: 'unseeded', revision: 0 });
    return this.books.get(id)!;
  }
  reset() { this.books.clear(); }
  remove(ids: string[]) { for (const id of ids) this.books.delete(id); }
  ingest(data: any, receivedAt: number): string[] {
    if (Array.isArray(data)) return [...new Set(data.flatMap(item => this.ingest(item, receivedAt)))];
    const type = data.event_type ?? data.type, p = data.payload ?? data;
    if (type === 'book' || (p.bids && p.asks)) {
      const id = String(p.asset_id ?? p.assetId ?? p.tokenId ?? ''); if (!id) return [];
      const l = this.ladder(id), serverAt = Number(p.timestamp);
      l.revision++;
      if (!(serverAt > 0) || serverAt < l.serverAt) { l.issue = 'out_of_order'; return [id]; }
      const load = (rows: any[]) => new Map<number, number>((rows ?? []).map(r => [Number(r.price), Number(r.size)] as [number, number])
        .filter(([px, size]) => Number.isFinite(px) && px >= 0 && px <= 1 && Number.isFinite(size) && size > 0));
      l.bids = load(p.bids); l.asks = load(p.asks); l.serverAt = serverAt; l.receivedAt = receivedAt; l.seeded = true; l.issue = null;
      return [id];
    }
    if (type !== 'price_change') return [];
    const changed = new Set<string>();
    for (const c of p.price_changes ?? p.priceChanges ?? []) {
      const id = String(c.asset_id ?? c.assetId ?? ''), l = this.ladder(id); if (!id) continue;
      l.revision++;
      changed.add(id);
      const serverAt = Number(p.timestamp), px = Number(c.price), size = Number(c.size);
      if (!l.seeded || !(serverAt > 0) || serverAt < l.serverAt || l.issue) { l.issue ??= l.seeded ? 'out_of_order' : 'unseeded'; continue; }
      const map = c.side === 'BUY' ? l.bids : c.side === 'SELL' ? l.asks : null;
      if (!map || !Number.isFinite(px) || px < 0 || px > 1 || !Number.isFinite(size) || size < 0) { l.issue = 'malformed_delta'; continue; }
      if (size === 0) map.delete(px); else map.set(px, size);
      l.serverAt = serverAt; l.receivedAt = receivedAt;
    }
    // Check touches after the complete multi-level event, avoiding transient crossings.
    for (const id of changed) {
      const l = this.ladder(id), bid = Math.max(...l.bids.keys()), ask = Math.min(...l.asks.keys());
      if (bid > ask) l.issue = 'crossed';
      const relevant = (p.price_changes ?? p.priceChanges ?? []).filter((c: any) => String(c.asset_id ?? c.assetId) === id);
      const last = relevant.at(-1);
      const advertisedBid = last?.best_bid ?? last?.bestBid, advertisedAsk = last?.best_ask ?? last?.bestAsk;
      if ((advertisedBid != null && l.bids.size && Math.abs(Number(advertisedBid) - bid) > 1e-9) ||
          (advertisedAsk != null && l.asks.size && Math.abs(Number(advertisedAsk) - ask) > 1e-9)) l.issue = 'touch_mismatch';
    }
    return [...changed];
  }
  snapshot(id: string, now: number) {
    const l = this.ladder(id);
    const levels = (map: Map<number, number>, direction: number) => [...map].map(([price, size]) => ({ price, size })).sort((a, b) => direction * (a.price - b.price));
    const bids = levels(l.bids, -1), asks = levels(l.asks, 1);
    const bid = bids[0], ask = asks[0], crossed = bid && ask && bid.price > ask.price;
    const weighted = (rows: DepthLevel[]) => rows.slice(0, 5).reduce((sum, r, i) => sum + r.size * .7 ** i, 0);
    const b = weighted(bids), a = weighted(asks);
    const ageMs = l.receivedAt ? now - l.receivedAt : null;
    const serverAgeMs = l.serverAt ? now - l.serverAt : null;
    const usable = l.seeded && !l.issue && !crossed && !!bid && !!ask && ageMs! >= 0 && ageMs! <= 15_000 && serverAgeMs! >= -1000 && serverAgeMs! <= 15_000;
    return { bids, asks, seeded: l.seeded, issue: l.issue ?? (crossed ? 'crossed' : null), usable, revision: l.revision, receivedAt: l.receivedAt, serverAt: l.serverAt, ageMs, serverAgeMs,
      bestBid: bid?.price ?? null, bestAsk: ask?.price ?? null, spread: bid && ask ? ask.price - bid.price : null,
      imbalance5: b + a ? (b - a) / (b + a) : null,
      microprice: bid && ask ? (bid.price * ask.size + ask.price * bid.size) / (bid.size + ask.size) : null,
      bidSize5: bids.slice(0, 5).reduce((s, r) => s + r.size, 0), askSize5: asks.slice(0, 5).reduce((s, r) => s + r.size, 0) };
  }
}
