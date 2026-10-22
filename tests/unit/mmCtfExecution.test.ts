import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {MmPaperSession,type PaperExpiryPolicy} from '../../src/research/mm/paperSession.js';
import {DEFAULT_MM_CONFIG} from '../../src/research/mm/strategy.js';
import {recoverPaperSession} from '../../src/research/mm/recovery.js';
import {CTF_MATCHING_MODEL} from '../../src/research/mm/ctfMatching.js';
const cfg={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000,maxPortfolioUsd:100};
const market={conditionId:'a',event:'event',tokens:['yes','no'] as [string,string],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true,quoteDeadlineAt:20000};
const quote=(side:'BUY'|'SELL',price:number,outcomeIndex:number)=>({side,price,outcomeIndex,shares:5,postOnly:true as const,expiresAt:10000});
const books=[{bids:[{price:.57,size:1000}],asks:[{price:.59,size:2},{price:.6,size:1000}]},{bids:[{price:.38,size:1000}],asks:[{price:.42,size:1000}]}];
const tape=(token='yes',aggressor:'BUY'|'SELL'='BUY',price=.6,shares=10,at=2000)=>({id:`0x${'a'.repeat(64)}:${token}:${at}:${price}:${shares}:${aggressor}`,token,aggressor,price,shares,at});
function fixture(fund=false,expiryPolicy:PaperExpiryPolicy='fixed-expiry'){
 const rows:any[]=[];let clock=1000,bookAt=1000,revision=1;const record=(type:string,data:any)=>rows.push({sequence:rows.length+1,at:clock,type,data});
 const session=new MmPaperSession(1000,cfg,record,250,'same-price','price-through',250,CTF_MATCHING_MODEL,expiryPolicy);session.register(market);
 record('market',{...market,eventAt:market.quoteDeadlineAt,eventBufferMs:0,protocol:'v1',negativeRisk:false,tokens:market.tokens.map(id=>({id}))});
 record('wire',{receivedAt:clock,wire:JSON.stringify(books.map((book,i)=>({...book,event_type:'book',asset_id:market.tokens[i],market:'a',timestamp:String(clock)})))});
 if(fund)session.splitInventory('a',5);
 const refresh=(at:number)=>{clock=at;bookAt=at;revision++;record('wire',{receivedAt:at,wire:JSON.stringify(books.map((book,i)=>({...book,event_type:'book',asset_id:market.tokens[i],market:'a',timestamp:String(at)})))});};
 const print=(p=tape(),complementHealthy=true)=>{clock=p.at;record('wire',{receivedAt:clock,wire:JSON.stringify({event_type:'last_trade_price',asset_id:p.token,transaction_hash:p.id.split(':')[0],timestamp:String(p.at),side:p.aggressor,price:String(p.price),size:String(p.shares)})});for(const token of market.tokens)record('print-book-health',{token,receivedAt:clock,structural:true,bookReceivedAt:bookAt,bookServerAt:bookAt,bookRevision:revision});return session.print(p,clock,true,complementHealthy);};
 const report=()=>({status:'completed',bankrollUsd:1000,config:cfg,expiryPolicy,leasesRenewed:session.leasesRenewed,matchingModel:CTF_MATCHING_MODEL,fillRule:'price-through',latencyMs:250,cancelLatencyMs:250,queueModel:'same-price',evidenceVersion:2,bookFreshness:'timestamp',actualSpendUsd:0,ordersSubmitted:0,cashUsd:session.inventory.cashUsd,realizedPnlUsd:session.inventory.realizedPnlUsd,feesUsd:session.inventory.feesUsd,inventory:session.inventory.snapshot().holdings.filter(h=>h.shares>1e-9),simulatedFills:session.simulatedFills,simulatedMerges:session.simulatedMerges,simulatedSplits:session.simulatedSplits,simulatedSettlements:session.simulatedSettlements});
 const save=(root:string,change?:(rs:any[],r:any)=>void)=>{const r=report(),rs=structuredClone(rows);change?.(rs,r);fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(r));fs.writeFileSync(path.join(root,'source.json'),JSON.stringify({files:{}}));fs.writeFileSync(path.join(root,'events.jsonl.gz'),gzipSync(rs.map(r=>JSON.stringify(r)+'\n').join('')));};
 const audit=(change?:(rs:any[],r:any)=>void)=>{const root=fs.mkdtempSync(path.join(tmpdir(),'ctf-execution-audit-'));try{save(root,change);return spawnSync('python3',['scripts/audit-mm-paper.py',root],{encoding:'utf8'});}finally{fs.rmSync(root,{recursive:true,force:true});}};
 return{session,rows,print,audit,save,refresh};
}
describe('joint CTF actor, receipts and independent proof',()=>{
 it('independently verifies renewal, an existing partial remainder, and a fill beyond original lease expiry',()=>{
  const f=fixture(true,'renewable-client-lease-v1');f.session.replace('a',[quote('SELL',.59,0)],books,1000);expect(f.print(tape('yes','BUY',.6,4))).toBe(2);
  f.refresh(3000);const old=f.session.openQuotes()[0];f.session.replace('a',[{...quote('SELL',.59,0),shares:3,expiresAt:13000,maintenanceOf:old.id}],books,3000);
  f.refresh(10500);expect(f.print(tape('yes','BUY',.6,7,10500))).toBe(3);
  const result=f.audit((rows,report)=>{
   rows.push({at:10550,type:'valuation-evidence',data:{at:10550,books:[{token:'no',snapshot:{revision:3,serverAt:10500,receivedAt:10500,seeded:true,issue:null,bids:books[1].bids,asks:books[1].asks},confirmation:null}]}});rows.forEach((r,i)=>r.sequence=i+1);
   Object.assign(report,{startedAt:1000,updatedAt:10600,valuationAt:10550,liquidationConstraints:'ctf-minimum-and-two-decimal-size-v1',midEquityUsd:999.94,midPnlUsd:-.06,liquidationEquityUsd:999.84,liquidationPnlUsd:-.16});
  });expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({leasesRenewed:1,simulatedFills:2,finalValuationVerified:true});
 });
 it.each(['price','remaining','deadline','native-book','cancelled','counter'])('rejects forged lease %s',kind=>{
  const f=fixture(true,'renewable-client-lease-v1');f.session.replace('a',[quote('SELL',.59,0)],books,1000);f.print(tape('yes','BUY',.6,4));f.refresh(3000);const q=f.session.openQuotes()[0];f.session.replace('a',[{...quote('SELL',.59,0),shares:3,expiresAt:13000,maintenanceOf:q.id}],books,3000);
  const result=f.audit((rows,report)=>{
   const lease=rows.find(r=>r.type==='paper-lease-renewal').data;
   if(kind==='price')lease.price=.6;if(kind==='remaining')lease.remainingShares=4;if(kind==='deadline')lease.expiresAt=20001;
   if(kind==='native-book')rows.splice(rows.findIndex(r=>r.type==='wire'&&r.data.receivedAt===3000),1);
   if(kind==='cancelled')rows.splice(rows.findIndex(r=>r.type==='paper-lease-renewal'),0,{at:2500,type:'paper-cancel-request',data:{id:q.id,requestedAt:2500,ackAt:2750,reason:'test'}});
   if(kind==='counter')report.leasesRenewed=2;rows.forEach((r,i)=>r.sequence=i+1);
  });expect(result.status).not.toBe(0);
 });
 it('credits a mint fill to the complementary bought token and independently reconstructs its money',()=>{
  const f=fixture();f.session.replace('a',[quote('BUY',.4,1)],books,1000);expect(f.print()).toBe(5);
  expect(f.session.inventory.holdings.get('no')!.shares).toBe(5);expect(f.session.inventory.holdings.has('yes')).toBe(false);expect(f.session.inventory.cashUsd).toBe(998);
  expect(f.rows.find(r=>r.type==='paper-fill').data).toMatchObject({token:'no',route:'mint',shares:5});
  const audit=f.audit();expect(audit.status,audit.stderr).toBe(0);expect(JSON.parse(audit.stdout).riskCapsVerified).toBe(true);
 });
 it('credits a complementary merge sale to owned inventory',()=>{
  const f=fixture(true);f.session.replace('a',[quote('SELL',.4,1)],books,1000);expect(f.print(tape('yes','SELL'))).toBe(5);
  expect(f.session.inventory.holdings.get('no')!.shares).toBe(0);expect(f.session.inventory.cashUsd).toBeCloseTo(996.99);
  const result=f.audit();expect(result.status,result.stderr).toBe(0);
 });
 it('allocates direct and mint fills in economic price order within one native volume budget',()=>{
  const f=fixture(true);f.session.replace('a',[quote('BUY',.4,1),quote('SELL',.59,0)],books,1000);
  expect(f.print(tape('yes','BUY',.6,8))).toBe(6);
  expect(f.rows.filter(r=>r.type==='paper-fill').map(r=>[r.data.route,r.data.shares])).toEqual([['direct',5],['mint',1]]);
  expect(f.session.inventory.cashUsd).toBeCloseTo(997.54);
  const result=f.audit();expect(result.status,result.stderr).toBe(0);
 });
 it('keeps one economic representative, preserves its priority, and blocks pending equivalent replacements',()=>{
  const f=fixture(true);const qs=[quote('BUY',.4,1),quote('SELL',.6,0)];f.session.replace('a',qs,books,1000);
  expect(f.session.openQuotes()).toHaveLength(1);expect(f.session.openQuotes()[0].side).toBe('SELL');const id=f.session.openQuotes()[0].id;
  f.session.replace('a',qs,books,1100);expect(f.session.openQuotes()[0].id).toBe(id);
  f.session.replace('a',[quote('BUY',.4,1)],books,1500);expect(f.session.openQuotes()).toHaveLength(1);expect(f.session.openQuotes()[0].id).toBe(id);
  f.session.replace('a',[quote('BUY',.4,1)],books,1750);expect(f.session.openQuotes()).toHaveLength(1);expect(f.session.openQuotes()[0].token).toBe('no');
 });
 it('rejects a cross-outcome self-cross before altering existing quotes',()=>{
  const f=fixture();const wide=[{bids:[{price:.5,size:100}],asks:[{price:.7,size:100}]},{bids:[{price:.3,size:100}],asks:[{price:.5,size:100}]}];
  expect(()=>f.session.replace('a',[quote('BUY',.6,0),quote('BUY',.4,1)],wide,1000)).toThrow(/CTF quotes self-cross/);expect(f.session.openQuotes()).toHaveLength(0);
 });
 it('blocks complementary volume without counterpart health and cannot grant volume again for mirrored token views',()=>{
  const f=fixture();f.session.replace('a',[quote('BUY',.4,1)],books,1000);expect(f.print(tape(),false)).toBe(0);
  expect(f.print(tape('no','SELL',.4))).toBe(0);expect(f.session.simulatedFills).toBe(0);
 });
 it.each(['token','route','volume','counterpart-book','counterpart-health','synthetic-overlap','late-after-cancel'])('independently rejects forged %s',kind=>{
  const f=fixture();f.session.replace('a',[quote('BUY',.4,1)],books,1000);f.print();
  const result=f.audit((rows,report)=>{
   const fill=rows.find(r=>r.type==='paper-fill').data,print=rows.find(r=>r.type==='paper-print').data;
   if(kind==='token')fill.token='yes';if(kind==='route')fill.route='direct';if(kind==='volume')print.volumeBudget.availableShares=20;
   if(kind==='counterpart-book'){const wire=rows.find(r=>r.type==='wire').data;wire.wire=JSON.stringify(JSON.parse(wire.wire).filter((r:any)=>r.asset_id==='yes'));}
   if(kind==='counterpart-health')rows.find(r=>r.type==='print-book-health'&&r.data.token==='no').data.bookRevision=123;
   if(kind==='late-after-cancel'){const order=rows.find(r=>r.type==='paper-order').data;rows.splice(rows.findIndex(r=>r.type==='wire'&&r.data.receivedAt===2000),0,{at:1500,type:'paper-cancel-request',data:{id:order.id,requestedAt:1500,ackAt:1750,reason:'test'}});}
   if(kind==='synthetic-overlap'){const order=rows.find(r=>r.type==='paper-order');rows.splice(rows.indexOf(order)+1,0,{...order,data:{...order.data,id:'other',token:'yes',side:'SELL',price:.6,outcomeIndex:0,queueAhead:1000,queueEvidence:{levels:books[0].asks}}});}
   rows.forEach((r,i)=>r.sequence=i+1);
  });expect(result.status).not.toBe(0);if(kind==='synthetic-overlap')expect(result.stderr).toContain('Overlapping economic CTF quotes');
 });
 it('recovers the correct token and does not replenish a previously observed transaction budget after restart',async()=>{
  const f=fixture();f.session.replace('a',[quote('BUY',.4,1)],books,1000);f.print();const root=fs.mkdtempSync(path.join(tmpdir(),'ctf-recover-'));
  try{f.save(root);const recovered=await recoverPaperSession(root);expect(recovered.inventory.cashUsd).toBe(998);expect(recovered.inventory.holdings.find(h=>h.token==='no')!.shares).toBe(5);
   const next=new MmPaperSession(1000,cfg,()=>{},250,'same-price','price-through',250,CTF_MATCHING_MODEL);next.restoreRecovered(recovered,4000);next.expire(4500);next.replace('a',[quote('BUY',.4,1)],books,4500);
   expect(next.print(tape('yes','BUY',.6,10,5000),5000,true,true)).toBe(0);expect(next.simulatedFills).toBe(1);expect(next.inventory.cashUsd).toBe(998);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it('independently audits a direct continuation that inherits CTF receipts without resetting the account',async()=>{
  const f=fixture();f.session.replace('a',[quote('BUY',.4,1)],books,1000);f.print();
  const root=fs.mkdtempSync(path.join(tmpdir(),'ctf-to-direct-')),parent=path.join(root,'parent'),child=path.join(root,'child');fs.mkdirSync(parent);fs.mkdirSync(child);
  try{f.save(parent);const recovered=await recoverPaperSession(parent),rows=[...f.rows];
   const next=new MmPaperSession(1000,cfg,(type,data)=>rows.push({sequence:rows.length+1,at:4000,type,data}),250,'same-price','price-through',250,'direct');next.restoreRecovered(recovered,4000,true);
   const report={...JSON.parse(fs.readFileSync(path.join(parent,'report.json'),'utf8')),matchingModel:'direct',initialMatchingModel:CTF_MATCHING_MODEL,recoveryParent:parent,cashUsd:next.inventory.cashUsd};
   fs.writeFileSync(path.join(child,'report.json'),JSON.stringify(report));fs.writeFileSync(path.join(child,'source.json'),JSON.stringify({files:{}}));fs.writeFileSync(path.join(child,'events.jsonl.gz'),gzipSync(rows.map(r=>JSON.stringify(r)+'\n').join('')));
   const audit=spawnSync('python3',['scripts/audit-mm-paper.py',child],{encoding:'utf8'});expect(audit.status,audit.stderr).toBe(0);expect(JSON.parse(audit.stdout).endingCashUsd).toBe(998);expect(JSON.parse(audit.stdout).simulatedFills).toBe(1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
});
