import { describe, expect, it } from 'vitest';
import { DepthState } from '../../src/research/depthState.js';

const seed = (id = 'up', at = 1000) => ({ event_type: 'book', asset_id: id, timestamp: at, bids: [{ price: '.4', size: '10' }], asks: [{ price: '.6', size: '20' }] });
const delta = (at: number, changes: any[]) => ({ event_type: 'price_change', timestamp: at, price_changes: changes });
describe('research full-depth state', () => {
  it('requires a snapshot before deltas and clears state on reconnect', () => {
    const s = new DepthState(); s.ingest(delta(1000, [{ asset_id: 'up', side: 'BUY', price: '.4', size: '2' }]), 1000);
    expect(s.snapshot('up', 1000).usable).toBe(false);
    s.ingest(seed(), 1000); expect(s.snapshot('up', 1000).usable).toBe(true);
    s.reset(); expect(s.snapshot('up', 1000).seeded).toBe(false);
  });
  it('handles arrays of mixed snapshot and delta events with no depth truncation', () => {
    const s = new DepthState(); const event = seed();
    event.bids = Array.from({ length: 30 }, (_, i) => ({ price: String(.4 - i * .01), size: '10' }));
    s.ingest([event, delta(1001, [{ asset_id: 'up', side: 'BUY', price: '.5', size: '25' }])], 1001);
    const snap = s.snapshot('up', 1001); expect(snap.bids).toHaveLength(31); expect(snap.bestBid).toBe(.5);
    expect(snap.microprice).toBeCloseTo((.5 * 20 + .6 * 25) / 45);
  });
  it('supports new payload field names and size-zero deletion', () => {
    const s = new DepthState(); s.ingest({ type: 'book', payload: { ...seed(), assetId: 'up' } }, 1000);
    s.ingest({ type: 'price_change', payload: { timestamp: 1001, priceChanges: [{ assetId: 'up', side: 'BUY', price: '.4', size: '0' }] } }, 1001);
    expect(s.snapshot('up', 1001).bids).toHaveLength(0);
  });
  it('does not refresh depth timestamps from trades', () => {
    const s = new DepthState(); s.ingest(seed(), 1000);
    s.ingest({ event_type: 'last_trade_price', asset_id: 'up', timestamp: 20_000, price: '.5' }, 20_000);
    expect(s.snapshot('up', 20_000).usable).toBe(false); expect(s.snapshot('up', 20_000).receivedAt).toBe(1000);
  });
  it('invalidates out-of-order deltas and requires a new snapshot', () => {
    const s = new DepthState(); s.ingest(seed(), 1000);
    s.ingest(delta(999, [{ asset_id: 'up', side: 'BUY', price: '.45', size: '5' }]), 1001);
    expect(s.snapshot('up', 1001).issue).toBe('out_of_order');
    s.ingest(delta(1002, [{ asset_id: 'up', side: 'BUY', price: '.45', size: '5' }]), 1002);
    expect(s.snapshot('up', 1002).usable).toBe(false);
    s.ingest(seed('up', 1003), 1003); expect(s.snapshot('up', 1003).usable).toBe(true);
  });
  it('rejects mismatched touches and malformed sizes instead of deleting levels', () => {
    const s = new DepthState(); s.ingest(seed(), 1000);
    s.ingest(delta(1001, [{ asset_id: 'up', side: 'BUY', price: '.4', size: 'garbage' }]), 1001);
    expect(s.snapshot('up', 1001).issue).toBe('malformed_delta'); expect(s.snapshot('up', 1001).bids).toHaveLength(1);
    s.ingest(seed('up', 1002), 1002);
    s.ingest(delta(1003, [{ asset_id: 'up', side: 'BUY', price: '.45', size: '5', best_bid: '.46', best_ask: '.6' }]), 1003);
    expect(s.snapshot('up', 1003).issue).toBe('touch_mismatch');
  });
  it('uses server age as well as receive age', () => {
    const s = new DepthState(); s.ingest(seed(), 20_000);
    expect(s.snapshot('up', 20_000).usable).toBe(false);
  });
  it('changes revision even for two updates received in the same millisecond', () => {
    const s = new DepthState(); s.ingest(seed(), 1000); const initial = s.snapshot('up', 1000).revision;
    s.ingest(delta(1000, [{ asset_id: 'up', side: 'BUY', price: '.4', size: '12' }]), 1000);
    expect(s.snapshot('up', 1000).revision).toBeGreaterThan(initial);
  });
  it('invalidates only a disconnected market while preserving unrelated depth', () => {
    const s = new DepthState();
    for (const id of ['btc-up', 'btc-down', 'eth-up', 'eth-down']) s.ingest(seed(id), 1000);
    s.remove(['btc-up', 'btc-down']);
    expect(s.snapshot('btc-up', 1000).seeded).toBe(false);
    expect(s.snapshot('btc-down', 1000).seeded).toBe(false);
    expect(s.snapshot('eth-up', 1000).usable).toBe(true);
    expect(s.snapshot('eth-down', 1000).usable).toBe(true);
  });
});
