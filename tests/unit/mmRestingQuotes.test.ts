import {describe,it,expect} from 'vitest';
import {MmPaperSession,RESTING_POLICY} from '../../src/research/mm/paperSession.js';
import {CTF_MATCHING_MODEL} from '../../src/research/mm/ctfMatching.js';
import {DEFAULT_MM_CONFIG} from '../../src/research/mm/strategy.js';

const config={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000,maxPortfolioUsd:100,restToleranceTicks:1};
const market={conditionId:'market',event:'event',tokens:['yes','no'] as [string,string],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true,quoteDeadlineAt:200000};
const book=(bid:number,ask:number)=>[{bids:[{price:bid,size:1000}],asks:[{price:ask,size:1000}]},{bids:[{price:+(1-ask).toFixed(2),size:1000}],asks:[{price:+(1-bid).toFixed(2),size:1000}]}];
const buy=(price:number,expiresAt:number)=>({outcomeIndex:0,side:'BUY' as const,price,shares:5,postOnly:true as const,expiresAt});

function fixture(){
 const rows:any[]=[];
 const s=new MmPaperSession(1000,{...config},(type,data)=>rows.push({type,data}),250,'same-price','exact-price',250,CTF_MATCHING_MODEL,RESTING_POLICY);
 s.register(market);
 const print=(n:number,price:number,shares:number,at:number)=>{const tx=`0x${n.toString(16).padStart(64,'0')}`;return s.print({id:`${tx}:yes:${at}:${price}:${shares}:SELL`,token:'yes',aggressor:'SELL',price,shares,at},at,true,true);};
 return{s,rows,print};
}

describe('resting quotes with churn tolerance',()=>{
 it('keeps order identity and queue progress while the target moves within tolerance',()=>{
  const f=fixture();
  f.s.replace('market',[buy(.77,110000)],book(.77,.79),100000);
  const id=f.s.openQuotes()[0].id;
  expect(f.print(1,.77,400,101000)).toBe(0);
  expect(f.s.openQuotes()[0].queueAhead).toBeCloseTo(600);
  f.s.replace('market',[buy(.76,111000)],book(.77,.79),101500);
  expect(f.s.openQuotes()[0]).toMatchObject({id,price:.77});
  expect(f.s.openQuotes()[0].queueAhead).toBeCloseTo(600);
  expect(f.s.quotesPlaced).toBe(1);
  expect(f.s.restingKept).toBe(1);
 });

 it('cancels and later re-places when the target moves beyond tolerance',()=>{
  const f=fixture();
  f.s.replace('market',[buy(.77,110000)],book(.77,.79),100000);
  const id=f.s.openQuotes()[0].id;
  f.s.replace('market',[buy(.74,111000)],book(.74,.79),101000);
  expect(f.rows.some(r=>r.type==='paper-cancel-request'&&r.data.id===id&&r.data.reason==='outside_tolerance')).toBe(true);
  f.s.replace('market',[buy(.74,111500)],book(.74,.79),101500);
  const open=f.s.openQuotes();
  expect(open).toHaveLength(1);
  expect(open[0].id).not.toBe(id);
  expect(open[0].price).toBe(.74);
 });

 it('has no client-side expiry and ends at the market quote deadline',()=>{
  const f=fixture();
  f.s.replace('market',[buy(.77,110000)],book(.77,.79),100000);
  f.s.expire(150000);
  expect(f.s.openQuotes()).toHaveLength(1);
  f.s.expire(200000);
  expect(f.rows.some(r=>r.type==='paper-cancel-request'&&r.data.reason==='quote_deadline')).toBe(true);
  f.s.expire(200300);
  expect(f.s.openQuotes()).toHaveLength(0);
 });

 it('cancels a kept quote that would now cross the book',()=>{
  const f=fixture();
  f.s.replace('market',[buy(.77,110000)],book(.77,.79),100000);
  f.s.replace('market',[buy(.76,111000)],book(.76,.77),101000);
  expect(f.rows.some(r=>r.type==='paper-cancel-request'&&r.data.reason==='would_cross')).toBe(true);
 });

 it('cancels when the strategy no longer wants a quote on that side',()=>{
  const f=fixture();
  f.s.replace('market',[buy(.77,110000)],book(.77,.79),100000);
  f.s.replace('market',[],book(.77,.79),101000);
  expect(f.rows.some(r=>r.type==='paper-cancel-request'&&r.data.reason==='no_target')).toBe(true);
 });

 it('fills a kept quote from its preserved queue position',()=>{
  const f=fixture();
  f.s.replace('market',[buy(.77,110000)],book(.77,.79),100000);
  f.print(1,.77,400,101000);
  f.s.replace('market',[buy(.77,121000)],book(.77,.79),111000);
  expect(f.print(2,.77,603,112000)).toBe(3);
  expect(f.s.simulatedFills).toBe(1);
 });
});
