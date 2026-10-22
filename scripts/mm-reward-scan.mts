// Full reward-market scan: every reward-eligible market from CLOB /sampling-markets, books fetched in batches.
// Read-only public GETs and the public batch /books POST; no orders, no keys.
// Writes a ranked candidate list and a universe file in the runner's --discovery=file format.
import fs from 'node:fs';
import path from 'node:path';

const CLOB = 'https://clob.polymarket.com';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const OUT = path.resolve(args.out ?? `tmp/commercial-evidence/mm-reward-scan-${new Date().toISOString().slice(0, 10)}.json`);
const LIMIT = Number(args.limit ?? 40);              // markets in the universe output
const MIN_DAYS = Number(args.minDays ?? 7);          // time to end date
const MIN_POOL = Number(args.minPool ?? 5);          // daily pool, USD
const MAX_MIN_SIZE = Number(args.maxMinSize ?? 1000);
const MIN_COMPETITION = Number(args.minCompetition ?? 10_000); // per-side in-band score; below = "thin"
const INCLUDE_THIN = args.includeThin === 'true';   // thin markets go in the universe only when asked
const now = Date.now();

const getJson = async (url: string, init?: RequestInit) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    if (r.ok) return r.json() as Promise<any>;
    if (r.status !== 429 && r.status < 500) throw Error(`${r.status} ${url}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw Error(`retries exhausted ${url}`);
};
const score = (levels: any[], mid: number, v: number) =>
  levels.reduce((a, l) => { const d = Math.abs(Number(l.price) - mid); return d <= v ? a + Number(l.size) * ((v - d) / v) ** 2 : a; }, 0);

// 1. All reward-eligible markets.
const all: any[] = []; let cursor = '';
for (let page = 0; page < 100; page++) {
  const j = await getJson(`${CLOB}/sampling-markets${cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : ''}`);
  all.push(...(j.data ?? []));
  if (!j.next_cursor || j.next_cursor === 'LTE=' || !(j.data ?? []).length) break;
  cursor = j.next_cursor;
}

const rejected: Record<string, number> = {};
const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
const pre: any[] = [];
for (const m of all) {
  const pool = (m.rewards?.rates ?? []).reduce((a: number, r: any) => a + Number(r.rewards_daily_rate ?? 0), 0);
  const maxSpread = Number(m.rewards?.max_spread) / 100, minSize = Number(m.rewards?.min_size ?? 0);
  const end = Date.parse(m.end_date_iso ?? '');
  if (!m.accepting_orders || m.closed || !m.active) { reject('not_open'); continue; }
  if (m.game_start_time) { reject('sports_event'); continue; }
  if (!(pool >= MIN_POOL)) { reject('small_pool'); continue; }
  if (!(maxSpread > 0 && minSize > 0)) { reject('no_reward_params'); continue; }
  if (minSize > MAX_MIN_SIZE) { reject('reward_min_size_too_large'); continue; }
  if (!Number.isFinite(end) || end - now < MIN_DAYS * 86_400_000) { reject('ends_too_soon'); continue; }
  if (!Array.isArray(m.tokens) || m.tokens.length !== 2) { reject('not_binary'); continue; }
  pre.push({ m, pool, maxSpread, minSize, end });
}

// 2. Books in batches of 50 (outcome-0 token; the other side mirrors it).
const books = new Map<string, any>();
for (let i = 0; i < pre.length; i += 50) {
  const ids = pre.slice(i, i + 50).map((c) => ({ token_id: c.m.tokens[0].token_id }));
  const rows = await getJson(`${CLOB}/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ids) }).catch(() => []);
  for (const b of rows) books.set(String(b.asset_id), b);
  await new Promise((r) => setTimeout(r, 150));
}

// 3. Score each market for a minimum-size two-sided quote at the touch.
const candidates: any[] = [];
for (const { m, pool, maxSpread, minSize, end } of pre) {
  const b = books.get(String(m.tokens[0].token_id));
  if (!b?.bids?.length || !b?.asks?.length) { reject('empty_book'); continue; }
  const bid = Math.max(...b.bids.map((l: any) => Number(l.price))), ask = Math.min(...b.asks.map((l: any) => Number(l.price)));
  const mid = (bid + ask) / 2;
  if (!(bid < ask)) { reject('crossed'); continue; }
  if (mid < 0.1 || mid > 0.9) { reject('extreme_price'); continue; }
  if (mid - bid > maxSpread || ask - mid > maxSpread) { reject('touch_outside_band'); continue; }
  const cBid = score(b.bids, mid, maxSpread), cAsk = score(b.asks, mid, maxSpread);
  const ours = (p: number) => minSize * ((maxSpread - Math.abs(p - mid)) / maxSpread) ** 2;
  const share = Math.min(ours(bid) / (ours(bid) + cBid), ours(ask) / (ours(ask) + cAsk));
  const capitalUsd = minSize * bid + minSize * (1 - ask);
  const thin = Math.min(cBid, cAsk) < MIN_COMPETITION;
  candidates.push({
    conditionId: m.condition_id, title: m.question, slug: m.market_slug, event: String(m.neg_risk_market_id || m.condition_id),
    family: 'reward-scan', eventAt: end, eventBufferMs: 600_000, lifecycle: 'market-close', negativeRisk: !!m.neg_risk, protocol: 'v1',
    tokens: m.tokens.map((t: any) => ({ id: String(t.token_id), outcome: String(t.outcome) })),
    rewards: { dailyPoolUsd: pool, maxSpread, minSize },
    triage: { mid, spread: ask - bid, tick: Number(b.tick_size ?? m.minimum_tick_size), competitionBid: Math.round(cBid), competitionAsk: Math.round(cAsk),
      thin, estShare: share, estUsdPerDay: share * pool, capitalUsd, estUsdPerDayPer100: capitalUsd > 0 ? (share * pool) / capitalUsd * 100 : 0 },
  });
}

candidates.sort((a, b) => b.triage.estUsdPerDayPer100 - a.triage.estUsdPerDayPer100);
const seen = new Set<string>(), selected: any[] = [];
for (const c of candidates) {
  if (c.triage.thin && !INCLUDE_THIN) continue;
  if (seen.has(c.event)) continue; // one market per event / multi-outcome group
  seen.add(c.event); selected.push(c); if (selected.length >= LIMIT) break;
}
const sum = (xs: any[], k: string) => xs.reduce((a, x) => a + x.triage[k], 0);
const summary = {
  scannedAt: new Date(now).toISOString(), rewardMarkets: all.length, totalDailyPoolUsd: Math.round(all.reduce((a, m) => a + (m.rewards?.rates ?? []).reduce((b: number, r: any) => b + Number(r.rewards_daily_rate ?? 0), 0), 0)),
  scored: candidates.length, thin: candidates.filter((c) => c.triage.thin).length, rejected,
  selected: selected.length, selectedUsdPerDay: sum(selected, 'estUsdPerDay'), selectedCapitalUsd: sum(selected, 'capitalUsd'),
  criteria: { MIN_DAYS, MIN_POOL, MAX_MIN_SIZE, MIN_COMPETITION, INCLUDE_THIN, LIMIT },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ ...summary, selected, candidates }, null, 2));
console.log(JSON.stringify(summary));
