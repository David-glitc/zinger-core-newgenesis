import { quoteFee, type QuoteFee, type QuoteLadder } from '../bookArbitrage.js';
export type MmRegime = 'warmup' | 'paused' | 'two-sided' | 'reduce-inventory';
export interface MidObservation { at: number; mid: number }
export interface MmInput {
  now: number; receivedAt: number; serverAt: number; usable: boolean;
  confirmedAt?: number;
  book: QuoteLadder; history: MidObservation[]; tick: number; minShares: number; fee: QuoteFee;
  accepting: boolean; eventAt: number | null; eventTimeRequired: boolean;
  eventBufferMs?: number;
  cashAvailableUsd: number; ownedShares: number; netOutcomeShares: number;
  marketCommittedUsd: number; eventCommittedUsd: number; portfolioCommittedUsd: number;
}
export interface MmConfig {
  maxAgeMs: number; maxSpread: number; minHistorySeconds: number; eventBufferMs: number;
  maxOrderShares: number; maxNetShares: number; maxMarketUsd: number; maxEventUsd: number; maxPortfolioUsd: number;
  reservePerShare: number; skewAtLimit: number; shockMove: number;
  quoteLifetimeMs?: number; feeReserveLegs?: number;
  /** Passive quotes placed this many ticks further from the touch (0 = at touch). Sweep setting, paper only. */
  quoteOffsetTicks?: number;
  /** Resting policy: keep an order while the new target is within this many ticks of it. */
  restToleranceTicks?: number;
  sigmaMultiplier?: number;
  maxCashLossUsd?:number;
}
export const DEFAULT_MM_CONFIG: MmConfig = {
  maxAgeMs: 1500, maxSpread: .12, minHistorySeconds: 20, eventBufferMs: 10*60_000,
  maxOrderShares: 5, maxNetShares: 20, maxMarketUsd: 10, maxEventUsd: 20, maxPortfolioUsd: 100,
  reservePerShare: .005, skewAtLimit: .02, shockMove: .03,
};
export interface MmQuote { side: 'BUY' | 'SELL'; price: number; shares: number; postOnly: true; expiresAt: number; maintenanceOf?:string }
export interface ExistingMmQuote {id:string;outcomeIndex:number;side:'BUY'|'SELL';price:number;remaining:number;originalShares:number;cancelAt?:number|null}
interface QuoteContext {workingSell?:boolean;existing?:ExistingMmQuote}
export type MmQuotePricing = 'model' | 'touch' | 'improve';
/** Recheck the source snapshot at order placement, after planning/latency. */
export function mmInputFreshAt(input:MmInput,at:number,maxAgeMs:number){
  const confirmationAt=input.confirmedAt??input.serverAt;
  return Number.isFinite(at)&&Number.isFinite(maxAgeMs)&&maxAgeMs>0&&input.usable&&
    [input.receivedAt,input.serverAt,confirmationAt].every(Number.isFinite)&&
    at-input.receivedAt>=0&&at-input.receivedAt<=maxAgeMs&&
    at-input.serverAt>=-1000&&
    at-confirmationAt>=(input.confirmedAt==null?-1000:0)&&at-confirmationAt<=maxAgeMs;
}
export function planMmQuote(input: MmInput, cfg: MmConfig = DEFAULT_MM_CONFIG, pricing:MmQuotePricing='model', context:QuoteContext={}) {
  const no = (regime: MmRegime, reason: string) => ({ regime, reason, quotes: [] as MmQuote[], fairReference: null as number|null, sigmaPerSqrtSecond: null as number|null });
  if (Object.values(cfg).some(x=>!Number.isFinite(x)||x<0) || cfg.maxAgeMs===0 || cfg.maxNetShares===0 || cfg.maxOrderShares===0 || cfg.maxSpread===0) throw Error('Invalid MM configuration');
  if(!['model','touch','improve'].includes(pricing))throw Error('Invalid MM quote pricing');
  const lifetime=cfg.quoteLifetimeMs??2000,feeLegs=cfg.feeReserveLegs??2;
  if(lifetime<500||lifetime>60000||!Number.isInteger(feeLegs)||feeLegs<1||feeLegs>2)throw Error('Invalid MM execution configuration');
  const x=input;
  const existing=context.existing;
  if(existing&&(!existing.id||!['BUY','SELL'].includes(existing.side)||![existing.price,existing.remaining,existing.originalShares].every(Number.isFinite)||existing.remaining<1e-6-1e-9||existing.remaining>existing.originalShares+1e-9||existing.originalShares<x.minShares||existing.originalShares>cfg.maxOrderShares||existing.cancelAt!=null))return no('paused','invalid_maintenance_order');
  if (![x.now,x.receivedAt,x.serverAt,x.tick,x.minShares,x.cashAvailableUsd,x.ownedShares,x.netOutcomeShares,x.marketCommittedUsd,x.eventCommittedUsd,x.portfolioCommittedUsd].every(Number.isFinite) || x.tick<=0 || x.tick>=1 || x.minShares<=0 || x.ownedShares<0 || x.cashAvailableUsd<0 || [x.marketCommittedUsd,x.eventCommittedUsd,x.portfolioCommittedUsd].some(v=>v<0)) return no('paused','invalid_state');
  if (!x.accepting || !mmInputFreshAt(x,x.now,cfg.maxAgeMs)) return no('paused','stale_or_unusable_book');
  const eventBuffer=x.eventBufferMs??cfg.eventBufferMs;
  if (!Number.isFinite(eventBuffer)||eventBuffer<0||(x.eventTimeRequired && x.eventAt==null) || (x.eventAt!=null && (!Number.isFinite(x.eventAt) || x.eventAt-x.now<=eventBuffer))) return no('paused','event_time_guard');
  const valid=(rows:QuoteLadder['bids'])=>rows.length>0 && rows.every(l=>Number.isFinite(l.price)&&l.price>0&&l.price<1&&Number.isFinite(l.size)&&l.size>0);
  if(!valid(x.book.bids)||!valid(x.book.asks))return no('paused','invalid_depth');
  const bids=[...x.book.bids].sort((a,b)=>b.price-a.price), asks=[...x.book.asks].sort((a,b)=>a.price-b.price);
  const bid=bids[0],ask=asks[0],spread=ask.price-bid.price,mid=(ask.price+bid.price)/2;
  if(spread<=0||spread>cfg.maxSpread)return no('paused','crossed_or_wide_book');
  const h=x.history.filter(p=>p.at<=x.now&&p.at>=x.now-60_000);
  if(h.some((p,i)=>!Number.isFinite(p.mid)||p.mid<=0||p.mid>=1||!Number.isFinite(p.at)||(i>0&&p.at<=h[i-1].at)))return no('paused','invalid_history');
  if(h.length<8 || (h.at(-1)!.at-h[0].at)/1000<cfg.minHistorySeconds || x.now-h.at(-1)!.at>cfg.maxAgeMs)return no('warmup','insufficient_recent_history');
  if(h.some((p,i)=>i>0&&p.at-h[i-1].at>5000))return no('warmup','history_gap');
  const last=h.at(-1)!,recent=h.find(p=>p.at>=last.at-5000)!;
  if(Math.abs(last.mid-recent.mid)>=cfg.shockMove)return no('paused','probability_shock');
  const elapsed=(last.at-h[0].at)/1000;
  const sigma=Math.sqrt(h.slice(1).reduce((s,p,i)=>s+(p.mid-h[i].mid)**2,0)/elapsed);
  // A conservative book reference, not a forecast of the true outcome probability.
  const micro=(bid.price*ask.size+ask.price*bid.size)/(bid.size+ask.size);
  const fair=mid*.8+micro*.2;
  const skew=cfg.skewAtLimit*Math.max(-1,Math.min(1,x.netOutcomeShares/cfg.maxNetShares));
  const center=fair-skew;
  // A maker entry is fee-free; one leg reserves an emergency taker exit.
  // Two legs retain the original conservative policy for controlled comparisons.
  const fees=feeLegs*quoteFee(1,fair,x.fee),sigmaMultiplier=cfg.sigmaMultiplier??1.5;
  const halfWidth=Math.max(x.tick,fees+cfg.reservePerShare+sigmaMultiplier*sigma*Math.sqrt(lifetime/1000));
  const floor=(p:number)=>Math.floor((p+1e-10)/x.tick)*x.tick;
  const ceil=(p:number)=>Math.ceil((p-1e-10)/x.tick)*x.tick;
  let bidReference=bid.price,askReference=ask.price;
  if(pricing==='improve'&&spread>=2*x.tick-1e-9){
    if(spread>=3*x.tick-1e-9){bidReference+=x.tick;askReference-=x.tick;}
    else if(x.ownedShares>=x.minShares||context.workingSell)askReference-=x.tick;
    else bidReference+=x.tick;
  }
  const passive=pricing!=='model';
  if(passive&&(cfg.quoteOffsetTicks??0)>0){const off=cfg.quoteOffsetTicks!*x.tick;bidReference-=off;askReference+=off;}
  const buy=floor(Math.min(passive?bidReference-skew:center-halfWidth,ask.price-x.tick)),sell=ceil(Math.max(passive?askReference-skew:center+halfWidth,bid.price+x.tick));
  if(passive&&(sell-buy+1e-10<2*cfg.reservePerShare+2*sigmaMultiplier*sigma*Math.sqrt(lifetime/1000)||buy>=sell))return no('paused','insufficient_spread_after_risk');
  const q=existing?.remaining??Math.max(x.minShares,cfg.maxOrderShares),quotes:MmQuote[]=[];
  const room=Math.max(0,Math.min(cfg.maxMarketUsd-x.marketCommittedUsd,cfg.maxEventUsd-x.eventCommittedUsd,cfg.maxPortfolioUsd-x.portfolioCommittedUsd,x.cashAvailableUsd));
  const buyCost=q*buy+quoteFee(q,buy,x.fee);
  if(q<=cfg.maxOrderShares && x.netOutcomeShares+q<=cfg.maxNetShares && buy>0 && buy<1 && buy<ask.price && buyCost<=room+1e-9&&(!existing||existing.side==='BUY'&&Math.abs(existing.price-buy)<1e-9))
    quotes.push({side:'BUY',price:buy,shares:q,postOnly:true,expiresAt:x.now+lifetime,...(existing?{maintenanceOf:existing.id}:{})});
  if(q<=cfg.maxOrderShares && x.ownedShares+1e-9>=q && x.netOutcomeShares-q>=-cfg.maxNetShares && sell>0 && sell<1 && sell>bid.price&&(!existing||existing.side==='SELL'&&Math.abs(existing.price-sell)<1e-9))
    quotes.push({side:'SELL',price:sell,shares:q,postOnly:true,expiresAt:x.now+lifetime,...(existing?{maintenanceOf:existing.id}:{})});
  return {regime: Math.abs(x.netOutcomeShares)>=cfg.maxNetShares ? 'reduce-inventory' as const : 'two-sided' as const,
    reason:quotes.length?'quote_intent_only':'inventory_cash_or_minimum_limit',quotes,fairReference:fair,sigmaPerSqrtSecond:sigma};
}

