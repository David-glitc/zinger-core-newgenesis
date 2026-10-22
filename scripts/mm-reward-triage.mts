// Read-only reward-band triage for passive maker quoting. No orders, no keys.
import fs from 'node:fs';
import path from 'node:path';

const GAMMA = 'https://gamma-api.polymarket.com/markets';
const CLOB = 'https://clob.polymarket.com';
const PAGES = Number(process.env.TRIAGE_PAGES ?? 4);
const LIMIT = 100;
const OUT_DIR = path.resolve('tmp/commercial-evidence/mm-triage');
const now = Date.now();

const getJson = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error(`${r.status} ${url}`);
  return r.json() as Promise<any>;
};

// Gamma returns markets; keep active, open, reward-enabled ones.
const markets: any[] = [];
for (let p = 0; p < PAGES; p++) {
  const page = await getJson(`${GAMMA}?active=true&closed=false&order=volume24hr&ascending=false&limit=${LIMIT}&offset=${p * LIMIT}`);
  markets.push(...page);
}
const rewarded = markets.filter((m) =>
  Array.isArray(m.clobRewards) && m.clobRewards.length > 0 && Number(m.rewardsMaxSpread) > 0 &&
  m.endDate && Date.parse(m.endDate) > now && m.enableOrderBook !== false);

const rows: any[] = [];
for (const m of rewarded) {
  const tokens: string[] = JSON.parse(m.clobTokenIds ?? '[]');
  if (tokens.length !== 2) continue;
  const maxSpread = Number(m.rewardsMaxSpread) / 100; // cents -> price units
  const minSize = Number(m.rewardsMinSize ?? m.orderMinSize ?? 5);
  const daily = m.clobRewards.reduce((s: number, r: any) => s + Number(r.rewardsDailyRate ?? 0), 0);
  // Per token: book, midpoint, competing reward score inside the band.
  const sides = [];
  for (const t of tokens) {
    const book = await getJson(`${CLOB}/book?token_id=${t}`).catch(() => null);
    if (!book?.bids?.length || !book?.asks?.length) { sides.length = 0; break; }
    const bid = Math.max(...book.bids.map((l: any) => Number(l.price)));
    const ask = Math.min(...book.asks.map((l: any) => Number(l.price)));
    const mid = (bid + ask) / 2;
    // Quadratic reward score (docs): ((v - s)/v)^2 * size, bids/asks summed separately.
    const score = (levels: any[]) => levels.reduce((acc, l) => {
      const s = Math.abs(Number(l.price) - mid);
      return s <= maxSpread ? acc + Number(l.size) * ((maxSpread - s) / maxSpread) ** 2 : acc;
    }, 0);
    sides.push({ token: t, bid, ask, spread: ask - bid, mid, competitionScore: Math.min(score(book.bids), score(book.asks)) });
  }
  if (sides.length !== 2) continue;
  // Our candidate: minSize shares at the best bid, scored the same way.
  const ours = sides.map((s) => {
    const q = minSize * ((maxSpread - (s.mid - s.bid)) / maxSpread) ** 2;
    const share = q / (q + s.competitionScore || 1);
    return { ...s, ourScore: q, estShare: share };
  });
  const estShare = Math.min(...ours.map((o) => o.estShare));
  rows.push({
    question: m.question, slug: m.slug, endDate: m.endDate, volume24hr: Number(m.volume24hr ?? 0),
    rewardsMaxSpreadCents: Number(m.rewardsMaxSpread), minSize, dailyRewardPoolUsd: daily,
    spreadTicks: Math.round(ours[0].spread / Number(m.orderPriceMinTickSize ?? 0.01)),
    est_daily_reward_usd: +(estShare * daily).toFixed(4),
    tokens: ours.map((o) => ({ token: o.token, bid: o.bid, ask: o.ask, competitionScore: +o.competitionScore.toFixed(2), estShare: +o.estShare.toFixed(4) })),
  });
  await new Promise((r) => setTimeout(r, 150));
}

rows.sort((a, b) => b.est_daily_reward_usd - a.est_daily_reward_usd);
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date(now).toISOString().slice(0, 16).replace(/:/g, '');
const outFile = path.join(OUT_DIR, `reward-triage-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({ at: new Date(now).toISOString(), scanned: markets.length, rewarded: rewarded.length, scored: rows.length, rows }, null, 2));
console.log(JSON.stringify({ scanned: markets.length, rewarded: rewarded.length, scored: rows.length, outFile }));
for (const r of rows.slice(0, 15)) {
  console.log([r.est_daily_reward_usd.toFixed(3).padStart(8), `pool$${r.dailyRewardPoolUsd}`.padEnd(12), `band${r.rewardsMaxSpreadCents}c`.padEnd(9), `ticks${r.spreadTicks}`.padEnd(8), `vol$${Math.round(r.volume24hr)}`.padEnd(13), r.question.slice(0, 60)].join(' | '));
}
