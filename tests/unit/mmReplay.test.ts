import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {DEFAULT_MM_CONFIG} from '../../src/research/mm/strategy.js';
import {MmPaperSession} from '../../src/research/mm/paperSession.js';
import {recoverPaperSession} from '../../src/research/mm/recovery.js';

function fixture(){
 const dir=fs.mkdtempSync(path.join(tmpdir(),'mm-common-tape-')),input=path.join(dir,'capture'),out=path.join(dir,'comparison'),planFile=path.join(dir,'plan.json');
 fs.mkdirSync(input);
 const files=['src/research/mm/paperSession.ts','src/research/mm/paperInventory.ts','src/research/mm/ctfMatching.ts','src/research/mm/strategy.ts','src/research/bookArbitrage.ts','src/research/depthState.ts','src/research/mm/bookConfirmation.ts','src/research/mm/recovery.ts'];
 const source={files:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))};
 for(const file of files){const target=path.join(input,'sources',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);}
 const config={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000,feeReserveLegs:1,reservePerShare:.0025,sigmaMultiplier:.5};
 const report={status:'completed',captureInputs:true,startedAt:100000,scheduledEndAt:105000,config,inventoryMode:'split',quoteScope:'independent',bookFreshness:'timestamp'};
 const plan={createdAt:99999,sourceSha256:source.files,bankrollPerIndependentVariantUsd:1000,sharedSettings:{activationLatencyMs:250,cancelLatencyMs:250},variants:[
  {id:'touch-exact',quotePricing:'touch',fillRule:'exact-price'},
  {id:'improve-exact',quotePricing:'improve',fillRule:'exact-price'},
  {id:'improve-through',quotePricing:'improve',fillRule:'price-through'},
 ]};
 const market={conditionId:'market',event:'event',eventAt:3700000,eventBufferMs:600000,accepting:true,negativeRisk:false,protocol:'v1',tick:.01,minShares:5,fee:{rate:0,exponent:1},tokens:[{id:'yes'},{id:'no'}]};
 const frame=(now:number)=>({evaluationAt:now,placementAt:now+1,conditionId:'market',inputs:[0,1].map(()=>({now,receivedAt:now,serverAt:now,usable:true,book:{bestBid:.48,bestAsk:.52,bids:[{price:.48,size:1000}],asks:[{price:.52,size:1000}]},history:Array.from({length:31},(_,i)=>({at:now-30000+i*1000,mid:.5})),tick:.01,minShares:5,fee:market.fee,accepting:true,eventAt:market.eventAt,eventBufferMs:600000,eventTimeRequired:true,cashAvailableUsd:1000,ownedShares:0,netOutcomeShares:0,marketCommittedUsd:0,eventCommittedUsd:0,portfolioCommittedUsd:0}))});
 const tx=`0x${'a'.repeat(64)}`,print={id:`${tx}:yes:100500:0.52:5:BUY`,token:'yes',aggressor:'BUY',price:.52,shares:5,at:100500};
 const rows:any[]=[{at:100000,type:'market',data:market},{at:100001,type:'decision',data:frame(100000)},
  {at:100500,type:'wire',data:{conditionId:'market',receivedAt:100500,wire:JSON.stringify({event_type:'last_trade_price',asset_id:'yes',timestamp:'100500',transaction_hash:tx,side:'BUY',price:'0.52',size:'5'})}},
  {at:100500,type:'paper-print',data:{print,receivedAt:100500,healthy:true,accepted:true}},
  {at:101500,type:'decision',data:frame(101500)},{at:104900,type:'decision',data:frame(104900)}];
 for(let i=rows.length-1;i>=0;i--)if(rows[i].type==='decision'){
  const now=rows[i].data.evaluationAt;rows.splice(i,0,{at:now,type:'wire',data:{receivedAt:now,wire:JSON.stringify(['yes','no'].map(asset_id=>({event_type:'book',asset_id,market:'market',timestamp:String(now),bids:[{price:.48,size:1000}],asks:[{price:.52,size:1000}]})))}});
 }
 fs.writeFileSync(path.join(input,'events.jsonl.gz'),gzipSync(rows.map((row,i)=>JSON.stringify({sequence:i+1,...row})).join('\n')+'\n'));
 fs.writeFileSync(path.join(input,'source.json'),JSON.stringify(source));fs.writeFileSync(path.join(input,'report.json'),JSON.stringify(report));fs.writeFileSync(planFile,JSON.stringify(plan));
 return{dir,input,out,plan,planFile,report,rows,market,run:()=>spawnSync(process.execPath,['--import','tsx','scripts/replay-mm-inputs.ts',input,planFile,out],{encoding:'utf8',timeout:15000})};
}