/** Reserve quote capital by event as well as market; related sports lines share a cap. */
export class QuoteReservations {
  private entries=new Map<string,{event:string;usd:number}>();
  release(key:string){this.entries.delete(key);}
  totals(market:string,event:string){let portfolio=0,byEvent=0;for(const [key,e]of this.entries){portfolio+=e.usd;if(e.event===event)byEvent+=e.usd;}
    return {market:this.entries.get(market)?.usd??0,event:byEvent,portfolio};}
  reserve(market:string,event:string,usd:number,cfg:MmConfig=DEFAULT_MM_CONFIG){
    if(!Number.isFinite(usd)||usd<0)throw Error('Invalid capital reservation');
    const old=this.entries.get(market);this.entries.delete(market);const t=this.totals(market,event);
    if(usd>cfg.maxMarketUsd+1e-9||t.event+usd>cfg.maxEventUsd+1e-9||t.portfolio+usd>cfg.maxPortfolioUsd+1e-9){if(old)this.entries.set(market,old);return false;}
    this.entries.set(market,{event,usd});return true;
  }
}

/** Both outcome bids share capital and a complete-set cost guard. These fills are not atomic. */
export function planMmPair(a: MmInput, b: MmInput, cfg: MmConfig = DEFAULT_MM_CONFIG, pricing:MmQuotePricing='model', existing:ExistingMmQuote[]=[]) {
  return planMmOutcomes(a,b,cfg,false,pricing,existing);
}

