import {quoteFee, type QuoteFee, type QuoteLadder} from '../bookArbitrage.js';
import {MmPaperInventory, PaperQueue} from './paperInventory.js';
import {DEFAULT_MM_CONFIG, type MmConfig, type MmQuote} from './strategy.js';
import type {RecoveredPaperSession} from './recovery.js';
import {allocateCtfPrint,CTF_MATCHING_MODEL,CtfTapeBudget,economicKey,economicQuote,nativeTransaction,syntheticCross,type CtfMatchingModel} from './ctfMatching.js';

export type PaperExpiryPolicy='fixed-expiry'|'renewable-client-lease-v1'|'resting-tolerance-v1';
/** Resting GTC quotes: an order keeps its queue position while the new target stays within restToleranceTicks and does not cross the book. */
export const RESTING_POLICY='resting-tolerance-v1';
export interface PaperMarket {conditionId:string;event:string;tokens:[string,string];fee:QuoteFee;minShares:number;tick:number;mergeSupported:boolean;quoteDeadlineAt?:number}
interface RestingQuote {id:string;market:PaperMarket;token:string;side:'BUY'|'SELL';price:number;originalShares:number;queue:PaperQueue;activateAt:number;expiresAt:number;expiryPolicy:PaperExpiryPolicy;cancelAt?:number;cancelReason?:string}
export interface PaperPrint {id:string;token:string;aggressor:'BUY'|'SELL';price:number;shares:number;at:number}
export type PaperQueueModel = 'same-price' | 'legacy-cumulative';
export type PaperFillRule = 'exact-price' | 'price-through';
export class MmPaperSession {
  readonly inventory:MmPaperInventory;
  readonly markets=new Map<string,PaperMarket>();
  private resting=new Map<string,RestingQuote>();
  private sequence=0;
  private seenPrints=new Set<string>();
  private splitMarkets=new Set<string>();
  private pendingMerges=new Set<string>();
  private forcedMerges=new Set<string>();
  private inventoryReserves=new Map<string,number>();
  private resolvedMarkets=new Set<string>();
  private clock=0;
  private recoveryQuarantineUntil=0;
  private tapeBudget=new CtfTapeBudget();
  leasesRenewed=0;
  restingKept=0;
  simulatedFills=0;simulatedMerges=0;simulatedSplits=0;simulatedSettlements=0;quotesPlaced=0;quotesCancelled=0;printsSeen=0;printsRejected=0;
  constructor(bankroll:number,readonly config:MmConfig={...DEFAULT_MM_CONFIG,maxPortfolioUsd:50},readonly record:(type:string,data:any)=>void=()=>{},readonly latencyMs=250,readonly queueModel:PaperQueueModel='same-price',readonly fillRule:PaperFillRule='exact-price',readonly cancelLatencyMs=0,readonly matchingModel:CtfMatchingModel='direct',readonly expiryPolicy:PaperExpiryPolicy='fixed-expiry'){
    this.inventory=new MmPaperInventory(bankroll);
    if(!Number.isFinite(latencyMs)||latencyMs<0||latencyMs>2000)throw Error('Invalid paper latency');
    if(!['same-price','legacy-cumulative'].includes(queueModel))throw Error('Invalid paper queue model');
    if(!['exact-price','price-through'].includes(fillRule))throw Error('Invalid paper fill rule');
    if(!Number.isFinite(cancelLatencyMs)||cancelLatencyMs<0||cancelLatencyMs>2000)throw Error('Invalid paper cancel latency');
    if(config.maxPortfolioUsd>bankroll)throw Error('Paper deployment cap exceeds starting capital');
    if(config.maxCashLossUsd!=null&&(!Number.isFinite(config.maxCashLossUsd)||config.maxCashLossUsd<0||config.maxCashLossUsd>bankroll))throw Error('Invalid cash loss budget');
    if(!['direct',CTF_MATCHING_MODEL].includes(matchingModel)||matchingModel!=='direct'&&queueModel!=='same-price')throw Error('Invalid matching model or queue policy');
    if(!['fixed-expiry','renewable-client-lease-v1',RESTING_POLICY].includes(expiryPolicy)||expiryPolicy!=='fixed-expiry'&&(matchingModel!==CTF_MATCHING_MODEL||cancelLatencyMs<=0))throw Error('Client leases require joint CTF matching and cancellation latency');
  }
  restoreRecovered(s:RecoveredPaperSession,now:number,allowQuotePolicyChange=false){
    if(this.markets.size||this.sequence||this.printsSeen||!Number.isFinite(now))throw Error('Recovery requires a pristine paper actor');
    const canonical=(value:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
    const current={...this.config},prior={...s.report.config};
    if(allowQuotePolicyChange){const oldLimit=prior.maxCashLossUsd??this.inventory.initialCashUsd,newLimit=current.maxCashLossUsd??this.inventory.initialCashUsd;if(newLimit>oldLimit)throw Error('Recovery cannot loosen the cash risk budget');delete current.maxCashLossUsd;delete prior.maxCashLossUsd;}
    if(canonical(current as any)!==canonical(prior)||this.queueModel!==(s.report.queueModel??'same-price')||(!allowQuotePolicyChange&&(this.latencyMs!==s.report.latencyMs||this.cancelLatencyMs!==(s.report.cancelLatencyMs??0)||this.fillRule!==(s.report.fillRule??'exact-price'))))throw Error('Recovered execution settings differ');
    if(!allowQuotePolicyChange&&this.matchingModel!==(s.report.matchingModel??'direct'))throw Error('Recovered matching model differs');
    if(!allowQuotePolicyChange&&this.expiryPolicy!==(s.report.expiryPolicy??'fixed-expiry'))throw Error('Recovered expiry policy differs');
    const candidate=new MmPaperSession(this.inventory.initialCashUsd,this.config,()=>{},this.latencyMs,this.queueModel,this.fillRule,this.cancelLatencyMs,this.matchingModel,this.expiryPolicy);
    for(const m of s.markets)candidate.register(m);candidate.inventory.restore(s.inventory);
    const counters=['simulatedFills','simulatedMerges','simulatedSplits','simulatedSettlements','quotesPlaced','quotesCancelled','printsSeen','printsRejected'] as const;
    if(!Number.isInteger(s.actorSequence)||s.actorSequence<0||counters.some(k=>!Number.isInteger(s.counters[k])||s.counters[k]<0))throw Error('Invalid recovered actor counters');
    if(!Number.isSafeInteger(s.counters.leasesRenewed??0)||(s.counters.leasesRenewed??0)<0)throw Error('Invalid recovered lease counter');
    for(const old of s.outstandingOrders){
      const market=candidate.markets.get(old.conditionId);if(!market||!market.tokens.includes(old.token))throw Error('Recovered quote has no registered market');
      const key=`${old.token}:${old.side}`;if(candidate.resting.has(key))throw Error('Recovered quotes overlap');
      const expiryPolicy=old.expiryPolicy??'fixed-expiry';
      if(!['fixed-expiry','renewable-client-lease-v1',RESTING_POLICY].includes(expiryPolicy))throw Error('Unknown recovered quote expiry policy');
      if(!Number.isFinite(old.expiresAt)||old.expiresAt<=old.activateAt||!Number.isFinite(old.shares)||old.shares<market.minShares||old.shares>this.config.maxOrderShares||old.remaining>old.shares+1e-9)throw Error('Invalid recovered quote size or deadline');
      candidate.resting.set(key,{id:old.id,market,token:old.token,side:old.side,price:old.price,originalShares:old.shares,queue:new PaperQueue(old.side,old.price,old.remaining,old.queueAhead,old.activateAt,expiryPolicy==='fixed-expiry'?old.expiresAt:Number.MAX_SAFE_INTEGER,this.fillRule),activateAt:old.activateAt,expiresAt:old.expiresAt,expiryPolicy,cancelAt:old.cancelAt,cancelReason:old.cancelReason});
    }
    for(const condition of [...s.splitMarkets,...s.resolvedMarkets,...s.pendingMerges])if(!candidate.markets.has(condition))throw Error('Recovered lifecycle has no market');
    if(new Map(s.inventoryReserves).size!==s.inventoryReserves.length||s.inventoryReserves.some(([condition,shares])=>!candidate.markets.has(condition)||!Number.isFinite(shares)||shares<0||shares>this.config.maxOrderShares)||s.forcedMerges.some(condition=>!s.pendingMerges.includes(condition)))throw Error('Invalid recovered inventory reserve');
    this.inventory.restore(s.inventory);for(const[id,m]of candidate.markets)this.markets.set(id,m);this.resting=candidate.resting;
    this.sequence=s.actorSequence;this.splitMarkets=new Set(s.splitMarkets);this.resolvedMarkets=new Set(s.resolvedMarkets);this.pendingMerges=new Set(s.pendingMerges);this.seenPrints=new Set(s.seenPrints);
    this.forcedMerges=new Set(s.forcedMerges);this.inventoryReserves=new Map(s.inventoryReserves);
    if(allowQuotePolicyChange)for(const condition of s.splitMarkets)if(!(this.inventoryReserves.get(condition)!>0)){if(this.pendingMerges.has(condition))this.forcedMerges.add(condition);this.inventoryReserves.set(condition,this.config.maxOrderShares);}
    for(const k of counters)this[k]=s.counters[k];this.clock=now;
    this.leasesRenewed=s.counters.leasesRenewed??0;
    this.tapeBudget.restore(s.seenPrints,new Map(s.markets.flatMap(m=>m.tokens.map(token=>[token,m.conditionId] as [string,string]))));
    this.record('paper-recovery',{parent:s.evidence,bankrollUsd:this.inventory.initialCashUsd,cashUsd:this.inventory.cashUsd,inventory:s.inventory.holdings,outstandingOrders:s.outstandingOrders.map(q=>q.id),fillRule:this.fillRule,matchingModel:this.matchingModel,expiryPolicy:this.expiryPolicy,latencyMs:this.latencyMs,cancelLatencyMs:this.cancelLatencyMs,maxCashLossUsd:this.config.maxCashLossUsd??null,inventoryReserves:[...this.inventoryReserves],pendingMerges:[...this.pendingMerges],forcedMerges:[...this.forcedMerges],performanceClaimEligible:false});
    // Quote priority through the unobserved interval is unknown. Keep exposure
    // reserved until cancellation, but do not claim fills during quarantine.
    this.cancelAll('recovery_data_gap',now);this.recoveryQuarantineUntil=Math.max(now,...[...this.resting.values()].map(q=>q.cancelAt??now+this.cancelLatencyMs));this.expire(now);
  }
  register(m:PaperMarket){
    if(!m.conditionId||!m.event||m.tokens.length!==2||m.tokens.some(t=>!t)||m.tokens[0]===m.tokens[1]||![m.minShares,m.tick].every(Number.isFinite)||m.minShares<=0||m.tick<=0||m.tick>=1)throw Error('Invalid paper market');
    quoteFee(1,.5,m.fee);this.inventory.registerMarket(m.conditionId,...m.tokens);this.markets.set(m.conditionId,m);
  }
  /** Fund a working reserve; replenishment is possible only after both legs are gone. */
  splitInventory(condition:string,shares:number,feeUsd=.01){
    const m=this.markets.get(condition);
    if(!m||!m.mergeSupported||this.resolvedMarkets.has(condition))return false;
    if(this.splitMarkets.has(condition)&&m.tokens.some(token=>(this.inventory.holdings.get(token)?.shares??0)>1e-9))return false;
    if(![shares,feeUsd].every(Number.isFinite)||shares<m.minShares||shares>this.config.maxOrderShares||feeUsd<0)throw Error('Invalid initial inventory split');
    const cap=this.exposure(condition,m.event),cost=shares+feeUsd;
    if(cost+cap.marketUsd>this.config.maxMarketUsd+1e-9||cost+cap.eventUsd>this.config.maxEventUsd+1e-9||cost+cap.portfolioUsd>this.config.maxPortfolioUsd+1e-9||cost>this.availableRiskCash(cap.reservedCashUsd)+1e-9)return false;
    const id=`split-${++this.sequence}`;
    this.inventory.split(id,condition,shares,feeUsd);this.splitMarkets.add(condition);this.inventoryReserves.set(condition,shares);this.simulatedSplits++;
    this.record('paper-split',{id,conditionId:condition,tokens:m.tokens,shares,reserveShares:shares,feeUsd,cashUsd:this.inventory.cashUsd,realizedPnlUsd:this.inventory.realizedPnlUsd});return true;
  }
  expire(now:number){
    this.clock=now;
    for(const[key,q]of this.resting){
      if(q.expiryPolicy==='renewable-client-lease-v1'){
        if(q.cancelAt!=null&&q.cancelAt<=now)this.cancelKey(key,q.cancelReason??'cancelled',now,true);
        else if(q.expiresAt<=now)this.cancelKey(key,'lease_expired',now);
      }else if(q.expiryPolicy===RESTING_POLICY){
        if(q.cancelAt!=null&&q.cancelAt<=now)this.cancelKey(key,q.cancelReason??'cancelled',now,true);
        else if(q.expiresAt<=now)this.cancelKey(key,'quote_deadline',now);
      }else if(q.expiresAt<=now)this.cancelKey(key,'expired',now,true);
      else if(q.cancelAt!=null&&q.cancelAt<=now)this.cancelKey(key,q.cancelReason??'cancelled',now,true);
    }
    for(const condition of [...this.pendingMerges])if(![...this.resting.values()].some(q=>q.market.conditionId===condition)){
      this.pendingMerges.delete(condition);const force=this.forcedMerges.delete(condition);this.completeMerge(this.markets.get(condition)!,force);
    }
  }
  private cancelKey(key:string,reason:string,now=this.clock,confirmed=false){
    const q=this.resting.get(key);if(!q)return;
    if(this.cancelLatencyMs>0&&!confirmed){
      if(q.cancelAt==null){q.cancelAt=now+this.cancelLatencyMs;q.cancelReason=reason;this.record('paper-cancel-request',{id:q.id,token:q.token,reason,requestedAt:now,ackAt:q.cancelAt});}
      return;
    }
    this.resting.delete(key);this.quotesCancelled++;this.record('paper-cancel',{id:q.id,token:q.token,reason});
  }
  cancelMarket(condition:string,reason:string,now=this.clock){for(const[key,q]of this.resting)if(q.market.conditionId===condition)this.cancelKey(key,reason,now);}
  cancelAll(reason:string,now=this.clock){for(const key of [...this.resting.keys()])this.cancelKey(key,reason,now);}
  releasePairedInventory(condition:string,now=this.clock){const m=this.markets.get(condition);if(m){this.clock=now;this.merge(m,true);}}
  resolveMarket(condition:string,winner:string,now:number){
    const m=this.markets.get(condition);if(!m||!m.tokens.includes(winner))throw Error('Unverified market resolution');
    if(this.resolvedMarkets.has(condition))return false;
    this.clock=now;this.pendingMerges.delete(condition);this.forcedMerges.delete(condition);
    for(const[key,q]of this.resting)if(q.market.conditionId===condition)this.cancelKey(key,'market_resolved',now,true);
    const payouts:[number,number]=m.tokens[0]===winner?[1,0]:[0,1];
    const proceeds=this.inventory.holdings.get(winner)?.shares??0,feeUsd=Math.min(.01,proceeds);
    const id=`resolution-${condition}`;this.inventory.settle(id,condition,payouts,feeUsd);this.resolvedMarkets.add(condition);this.simulatedSettlements++;
    this.record('paper-settlement',{id,conditionId:condition,tokens:m.tokens,winner,payouts,feeUsd,cashUsd:this.inventory.cashUsd,realizedPnlUsd:this.inventory.realizedPnlUsd});return true;
  }
  exposure(condition:string,event:string,excludeQuotesForCondition=false){
    let marketUsd=0,eventUsd=0,portfolioUsd=0,reservedCashUsd=0;
    for(const m of this.markets.values())for(const token of m.tokens){const cost=this.inventory.holdings.get(token)?.costUsd??0;portfolioUsd+=cost;if(m.event===event)eventUsd+=cost;if(m.conditionId===condition)marketUsd+=cost;}
    for(const q of this.resting.values())if(q.side==='BUY'){
      const cost=q.queue.remaining*q.price+quoteFee(q.queue.remaining,q.price,q.market.fee);reservedCashUsd+=cost;
      if(excludeQuotesForCondition&&q.market.conditionId===condition)continue;
      portfolioUsd+=cost;if(q.market.event===event)eventUsd+=cost;if(q.market.conditionId===condition)marketUsd+=cost;
    }
    return{marketUsd,eventUsd,portfolioUsd,reservedCashUsd};
  }
  availableRiskCash(reservedCashUsd=0){return Math.max(0,this.inventory.cashUsd-reservedCashUsd-Math.max(0,this.inventory.initialCashUsd-(this.config.maxCashLossUsd??this.inventory.initialCashUsd)));}
  private workingRiskValid(q:RestingQuote){
    const c=this.exposure(q.market.conditionId,q.market.event),cfg=this.config;
    if(c.marketUsd>cfg.maxMarketUsd+1e-8||c.eventUsd>cfg.maxEventUsd+1e-8||c.portfolioUsd>cfg.maxPortfolioUsd+1e-8||c.reservedCashUsd>this.inventory.cashUsd-Math.max(0,this.inventory.initialCashUsd-(cfg.maxCashLossUsd??this.inventory.initialCashUsd))+1e-8)return false;
    if(q.side==='SELL'&&q.queue.remaining>(this.inventory.holdings.get(q.token)?.shares??0)+1e-9)return false;
    const m=q.market,net=(this.inventory.holdings.get(m.tokens[0])?.shares??0)-(this.inventory.holdings.get(m.tokens[1])?.shares??0);let positive=0,negative=0;
    for(const r of this.resting.values())if(r.market.conditionId===m.conditionId){if((r.token===m.tokens[0])===(r.side==='BUY'))positive+=r.queue.remaining;else negative+=r.queue.remaining;}
    return net+positive<=cfg.maxNetShares+1e-8&&net-negative>=-cfg.maxNetShares-1e-8;
  }
  replace(condition:string,quotes:(MmQuote&{outcomeIndex:number})[],books:QuoteLadder[],now:number){
    const m=this.markets.get(condition);if(!m)throw Error('Unregistered paper market');this.expire(now);
    if(this.resolvedMarkets.has(condition))return;
    if(this.pendingMerges.has(condition))return;
    const desired=new Map<string,MmQuote&{outcomeIndex:number}>();
    for(const q of quotes){const token=m.tokens[q.outcomeIndex],old=this.resting.get(`${token}:${q.side}`);
      if(q.maintenanceOf&&(!old||old.id!==q.maintenanceOf||old.cancelAt!=null)){this.record('paper-maintenance-rejected',{id:q.maintenanceOf,reason:'no_uncancelled_order',at:now});continue;}
      const maintenance=q.maintenanceOf!=null;
      if(maintenance&&(this.expiryPolicy!=='renewable-client-lease-v1'||old!.expiryPolicy!=='renewable-client-lease-v1'||q.price!==old!.price||Math.abs(q.shares-old!.queue.remaining)>1e-9||old!.originalShares<m.minShares))throw Error('Invalid quote maintenance binding');
      if(!token||!['BUY','SELL'].includes(q.side)||!q.postOnly||![q.price,q.shares,q.expiresAt].every(Number.isFinite)||q.price<=0||q.price>=1||q.shares<=0||(!maintenance&&q.shares<m.minShares)||q.shares>this.config.maxOrderShares||Math.abs(q.price/m.tick-Math.round(q.price/m.tick))>1e-7||q.expiresAt<=now+this.latencyMs)throw Error('Invalid resting paper quote');
      if(this.expiryPolicy==='renewable-client-lease-v1'&&(!Number.isFinite(m.quoteDeadlineAt)||q.expiresAt>m.quoteDeadlineAt!||q.expiresAt>now+(this.config.quoteLifetimeMs??2000)))throw Error('Invalid client lease deadline');
      const b=books[q.outcomeIndex],bid=Math.max(...b.bids.map(l=>l.price)),ask=Math.min(...b.asks.map(l=>l.price));
      if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid>=ask||(q.side==='BUY'?q.price>=ask:q.price<=bid))throw Error('Paper quote crosses the book');
      const key=`${token}:${q.side}`;if(desired.has(key))throw Error('Duplicate paper quote');desired.set(key,q);
    }
    for(const token of m.tokens){const buy=desired.get(`${token}:BUY`),sell=desired.get(`${token}:SELL`);if(buy&&sell&&buy.price>=sell.price)throw Error('Paper quotes self-cross');}
    if(this.matchingModel!== 'direct'){
      const intents=[...desired.entries()];
      for(let i=0;i<intents.length;i++)for(let j=i+1;j<intents.length;j++)if(syntheticCross(m.tokens,{...intents[i][1],token:m.tokens[intents[i][1].outcomeIndex]},{...intents[j][1],token:m.tokens[intents[j][1].outcomeIndex]}))throw Error('Paper CTF quotes self-cross');
      const rank=([key,q]:typeof intents[number])=>{const old=this.resting.get(key);return old&&old.price===q.price&&old.cancelAt==null?0:q.side==='SELL'?1:2;};
      const unique=new Set<string>();desired.clear();
      for(const[key,q]of intents.sort((a,b)=>rank(a)-rank(b))){const canonical=economicKey(m.tokens,m.tokens[q.outcomeIndex],q.side,q.price);if(!unique.has(canonical)){unique.add(canonical);desired.set(key,q);}}
    }
    const tolerance=(this.config.restToleranceTicks??1)*m.tick;
    for(const[key,old]of this.resting)if(old.market.conditionId===condition&&old.expiryPolicy===RESTING_POLICY&&old.cancelAt==null){
      const q=desired.get(key),b=books[m.tokens.indexOf(old.token)],bid=Math.max(...b.bids.map(l=>l.price)),ask=Math.min(...b.asks.map(l=>l.price));
      const stillPassive=Number.isFinite(bid)&&Number.isFinite(ask)&&(old.side==='BUY'?old.price<ask:old.price>bid);
      if(!q)this.cancelKey(key,'no_target',now);
      else if(Math.abs(q.price-old.price)>tolerance+1e-9)this.cancelKey(key,'outside_tolerance',now);
      else if(!stillPassive)this.cancelKey(key,'would_cross',now);
      else if(!this.workingRiskValid(old))this.cancelKey(key,'reservation_risk',now);
      else this.restingKept++;
    }
    for(const[key,old]of this.resting)if(old.market.conditionId===condition&&old.expiryPolicy!==RESTING_POLICY){const q=desired.get(key),same=q&&q.price===old.price&&(q.maintenanceOf===old.id?Math.abs(q.shares-old.queue.remaining)<=1e-9:Math.abs(q.shares-old.originalShares)<=1e-8);
      if(!same)this.cancelKey(key,'replace',now);
      else if(old.expiryPolicy==='renewable-client-lease-v1'&&old.cancelAt==null){
        if(!this.workingRiskValid(old))this.cancelKey(key,'reservation_risk',now);
        else if(q!.expiresAt>old.expiresAt){const previousExpiresAt=old.expiresAt;old.expiresAt=q!.expiresAt;this.leasesRenewed++;
          this.record('paper-lease-renewal',{id:old.id,conditionId:condition,token:old.token,side:old.side,price:old.price,remainingShares:old.queue.remaining,originalShares:old.originalShares,previousExpiresAt,expiresAt:old.expiresAt,renewedAt:now,quoteDeadlineAt:m.quoteDeadlineAt,bookEvidence:books[m.tokens.indexOf(old.token)],maintenanceOf:q!.maintenanceOf??null});}
      }
    }
    for(const[key,q]of desired){if(this.resting.has(key)||q.maintenanceOf)continue;const token=m.tokens[q.outcomeIndex],cap=this.exposure(condition,m.event);
      if(this.matchingModel!=='direct'&&[...this.resting.values()].some(old=>old.market.conditionId===condition&&(economicKey(m.tokens,old.token,old.side,old.price)===economicKey(m.tokens,token,q.side,q.price)||syntheticCross(m.tokens,old,{token,...q}))))continue;
      const opposite=this.resting.get(`${token}:${q.side==='BUY'?'SELL':'BUY'}`);
      if(opposite&&(q.side==='BUY'?q.price>=opposite.price:q.price<=opposite.price))continue;
      const cost=q.shares*q.price+quoteFee(q.shares,q.price,m.fee);
      if(q.side==='BUY'&&(cost+cap.marketUsd>this.config.maxMarketUsd+1e-8||cost+cap.eventUsd>this.config.maxEventUsd+1e-8||cost+cap.portfolioUsd>this.config.maxPortfolioUsd+1e-8||cost>this.availableRiskCash(cap.reservedCashUsd)+1e-8))continue;
      if(q.side==='SELL'&&q.shares>(this.inventory.holdings.get(token)?.shares??0))continue;
      // Both a BUY of the first token and a SELL of its complement increase
      // the same directional exposure. Pending cancel acknowledgments still
      // reserve that exposure; do not assume offsetting orders both fill.
      const net=(this.inventory.holdings.get(m.tokens[0])?.shares??0)-(this.inventory.holdings.get(m.tokens[1])?.shares??0);
      let positive=0,negative=0;
      for(const old of this.resting.values())if(old.market.conditionId===condition){
        if((old.token===m.tokens[0])===(old.side==='BUY'))positive+=old.queue.remaining;else negative+=old.queue.remaining;
      }
      if((q.outcomeIndex===0)===(q.side==='BUY'))positive+=q.shares;else negative+=q.shares;
      if(net+positive>this.config.maxNetShares+1e-8||net-negative< -this.config.maxNetShares-1e-8)continue;
      const ladder=q.side==='BUY'?books[q.outcomeIndex].bids:books[q.outcomeIndex].asks;
      // Exact-price prints can deplete only the existing queue at that price.
      // Better-priced liquidity is consumed at other prices, not again here.
      const ahead=ladder.filter(l=>this.queueModel==='same-price'?Math.abs(l.price-q.price)<1e-9:(q.side==='BUY'?l.price>=q.price:l.price<=q.price)).reduce((s,l)=>s+l.size,0);
      const activateAt=now+this.latencyMs,id=`order-${++this.sequence}`;
      const entry={id,market:m,token,side:q.side,price:q.price,originalShares:q.shares,queue:new PaperQueue(q.side,q.price,q.shares,ahead,activateAt,this.expiryPolicy==='fixed-expiry'?q.expiresAt:Number.MAX_SAFE_INTEGER,this.fillRule),activateAt,expiresAt:this.expiryPolicy===RESTING_POLICY?(m.quoteDeadlineAt??Number.MAX_SAFE_INTEGER):q.expiresAt,expiryPolicy:this.expiryPolicy};
      this.resting.set(key,entry);this.quotesPlaced++;this.record('paper-order',{id,conditionId:condition,token,...q,expiryPolicy:this.expiryPolicy,quoteDeadlineAt:m.quoteDeadlineAt??null,queueAhead:ahead,queueModel:this.queueModel,fillRule:this.fillRule,matchingModel:this.matchingModel,minimumFillShares:PaperQueue.MIN_FILL_SHARES,queueEvidence:{levels:ladder},placedAt:now,activateAt});
    }
  }
  print(p:PaperPrint,receivedAt:number,healthy:boolean,complementHealthy=false){
    this.expire(receivedAt);
    this.printsSeen++;
    const market=[...this.markets.values()].find(m=>m.tokens.includes(p.token));
    let native=true;if(this.matchingModel!=='direct')try{nativeTransaction(p);}catch{native=false;}
    const accepted=native&&!!market&&receivedAt>=this.recoveryQuarantineUntil&&healthy&&!!p.id&&!this.seenPrints.has(p.id)&&[p.at,p.price,p.shares,receivedAt].every(Number.isFinite)&&p.at<=receivedAt&&receivedAt-p.at<=1500&&p.shares>0&&p.price>0&&p.price<1&&['BUY','SELL'].includes(p.aggressor);
    const volumeBudget=accepted&&this.matchingModel!=='direct'?this.tapeBudget.observe(market!.conditionId,p):null;
    this.record('paper-print',{print:p,receivedAt,healthy,accepted,matchingModel:this.matchingModel,complementHealthy,volumeBudget});
    if(!accepted){this.printsRejected++;return 0;}
    this.seenPrints.add(p.id);this.expire(receivedAt);let total=0;
    if(this.matchingModel!=='direct'){
      const m=market!,entries=[...this.resting.entries()].filter(([,q])=>q.market.conditionId===m.conditionId);
      const result=allocateCtfPrint(m.tokens,entries.map(([,q])=>({...q,expiresAt:q.expiryPolicy==='fixed-expiry'?q.expiresAt:q.cancelAt??Number.MAX_SAFE_INTEGER,remaining:q.queue.remaining,queueAhead:q.queue.queueAhead})),p,receivedAt,volumeBudget!.availableShares,this.fillRule,complementHealthy&&m.mergeSupported);
      for(const a of result.allocations){const[key,q]=entries.find(([,q])=>q.id===a.orderId)!;q.queue.queueAhead=a.queueAhead;q.queue.remaining=a.remaining;if(a.shares<=0)continue;
        this.inventory.fill(`${q.id}:${p.id}`,q.token,q.side,a.shares,q.price,0);this.simulatedFills++;total+=a.shares;
        const price=economicQuote(m.tokens,q.token,q.side,q.price).price,observed=economicQuote(m.tokens,p.token,p.aggressor,p.price).price;
        this.record('paper-fill',{orderId:q.id,token:q.token,print:p,receivedAt,side:q.side,price:q.price,shares:a.shares,fillRule:this.fillRule,matchingModel:this.matchingModel,route:a.route,volumeBudget,match:Math.abs(price-observed)<=1e-9?'exact-price':'price-through',feeUsd:0,cashUsd:this.inventory.cashUsd,realizedPnlUsd:this.inventory.realizedPnlUsd});
        if(q.queue.remaining<=1e-9)this.resting.delete(key);
      }
      this.merge(m);return total;
    }
    for(const[key,q]of this.resting){if(q.token!==p.token||receivedAt<q.activateAt||receivedAt>=q.expiresAt)continue;const fill=q.queue.print(p.id,p.aggressor,p.price,p.shares,p.at);if(fill<=0)continue;
      // Verified public fee policy: passive makers pay zero. Incentives remain zero.
      this.inventory.fill(`${q.id}:${p.id}`,p.token,q.side,fill,q.price,0);this.simulatedFills++;total+=fill;
      this.record('paper-fill',{orderId:q.id,print:p,receivedAt,side:q.side,price:q.price,shares:fill,fillRule:this.fillRule,match:Math.abs(q.price-p.price)<1e-9?'exact-price':'price-through',feeUsd:0,cashUsd:this.inventory.cashUsd,realizedPnlUsd:this.inventory.realizedPnlUsd});
      if(q.queue.remaining<=1e-9)this.resting.delete(key);
      this.merge(q.market);
    }
    return total;
  }
  private merge(m:PaperMarket,force=false){
    if(!m.mergeSupported)return;
    const paired=Math.min(...m.tokens.map(token=>this.inventory.holdings.get(token)?.shares??0))-(force?0:this.inventoryReserves.get(m.conditionId)??0);if(paired<=1e-9)return;
    this.cancelMarket(m.conditionId,'merge',this.clock);
    if([...this.resting.values()].some(q=>q.market.conditionId===m.conditionId)){if(!this.pendingMerges.has(m.conditionId)||force&&!this.forcedMerges.has(m.conditionId))this.record('paper-merge-request',{conditionId:m.conditionId,pairedShares:paired,force,requestedAt:this.clock});this.pendingMerges.add(m.conditionId);if(force)this.forcedMerges.add(m.conditionId);return;}
    this.completeMerge(m,force);
  }
  private completeMerge(m:PaperMarket,force=false){
    const paired=Math.min(...m.tokens.map(token=>this.inventory.holdings.get(token)?.shares??0))-(force?0:this.inventoryReserves.get(m.conditionId)??0);if(paired<=1e-9)return;
    // Reserve one cent per operation as an explicit paper execution-cost assumption.
    const fee=.01;if(paired<fee)return;
    const id=`merge-${++this.sequence}`;this.inventory.merge(id,...m.tokens,paired,fee);this.simulatedMerges++;
    this.record('paper-merge',{id,conditionId:m.conditionId,tokens:m.tokens,shares:paired,feeUsd:fee,cashUsd:this.inventory.cashUsd,realizedPnlUsd:this.inventory.realizedPnlUsd});
  }
  openQuotes(){return[...this.resting.values()].map(q=>({id:q.id,conditionId:q.market.conditionId,token:q.token,side:q.side,price:q.price,originalShares:q.originalShares,remaining:q.queue.remaining,queueAhead:q.queue.queueAhead,activateAt:q.activateAt,expiresAt:q.expiresAt,expiryPolicy:q.expiryPolicy,cancelAt:q.cancelAt??null}));}
}
