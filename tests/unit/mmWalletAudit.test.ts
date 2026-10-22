import {describe,it,expect} from 'vitest';
import {TradeAudit,auditPnl,makerRowEstimate,marketFamily} from '../../src/research/mm/walletAudit.js';
import {walkPublicPages,publicJson} from '../../src/research/mm/publicData.js';
const wallet='0x'+'1'.repeat(40),condition='0x'+'2'.repeat(64),complete={rows:2,pages:1,complete:true,reason:null};
const trade=(overrides={})=>({proxy_wallet:wallet,condition_id:condition,token_id:'123',side:'BUY',size:10,price:.4,timestamp:100,title:'Counter-Strike: A vs B',slug:'cs2-a-b',event_slug:'match',outcome:'A',...overrides});
describe('public wallet audits',()=>{
 it('groups outcome executions within a condition and does not label turnover as profit',()=>{
  const a=new TradeAudit(wallet,90,110);a.add([trade(),trade({token_id:'456',price:.5}),trade({side:'SELL',size:2})]);const s=a.summary(complete);
  expect(s.marketCount).toBe(1);expect(s.multipleOutcomeMarkets).toBe(1);expect(s.sameTokenBuyAndSellMarkets).toBe(1);expect(s.grossUsd).toBeCloseTo(9.8);expect(s.netTradeCashBeforeFeesUsd).toBeCloseTo(-8.2);expect(s.effectiveMarketCount).toBe(1);
 });
 it('rejects wrong wallets, invalid prices and rows outside the requested window',()=>{
  const a=new TradeAudit(wallet,90,110);a.add([trade({proxy_wallet:'bad'}),trade({price:NaN}),trade({timestamp:111})]);expect(a.rows).toBe(0);expect(a.rejectedRows).toBe(3);
 });
 it('estimates maker rows only with complete consistent feeds',()=>{
  const a=new TradeAudit(wallet,90,110),t=new TradeAudit(wallet,90,110);a.add([trade(),trade()]);t.add([trade()]);
  expect(makerRowEstimate(a.summary(complete),t.summary(complete)).makerRowShare).toBe(.5);
  expect(makerRowEstimate(a.summary({...complete,complete:false}),t.summary(complete)).available).toBe(false);
  expect(makerRowEstimate(t.summary(complete),a.summary(complete)).available).toBe(false);
 });
 it('excludes the partial day and never interprets dollar PnL consistency as portfolio Sharpe',()=>{
  const p=(timestamp:number,value:number)=>({timestamp,economic_pnl:value,position_pnl:value-1,wallet_income:1,cashflow_net:null});
  const s=auditPnl([p(86400,5),p(172800,7),p(259200,11),p(260000,1000)],259200);
  expect(s.completeDayIncrements).toBe(2);expect(s.economicPnlChangeUsd).toBe(6);expect(s.meanDailyDollarPnl).toBe(3);expect(s.portfolioSharpe).toBeNull();expect(s.cashflowCoverage).toBe(0);
 });
 it('does not fabricate zero returns across missing marks or calendar gaps',()=>{
  const s=auditPnl([{timestamp:86400,economic_pnl:0,position_pnl:0},{timestamp:259200,economic_pnl:3,position_pnl:3},{timestamp:345600,economic_pnl:null,position_pnl:null}],345600);
  expect(s.completeDayIncrements).toBe(0);expect(s.missingOrIrregularIntervals).toBe(2);expect(s.dailyDollarPnlMeanOverSd).toBeNull();
 });
 it('keeps crypto, esports, tennis and unknown discovery labels explicit',()=>{
  expect(marketFamily('Counter-Strike: A vs B','cs2-a-b')).toBe('esports');expect(marketFamily('Braga: Player A vs Player B','atp-a-b')).toBe('tennis');expect(marketFamily('BTC','btc-updown-5m-1')).toBe('crypto');expect(marketFamily('Unknown','unknown')).toBe('unclassified');
 });
});
describe('public pagination and transport boundaries',()=>{
 it('preserves wallet/window/role filters on subsequent cursor pages',async()=>{
  const seen:string[]=[];const collected:number[]=[];const r=await walkPublicPages<number>('https://data-api.polymarket.com/v2/trades?user=abc&start=12&taker_only=false',3,a=>collected.push(...a),async url=>{
   seen.push(url);return seen.length===1?{data:[1],pagination:{has_more:true,next_cursor:'next'}}:{data:[2],pagination:{has_more:false,next_cursor:null}};
  });expect(r.complete).toBe(true);expect(collected).toEqual([1,2]);expect(new URL(seen[1]).searchParams.get('taker_only')).toBe('false');expect(new URL(seen[1]).searchParams.get('start')).toBe('12');
 });
 it('reports page caps without declaring the feed complete',async()=>{
  const r=await walkPublicPages('https://data-api.polymarket.com/v2/trades',1,()=>{},async()=>({data:[1],pagination:{has_more:true,next_cursor:'next'}}));expect(r.complete).toBe(false);expect(r.reason).toBe('page_budget_exhausted');
 });
 it('rejects repeating cursor loops',async()=>{await expect(walkPublicPages('https://data-api.polymarket.com/v2/trades',3,()=>{},async()=>({data:[1],pagination:{has_more:true,next_cursor:'same'}}))).rejects.toThrow(/repeating/);});
 it('rejects arbitrary hosts and URL credentials before networking',async()=>{await expect(publicJson('https://example.com')).rejects.toThrow(/Unsupported/);await expect(publicJson('https://secret@data-api.polymarket.com/v2/trades')).rejects.toThrow(/Unsupported/);});
});
