import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {MmPaperSession} from '../../src/research/mm/paperSession.js';
import {recoverPaperSession} from '../../src/research/mm/recovery.js';
import {DEFAULT_MM_CONFIG} from '../../src/research/mm/strategy.js';

async function continuation(change:(rows:any[],report:any,parent:string)=>void=()=>{}){
 const root=fs.mkdtempSync(path.join(tmpdir(),'mm-continuation-audit-')),parent=path.join(root,'parent'),child=path.join(root,'child');fs.mkdirSync(parent);fs.mkdirSync(child);
 try{
  let rows:any[]=[],at=1000;const record=(type:string,data:any)=>rows.push({sequence:rows.length+1,at,type,data});
  const config={...DEFAULT_MM_CONFIG,quoteLifetimeMs:10000},m={conditionId:'a',event:'event',tokens:['yes','no'] as [string,string],fee:{rate:0,exponent:1},minShares:5,tick:.01,mergeSupported:true};
  const market=(m:any)=>({...m,tokens:m.tokens.map((id:string)=>({id})),negativeRisk:false});
  const original=new MmPaperSession(1000,config,record,250,'same-price','price-through',250);original.register(m);record('market',market(m));original.splitInventory('a',5);original.releasePairedInventory('a',at);
  const base={status:'completed',bankrollUsd:1000,config,latencyMs:250,cancelLatencyMs:250,queueModel:'same-price',fillRule:'price-through',ordersSubmitted:0,actualSpendUsd:0,cashUsd:original.inventory.cashUsd};
  fs.writeFileSync(path.join(parent,'report.json'),JSON.stringify(base));fs.writeFileSync(path.join(parent,'source.json'),JSON.stringify({files:{}}));fs.writeFileSync(path.join(parent,'events.jsonl.gz'),gzipSync(rows.map(r=>JSON.stringify(r)+'\n').join('')));
  rows=[];const recovered=await recoverPaperSession(parent,row=>{rows.push(row);});at=3000;
  const nextConfig={...config,maxCashLossUsd:50},next=new MmPaperSession(1000,nextConfig,record,500,'same-price','exact-price',500);next.restoreRecovered(recovered,at,true);
  const second={...m,conditionId:'b',tokens:['yes-b','no-b'] as [string,string]};next.register(second);record('market',market(second));next.splitInventory('b',5);next.releasePairedInventory('b',at);
  const report={...base,evidenceVersion:2,config:nextConfig,latencyMs:500,cancelLatencyMs:500,fillRule:'exact-price',initialFillRule:'price-through',initialLatencyMs:250,initialCancelLatencyMs:250,initialMaxCashLossUsd:null,
   cashUsd:next.inventory.cashUsd,midEquityUsd:next.inventory.cashUsd,liquidationEquityUsd:next.inventory.cashUsd,midPnlUsd:next.inventory.cashUsd-1000,liquidationPnlUsd:next.inventory.cashUsd-1000,
   realizedPnlUsd:next.inventory.realizedPnlUsd,feesUsd:next.inventory.feesUsd,inventory:[],simulatedFills:next.simulatedFills,simulatedMerges:next.simulatedMerges,simulatedSplits:next.simulatedSplits,simulatedSettlements:next.simulatedSettlements};
  change(rows,report,parent);
  fs.writeFileSync(path.join(child,'report.json'),JSON.stringify(report));fs.writeFileSync(path.join(child,'source.json'),JSON.stringify({files:{}}));fs.writeFileSync(path.join(child,'events.jsonl.gz'),gzipSync(rows.map(r=>JSON.stringify(r)+'\n').join('')));
  return spawnSync('python3',['scripts/audit-mm-paper.py',child],{encoding:'utf8'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
describe('independent continuation accounting',()=>{
 it('audits inherited cash and policy changes without adding another initial deposit',async()=>{
  const result=await continuation();expect(result.status,result.stderr).toBe(0);const r=JSON.parse(result.stdout);expect(r.endingCashUsd).toBeCloseTo(999.96);expect(r.startingCapitalUsd).toBe(1000);expect(r.simulatedSplits).toBe(2);
 });
 it.each(['opening-cash','parent-source','prefix','cash-budget'])('rejects %s while preserving ordinary receipt totals',async kind=>{
  const result=await continuation((rows,report,parent)=>{
   const marker=rows.find(r=>r.type==='paper-recovery').data;
   if(kind==='opening-cash')marker.cashUsd=1000;
   if(kind==='parent-source')fs.appendFileSync(path.join(parent,'report.json'),' ');
   if(kind==='prefix')marker.parent.prefixSha256='0'.repeat(64);
   if(kind==='cash-budget'){report.config.maxCashLossUsd=1;marker.maxCashLossUsd=1;}
  });expect(result.status).not.toBe(0);
 });
});
