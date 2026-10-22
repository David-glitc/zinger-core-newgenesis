import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {describe,it,expect} from 'vitest';
import {MmPaperSession} from '../../src/research/mm/paperSession.js';
import {CTF_MATCHING_MODEL} from '../../src/research/mm/ctfMatching.js';
import {DEFAULT_MM_CONFIG,planMmIndependent,type MmInput} from '../../src/research/mm/strategy.js';
import {recoverPaperSession} from '../../src/research/mm/recovery.js';

const config={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000,maxPortfolioUsd:100,reservePerShare:.0025,skewAtLimit:0,sigmaMultiplier:.5,feeReserveLegs:1};
const market={conditionId:'market',event:'event',tokens:['yes','no'] as [string,string],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true,quoteDeadlineAt:200000};
const books=[{bids:[{price:.77,size:1000}],asks:[{price:.78,size:10.01}]},{bids:[{price:.22,size:10.01}],asks:[{price:.23,size:1000}]}];
const quote=(expiresAt:number)=>({outcomeIndex:0,side:'SELL' as const,price:.78,shares:5,postOnly:true as const,expiresAt});
function fixture(policy:'fixed-expiry'|'renewable-client-lease-v1'='renewable-client-lease-v1'){
 const rows:any[]=[];let clock=100000;const cfg={...config};
 const s=new MmPaperSession(1000,cfg,(type,data)=>rows.push({sequence:rows.length+1,at:clock,type,data}),250,'same-price','price-through',250,CTF_MATCHING_MODEL,policy);
 s.register(market);rows.push({sequence:1,at:clock,type:'market',data:{...market,protocol:'v1',negativeRisk:false,eventAt:market.quoteDeadlineAt,eventBufferMs:0,tokens:market.tokens.map(id=>({id}))}});s.splitInventory('market',5);
 const replace=(quotes:any[],at:number)=>{clock=at;s.replace('market',quotes,books,at);};
 const print=(n:number,shares:number,at:number)=>{clock=at;const tx=`0x${n.toString(16).padStart(64,'0')}`;return s.print({id:`${tx}:yes:${at}:0.78:${shares}:BUY`,token:'yes',aggressor:'BUY',price:.78,shares,at},at,true,true);};
 const input=(now:number,i:number):MmInput=>({now,receivedAt:now,serverAt:now,usable:true,book:books[i],history:Array.from({length:31},(_,j)=>({at:now-30000+j*1000,mid:i?.225:.775})),tick:.01,minShares:5,fee:market.fee,accepting:true,eventAt:market.quoteDeadlineAt,eventBufferMs:0,eventTimeRequired:true,cashAvailableUsd:s.availableRiskCash(),ownedShares:s.inventory.holdings.get(market.tokens[i])?.shares??0,netOutcomeShares:(s.inventory.holdings.get(market.tokens[i])?.shares??0)-(s.inventory.holdings.get(market.tokens[1-i])?.shares??0),marketCommittedUsd:s.exposure('market','event',true).marketUsd,eventCommittedUsd:s.exposure('market','event',true).eventUsd,portfolioCommittedUsd:s.exposure('market','event',true).portfolioUsd});
 return{s,cfg,rows,replace,print,input,setClock:(at:number)=>{clock=at;}};
}
describe('GTC client leases and legal partial maintenance',()=>{
 it('preserves queue progress and order identity across renewed full-size intents',()=>{
  const f=fixture();f.replace([quote(110000)],100000);const id=f.s.openQuotes()[0].id;
  expect(f.print(1,4,105000)).toBe(0);expect(f.s.openQuotes()[0].queueAhead).toBeCloseTo(6.01);
  f.replace([quote(119000)],109000);expect(f.s.openQuotes()[0]).toMatchObject({id,queueAhead:6.01,expiresAt:119000});expect(f.s.quotesPlaced).toBe(1);expect(f.s.leasesRenewed).toBe(1);
  expect(f.print(2,11.01,111000)).toBe(5);expect(f.s.simulatedFills).toBe(1);
 });
 it('keeps the observed 0.03532-share remainder working without submitting an undersized new order',()=>{
  const f=fixture();f.replace([quote(110000)],100000);const id=f.s.openQuotes()[0].id;f.replace([quote(119000)],109000);
  expect(f.print(1,14.97468,109584)).toBe(4.96468);expect(f.s.openQuotes()[0].remaining).toBeCloseTo(.03532);
  const now=109900,existing=f.s.openQuotes().map(q=>({...q,outcomeIndex:market.tokens.indexOf(q.token)}));
  const plan=planMmIndependent(f.input(now,0),f.input(now,1),f.cfg,'touch',existing);
  expect(plan.quotes.find(q=>q.maintenanceOf===id)).toMatchObject({side:'SELL',price:.78,shares:.03532});
  f.replace(plan.quotes,now);expect(f.s.openQuotes().find(q=>q.id===id)!.expiresAt).toBe(119900);
  expect(f.rows.filter(r=>r.type==='paper-order').every(r=>r.data.shares>=5)).toBe(true);
  expect(f.print(2,.03532,111000)).toBe(.03532);expect(f.s.openQuotes().some(q=>q.id===id)).toBe(false);
 });
 it('retains working-ask pricing context instead of improving a new bid into the partial ask',()=>{
  const f=fixture();const input={...f.input(109900,0),book:{bids:[{price:.77,size:10}],asks:[{price:.79,size:10}]},ownedShares:.03532};
  const p=planMmIndependent(input,f.input(109900,1),f.cfg,'improve',[{id:'existing',outcomeIndex:0,side:'SELL',price:.78,remaining:.03532,originalShares:5}]);
  const own=p.quotes.filter(q=>q.outcomeIndex===0);expect(own.find(q=>q.side==='BUY')?.price).toBe(.77);expect(own.find(q=>q.side==='SELL')?.price).toBe(.78);
 });
 it('requests cancellation at lease expiry, retains risk and can fill before acknowledgment',()=>{
  const f=fixture();f.replace([quote(110000)],100000);f.setClock(110000);f.s.expire(110000);
  expect(f.s.openQuotes()[0]).toMatchObject({cancelAt:110250});expect(f.s.quotesCancelled).toBe(0);
  expect(f.print(1,11.01,110100)).toBe(1);expect(f.s.openQuotes()[0].remaining).toBe(4);
  f.replace([{...quote(120100),shares:4,maintenanceOf:f.s.openQuotes()[0].id}],110150);expect(f.s.leasesRenewed).toBe(0);expect(f.s.openQuotes()[0].cancelAt).toBe(110250);
  expect(f.print(2,100,110250)).toBe(0);expect(f.s.openQuotes()).toHaveLength(0);
 });
 it('retains the fixed-expiry control and rejects new undersized orders, amendments and unknown IDs',()=>{
  const control=fixture('fixed-expiry');control.replace([quote(110000)],100000);expect(control.print(1,100,110100)).toBe(0);expect(control.s.quotesCancelled).toBe(1);
  const f=fixture();expect(()=>f.replace([{...quote(110000),shares:.03532}],100000)).toThrow(/Invalid resting/);
  f.replace([quote(110000)],100000);const id=f.s.openQuotes()[0].id;
  expect(()=>f.replace([{...quote(111000),shares:4,maintenanceOf:id}],101000)).toThrow(/maintenance binding/);
  expect(()=>f.replace([{...quote(111000),price:.79,maintenanceOf:id}],101000)).toThrow(/maintenance binding/);
  f.replace([{...quote(111000),shares:.03532,maintenanceOf:'missing'}],101000);expect(f.s.quotesPlaced).toBe(1);expect(f.rows.some(r=>r.type==='paper-maintenance-rejected')).toBe(true);
 });
 it('cancels changed-price or stale plans instead of renewing and enforces the hard deadline',()=>{
  const f=fixture();f.replace([quote(110000)],100000);const p=planMmIndependent({...f.input(109000,0),usable:false},f.input(109000,1),f.cfg,'touch',f.s.openQuotes().map(q=>({...q,outcomeIndex:0})));
  expect(p.quotes.some(q=>q.maintenanceOf)).toBe(false);f.replace([],109000);expect(f.s.openQuotes()[0].cancelAt).toBe(109250);expect(f.s.leasesRenewed).toBe(0);
  const next=fixture();expect(()=>next.replace([quote(200001)],199000)).toThrow(/lease deadline/);
  const changed=planMmIndependent({...next.input(109000,0),book:{bids:[{price:.78,size:100}],asks:[{price:.79,size:100}]}},next.input(109000,1),next.cfg,'touch',[{id:'old',outcomeIndex:0,side:'SELL',price:.78,remaining:.03532,originalShares:5}]);expect(changed.quotes.some(q=>q.maintenanceOf==='old')).toBe(false);
 });
 it('cannot renew through tightened risk limits',()=>{
  const f=fixture();f.replace([quote(110000)],100000);f.cfg.maxMarketUsd=2;f.replace([quote(119000)],109000);
  expect(f.s.leasesRenewed).toBe(0);expect(f.rows.find(r=>r.type==='paper-cancel-request').data.reason).toBe('reservation_risk');
 });
 it('recovers the renewed lease, original size and cash, then quarantines uncertain old orders',async()=>{
  const f=fixture();f.replace([quote(110000)],100000);f.replace([quote(119000)],109000);f.print(1,14.97468,109584);
  const root=fs.mkdtempSync(path.join(tmpdir(),'mm-lease-recovery-'));
  try{fs.writeFileSync(path.join(root,'source.json'),JSON.stringify({files:{}}));fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({status:'completed',bankrollUsd:1000,config:f.cfg,matchingModel:CTF_MATCHING_MODEL,expiryPolicy:'renewable-client-lease-v1',latencyMs:250,cancelLatencyMs:250,queueModel:'same-price',fillRule:'price-through',actualSpendUsd:0,ordersSubmitted:0}));fs.writeFileSync(path.join(root,'events.jsonl.gz'),gzipSync(f.rows.map(r=>JSON.stringify(r)+'\n').join('')));
   const r=await recoverPaperSession(root);expect(r.counters.leasesRenewed).toBe(1);expect(r.outstandingOrders[0]).toMatchObject({shares:5,remaining:.03532,expiresAt:119000});expect(r.inventory.cashUsd).toBeCloseTo(f.s.inventory.cashUsd);
   const next=new MmPaperSession(1000,f.cfg,()=>{},250,'same-price','price-through',250,CTF_MATCHING_MODEL,'renewable-client-lease-v1');next.restoreRecovered(r,111000);expect(next.openQuotes()[0]).toMatchObject({cancelAt:111250,originalShares:5});next.expire(111250);expect(next.openQuotes()).toHaveLength(0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
});
