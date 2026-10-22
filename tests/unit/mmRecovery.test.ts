import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {describe,it,expect} from 'vitest';
import {recoverPaperSession} from '../../src/research/mm/recovery.js';
import {MmPaperSession} from '../../src/research/mm/paperSession.js';
import {MmPaperInventory} from '../../src/research/mm/paperInventory.js';
import {DEFAULT_MM_CONFIG} from '../../src/research/mm/strategy.js';

function fixture(layout:'complete'|'partial'|'overlap'='complete'){
 const root=fs.mkdtempSync(path.join(tmpdir(),'mm-recovery-')),rows:any[]=[];let clock=1000;
 const cfg={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000},market={conditionId:'a',event:'event',tokens:['yes','no'] as [string,string],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true};
 const record=(type:string,data:any)=>rows.push({sequence:rows.length+1,at:clock,type,data});
 const s=new MmPaperSession(1000,cfg,record,250,'same-price','exact-price',250);s.register(market);
 record('market',{...market,negativeRisk:false,tokens:market.tokens.map(id=>({id}))});s.splitInventory('a',5,.01);
 s.replace('a',[{side:'SELL',price:.52,shares:5,postOnly:true,expiresAt:10000,outcomeIndex:0}],[{bids:[{price:.48,size:100}],asks:[{price:.53,size:100}]}],1000);
 clock=1500;s.print({id:'fill',token:'yes',aggressor:'BUY',price:.52,shares:2,at:1500},1500,true);s.releasePairedInventory('a',1500);
 const report={status:'failed',pid:999999999,bankrollUsd:1000,cashUsd:1000,ordersSubmitted:0,actualSpendUsd:0,config:cfg,latencyMs:250,cancelLatencyMs:250,queueModel:'same-price',fillRule:'exact-price'};
 const encoded=rows.map(r=>JSON.stringify(r)+'\n'),full=gzipSync(encoded.join(''));
 fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report));fs.writeFileSync(path.join(root,'source.json'),JSON.stringify({files:{}}));
 if(layout==='complete')fs.writeFileSync(path.join(root,'events.jsonl.gz'),full);
 else{
  fs.mkdirSync(path.join(root,'events.jsonl.gz.parts'));
  if(layout==='partial'){
   fs.writeFileSync(path.join(root,'events.jsonl.gz'),full.subarray(0,Math.floor(full.length*.7)));
   fs.writeFileSync(path.join(root,'events.jsonl.gz.parts/00000000.jsonl'),encoded.join('')+'{"sequence":');
  }else{
   fs.writeFileSync(path.join(root,'events.jsonl.gz'),full);fs.writeFileSync(path.join(root,'events.jsonl.gz.parts/00000000.jsonl'),encoded.slice(2).join(''));
  }
 }
 return{root,rows,session:s,report,rewrite:()=>fs.writeFileSync(path.join(root,'events.jsonl.gz'),gzipSync(rows.map(r=>JSON.stringify(r)+'\n').join('')))};
}

