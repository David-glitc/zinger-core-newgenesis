import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';

function audit(tamper:(rows:any[])=>void=()=>{}){
 const dir=mkdtempSync(path.join(tmpdir(),'mm-confirmation-audit-'));
 try{
  const at=101500,proof={token:'yes',hash:'a'.repeat(40),requestedAt:101300,receivedAt:101400,date:new Date(101400).toUTCString(),age:null,cacheStatus:'DYNAMIC',serverAt:40000,revision:3};
  const print={id:'trade',token:'yes',aggressor:'SELL',price:.45,shares:5,at};
  const rows=[
   {type:'market',data:{conditionId:'condition',tokens:[{id:'yes'},{id:'no'}],negativeRisk:false}},
   {type:'paper-order',data:{id:'order',token:'yes',side:'BUY',price:.45,shares:5,queueAhead:0,queueModel:'same-price',queueEvidence:{levels:[{price:.5,size:100}]},activateAt:101000,expiresAt:103000}},
   {type:'print-book-health',data:{token:'yes',receivedAt:at,structural:true,bookReceivedAt:101400,bookServerAt:40000,bookRevision:3,confirmation:proof}},
   {type:'paper-print',data:{print,receivedAt:at,healthy:true,accepted:true}},
   {type:'paper-fill',data:{print,receivedAt:at,orderId:'order',side:'BUY',price:.45,shares:5,feeUsd:0,cashUsd:997.75,realizedPnlUsd:0}},
  ];tamper(rows);
  writeFileSync(path.join(dir,'events.jsonl.gz'),gzipSync(rows.map((r,i)=>JSON.stringify({sequence:i+1,at,...r})).join('\n')+'\n'));
  writeFileSync(path.join(dir,'report.json'),JSON.stringify({status:'completed',bookFreshness:'verified-snapshot',bankrollUsd:1000,cashUsd:997.75,realizedPnlUsd:0,feesUsd:0,simulatedFills:1,simulatedMerges:0,ordersSubmitted:0,actualSpendUsd:0}));
  writeFileSync(path.join(dir,'source.json'),JSON.stringify({files:{}}));
  return spawnSync('python3',['scripts/audit-mm-paper.py',dir],{encoding:'utf8'});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
describe('independent confirmed-book MM audit',()=>{
 it('reconciles a legitimate same-price fill against a recent confirmation',()=>{const r=audit();expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout).endingCashUsd).toBe(997.75);});
 it.each(['cache','old-date','revision','queue'])('rejects tampered %s evidence',kind=>{
  const r=audit(rows=>{const h=rows[2].data;if(kind==='cache')h.confirmation.cacheStatus='HIT';if(kind==='old-date')h.confirmation.date=new Date(90000).toUTCString();if(kind==='revision')h.bookRevision=4;if(kind==='queue')rows[1].data.queueAhead=100;});expect(r.status).not.toBe(0);
 });
});