/** Independently fresh books may quote without assuming an atomic complete set. */
export function planMmIndependent(a: MmInput, b: MmInput, cfg: MmConfig = DEFAULT_MM_CONFIG, pricing:MmQuotePricing='model',existing:ExistingMmQuote[]=[]) {
  return planMmOutcomes(a,b,cfg,true,pricing,existing);
}

function planMmOutcomes(a: MmInput, b: MmInput, cfg: MmConfig, independent: boolean, pricing:MmQuotePricing,existing:ExistingMmQuote[]) {
  const plans=[a,b].map((input,i)=>{
    const working=existing.filter(q=>q.outcomeIndex===i&&q.cancelAt==null),workingSell=working.some(q=>q.side==='SELL'&&q.remaining>0&&q.remaining<=input.ownedShares+1e-9);
    const p=planMmQuote(input,cfg,pricing,{workingSell});
    for(const q of working){const maintenance=planMmQuote(input,cfg,pricing,{workingSell,existing:q}).quotes;
      if(maintenance.length)p.quotes=[...p.quotes.filter(next=>next.side!==q.side),...maintenance];}
    return p;
  });
  if(!independent && (Math.abs((a.confirmedAt??a.serverAt)-(b.confirmedAt??b.serverAt))>250 || plans.some(p=>p.regime==='paused'||p.regime==='warmup')))
    return {plans,quotes:[] as (MmQuote&{outcomeIndex:number})[],reason:'pair_not_ready',buyReservationUsd:0};
  let quotes=plans.flatMap((p,i)=>p.quotes.map(q=>({...q,outcomeIndex:i})));
  let buys=quotes.filter(q=>q.side==='BUY');
  let reserve=buys.reduce((s,q)=>s+q.shares*q.price+quoteFee(q.shares,q.price,a.fee),0);
  const room=Math.max(0,Math.min(cfg.maxMarketUsd-a.marketCommittedUsd,cfg.maxEventUsd-a.eventCommittedUsd,cfg.maxPortfolioUsd-a.portfolioCommittedUsd,a.cashAvailableUsd));
  let sharedCapitalGuard=false;
  if(reserve>room+1e-9){
    if(!independent){quotes=quotes.filter(q=>q.side==='SELL');buys=[];reserve=0;sharedCapitalGuard=true;}
    else{
    let left=room;const accepted=new Set<typeof buys[number]>();
    for(const q of [...buys].sort((x,y)=>[a,b][x.outcomeIndex].netOutcomeShares-[a,b][y.outcomeIndex].netOutcomeShares||x.price-y.price)){
      const cost=q.shares*q.price+quoteFee(q.shares,q.price,a.fee);if(cost<=left+1e-9){accepted.add(q);left-=cost;}
    }
    quotes=quotes.filter(q=>q.side==='SELL'||accepted.has(q));buys=quotes.filter(q=>q.side==='BUY');reserve=room-left;
    if(!quotes.length)return{plans,quotes,reason:'shared_capital_limit',buyReservationUsd:0};
    }
  }
  // Touch pricing models actual fee-free maker entries. Capital still reserves
  // emergency taker costs above; fills of the two outcomes are never atomic.
  let costGuard=false;
  if(buys.length===2 && buys.reduce((s,q)=>s+q.price+(pricing!=='model'?0:quoteFee(1,q.price,a.fee)),0)>1-cfg.reservePerShare){
    quotes=quotes.filter(q=>q.side==='SELL');reserve=0;costGuard=true;
  }
  // Improving both outcome asks can erase the entire complete-set premium.
  // Retain the reserve while keeping the more overweight outcome competitive.
  const sells=quotes.filter(q=>q.side==='SELL');
  if(sells.length===2){
    const missing=1+cfg.reservePerShare-sells.reduce((sum,q)=>sum+q.price,0);
    if(missing>1e-9){
      const widen=[...sells].sort((x,y)=>[a,b][x.outcomeIndex].netOutcomeShares-[a,b][y.outcomeIndex].netOutcomeShares||y.outcomeIndex-x.outcomeIndex)[0];
      const tick=[a,b][widen.outcomeIndex].tick,price=Math.ceil((widen.price+missing-1e-10)/tick)*tick;
      if(price>=1)quotes=quotes.filter(q=>q.side!=='SELL');
      else quotes=quotes.flatMap(q=>q!==widen?[q]:q.maintenanceOf?[]:[{...q,price}]);
    }
  }
  return{plans,quotes,reason:costGuard?'complete_set_cost_guard':sharedCapitalGuard?'shared_capital_limit':quotes.length?'paper_quote_intent':'no_quote',buyReservationUsd:reserve};
}
