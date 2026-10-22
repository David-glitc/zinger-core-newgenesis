import {describe,it,expect} from 'vitest';
import {MmPaperSession,type PaperMarket} from '../../src/research/mm/paperSession.js';
import {DEFAULT_MM_CONFIG,type MmQuote} from '../../src/research/mm/strategy.js';
const cfg={...DEFAULT_MM_CONFIG,maxPortfolioUsd:50};
const market=(id='a',event='match'):PaperMarket=>({conditionId:id,event,tokens:[`yes-${id}`,`no-${id}`],fee:{rate:.05,exponent:1},minShares:5,tick:.01,mergeSupported:true});
const book={bids:[{price:.4,size:10}],asks:[{price:.6,size:10}]};
const quote=(price=.45,outcomeIndex=0,side:'BUY'|'SELL'='BUY'):MmQuote&{outcomeIndex:number}=>({side,price,shares:5,postOnly:true,expiresAt:3000,outcomeIndex});
const print=(id='t',overrides={})=>({id,token:'yes-a',aggressor:'SELL' as const,price:.45,shares:5,at:1500,...overrides});
describe('$500 MM paper session',()=>{
 it('does not charge better-priced bid depth again to an exact-price print',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());const deep={bids:[{price:.5,size:100000},{price:.45,size:10}],asks:book.asks};s.replace('a',[quote()],[deep,book],1000);
  expect(s.openQuotes()[0].queueAhead).toBe(10);expect(s.print(print('better',{price:.5,shares:100000}),1500,true)).toBe(0);
  expect(s.print(print('same',{at:1600,shares:15}),1600,true)).toBe(5);expect(s.inventory.cashUsd).toBeCloseTo(497.75);
 });
 it('uses only the same-price ask queue and still requires owned inventory',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.inventory.fill('owned','yes-a','BUY',5,.4,0);
  const deep={bids:book.bids,asks:[{price:.5,size:100000},{price:.55,size:10}]};s.replace('a',[quote(.55,0,'SELL')],[deep,book],1000);
  expect(s.openQuotes()[0].queueAhead).toBe(10);expect(s.print(print('ask',{aggressor:'BUY',price:.55,shares:15}),1500,true)).toBe(5);expect(s.inventory.realizedPnlUsd).toBeCloseTo(.75);
 });
 it('can reproduce the legacy cumulative queue in an explicitly labeled comparison',()=>{
  const s=new MmPaperSession(500,cfg,()=>{},250,'legacy-cumulative');s.register(market());s.replace('a',[quote()],[{bids:[{price:.5,size:100},{price:.45,size:10}],asks:book.asks},book],1000);
  expect(s.openQuotes()[0].queueAhead).toBe(110);expect(s.print(print('same',{shares:15}),1500,true)).toBe(0);
 });
 it('starts with exactly $500 and changes cash only on identified simulated fills',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.replace('a',[quote()],[book,book],1000);expect(s.inventory.cashUsd).toBe(500);expect(s.openQuotes()).toHaveLength(1);
  expect(s.print(print(),1500,true)).toBe(5);expect(s.inventory.cashUsd).toBeCloseTo(497.75);expect(s.simulatedFills).toBe(1);expect(s.inventory.feesUsd).toBe(0);
 });
 it('waits for activation and does not fill from prints occurring before placement',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.replace('a',[quote()],[book,book],1000);
  expect(s.print(print('early',{at:1100}),1100,true)).toBe(0);expect(s.print(print('before',{at:900}),1400,true)).toBe(0);expect(s.inventory.cashUsd).toBe(500);
 });
 it('never books late, future, unidentified, duplicated or unhealthy prints',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.replace('a',[quote()],[book,book],1000);
  for(const[id,p,received,healthy]of [['',{},1500,true],['future',{at:1600},1500,true],['late',{at:1000},2800,true],['bad',{},1500,false]] as const)expect(s.print(print(id,p),received,healthy)).toBe(0);
  expect(s.print(print('good'),1500,true)).toBe(5);expect(s.print(print('good'),1500,true)).toBe(0);expect(s.simulatedFills).toBe(1);
 });
 it('consumes displayed queue without giving credit for cancellations',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());const deep={bids:[{price:.45,size:10}],asks:book.asks};s.replace('a',[quote()],[deep,book],1000);
  expect(s.print(print('first',{shares:10}),1500,true)).toBe(0);expect(s.print(print('second',{at:1600,shares:2}),1600,true)).toBe(2);expect(s.inventory.holdings.get('yes-a')!.shares).toBe(2);
 });
 it('preserves an unchanged quote queue until its original expiration',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.replace('a',[quote()],[book,book],1000);const id=s.openQuotes()[0].id;s.replace('a',[{...quote(),expiresAt:4000}],[book,book],2000);expect(s.openQuotes()[0].id).toBe(id);expect(s.openQuotes()[0].expiresAt).toBe(3000);s.expire(3000);expect(s.openQuotes()).toHaveLength(0);
 });
 it('does not oversell or exceed global committed cash',()=>{
  const s=new MmPaperSession(500,{...cfg,maxPortfolioUsd:3});s.register(market());s.replace('a',[quote(),quote(.5,1),quote(.55,0,'SELL')],[book,book],1000);expect(s.openQuotes()).toHaveLength(1);expect(s.exposure('a','match').portfolioUsd).toBeLessThanOrEqual(3);
 });
 it('includes filled inventory in market and event risk limits',()=>{
  const s=new MmPaperSession(500,{...cfg,maxMarketUsd:3});s.register(market());s.replace('a',[quote()],[book,book],1000);s.print(print(),1500,true);s.replace('a',[{...quote(),expiresAt:5000}],[book,book],2000);expect(s.openQuotes()).toHaveLength(0);expect(s.exposure('a','match').marketUsd).toBeCloseTo(2.25);
 });
 it('merges only after both paid simulated fills, charges a cost and cancels stale sell quotes',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.replace('a',[quote(),quote(.5,1)],[book,book],1000);s.print(print(),1500,true);expect(s.simulatedMerges).toBe(0);
  s.print(print('other',{token:'no-a',price:.5,at:1600}),1600,true);expect(s.simulatedMerges).toBe(1);expect(s.inventory.cashUsd).toBeCloseTo(500.24);expect(s.inventory.realizedPnlUsd).toBeCloseTo(.24);expect(s.openQuotes()).toHaveLength(0);
 });
 it('keeps negative-risk pairs as inventory until their lifecycle is supported',()=>{
  const s=new MmPaperSession(500,cfg);s.register({...market(),mergeSupported:false});s.replace('a',[quote(),quote(.5,1)],[book,book],1000);s.print(print(),1500,true);s.print(print('other',{token:'no-a',price:.5,at:1600}),1600,true);expect(s.simulatedMerges).toBe(0);expect(s.inventory.cashUsd).toBeCloseTo(495.25);
 });
 it('cannot refill an expired quote or a quote cancelled after disconnect',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());s.replace('a',[quote()],[book,book],1000);s.cancelMarket('a','disconnect');expect(s.print(print(),1500,true)).toBe(0);s.replace('a',[quote()],[book,book],2000);expect(s.print(print('after',{at:3100}),3100,true)).toBe(0);
 });
 it('rejects a crossing quote before it can be treated as passive',()=>{
  const s=new MmPaperSession(500,cfg);s.register(market());expect(()=>s.replace('a',[quote(.6)],[book,book],1000)).toThrow(/crosses/);expect(s.openQuotes()).toHaveLength(0);
 });
});
