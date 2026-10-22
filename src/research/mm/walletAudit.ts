import type { Coverage } from './publicData.js';
export interface PublicTrade { proxy_wallet: string; condition_id: string; token_id: string; side: string; size: number; price: number; timestamp: number; title: string; slug: string; event_slug: string; outcome: string }
export interface MarketFlow { conditionId: string; title: string; slug: string; eventSlug: string; family: string; rows: number; buyUsd: number; sellUsd: number; grossUsd: number; shares: number; firstAt: number; lastAt: number; tokens: Record<string, { outcome: string; buys: number; sells: number; buyUsd: number; sellUsd: number }> }
/** Labelled heuristics for discovery only; these are not authoritative Gamma categories. */
export function marketFamily(title: string, slug: string): string {
  const s = `${title} ${slug}`.toLowerCase();
  if (/counter-strike|valorant|league of legends|dota|rocket league|(?:^|\s)(cs2|lol|dota2|val)-/.test(s)) return 'esports';
  if (/bitcoin|ethereum|solana|crypto|(?:btc|eth|sol|xrp)-updown/.test(s)) return 'crypto';
  if (/\batp\b|\bwta\b|\bitf\b|\btennis\b|masters:|wimbledon|roland garros/.test(s)) return 'tennis';
  if (/\bnba\b|\bwnba\b|basketball|(?:nba|wnba|cbb)-/.test(s)) return 'basketball';
  if (/\bnfl\b|\bncaaf\b|touchdown|(?:nfl|cfb)-/.test(s)) return 'american-football';
  if (/\bmlb\b|baseball|(?:mlb)-/.test(s)) return 'baseball';
  if (/\bnhl\b|hockey|(?:nhl)-/.test(s)) return 'hockey';
  if (/halftime|both teams.*score|end in a draw|(?:epl|sea|lal|bun|lig|ucl|uel|tur|srb|aze1|isl1|por|ere|sco|rus|bra|mls|arg|ita|eng|ger|esp|fra)-/.test(s)) return 'soccer';
  if (/election|president|trump|congress|senate|prime minister/.test(s)) return 'politics';
  if (/fed |interest rate|inflation|gdp|unemployment/.test(s)) return 'macro';
  if (/\bvs\.?\b|o\/u|spread:|will .* win on \d{4}/.test(s)) return 'sports-other';
  return 'unclassified';
}
export class TradeAudit {
  readonly markets = new Map<string, MarketFlow>();
  rejectedRows = 0; rows = 0; grossUsd = 0; buyUsd = 0; sellUsd = 0;
  constructor(readonly wallet: string, readonly start: number, readonly end: number) {}
  add(trades: PublicTrade[]) {
    for (const t of trades) {
      const q = Number(t.size), p = Number(t.price), at = Number(t.timestamp);
      if (String(t.proxy_wallet).toLowerCase() !== this.wallet.toLowerCase() || !/^0x[0-9a-f]{64}$/i.test(t.condition_id) || !t.token_id ||
          !['BUY','SELL'].includes(t.side) || ![q,p,at].every(Number.isFinite) || q <= 0 || p < 0 || p > 1 || at < this.start || at > this.end) { this.rejectedRows++; continue; }
      const usd = q * p; this.rows++; this.grossUsd += usd; this.buyUsd += t.side === 'BUY' ? usd : 0; this.sellUsd += t.side === 'SELL' ? usd : 0;
      if (!this.markets.has(t.condition_id)) this.markets.set(t.condition_id, { conditionId: t.condition_id, title: t.title, slug: t.slug, eventSlug: t.event_slug || `condition:${t.condition_id}`, family: marketFamily(t.title, t.slug), rows: 0, buyUsd: 0, sellUsd: 0, grossUsd: 0, shares: 0, firstAt: at, lastAt: at, tokens: {} });
      const m = this.markets.get(t.condition_id)!; m.rows++; m.grossUsd += usd; m.shares += q; m.firstAt = Math.min(m.firstAt, at); m.lastAt = Math.max(m.lastAt, at);
      m.buyUsd += t.side === 'BUY' ? usd : 0; m.sellUsd += t.side === 'SELL' ? usd : 0;
      const token = m.tokens[t.token_id] ??= { outcome: t.outcome, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0 };
      if (t.side === 'BUY') { token.buys += q; token.buyUsd += usd; } else { token.sells += q; token.sellUsd += usd; }
    }
  }
  summary(coverage: Coverage) {
    const ranked = [...this.markets.values()].sort((a,b) => b.grossUsd-a.grossUsd);
    const families: Record<string, { grossUsd: number; markets: number; rows: number }> = {};
    const events = new Map<string, number>();
    for (const m of ranked) { const f = families[m.family] ??= { grossUsd: 0, markets: 0, rows: 0 }; f.grossUsd += m.grossUsd; f.markets++; f.rows += m.rows; events.set(m.eventSlug, (events.get(m.eventSlug) ?? 0) + m.grossUsd); }
    const hhi = this.grossUsd > 0 ? ranked.reduce((s,m) => s+(m.grossUsd/this.grossUsd)**2,0) : null;
    return { coverage, rejectedRows: this.rejectedRows, rows: this.rows, grossUsd: this.grossUsd, buyUsd: this.buyUsd, sellUsd: this.sellUsd,
      netTradeCashBeforeFeesUsd: this.sellUsd-this.buyUsd, marketCount: ranked.length, eventCount: events.size,
      sameTokenBuyAndSellMarkets: ranked.filter(m => Object.values(m.tokens).some(t => t.buys > 0 && t.sells > 0)).length,
      multipleOutcomeMarkets: ranked.filter(m => Object.keys(m.tokens).length > 1).length,
      topTenMarketNotionalShare: this.grossUsd > 0 ? ranked.slice(0,10).reduce((s,m)=>s+m.grossUsd,0)/this.grossUsd : null,
      notionalHHI: hhi, effectiveMarketCount: hhi != null && hhi > 0 ? 1/hhi : null,
      families, topEvents: [...events].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([slug,grossUsd])=>({slug,grossUsd})), markets: ranked };
  }
}
export function makerRowEstimate(all: ReturnType<TradeAudit['summary']>, taker: ReturnType<TradeAudit['summary']>) {
  if (!all.coverage.complete || !taker.coverage.complete || all.rejectedRows || taker.rejectedRows || taker.rows > all.rows || taker.grossUsd > all.grossUsd+1e-6)
    return { available: false, makerRows: null, makerRowShare: null, makerNotionalShare: null, reason: 'Incomplete or inconsistent matching-window feeds' };
  return { available: true, makerRows: all.rows-taker.rows, makerRowShare: all.rows ? 1-taker.rows/all.rows : null,
    makerNotionalShare: all.grossUsd ? 1-taker.grossUsd/all.grossUsd : null, reason: 'Aggregate difference between all-role and taker-only rows; quote lifecycle and identities are unverified' };
}
export function auditPnl(points: any[], cutoff: number) {
  const daily = points.filter(p => Number.isInteger(p.timestamp) && p.timestamp % 86400 === 0 && p.timestamp <= cutoff).sort((a,b)=>a.timestamp-b.timestamp);
  const pairs = daily.slice(1).map((p,i)=>({a:daily[i],b:p})).filter(({a,b})=>b.timestamp-a.timestamp===86400);
  const usable = pairs.filter(({a,b})=>[a.economic_pnl,b.economic_pnl,a.position_pnl,b.position_pnl].every(x=>typeof x==='number'&&Number.isFinite(x)));
  const increments = usable.map(({a,b})=>b.economic_pnl-a.economic_pnl);
  const mean = increments.length ? increments.reduce((a,b)=>a+b,0)/increments.length : null;
  const sd = increments.length>1 ? Math.sqrt(increments.reduce((s,x)=>s+(x-mean!)**2,0)/(increments.length-1)) : null;
  const compositionErrors = daily.filter(p=>[p.economic_pnl,p.position_pnl,p.wallet_income].every(x=>typeof x==='number'&&Number.isFinite(x)) && Math.abs(p.economic_pnl-p.position_pnl-p.wallet_income)>1e-4).length;
  const first=usable[0]?.a,last=usable.at(-1)?.b;
  return { dailyPoints: daily.length, completeDayIncrements: increments.length, missingOrIrregularIntervals: Math.max(0,daily.length-1-usable.length),
    from: first?.timestamp ?? null, to: last?.timestamp ?? null, economicPnlChangeUsd: first&&last ? last.economic_pnl-first.economic_pnl : null,
    positionPnlChangeUsd: first&&last ? last.position_pnl-first.position_pnl : null, walletIncomeChangeUsd: first&&last ? last.wallet_income-first.wallet_income : null,
    compositionErrors, meanDailyDollarPnl: mean, sdDailyDollarPnl: sd,
    dailyDollarPnlMeanOverSd: sd != null && sd > 0 ? mean!/sd : null,
    portfolioSharpe: null, cashflowCoverage: daily.filter(p=>p.cashflow_net != null).length,
    reason: 'Dollar PnL consistency only; no verified historical equity, external-flow ledger or annualized portfolio Sharpe' };
}
