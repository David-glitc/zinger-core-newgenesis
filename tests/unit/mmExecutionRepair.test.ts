import {describe,it,expect} from 'vitest';
import {MmPaperInventory,PaperQueue} from '../../src/research/mm/paperInventory.js';
import {MmPaperSession} from '../../src/research/mm/paperSession.js';
import {DEFAULT_MM_CONFIG,planMmQuote} from '../../src/research/mm/strategy.js';

const market={conditionId:'a',event:'event',tokens:['yes','no'] as [string,string],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true};
const book={bids:[{price:.48,size:1000}],asks:[{price:.52,size:1000}]};
const cfg={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000,maxPortfolioUsd:100};
const quote=(side:'BUY'|'SELL',price:number)=>({side,price,shares:5,expiresAt:20000,postOnly:true as const,outcomeIndex:0});

describe('MM execution repairs',()=>{
  it('does not turn queue-subtraction residue into a fill, while allowing a one-microshare partial execution',()=>{
    const records:any[]=[];const s=new MmPaperSession(1000,cfg,(type,data)=>records.push({type,data}),250,'same-price','price-through',250);
    s.register(market);s.splitInventory('a',5);
    const b={bids:[{price:.48,size:1000}],asks:[{price:.5,size:46.01999999999998}]};
    s.replace('a',[quote('SELL',.5)],[b,b],1000);const cash=s.inventory.cashUsd;
    expect(s.print({id:'equal-queue',token:'yes',aggressor:'BUY',price:.5,shares:46.02,at:1500},1500,true)).toBe(0);
    expect(s.simulatedFills).toBe(0);expect(s.inventory.cashUsd).toBe(cash);expect(s.openQuotes()[0].remaining).toBe(5);
    expect(s.print({id:'through',token:'yes',aggressor:'BUY',price:.51,shares:86.843138,at:1600},1600,true)).toBe(5);
    expect(records.filter(r=>r.type==='paper-fill')).toHaveLength(1);expect(s.simulatedFills).toBe(1);
    expect(records.find(r=>r.type==='paper-order').data.minimumFillShares).toBe(1e-6);
    const q=new PaperQueue('BUY',.49,5,0,1000,5000);
    expect(q.print('micro','SELL',.49,1e-6,2000)).toBe(1e-6);
  });
  it('retains working inventory and existing queue priority across a partial round trip',()=>{
    const s=new MmPaperSession(1000,cfg,()=>{},250,'same-price','exact-price',250);s.register(market);s.splitInventory('a',5);
    s.replace('a',[quote('BUY',.49),quote('SELL',.51)],[book,book],1000);
    expect(s.print({id:'buy-first',token:'yes',aggressor:'SELL',price:.49,shares:2,at:1500},1500,true)).toBe(2);
    const id=s.openQuotes().find(q=>q.side==='BUY')!.id;s.replace('a',[quote('BUY',.49),quote('SELL',.51)],[book,book],1600);
    expect(s.openQuotes().find(q=>q.side==='BUY')!.id).toBe(id);expect(s.quotesCancelled).toBe(0);expect(s.simulatedMerges).toBe(0);
    expect(s.print({id:'sell-next',token:'yes',aggressor:'BUY',price:.51,shares:2,at:1800},1800,true)).toBe(2);
    expect(s.inventory.holdings.get('yes')!.shares).toBe(5);expect(s.inventory.holdings.get('no')!.shares).toBe(5);expect(s.simulatedMerges).toBe(0);
    s.releasePairedInventory('a',2000);s.expire(2250);expect(s.inventory.cashUsd).toBeCloseTo(1000.02);expect(s.simulatedMerges).toBe(1);
    expect(s.splitInventory('a',5)).toBe(true);expect(s.inventory.cashUsd).toBeCloseTo(995.01);expect(s.splitInventory('a',5)).toBe(false);
  });
  it('reserves a cash floor even when open inventory has no usable mark',()=>{
    const s=new MmPaperSession(1000,{...cfg,maxCashLossUsd:6});s.register(market);expect(s.splitInventory('a',5)).toBe(true);
    const shallow={bids:[{price:.09,size:100}],asks:[{price:.13,size:100}]};
    s.replace('a',[quote('BUY',.1),{...quote('BUY',.1),outcomeIndex:1}],[shallow,shallow],1000);
    expect(s.openQuotes()).toHaveLength(1);expect(s.inventory.cashUsd-s.exposure('a','event').reservedCashUsd).toBeGreaterThanOrEqual(994);
    expect(s.splitInventory('a',5)).toBe(false);
  });
  it('charges collateral and costs for complete-set inventory, with no free equity',()=>{
    const p=new MmPaperInventory(1000);p.registerMarket('a','yes','no');
    expect(p.split('split','a',5,.01)).toBe(true);expect(p.cashUsd).toBeCloseTo(994.99);
    expect(p.holdings.get('yes')).toEqual({shares:5,costUsd:2.505});
    expect(p.equity(new Map([['yes',.48],['no',.52]]))).toBeCloseTo(999.99);
    expect(p.split('split','a',5,.01)).toBe(false);expect(p.feesUsd).toBe(.01);
    p.merge('merge','yes','no',5,.01);expect(p.cashUsd).toBeCloseTo(999.98);expect(p.realizedPnlUsd).toBeCloseTo(-.02);
  });
  it('rejects unsupported or unaffordable splits without changing inventory',()=>{
    const p=new MmPaperInventory(5);p.registerMarket('a','yes','no');
    expect(()=>p.split('x','a',5,.01)).toThrow(/overdraft/);expect(p.cashUsd).toBe(5);expect(p.holdings.size).toBe(0);
    const s=new MmPaperSession(1000,cfg);s.register({...market,mergeSupported:false});expect(s.splitInventory('a',5)).toBe(false);
  });
  it('counts split inventory against risk caps and enables only owned asks',()=>{
    const events:any[]=[];const s=new MmPaperSession(1000,cfg,(type,data)=>events.push({type,data}));s.register(market);
    expect(s.splitInventory('a',5)).toBe(true);expect(s.splitInventory('a',5)).toBe(false);
    expect(s.exposure('a','event').marketUsd).toBeCloseTo(5.01);expect(s.simulatedSplits).toBe(1);expect(s.simulatedFills).toBe(0);
    s.replace('a',[quote('BUY',.48),quote('SELL',.52)],[book,book],1000);
    expect(s.openQuotes().map(q=>q.side)).toEqual(['BUY','SELL']);expect(events[0].type).toBe('paper-split');
    const limited=new MmPaperSession(1000,{...cfg,maxMarketUsd:5});limited.register(market);expect(limited.splitInventory('a',5)).toBe(false);
  });
  it('keeps exact-price controls and labels price-through counterfactual fills',()=>{
    const strict=new PaperQueue('BUY',.49,5,0,1000,5000),through=new PaperQueue('BUY',.49,5,0,1000,5000,'price-through');
    expect(strict.print('sell','SELL',.48,5,2000)).toBe(0);expect(through.print('sell','SELL',.48,5,2000)).toBe(5);
    const ask=new PaperQueue('SELL',.51,5,3,1000,5000,'price-through');expect(ask.print('buy','BUY',.52,5,2000)).toBe(2);
    expect(ask.print('buy','BUY',.52,5,2000)).toBe(0);
  });
  it('never infers fills from a print that does not reach our limit or precedes activation',()=>{
    const q=new PaperQueue('BUY',.49,5,0,1000,5000,'price-through');
    expect(q.print('bad','SELL',.50,100,2000)).toBe(0);expect(q.print('same-side','BUY',.48,100,2000)).toBe(0);
    expect(q.print('early','SELL',.48,100,900)).toBe(0);expect(q.print('late','SELL',.48,100,5000)).toBe(0);expect(q.remaining).toBe(5);
  });
  it('rejects self-crossing desired orders before changing existing quotes',()=>{
    const s=new MmPaperSession(1000,cfg);s.register(market);s.splitInventory('a',5);
    expect(()=>s.replace('a',[quote('BUY',.5),quote('SELL',.5)],[book,book],1000)).toThrow(/self-cross/);expect(s.openQuotes()).toHaveLength(0);
  });
  it('retains cancelling exposure and permits a real print before cancel acknowledgment',()=>{
    const s=new MmPaperSession(1000,cfg,()=>{},250,'same-price','exact-price',250);s.register(market);
    s.replace('a',[quote('BUY',.49)],[book,book],1000);s.cancelMarket('a','test',1500);
    expect(s.openQuotes()[0].cancelAt).toBe(1750);expect(s.exposure('a','event').reservedCashUsd).toBeGreaterThan(0);
    expect(s.print({id:'late-fill',token:'yes',aggressor:'SELL',price:.49,shares:5,at:1600},1600,true)).toBe(5);
    expect(s.inventory.cashUsd).toBeCloseTo(997.55);
  });
  it('does not overlap replacements or refill an acknowledged cancellation',()=>{
    const s=new MmPaperSession(1000,cfg,()=>{},250,'same-price','exact-price',250);s.register(market);
    s.replace('a',[quote('BUY',.49)],[book,book],1000);s.replace('a',[quote('BUY',.48)],[book,book],1500);
    expect(s.openQuotes()).toHaveLength(1);expect(s.openQuotes()[0].price).toBe(.49);
    s.expire(1750);expect(s.openQuotes()).toHaveLength(0);expect(s.exposure('a','event').reservedCashUsd).toBe(0);
    expect(s.print({id:'after-ack',token:'yes',aggressor:'SELL',price:.49,shares:5,at:1800},1800,true)).toBe(0);
  });
  it('does not cross an opposite order that is still awaiting cancel acknowledgment',()=>{
    const s=new MmPaperSession(1000,cfg,()=>{},250,'same-price','exact-price',250);s.register(market);s.splitInventory('a',5);
    s.replace('a',[quote('BUY',.51)],[book,book],1000);
    s.replace('a',[quote('BUY',.49),quote('SELL',.5)],[book,book],1500);
    expect(s.openQuotes()).toHaveLength(1);expect(s.openQuotes()[0].side).toBe('BUY');
    s.expire(1750);s.replace('a',[quote('BUY',.49),quote('SELL',.5)],[book,book],1800);
    expect(s.openQuotes()).toHaveLength(2);
  });
  it('reserves worst-case directional exposure across both outcome books and pending cancels',()=>{
    const s=new MmPaperSession(1000,{...cfg,maxNetShares:5},()=>{},250,'same-price','exact-price',250);s.register(market);s.splitInventory('a',5);
    s.replace('a',[quote('BUY',.49),{...quote('SELL',.51),outcomeIndex:1}],[book,book],1000);
    expect(s.openQuotes()).toHaveLength(1);expect(s.openQuotes()[0].side).toBe('BUY');
    s.cancelMarket('a','test',1500);
    s.replace('a',[{...quote('SELL',.51),outcomeIndex:1}],[book,book],1600);
    expect(s.openQuotes()).toHaveLength(1);expect(s.openQuotes()[0].side).toBe('BUY');
    s.expire(1750);s.replace('a',[{...quote('SELL',.51),outcomeIndex:1}],[book,book],1800);
    expect(s.openQuotes()).toHaveLength(1);expect(s.openQuotes()[0].side).toBe('SELL');
  });
  it('waits for live asks to cancel before merging their backing inventory',()=>{
    const s=new MmPaperSession(1000,cfg,()=>{},250,'same-price','exact-price',250);s.register(market);s.splitInventory('a',5);
    s.replace('a',[quote('SELL',.51)],[book,book],1000);s.releasePairedInventory('a',1500);
    expect(s.simulatedMerges).toBe(0);expect(s.inventory.holdings.get('yes')!.shares).toBe(5);
    s.expire(1750);expect(s.simulatedMerges).toBe(1);expect(s.inventory.cashUsd).toBeCloseTo(999.98);expect(s.openQuotes()).toHaveLength(0);
  });
  it('settles only a registered winning token and prevents quotes after resolution',()=>{
    const s=new MmPaperSession(1000,cfg);s.register(market);s.splitInventory('a',5);
    expect(()=>s.resolveMarket('a','unrelated',1500)).toThrow(/resolution/);
    expect(s.resolveMarket('a','yes',1500)).toBe(true);expect(s.inventory.cashUsd).toBeCloseTo(999.98);expect(s.simulatedSettlements).toBe(1);
    expect(s.resolveMarket('a','yes',1600)).toBe(false);s.replace('a',[quote('BUY',.49)],[book,book],2000);expect(s.openQuotes()).toHaveLength(0);
  });
  it('improves spread prices while retaining one tick between its own orders',()=>{
    const now=100000;const x={now,receivedAt:now,serverAt:now,usable:true,book,history:Array.from({length:31},(_,i)=>({at:now-30000+i*1000,mid:.5})),tick:.01,minShares:5,fee:market.fee,accepting:true,eventAt:now+3600000,eventTimeRequired:true,cashAvailableUsd:1000,ownedShares:5,netOutcomeShares:0,marketCommittedUsd:0,eventCommittedUsd:0,portfolioCommittedUsd:0};
    expect(planMmQuote(x,cfg,'improve').quotes.map(q=>q.price)).toEqual([.49,.51]);
    const two={...x,book:{bids:[{price:.49,size:1000}],asks:[{price:.51,size:1000}]}};
    expect(planMmQuote(two,cfg,'improve').quotes.map(q=>q.price)).toEqual([.49,.5]);
    expect(planMmQuote({...two,eventAt:now+120000,eventBufferMs:60000},cfg,'improve').quotes).toHaveLength(2);
    expect(planMmQuote({...two,eventAt:now+120000},cfg,'improve').reason).toBe('event_time_guard');
  });
});
