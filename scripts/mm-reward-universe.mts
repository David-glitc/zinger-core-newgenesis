// Build a paper-MM universe of reward-paying, long-dated, non-sports markets. Read-only public GETs; no orders.
// Output matches the runner's --discovery=file --universe=<path> format.
import fs from 'node:fs';
import path from 'node:path';

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const CLOB = 'https://clob.polymarket.com';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const OUT = path.resolve(args.out ?? `tmp/commercial-evidence/mm-reward-universe-${new Date().toISOString().slice(0, 10)}.json`);
const LIMIT = Number(args.limit ?? 10);             // markets selected
const PAGES = Number(args.pages ?? 6);              // Gamma pages of 100, by 24h volume
const MIN_DAYS = Number(args.minDays ?? 7);         // time to end date
const MAX_MIN_SIZE = Number(args.maxMinSize ?? 200); // reward minimum size, shares
const MIN_COMPETITION = Number(args.minCompetition ?? 10_000); // thin-book floor, same as the stub
const now = Date.now();

const getJson = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`${r.status} ${url}`);
  return r.json() as Promise<any>;
};
const score = (levels: any[], mid: number, v: number) =>
  levels.reduce((a, l) => { const d = Math.abs(Number(l.price) - mid); return d <= v ? a + Number(l.size) * ((v - d) / v) ** 2 : a; }, 0);

const pool: any[] = [];
for (let p = 0; p < PAGES; p++) pool.push(...await getJson(`${GAMMA}?active=true&closed=false&order=volume24hr&ascending=false&limit=100&offset=${p * 100}`));

const rejected: Record<string, number> = {};
const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
const candidates: any[] = [];
for (const m of pool) {
  const dailyPoolUsd = Array.isArray(m.clobRewards) ? m.clobRewards.reduce((a: number, r: any) => a + Number(r.rewardsDailyRate ?? 0), 0) : 0;
  const maxSpread = Number(m.rewardsMaxSpread) / 100, minSize = Number(m.rewardsMinSize ?? 0);
  const end = Date.parse(m.endDate ?? '');
  if (!(dailyPoolUsd > 0 && maxSpread > 0 && minSize > 0)) { reject('no_rewards'); continue; }
  if (m.negRisk !== false && args.allowNegRisk !== 'true') { reject('negative_risk'); continue; }
  if (m.gameStartTime || m.sportsMarketType) { reject('sports_event'); continue; }
  if (!Number.isFinite(end) || end - now < MIN_DAYS * 86_400_000) { reject('ends_too_soon'); continue; }
  if (minSize > MAX_MIN_SIZE) { reject('reward_min_size_too_large'); continue; }
  const tokens: string[] = JSON.parse(m.clobTokenIds ?? '[]'), outcomes: string[] = JSON.parse(m.outcomes ?? '[]');
  if (tokens.length !== 2) { reject('not_binary'); continue; }
  const book = await getJson(`${CLOB}/book?token_id=${tokens[0]}`).catch(() => null);
  if (!book?.bids?.length || !book?.asks?.length) { reject('empty_book'); continue; }
  const bid = Math.max(...book.bids.map((l: any) => Number(l.price))), ask = Math.min(...book.asks.map((l: any) => Number(l.price)));
  const mid = (bid + ask) / 2;
  if (mid < 0.1 || mid > 0.9) { reject('extreme_price'); continue; }
  const cBid = score(book.bids, mid, maxSpread), cAsk = score(book.asks, mid, maxSpread);
  if (Math.min(cBid, cAsk) < MIN_COMPETITION) { reject('thin_competition'); continue; }
  // Expected share of the pool for a minimum-size quote at the touch, per dollar of capital at risk (both sides).
  const ours = (p: number) => minSize * ((maxSpread - Math.abs(p - mid)) / maxSpread) ** 2;
  const share = Math.min(ours(bid) / (ours(bid) + cBid), ours(ask) / (ours(ask) + cAsk));
  const capitalUsd = minSize * bid + minSize * (1 - ask);
  candidates.push({
    conditionId: m.conditionId, title: m.question, slug: m.slug, event: String(m.events?.[0]?.slug ?? m.conditionId),
    family: 'reward-long-dated', eventAt: end, eventBufferMs: 600_000, lifecycle: 'market-close', negativeRisk: m.negRisk !== false, protocol: 'v1',
    tokens: tokens.map((id, i) => ({ id, outcome: outcomes[i] ?? String(i) })),
    rewards: { dailyPoolUsd, maxSpread, minSize },
    triage: { mid, spread: ask - bid, competitionBid: Math.round(cBid), competitionAsk: Math.round(cAsk), estShare: share,
      estUsdPerDay: share * dailyPoolUsd, capitalUsd, estUsdPerDayPer100: capitalUsd > 0 ? (share * dailyPoolUsd) / capitalUsd * 100 : 0 },
  });
  await new Promise((r) => setTimeout(r, 120));
}

// One market per event, ranked by projected reward per $100 of capital.
candidates.sort((a, b) => b.triage.estUsdPerDayPer100 - a.triage.estUsdPerDayPer100);
const seen = new Set<string>(), selected: any[] = [];
for (const c of candidates) { if (seen.has(c.event)) { reject('same_event'); continue; } seen.add(c.event); selected.push(c); if (selected.length >= LIMIT) break; }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date(now).toISOString(), criteria: { PAGES, MIN_DAYS, MAX_MIN_SIZE, MIN_COMPETITION, LIMIT }, scanned: pool.length, rejected, selected }, null, 2));
console.log(JSON.stringify({ out: OUT, scanned: pool.length, qualified: candidates.length, selected: selected.length, rejected }));
for (const s of selected) console.log([s.triage.estUsdPerDayPer100.toFixed(3).padStart(7), `$${s.triage.estUsdPerDay.toFixed(3)}/d`.padEnd(11), `cap$${Math.round(s.triage.capitalUsd)}`.padEnd(8), `min${s.rewards.minSize}`.padEnd(7), `mid${s.triage.mid.toFixed(3)}`, s.title.slice(0, 55)].join(' | '));
