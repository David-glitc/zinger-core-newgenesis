import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';

function audit(change:(rows:any[],report:any)=>void=()=>{},version=1,diagnostic=false){
  const dir=mkdtempSync(path.join(tmpdir(),'mm-split-audit-'));
  try{
    const print={id:'trade',token:'yes',aggressor:'BUY',price:.53,shares:5,at:2000};
    const rows:any[]=[
      {type:'market',data:{conditionId:'a',tokens:[{id:'yes'},{id:'no'}],negativeRisk:false}},
      {type:'paper-split',data:{id:'split',conditionId:'a',tokens:['yes','no'],shares:5,feeUsd:.01,cashUsd:994.99,realizedPnlUsd:0}},
      {type:'paper-order',data:{id:'order',token:'yes',side:'SELL',price:.52,shares:5,queueAhead:0,fillRule:'price-through',activateAt:1000,expiresAt:3000}},
      {type:'paper-print',data:{print,receivedAt:2000,healthy:true,accepted:true}},
      {type:'paper-fill',data:{orderId:'order',print,receivedAt:2000,side:'SELL',price:.52,shares:5,feeUsd:0,fillRule:'price-through',cashUsd:997.59,realizedPnlUsd:.095}},
    ];
    const report:any={status:'completed',bankrollUsd:1000,cashUsd:997.59,realizedPnlUsd:.095,feesUsd:.01,fillRule:'price-through',simulatedFills:1,simulatedMerges:0,simulatedSplits:1,ordersSubmitted:0,actualSpendUsd:0,inventory:[{token:'no',shares:5,costUsd:2.505}]};
    if(version===2){
      const tx=`0x${'a'.repeat(64)}`;print.id=`${tx}:yes:2000:0.53:5:BUY`;
      Object.assign(rows[0].data,{minShares:5,tick:.01});Object.assign(rows[2].data,{placedAt:750,conditionId:'a'});
      Object.assign(report,{evidenceVersion:2,latencyMs:250,config:{maxOrderShares:5}});
      rows.splice(3,0,{type:'wire',data:{conditionId:'a',receivedAt:2000,wire:JSON.stringify({event_type:'last_trade_price',asset_id:'yes',timestamp:'2000',transaction_hash:tx,side:'BUY',price:'0.53',size:'5'})}});
    }
    change(rows,report);
    writeFileSync(path.join(dir,'events.jsonl.gz'),gzipSync(rows.map((r,i)=>JSON.stringify({sequence:i+1,at:2000,...r})).join('\n')+'\n'));
    writeFileSync(path.join(dir,'report.json'),JSON.stringify(report));writeFileSync(path.join(dir,'source.json'),JSON.stringify({files:{}}));
    return Object.assign(spawnSync('python3',['scripts/audit-mm-paper.py',dir,...(diagnostic?['--failed-accounting-only']:[])],{encoding:'utf8'}),{independentAuditPresent:existsSync(path.join(dir,'independent-audit.json'))});
  }finally{rmSync(dir,{recursive:true,force:true});}
}
function addValuation(rows:any[],report:any,quiet=false){
  const raw={event_type:'book',asset_id:'no',market:'a',timestamp:quiet?'1':'2200',hash:'a'.repeat(40),bids:[{price:.48,size:100}],asks:[{price:.52,size:100}]};
  rows[0].data.fee={rate:0,exponent:1};
  const snapshot={revision:1,serverAt:Number(raw.timestamp),receivedAt:2200,seeded:true,issue:null,bids:raw.bids,asks:raw.asks};
  const confirmation=quiet?{token:'no',hash:raw.hash,serverAt:1,requestedAt:2100,receivedAt:2200,revision:1,date:new Date(2200).toUTCString(),age:null,cacheStatus:'DYNAMIC'}:null;
  if(quiet){
    rows.splice(rows.findIndex(r=>r.type==='paper-print'),0,{type:'print-book-health',data:{token:'yes',receivedAt:2000,structural:true,bookReceivedAt:2000,bookServerAt:2000,bookRevision:1}});
    rows.push({type:'http',at:2200,data:{url:'https://clob.polymarket.com/book?token_id=no',status:200,body:JSON.stringify(raw)}});
    rows.push({type:'book-seeded',at:2200,data:{token:'no',conditionId:'a',receivedAt:2200,serverAt:1,hash:raw.hash,revision:1}});
    rows.push({type:'book-confirmed',at:2200,data:confirmation});
  }else rows.push({type:'wire',at:2200,data:{receivedAt:2200,wire:JSON.stringify(raw)}});
  rows.push({type:'valuation-evidence',at:2500,data:{at:2500,books:[{token:'no',snapshot,confirmation}]}});
  Object.assign(report,{valuationAt:2500,startedAt:0,updatedAt:2600,midEquityUsd:1000.09,midPnlUsd:.09,liquidationEquityUsd:999.99,liquidationPnlUsd:-.01,bookFreshness:quiet?'verified-snapshot':'timestamp'});
  report.config.maxAgeMs=1500;
}
describe('independent split and price-through audit',()=>{
  it.each([false,true])('flags legacy numerical fill dust and rejects it under the new declared policy: %s',guarded=>{
    const result=audit((rows,report)=>{
      const order=rows.find(r=>r.type==='paper-order').data,fill=rows.find(r=>r.type==='paper-fill').data;
      order.queueAhead=5-1e-14;if(guarded)order.minimumFillShares=1e-6;
      const qty=5-order.queueAhead,cost=2.505*qty/5;
      fill.shares=qty;fill.cashUsd=994.99+qty*.52;fill.realizedPnlUsd=qty*.52-cost;
      report.cashUsd=fill.cashUsd;report.realizedPnlUsd=fill.realizedPnlUsd;
      report.inventory=[{token:'yes',shares:5-qty,costUsd:2.505-cost},{token:'no',shares:5,costUsd:2.505}];
    });
    if(guarded){expect(result.status).not.toBe(0);expect(result.stderr).toContain('Sub-microshare fill receipt');}
    else{expect(result.status,result.stderr).toBe(0);const a=JSON.parse(result.stdout);expect(a.subMicroshareFillReceipts).toBe(1);expect(a.materialSimulatedFills).toBe(0);expect(a.performanceClaimEligible).toBe(false);}
  });
  it('keeps failed-run cash diagnostics distinct from a passing session audit',()=>{
    const fail=(rows:any[],r:any)=>{r.status='failed';};
    expect(audit(fail,2).status).not.toBe(0);
    const result=audit(fail,2,true);expect(result.status,result.stderr).toBe(0);expect(result.independentAuditPresent).toBe(false);
    const report=JSON.parse(result.stdout);expect(report.status).toBe('reconciled_failed_run');expect(report.performanceClaimEligible).toBe(false);expect(report.captureStatus).toBe('failed');
  });
  it('reconstructs paid inventory and the separately declared counterfactual fill rule',()=>{const r=audit();expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout).simulatedSplits).toBe(1);});
  it.each(['free-split','negative-risk','price-not-reaching','wrong-cost','undeclared-through'])('rejects %s',kind=>{
    const r=audit((rows,report)=>{
      if(kind==='free-split')rows[1].data.cashUsd=1000;
      if(kind==='negative-risk')rows[0].data.negativeRisk=true;
      if(kind==='price-not-reaching')rows[3].data.print.price=.51;
      if(kind==='wrong-cost')report.inventory[0].costUsd=0;
      if(kind==='undeclared-through')report.fillRule='exact-price';
    });expect(r.status).not.toBe(0);
  });
  it('links version-two fills to an actual identified public wire event',()=>{const r=audit(()=>{},2);expect(r.status,r.stderr).toBe(0);});
  it('rejects a made-up accepted print absent from the wire capture',()=>{
    const r=audit(rows=>{rows.splice(rows.findIndex(r=>r.type==='wire'),1);},2);expect(r.status).not.toBe(0);
  });
  it('rejects a different fill price even when forged cash and P/L reconcile',()=>{
    const r=audit((rows,report)=>{const fill=rows.find(r=>r.type==='paper-fill').data;fill.price=.53;fill.cashUsd=997.64;fill.realizedPnlUsd=.145;report.cashUsd=997.64;report.realizedPnlUsd=.145;},2);expect(r.status).not.toBe(0);
  });
  it.each(['net-limit','market-limit','event-limit','complementary-orders','duplicate-order'])('independently rejects %s with otherwise reconciled cash',kind=>{
    const r=audit((rows,report)=>{
      Object.assign(report.config,{maxPortfolioUsd:100,maxMarketUsd:10,maxEventUsd:20,maxNetShares:5});
      Object.assign(rows[0].data,{event:'event',fee:{rate:0,exponent:1}});
      if(kind==='net-limit')report.config.maxNetShares=4;
      if(kind==='market-limit')report.config.maxMarketUsd=5;
      if(kind==='event-limit')report.config.maxEventUsd=5;
      if(kind==='complementary-orders'||kind==='duplicate-order'){
        const second={...rows[2].data,id:'second',token:kind==='complementary-orders'?'no':'yes',side:kind==='complementary-orders'?'BUY':'SELL',price:kind==='complementary-orders'?.48:.52};
        rows.splice(3,0,{type:'paper-order',data:second});
      }
    },2);expect(r.status).not.toBe(0);
  });
  it.each([false,true])('rebuilds final executable depth from public %s evidence',quiet=>{
    const r=audit((rows,report)=>addValuation(rows,report,quiet),2);expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout).finalValuationVerified).toBe(true);
  });
  it.each(['invented-book','missing-wire','wrong-equity','stale','invented-confirmation'])('rejects %s final valuation',kind=>{
    const r=audit((rows,report)=>{
      addValuation(rows,report,kind==='invented-confirmation');const evidence=rows.at(-1).data;
      if(kind==='invented-book')evidence.books[0].snapshot.bids=[{price:.6,size:100}];
      if(kind==='missing-wire')rows.splice(rows.length-2,1);
      if(kind==='wrong-equity')report.liquidationEquityUsd=1000;
      if(kind==='stale'){report.valuationAt=5000;report.updatedAt=5001;evidence.at=5000;}
      if(kind==='invented-confirmation')evidence.books[0].confirmation={...evidence.books[0].confirmation,receivedAt:2400};
    },2);expect(r.status).not.toBe(0);
  });
  it('independently charges the final taker fee and declines insufficient liquidation depth',()=>{
    const feeCase=audit((rows,report)=>{addValuation(rows,report);rows[0].data.fee.rate=.05;report.liquidationEquityUsd=999.9276;report.liquidationPnlUsd=-.0724;},2);
    expect(feeCase.status,feeCase.stderr).toBe(0);
    const missing=audit((rows,report)=>{
      addValuation(rows,report);const wire=rows.at(-2).data,raw=JSON.parse(wire.wire);raw.bids[0].size=2;wire.wire=JSON.stringify(raw);rows.at(-1).data.books[0].snapshot.bids=raw.bids;
      report.liquidationEquityUsd=null;report.liquidationPnlUsd=null;
    },2);expect(missing.status,missing.stderr).toBe(0);expect(JSON.parse(missing.stdout).finalValuationVerified).toBe(false);
  });
});
