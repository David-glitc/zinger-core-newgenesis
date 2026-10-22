import { publicJson } from './publicData.js';
import { marketFamily } from './walletAudit.js';

const wallets = ['0xfe787d2da716d60e8acff57fb87eb13cd4d10319', '0x2005d16a84ceefa912d4e380cd32e7ff827875ea', '0x821dab0565ebf5b327f51db06223fdcfe01acf16'];

/** Bounded recent public activity for discovery, not a complete wallet audit. */
export async function discoverMmUniverse(now = Date.now(), read = publicJson) {
  const turnover = new Map<string, number>();
  for (const wallet of wallets) {
    const url = new URL('https://data-api.polymarket.com/v2/trades');
    url.searchParams.set('user', wallet); url.searchParams.set('limit', '200');
    url.searchParams.set('taker_only', 'false');
    url.searchParams.set('start', String(Math.floor(now / 1000) - 3600));
    url.searchParams.set('end', String(Math.floor(now / 1000)));
    const response = await read(String(url));
    const rows = Array.isArray(response) ? response : response.data;
    if (!Array.isArray(rows)) throw Error('Malformed MM discovery trades');
    for (const t of rows) {
      const id = t.conditionId ?? t.condition_id;
      const price = Number(t.price), size = Number(t.size);
      if (typeof id === 'string' && /^0x[0-9a-f]{64}$/i.test(id) && Number.isFinite(price * size) && price > 0 && size > 0)
        turnover.set(id, (turnover.get(id) || 0) + price * size);
    }
  }
  const ids = [...turnover.keys()].sort((a,b) => turnover.get(b)! - turnover.get(a)!).slice(0,60);
  const metadata: any[] = [];
  for (let i = 0; i < ids.length; i += 15) {
    const batch = ids.slice(i,i+15), u = new URL('https://gamma-api.polymarket.com/markets');
    batch.forEach(id => u.searchParams.append('condition_ids',id)); u.searchParams.set('limit','100');
    const rows = await read(String(u));
    if (!Array.isArray(rows) || rows.some(m => !batch.includes(m.conditionId))) throw Error('Unrequested Gamma market in discovery');
    metadata.push(...rows);
  }
  const selected: any[] = [], events = new Set<string>(), families = new Map<string,number>();
  const skipped: Record<string,number> = {};
  for (const m of metadata.sort((a,b) => (turnover.get(b.conditionId) || 0) - (turnover.get(a.conditionId) || 0))) {
    const event = String(m.events?.[0]?.slug || '').replace(/-(more-markets|halftime-result|first-half|second-half)$/,'');
    const family = marketFamily(m.question, m.slug), eventAt = Date.parse(m.gameStartTime || m.events?.[0]?.startTime || '');
    const reason = !m.active || m.closed || !m.acceptingOrders ? 'inactive' : !event || !Number.isFinite(eventAt) ? 'unknown_event_time' : eventAt - now <= 600000 ? 'event_cutoff' : events.has(event) || (families.get(family) || 0) >= 3 ? 'diversification' : null;
    if (reason) { skipped[reason] = (skipped[reason] || 0) + 1; continue; }
    selected.push({conditionId:m.conditionId,title:m.question,slug:m.slug,event,family,eventAt});
    events.add(event); families.set(family,(families.get(family) || 0) + 1);
    if (selected.length === 8) break;
  }
  return {selected,discoveredAt:now,skipped,coverage:'At most 200 recent rows per public wallet; discovery sample, not an exhaustive wallet audit'};
}