describe('same-input MM comparisons',()=>{
 it('rejects a once-fresh book when simulated placement finishes after its freshness window',()=>{
  const f=fixture();try{
   const decision=f.rows.find(r=>r.type==='decision');decision.data.placementAt=101527;
   fs.writeFileSync(path.join(f.input,'events.jsonl.gz'),gzipSync(f.rows.map((r,i)=>JSON.stringify({sequence:i+1,...r})).join('\n')+'\n'));
   const run=f.run();expect(run.status,run.stderr).toBe(0);
   for(const variant of f.plan.variants){
    const dir=path.join(f.out,variant.id),rows=gunzipSync(fs.readFileSync(path.join(dir,'events.jsonl.gz'))).toString().trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.some(r=>r.type==='decision'&&r.data.placementRejection==='stale_at_placement')).toBe(true);
    expect(rows.some(r=>r.type==='paper-order'&&r.data.placedAt===101527)).toBe(false);
    expect(rows.some(r=>r.type==='paper-split'&&r.at===101527)).toBe(false);
    const audit=spawnSync('python3',['scripts/audit-mm-paper.py',dir],{encoding:'utf8'});expect(audit.status,audit.stderr).toBe(0);
   }
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it('replays renewable leases and legal partial remainders with independent native-book proof',()=>{
  const f=fixture();try{
   Object.assign(f.report,{scheduledEndAt:112000,observationEndAt:112500,valuationAt:112500});f.report.config.skewAtLimit=0;
   (f.plan.variants as any[]).splice(0,3,
    {id:'fixed',quotePricing:'improve',fillRule:'price-through',matchingModel:'ctf-max-transaction-volume-v1',expiryPolicy:'fixed-expiry'},
    {id:'lease',quotePricing:'improve',fillRule:'price-through',matchingModel:'ctf-max-transaction-volume-v1',expiryPolicy:'renewable-client-lease-v1'});
   const template=f.rows.find(r=>r.type==='decision').data;
   const decision=(at:number)=>{const d=structuredClone(template);d.evaluationAt=at;d.placementAt=at+1;for(const x of d.inputs){x.now=at;x.receivedAt=at;x.serverAt=at;x.history=x.history.map((h:any)=>({...h,at:h.at+at-100000}));}return{at,type:'decision',data:d};};
   const book=(at:number)=>({at,type:'wire',data:{receivedAt:at,wire:JSON.stringify(['yes','no'].map(asset_id=>({event_type:'book',asset_id,market:'market',timestamp:String(at),bids:[{price:.48,size:1000}],asks:[{price:.52,size:1000}]})))}});
   const trade=(at:number,shares:number,n:number,bookAt:number,revision:number)=>{
    const tx=`0x${n.toString(16).padStart(64,'0')}`,print={id:`${tx}:yes:${at}:0.51:${shares}:BUY`,token:'yes',aggressor:'BUY',price:.51,shares,at};
    return[{at,type:'wire',data:{receivedAt:at,wire:JSON.stringify({event_type:'last_trade_price',asset_id:'yes',timestamp:String(at),transaction_hash:tx,side:'BUY',price:'.51',size:String(shares)})}},
     ...['yes','no'].map(token=>({at,type:'print-book-health',data:{token,receivedAt:at,structural:true,bookReceivedAt:bookAt,bookServerAt:bookAt,bookRevision:revision}})),
     {at,type:'paper-print',data:{print,receivedAt:at,healthy:true,accepted:true,complementHealthy:true}}];
   };
   const rows=[{at:100000,type:'market',data:f.market},book(100000),decision(100000),...trade(100500,2,1,100000,1),book(109000),decision(109000),book(111000),...trade(111000,3,2,111000,3),book(112400)];
   fs.writeFileSync(path.join(f.input,'report.json'),JSON.stringify(f.report));fs.writeFileSync(f.planFile,JSON.stringify(f.plan));fs.writeFileSync(path.join(f.input,'events.jsonl.gz'),gzipSync(rows.map((r,i)=>JSON.stringify({sequence:i+1,...r})).join('\n')+'\n'));
   const run=f.run();expect(run.status,run.stderr).toBe(0);
   const d=path.join(f.out,'lease'),journal=gunzipSync(fs.readFileSync(path.join(d,'events.jsonl.gz'))).toString().trim().split('\n').map(line=>JSON.parse(line));
   const fills=journal.filter(r=>r.type==='paper-fill');expect(fills.map(r=>r.data.shares)).toEqual([2,3]);expect(fills[0].data.orderId).toBe(fills[1].data.orderId);
   expect(journal.some(r=>r.type==='paper-lease-renewal'&&r.data.remainingShares===3)).toBe(true);
   expect(journal.filter(r=>r.type==='paper-order').every(r=>r.data.shares>=5)).toBe(true);
   for(const variant of ['fixed','lease']){const audit=spawnSync('python3',['scripts/audit-mm-paper.py',path.join(f.out,variant)],{encoding:'utf8'});expect(audit.status,audit.stderr).toBe(0);expect(JSON.parse(audit.stdout).finalValuationVerified).toBe(variant==='lease');}
   const fixed=JSON.parse(fs.readFileSync(path.join(f.out,'fixed/report.json'),'utf8'));expect(fixed.simulatedFills).toBe(1);expect(fixed.liquidationPnlUsd).toBeNull();
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it('replays the opt-in joint model with complementary health, the correct filled token, and independent final valuation',()=>{
  const f=fixture();try{
   (f.plan.variants as any[]).push({id:'ctf-through',quotePricing:'improve',fillRule:'price-through',matchingModel:'ctf-max-transaction-volume-v1'});
   const event=f.rows.find(r=>r.type==='paper-print'),p=event.data.print,tx=p.id.split(':')[0];
   Object.assign(p,{aggressor:'SELL',price:.48,id:`${tx}:yes:100500:0.48:5:SELL`});event.data.complementHealthy=true;
   const native=f.rows.find(r=>r.type==='wire'&&r.at===100500);native.data.wire=JSON.stringify({event_type:'last_trade_price',asset_id:'yes',timestamp:'100500',transaction_hash:tx,side:'SELL',price:'0.48',size:'5'});
   f.rows.splice(f.rows.indexOf(event),0,...['yes','no'].map(token=>({at:100500,type:'print-book-health',data:{token,receivedAt:100500,structural:true,bookReceivedAt:100000,bookServerAt:100000,bookRevision:1}})));
   fs.writeFileSync(f.planFile,JSON.stringify(f.plan));fs.writeFileSync(path.join(f.input,'events.jsonl.gz'),gzipSync(f.rows.map((r,i)=>JSON.stringify({sequence:i+1,...r})).join('\n')+'\n'));
   const run=f.run();expect(run.status,run.stderr).toBe(0);const d=path.join(f.out,'ctf-through');
   const rows=gunzipSync(fs.readFileSync(path.join(d,'events.jsonl.gz'))).toString().trim().split('\n').map(line=>JSON.parse(line));
   expect(rows.find(r=>r.type==='paper-fill').data).toMatchObject({token:'no',route:'merge',shares:5});
   const audit=spawnSync('python3',['scripts/audit-mm-paper.py',d],{encoding:'utf8'});expect(audit.status,audit.stderr).toBe(0);expect(JSON.parse(audit.stdout).finalValuationVerified).toBe(true);
   const report=JSON.parse(fs.readFileSync(path.join(d,'report.json'),'utf8'));expect(report.liquidationPnlUsd).toBeCloseTo(-.06);expect(report.performanceClaimEligible).toBe(false);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it('starts all continuation controls from the same recovered money and verifies final book provenance',async()=>{
  const f=fixture(),parent=path.join(f.dir,'parent');fs.mkdirSync(parent);
  try{
   const inherited:any[]=[];const record=(type:string,data:any)=>inherited.push({sequence:inherited.length+1,at:99000,type,data});
   const actor=new MmPaperSession(1000,f.report.config,record,250,'same-price','price-through',250);
   actor.register({conditionId:'market',event:'event',tokens:['yes','no'],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true});
   record('market',f.market);
   record('wire',{receivedAt:99000,wire:JSON.stringify({event_type:'book',asset_id:'yes',market:'market',timestamp:'99000',bids:[{price:.48,size:1000}],asks:[{price:.52,size:1000}]})});
   actor.splitInventory('market',5);actor.releasePairedInventory('market',99000);
   const parentReport={...f.report,status:'completed',bankrollUsd:1000,cashUsd:actor.inventory.cashUsd,actualSpendUsd:0,ordersSubmitted:0,latencyMs:250,cancelLatencyMs:250,queueModel:'same-price',fillRule:'price-through'};
   fs.writeFileSync(path.join(parent,'report.json'),JSON.stringify(parentReport));fs.writeFileSync(path.join(parent,'source.json'),JSON.stringify({files:{}}));fs.writeFileSync(path.join(parent,'events.jsonl.gz'),gzipSync(inherited.map(r=>JSON.stringify(r)+'\n').join('')));
   const opening=await recoverPaperSession(parent);let marker:any;
   const temporary=new MmPaperSession(1000,f.report.config,(type,data)=>{if(type==='paper-recovery')marker={at:99500,type,data};},250,'same-price','price-through',250);temporary.restoreRecovered(opening,99500,true);
   Object.assign(f.report,{bankrollUsd:1000,recovery:opening.evidence,initialFillRule:'price-through',initialLatencyMs:250,initialCancelLatencyMs:250,initialMaxCashLossUsd:null});
   const raw={asset_id:'yes',market:'market',timestamp:'99990',hash:'b'.repeat(40),bids:[{price:.48,size:1000}],asks:[{price:.52,size:1000}]};
   const seed=[{at:99999,type:'http',data:{url:'https://clob.polymarket.com/book?token_id=yes',status:200,body:JSON.stringify(raw)}},{at:99999,type:'book-seeded',data:{token:'yes',conditionId:'market',receivedAt:99999,serverAt:99990,hash:raw.hash,revision:1}}];
   fs.writeFileSync(path.join(f.input,'report.json'),JSON.stringify(f.report));const all=[...inherited,marker,...seed,...f.rows];fs.writeFileSync(path.join(f.input,'events.jsonl.gz'),gzipSync(all.map((row,i)=>JSON.stringify({...row,sequence:i+1})).join('\n')+'\n'));
   const run=f.run();expect(run.status,run.stderr).toBe(0);const comparison=JSON.parse(fs.readFileSync(path.join(f.out,'comparison.json'),'utf8'));expect(comparison.openingCashUsd).toBeCloseTo(999.98);
   const candidate=JSON.parse(fs.readFileSync(path.join(f.out,'improve-through/report.json'),'utf8'));expect(candidate.cashUsd).toBeCloseTo(997.52);expect(candidate.phaseFills).toBe(1);expect(candidate.bankrollUsd).toBe(1000);
   for(const v of comparison.variants){const audit=spawnSync('python3',['scripts/audit-mm-paper.py',path.join(f.out,v.id)],{encoding:'utf8'});expect(audit.status,audit.stderr).toBe(0);expect(JSON.parse(audit.stdout).finalValuationVerified).toBe(true);}
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it('keeps independent ledgers, requires the declared fill rule, and marks inventory at executable depth',()=>{
  const f=fixture();try{
   const run=f.run();expect(run.status,run.stderr).toBe(0);
   const comparison=JSON.parse(fs.readFileSync(path.join(f.out,'comparison.json'),'utf8'));
   expect(comparison.commonInputFrames).toBe(3);expect(comparison.variants.map((v:any)=>v.fills)).toEqual([0,0,1]);expect(comparison.performanceClaimEligible).toBe(false);
   const candidate=JSON.parse(fs.readFileSync(path.join(f.out,'improve-through/report.json'),'utf8'));
   expect(candidate.cashUsd).toBeCloseTo(997.54);expect(candidate.midPnlUsd).toBeCloseTo(.04);expect(candidate.liquidationPnlUsd).toBeCloseTo(-.06);
   expect(candidate.markouts[0].complete).toBe(1);expect(candidate.markouts[1].missing).toBe(1);
   for(const v of comparison.variants){
    const p=path.join(f.out,v.id),audit=spawnSync('python3',['scripts/audit-mm-paper.py',p],{encoding:'utf8'});expect(audit.status,audit.stderr).toBe(0);
    const rows=gunzipSync(fs.readFileSync(path.join(p,'events.jsonl.gz'))).toString().trim().split('\n').map(l=>JSON.parse(l));expect(rows.at(-1).type).toBe('final');
   }
   expect(fs.existsSync(path.join(f.out,'analysis-source.json'))).toBe(true);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it.each(['future-plan','tampered-source'])('rejects %s before evaluating variants',kind=>{
  const f=fixture();try{
   if(kind==='future-plan'){f.plan.createdAt=100001;fs.writeFileSync(f.planFile,JSON.stringify(f.plan));}
   else fs.appendFileSync(path.join(f.input,'sources/src/research/mm/strategy.ts'),'\n// changed\n');
   const run=f.run();expect(run.status).not.toBe(0);expect(run.stderr).toContain(kind==='future-plan'?'predate':'Broken archived source');
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it('labels the placement-freshness counterfactual as post-capture analysis',()=>{
  const f=fixture();try{
   f.plan.createdAt=100001;(f.plan as any).analysisMode='post-capture-placement-freshness-correction-v1';fs.writeFileSync(f.planFile,JSON.stringify(f.plan));
   const run=f.run();expect(run.status,run.stderr).toBe(0);const comparison=JSON.parse(fs.readFileSync(path.join(f.out,'comparison.json'),'utf8'));
   expect(comparison.analysisMode).toBe('post-capture-placement-freshness-correction-v1');expect(comparison.performanceClaimEligible).toBe(false);
   const report=JSON.parse(fs.readFileSync(path.join(f.out,'touch-exact/report.json'),'utf8'));expect(report.limitations.some((x:string)=>x.includes('Post-capture diagnostic'))).toBe(true);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
});
