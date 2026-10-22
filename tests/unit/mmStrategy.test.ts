import {describe,it,expect} from 'vitest';
import {DEFAULT_MM_CONFIG,mmInputFreshAt,planMmQuote,planMmPair,planMmIndependent,QuoteReservations,type MmInput} from '../../src/research/mm/strategy.js';
import {MmPaperInventory,PaperQueue} from '../../src/research/mm/paperInventory.js';
const now=100_000;
const input=(overrides:Partial<MmInput>={}):MmInput=>({now,receivedAt:now,serverAt:now,usable:true,book:{bids:[{price:.49,size:100}],asks:[{price:.51,size:100}]},history:Array.from({length:31},(_,i)=>({at:now-30_000+i*1000,mid:.5})),tick:.01,minShares:5,fee:{rate:.05,exponent:1},accepting:true,eventAt:now+3600_000,eventTimeRequired:true,cashAvailableUsd:1000,ownedShares:10,netOutcomeShares:0,marketCommittedUsd:0,eventCommittedUsd:0,portfolioCommittedUsd:0,...overrides});
describe('market-making quote regimes',()=>{
 it('rechecks book age at simulated placement, including server and confirmed clocks',()=>{
  const x=input();expect(mmInputFreshAt(x,now+1499,1500)).toBe(true);expect(mmInputFreshAt(x,now+1501,1500)).toBe(false);
  expect(mmInputFreshAt({...x,serverAt:now-1499},now+1,1500)).toBe(true);expect(mmInputFreshAt({...x,serverAt:now-60000},now+1,1500)).toBe(false);
  expect(mmInputFreshAt({...x,confirmedAt:now-1499},now+1,1500)).toBe(true);expect(mmInputFreshAt({...x,confirmedAt:now-1501},now+1,1500)).toBe(false);
  expect(mmInputFreshAt({...x,usable:false},now,1500)).toBe(false);
 });
 it('can rest at the best bid/ask while retaining an emergency fee cash reserve',()=>{
  const cfg={...DEFAULT_MM_CONFIG,feeReserveLegs:1,quoteLifetimeMs:10000},x=input();
  const p=planMmQuote(x,cfg,'touch');expect(p.quotes.map(q=>q.price)).toEqual([.49,.51]);
  expect(planMmQuote({...x,cashAvailableUsd:2.45},cfg,'touch').quotes.map(q=>q.side)).toEqual(['SELL']);
 });
 it('uses actual maker fees for touch-priced complete sets and preserves the cost guard',()=>{
  const x=input({ownedShares:0});expect(planMmIndependent(x,x,DEFAULT_MM_CONFIG,'touch').quotes).toHaveLength(2);
  const rich=input({ownedShares:0,book:{bids:[{price:.6,size:100}],asks:[{price:.62,size:100}]},history:input().history.map(p=>({...p,mid:.61}))});
  expect(planMmIndependent(rich,rich,DEFAULT_MM_CONFIG,'touch').reason).toBe('complete_set_cost_guard');
 });
 it('blocks touch quotes when spread cannot cover the volatility/risk allowance',()=>{
  const x=input({book:{bids:[{price:.499,size:100}],asks:[{price:.501,size:100}]},tick:.001});expect(planMmQuote(x,DEFAULT_MM_CONFIG,'touch').reason).toBe('insufficient_spread_after_risk');
 });
 it('keeps original timestamps while accepting a separately verified snapshot clock',()=>{
  const x=input({serverAt:now-60000,confirmedAt:now});expect(planMmQuote(x).quotes.length).toBe(2);expect(x.serverAt).toBe(now-60000);
  expect(planMmQuote({...x,confirmedAt:now-2000}).quotes).toEqual([]);expect(planMmQuote({...x,confirmedAt:now+1}).quotes).toEqual([]);
 });
 it('can quote a fresh outcome while the complement is stale, including an owned ask',()=>{
  const fresh=input(),stale=input({serverAt:now-2000,receivedAt:now-2000});
  expect(planMmPair(fresh,stale).quotes).toEqual([]);
  const p=planMmIndependent(fresh,stale);expect(p.quotes.length).toBe(2);expect(p.quotes.every(q=>q.outcomeIndex===0)).toBe(true);expect(p.quotes.some(q=>q.side==='SELL')).toBe(true);
 });
 it('keeps shared capital and complete-set guards for independently quoted outcomes',()=>{
  const empty=input({ownedShares:0,cashAvailableUsd:1});expect(planMmIndependent(empty,empty).quotes).toEqual([]);
  const a=input({book:{bids:[{price:.69,size:100}],asks:[{price:.71,size:100}]},history:input().history.map(p=>({...p,mid:.7})),ownedShares:0});
  expect(planMmIndependent(a,a).reason).toBe('complete_set_cost_guard');expect(planMmIndependent(a,a).quotes).toEqual([]);
 });
 it('can retain one affordable independent bid instead of dropping both',()=>{
  const a=input({ownedShares:0,cashAvailableUsd:3}),b=input({ownedShares:0,cashAvailableUsd:3});
  const p=planMmIndependent(a,b,DEFAULT_MM_CONFIG,'touch');expect(p.quotes).toHaveLength(1);expect(p.buyReservationUsd).toBeLessThanOrEqual(3);
  expect(planMmPair(a,b,DEFAULT_MM_CONFIG,'touch').quotes).toHaveLength(0);
 });
 it('does not erase the complete-set ask reserve by improving both books',()=>{
  const cfg={...DEFAULT_MM_CONFIG,reservePerShare:.0025,quoteLifetimeMs:10000};
  const a=input({book:{bids:[{price:.83,size:100}],asks:[{price:.85,size:100}]},fee:{rate:0,exponent:1},history:input().history.map(p=>({...p,mid:.84})),netOutcomeShares:5});
  const b=input({book:{bids:[{price:.15,size:100}],asks:[{price:.17,size:100}]},fee:{rate:0,exponent:1},history:input().history.map(p=>({...p,mid:.16})),netOutcomeShares:-5});
  const asks=planMmIndependent(a,b,cfg,'improve').quotes.filter(q=>q.side==='SELL');
  expect(asks).toHaveLength(2);expect(asks.find(q=>q.outcomeIndex===0)!.price).toBeCloseTo(.84);
  expect(asks.reduce((sum,q)=>sum+q.price,0)).toBeGreaterThanOrEqual(1+cfg.reservePerShare);
  expect(5*(asks.reduce((sum,q)=>sum+q.price,0)-1)-.01).toBeGreaterThan(0);
  for(const planner of [planMmIndependent,planMmPair]){
    const left={...a,cashAvailableUsd:3,book:{bids:[{price:.6,size:100}],asks:[{price:.62,size:100}]},history:a.history.map(p=>({...p,mid:.61}))};
    const right={...b,cashAvailableUsd:3,book:{bids:[{price:.38,size:100}],asks:[{price:.4,size:100}]},history:b.history.map(p=>({...p,mid:.39}))};
    const cashLimitedAsks=planner(left,right,cfg,'improve').quotes.filter(q=>q.side==='SELL');
    expect(cashLimitedAsks).toHaveLength(2);expect(cashLimitedAsks.reduce((sum,q)=>sum+q.price,0)).toBeGreaterThanOrEqual(1+cfg.reservePerShare);
  }
 });
 it('supports longer resting quotes while retaining stale-book rejection',()=>{
  const cfg={...DEFAULT_MM_CONFIG,quoteLifetimeMs:30000};const p=planMmQuote(input(),cfg);
  expect(p.quotes.every(q=>q.expiresAt===now+30000)).toBe(true);expect(planMmQuote(input({receivedAt:now-2000}),cfg).quotes).toEqual([]);
 });
 it('reserves one emergency taker exit for maker execution and never crosses',()=>{
  const old=planMmQuote(input()),next=planMmQuote(input(),{...DEFAULT_MM_CONFIG,feeReserveLegs:1});
  expect(next.quotes[0].price).toBeGreaterThan(old.quotes[0].price);expect(next.quotes[1].price).toBeLessThan(old.quotes[1].price);
  expect(next.quotes[0].price).toBeLessThan(.51);expect(next.quotes[1].price).toBeGreaterThan(.49);
  expect(()=>planMmQuote(input(),{...DEFAULT_MM_CONFIG,quoteLifetimeMs:60001})).toThrow();expect(()=>planMmQuote(input(),{...DEFAULT_MM_CONFIG,feeReserveLegs:0})).toThrow();
 });
 it('quotes passive grid prices and owns inventory before offering an ask',()=>{
  const p=planMmQuote(input());expect(p.quotes.map(q=>q.side)).toEqual(['BUY','SELL']);for(const q of p.quotes){expect(q.price/.01).toBeCloseTo(Math.round(q.price/.01));expect(q.postOnly).toBe(true);}expect(p.quotes[0].price).toBeLessThan(.51);expect(p.quotes[1].price).toBeGreaterThan(.49);
  expect(planMmQuote(input({ownedShares:0})).quotes.every(q=>q.side==='BUY')).toBe(true);
 });
 it.each([{receivedAt:now-2000},{serverAt:now-2000},{usable:false},{accepting:false},{ownedShares:-1},{eventAt:now+10_000},{eventAt:null}])('pauses on stale, invalid or event-risk state %j',changes=>expect(planMmQuote(input(changes)).regime).toBe('paused'));
 it('does not warm up through a disconnected history',()=>{
  expect(planMmQuote(input({history:[]})).regime).toBe('warmup');const h=input().history.filter(p=>p.at<now-15_000||p.at>now-5_000);expect(planMmQuote(input({history:h})).reason).toBe('history_gap');
 });
 it('pauses on a probability shock',()=>{const h=input().history;h[h.length-1].mid=.55;expect(planMmQuote(input({history:h})).reason).toBe('probability_shock');});
 it('reduces a long exposure without adding another long leg',()=>{
  const p=planMmQuote(input({netOutcomeShares:20}));expect(p.regime).toBe('reduce-inventory');expect(p.quotes.every(q=>q.side==='SELL')).toBe(true);expect(p.quotes.length).toBe(1);
 });
 it.each([{cashAvailableUsd:0},{marketCommittedUsd:10},{eventCommittedUsd:20},{portfolioCommittedUsd:100},{minShares:10}])('enforces capital and exchange minimums %j',changes=>expect(planMmQuote(input(changes)).quotes.some(q=>q.side==='BUY')).toBe(false));
 it('requires synchronized complementary books and reserves both legs together',()=>{
  expect(planMmPair(input(),input({serverAt:now-500})).quotes).toHaveLength(0);
  const p=planMmPair(input({ownedShares:0}),input({ownedShares:0}));expect(p.quotes).toHaveLength(2);expect(p.buyReservationUsd).toBeGreaterThan(4);
  expect(planMmPair(input({cashAvailableUsd:3,ownedShares:0}),input({cashAvailableUsd:3,ownedShares:0})).reason).toBe('shared_capital_limit');
 });
 it('caps correlated event reservations and restores the prior reservation on failure',()=>{
  const r=new QuoteReservations();expect(r.reserve('a','match',10)).toBe(true);expect(r.reserve('b','match',10)).toBe(true);expect(r.reserve('c','match',1)).toBe(false);expect(r.reserve('a','match',11)).toBe(false);expect(r.totals('a','match')).toEqual({market:10,event:20,portfolio:20});r.release('a');expect(r.totals('a','match').portfolio).toBe(10);
 });
});
describe('paper inventory and conservative queue accounting',()=>{
 it('does not fill on touches or cancellations, and consumes queue before our shares',()=>{
  const q=new PaperQueue('BUY',.4,5,10,100,1000);expect(q.print('a','BUY',.4,20,200)).toBe(0);expect(q.print('b','SELL',.4,6,200)).toBe(0);expect(q.queueAhead).toBe(4);expect(q.print('c','SELL',.4,6,300)).toBe(2);expect(q.print('c','SELL',.4,6,300)).toBe(0);expect(q.remaining).toBe(3);
 });
 it('does not infer fills from another price or before/after the order lifetime',()=>{
  const q=new PaperQueue('BUY',.4,5,0,100,1000);expect(q.print('a','SELL',.3,20,200)).toBe(0);expect(q.print('b','SELL',.4,20,99)).toBe(0);expect(q.print('c','SELL',.4,20,1000)).toBe(0);
 });
 it('realizes paired profit only after both paid fills and a merge, including fees',()=>{
  const p=new MmPaperInventory(100);p.registerMarket('match','yes','no');p.fill('a','yes','BUY',5,.4,.025);expect(()=>p.merge('bad','yes','no',5)).toThrow(/Unpaired/);p.fill('b','no','BUY',5,.5,.025);p.merge('c','yes','no',5);expect(p.cashUsd).toBeCloseTo(100.45);expect(p.realizedPnlUsd).toBeCloseTo(.45);expect(p.feesUsd).toBeCloseTo(.05);expect(p.merge('c','yes','no',5)).toBe(false);
 });
 it('rejects overdrafts and oversells without mutating balances',()=>{
  const p=new MmPaperInventory(1);expect(()=>p.fill('a','yes','BUY',5,.4,0)).toThrow(/overdraft/);expect(p.cashUsd).toBe(1);expect(()=>p.fill('b','yes','SELL',1,.4,0)).toThrow(/oversell/);expect(p.cashUsd).toBe(1);
 });
 it('cannot merge unrelated outcome tokens or remap existing conditions',()=>{
  const p=new MmPaperInventory(100);p.registerMarket('a','yes-a','no-a');p.registerMarket('b','yes-b','no-b');p.fill('a','yes-a','BUY',5,.4,0);p.fill('b','no-b','BUY',5,.5,0);expect(()=>p.merge('c','yes-a','no-b',5)).toThrow(/Unregistered/);expect(()=>p.registerMarket('a','different','no-a')).toThrow(/changed/);
 });
 it('does not turn an unmarked open position into zero equity',()=>{
  const p=new MmPaperInventory(100);p.fill('a','yes','BUY',5,.4,0);expect(p.equity(new Map())).toBeNull();expect(p.equity(new Map([['yes',.3]]))).toBeCloseTo(99.5);expect(p.realizedPnlUsd).toBe(0);
 });
 it('keeps repeated fills idempotent and accounts for a partial sale correctly',()=>{
  const p=new MmPaperInventory(100);p.fill('a','yes','BUY',5,.4,.1);expect(p.fill('a','yes','BUY',5,.4,.1)).toBe(false);p.fill('b','yes','SELL',2,.5,.05);expect(p.holdings.get('yes')!.shares).toBe(3);expect(p.realizedPnlUsd).toBeCloseTo(.11);expect(p.cashUsd).toBeCloseTo(98.85);
 });
 it('books an unpaired losing leg at resolution instead of hiding its cost',()=>{
  const p=new MmPaperInventory(100);p.registerMarket('match','yes','no');p.fill('a','yes','BUY',5,.4,.025);p.settle('resolution','match',[0,1]);expect(p.cashUsd).toBeCloseTo(97.975);expect(p.realizedPnlUsd).toBeCloseTo(-2.025);expect(p.settle('resolution','match',[0,1])).toBe(false);
 });
 it('handles an explicitly supplied split resolution and cannot mint extra payout',()=>{
  const p=new MmPaperInventory(100);p.registerMarket('match','yes','no');p.fill('a','yes','BUY',5,.4,0);expect(()=>p.settle('bad','match',[1,1])).toThrow(/resolution/);p.settle('good','match',[.5,.5]);expect(p.cashUsd).toBeCloseTo(100.5);
 });
});