describe('durable MM account recovery',()=>{
 it('recovers synced money and intents after a producer is killed without journal finalization',async()=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),'mm-recovery-kill-')),worker=path.join(root,'worker.mts');
  const source=`import fs from 'node:fs';
import {PaperEvidenceJournal} from ${JSON.stringify(path.resolve('src/research/mm/journal.ts'))};
import {MmPaperSession} from ${JSON.stringify(path.resolve('src/research/mm/paperSession.ts'))};
import {DEFAULT_MM_CONFIG} from ${JSON.stringify(path.resolve('src/research/mm/strategy.ts'))};
const root=${JSON.stringify(root)},config={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000};
fs.writeFileSync(root+'/report.json',JSON.stringify({status:'running',pid:process.pid,bankrollUsd:1000,cashUsd:1000,config,latencyMs:250,cancelLatencyMs:250,queueModel:'same-price',fillRule:'exact-price',actualSpendUsd:0,ordersSubmitted:0}));
fs.writeFileSync(root+'/source.json',JSON.stringify({files:{}}));
const journal=new PaperEvidenceJournal(root+'/events.jsonl.gz'),record=(type,data)=>journal.append(type,data,1500),s=new MmPaperSession(1000,config,record,250,'same-price','exact-price',250);
const market={conditionId:'a',event:'event',tokens:['yes','no'],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true};
s.register(market);record('market',{...market,negativeRisk:false,tokens:market.tokens.map(id=>({id}))});s.splitInventory('a',5,.01);
s.replace('a',[{side:'SELL',price:.52,shares:5,postOnly:true,expiresAt:10000,outcomeIndex:0}],[{bids:[{price:.48,size:100}],asks:[{price:.53,size:100}]}],1000);
s.print({id:'fill',token:'yes',aggressor:'BUY',price:.52,shares:2,at:1500},1500,true);s.releasePairedInventory('a',1500);
fs.writeSync(1,'READY\\n');setInterval(()=>{},1000);`;
  fs.writeFileSync(worker,source);const child=spawn(process.execPath,['--import',path.resolve('node_modules/tsx/dist/loader.mjs'),worker],{stdio:['ignore','pipe','pipe']});
  const exit=once(child,'exit');let stderr='';child.stderr.on('data',b=>stderr+=b);let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await Promise.race([new Promise<void>(resolve=>child.stdout.on('data',b=>{if(String(b).includes('READY'))resolve();})),exit.then(()=>{throw Error(`Producer stopped before kill: ${stderr}`);}),new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(Error('Producer startup timeout')),8000);})]);
   if(timer)clearTimeout(timer);child.kill('SIGKILL');const[,signal]=await exit;expect(signal).toBe('SIGKILL');
   const recovered=await recoverPaperSession(root);expect(recovered.inventory.cashUsd).toBeCloseTo(996.03);expect(recovered.counters.simulatedFills).toBe(1);expect(recovered.outstandingOrders).toHaveLength(1);
   expect(recovered.evidence.gzipComplete).toBe(false);expect(recovered.evidence.receiptConsistencyVerified).toBe(true);
  }finally{if(timer)clearTimeout(timer);if(child.exitCode==null&&child.signalCode==null){child.kill('SIGKILL');await exit;}fs.rmSync(root,{recursive:true,force:true});}
 });
 it.each(['complete','partial','overlap'] as const)('recovers %s evidence without using a stale report balance',async layout=>{
  const f=fixture(layout);try{
   const r=await recoverPaperSession(f.root);expect(r.inventory.cashUsd).toBeCloseTo(996.03);expect(r.inventory.cashUsd).not.toBe(r.report.cashUsd);
   expect(r.counters.simulatedFills).toBe(1);expect(r.evidence.performanceClaimEligible).toBe(false);expect(r.evidence.dataGap).toBe(true);
   if(layout==='partial'){expect(r.evidence.gzipComplete).toBe(false);expect(r.evidence.truncatedRawTail).toBe(true);}
   if(layout==='overlap')expect(r.evidence.duplicatePrefixRows).toBeGreaterThan(0);
   const events:any[]=[];const resumed=new MmPaperSession(1000,f.report.config,(type,data)=>events.push({type,data}),250,'same-price','exact-price',250);
   resumed.restoreRecovered(r,1600);expect(resumed.inventory.cashUsd).toBeCloseTo(996.03);expect(resumed.openQuotes()).toHaveLength(1);
   expect(resumed.print({id:'during-quarantine',token:'yes',aggressor:'BUY',price:.52,shares:5,at:1650},1650,true)).toBe(0);
   resumed.expire(1850);expect(resumed.openQuotes()).toHaveLength(0);expect(resumed.simulatedMerges).toBe(1);expect(resumed.inventory.cashUsd).toBeCloseTo(999.02);
   expect(resumed.inventory.holdings.get('no')!.shares).toBe(2);expect(resumed.splitInventory('a',5)).toBe(false);
   expect(resumed.inventory.fill('order-2:fill','yes','SELL',2,.52,0)).toBe(false);expect(()=>resumed.restoreRecovered(r,2000)).toThrow(/pristine/);
   expect(events.some(e=>e.type==='paper-recovery'&&e.data.performanceClaimEligible===false)).toBe(true);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 it.each(['cash','gap','conflict','alive','missing-spool','uncommitted-bootstrap'])('rejects %s recovery evidence',async kind=>{
  const f=fixture(kind==='conflict'?'overlap':'complete');try{
   if(kind==='cash'){f.rows.find(r=>r.type==='paper-fill').data.cashUsd=1000;f.rewrite();}
   if(kind==='gap'){f.rows.splice(1,1);f.rewrite();}
   if(kind==='conflict')fs.writeFileSync(path.join(f.root,'events.jsonl.gz.parts/00000000.jsonl'),JSON.stringify({...f.rows[2],at:1234})+'\n');
   if(kind==='alive')fs.writeFileSync(path.join(f.root,'report.json'),JSON.stringify({...f.report,status:'running',pid:process.pid}));
   if(kind==='missing-spool'){const file=path.join(f.root,'events.jsonl.gz'),bytes=fs.readFileSync(file);fs.writeFileSync(file,bytes.subarray(0,Math.floor(bytes.length*.7)));}
   if(kind==='uncommitted-bootstrap')fs.writeFileSync(path.join(f.root,'report.json'),JSON.stringify({...f.report,recoveryParent:path.join(f.root,'parent')}));
   await expect(recoverPaperSession(f.root)).rejects.toThrow();
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 });
 it('does not mutate a ledger when recovered capital is forged',()=>{
  const p=new MmPaperInventory(1000);p.registerMarket('a','yes','no');p.split('split','a',5,.01);const snapshot=p.snapshot(),target=new MmPaperInventory(1000);
  expect(()=>target.restore({...snapshot,cashUsd:1000})).toThrow(/reconcile/);expect(target.cashUsd).toBe(1000);expect(target.holdings.size).toBe(0);
  target.restore(snapshot);expect(target.cashUsd).toBeCloseTo(994.99);expect(target.split('split','a',5,.01)).toBe(false);
 });
});
