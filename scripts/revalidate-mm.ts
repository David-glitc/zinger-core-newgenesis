/** Offline, chronological replay of a frozen MM journal prefix. Never submits orders. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {createGzip} from 'node:zlib';
import {once} from 'node:events';
import {DepthState} from '../src/research/depthState.js';
import {MmPaperSession,type PaperQueueModel} from '../src/research/mm/paperSession.js';
import {DEFAULT_MM_CONFIG} from '../src/research/mm/strategy.js';
import {quoteFee,walkQuote} from '../src/research/bookArbitrage.js';

const input=path.resolve(process.argv[2]??''),out=path.resolve(process.argv[3]??'');
if(!process.argv[2]||!process.argv[3]||!fs.statSync(input).isFile())throw Error('Pass a frozen JSONL prefix and a new output directory');
fs.mkdirSync(out,{recursive:true});
const settings=[
 {id:'legacy-2s',queue:'legacy-cumulative',ttl:2000,feeLegs:2,scope:'pair'},
 {id:'same-price-2s',queue:'same-price',ttl:2000,feeLegs:2,scope:'pair'},
 {id:'same-price-10s',queue:'same-price',ttl:10000,feeLegs:2,scope:'pair'},
 {id:'same-price-30s',queue:'same-price',ttl:30000,feeLegs:2,scope:'pair'},
 {id:'maker-10s',queue:'same-price',ttl:10000,feeLegs:1,scope:'pair'},
 {id:'maker-30s',queue:'same-price',ttl:30000,feeLegs:1,scope:'pair'},
 {id:'independent-maker-10s',queue:'same-price',ttl:10000,feeLegs:1,scope:'independent'},
];
let clock=0,first=0,records=0,originalOrders=0,originalFills=0,originalCancels=0,decisions=0,eligible=0;
const state=new DepthState(),markets=new Map<string,any>(),issues:Record<string,number>={},httpCounts:Record<string,number>={};
const sources=['scripts/revalidate-mm.ts','src/research/mm/paperSession.ts','src/research/mm/paperInventory.ts','src/research/mm/strategy.ts','src/research/bookArbitrage.ts','src/research/depthState.ts'];
const variants=settings.map(setting=>{
 const dir=path.join(out,setting.id);fs.mkdirSync(dir,{recursive:true});
 const output=fs.createWriteStream(path.join(dir,'events.jsonl.gz'),{flags:'wx'}),gzip=createGzip();gzip.pipe(output);let sequence=0;
 const record=(type:string,data:any)=>gzip.write(JSON.stringify({sequence:++sequence,at:clock,type,data})+'\n');
 const config={...DEFAULT_MM_CONFIG,quoteLifetimeMs:setting.ttl,feeReserveLegs:setting.feeLegs};
 const session=new MmPaperSession(1000,config,record,250,setting.queue as PaperQueueModel);
 const hashes={files:{}};for(const file of sources){const bytes=fs.readFileSync(file);hashes.files[file]=createHash('sha256').update(bytes).digest('hex');const target=path.join(dir,'sources',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
 fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify(hashes,null,2));
 return {setting,dir,session,record,gzip,output,invalidReplayBooks:0,matchingPrints:0,matchingVolume:0};
});
for await(const line of readline.createInterface({input:fs.createReadStream(input),crlfDelay:Infinity})){
 const row=JSON.parse(line);records++;if(row.sequence!==records)throw Error('Noncontiguous input journal');clock=row.at;first ||= clock;
 const d=row.data;
 for(const v of variants)v.session.expire(clock);
 if(row.type==='market'){
  markets.set(d.conditionId,{...d,accepting:true});for(const v of variants){v.session.register({conditionId:d.conditionId,event:d.event,tokens:d.tokens.map((t:any)=>t.id),fee:d.fee,minShares:d.minShares,tick:d.tick,mergeSupported:!d.negativeRisk});v.record('market',d);}
 }else if(row.type==='connected'||row.type==='disconnected'){
  const m=markets.get(d.conditionId);if(m){state.remove(m.tokens.map((t:any)=>t.id));for(const v of variants)v.session.cancelMarket(d.conditionId,row.type);}
 }else if(row.type==='market-retired'||row.type==='halted'){
  const m=markets.get(d.conditionId);if(m){m.accepting=false;for(const v of variants)v.session.cancelMarket(d.conditionId,row.type);}
 }else if(row.type==='http'){
  httpCounts[d.status]=(httpCounts[d.status]??0)+1;
  if(d.status===200 && d.url.includes('/book?')){const book=JSON.parse(d.body),id=new URL(d.url).searchParams.get('token_id');const before=state.snapshot(id,clock);
   // A captured response is not proof it won the live seed/WS race. Count mismatches below.
   if(Number(book.timestamp)>=before.serverAt)state.ingest({...book,event_type:'book',asset_id:id},clock);
  }
 }else if(row.type==='wire'){
  state.ingest(JSON.parse(d.wire),clock);
 }else if(row.type==='paper-order')originalOrders++;
 else if(row.type==='paper-fill')originalFills++;
 else if(row.type==='paper-cancel')originalCancels++;
 else if(row.type==='paper-print'){
  for(const v of variants){const p=d.print;for(const q of v.session.openQuotes())if(d.accepted&&q.token===p.token&&q.side!==p.aggressor&&Math.abs(q.price-p.price)<1e-9&&p.at>q.activateAt&&p.at<q.expiresAt&&d.receivedAt>=q.activateAt&&d.receivedAt<q.expiresAt){v.matchingPrints++;v.matchingVolume+=p.shares;}
   v.session.print(p,d.receivedAt,d.healthy);
  }
 }else if(row.type==='decision'){
  decisions++;const m=markets.get(d.conditionId);if(!m)throw Error('Decision before market registration');
  const now=d.evaluationAt,books=m.tokens.map((t:any)=>state.snapshot(t.id,now));
  for(const b of books){const issue=b.issue??(now-b.serverAt>1500?'server_timestamp_old':now-b.receivedAt>1500?'receive_timestamp_old':'usable');issues[issue]=(issues[issue]??0)+1;}
  if(d.plan.reason==='paper_quote_intent')eligible++;
  for(const v of variants){let quotes:any[]=[];
   if(v.setting.ttl===2000&&v.setting.feeLegs===2)quotes=d.plan.quotes;
   else if(v.setting.scope==='independent'||d.plan.reason!=='pair_not_ready'){
    for(let i=0;i<2;i++){
     const plan=d.plan.plans[i],b=books[i];if(['paused','warmup'].includes(plan.regime)||plan.fairReference==null||!b.bids.length||!b.asks.length)continue;
     const held=v.session.inventory.holdings.get(m.tokens[i].id)?.shares??0,other=v.session.inventory.holdings.get(m.tokens[1-i].id)?.shares??0;
     const net=held-other,fair=plan.fairReference,center=fair-v.session.config.skewAtLimit*Math.max(-1,Math.min(1,net/v.session.config.maxNetShares));
     const width=Math.max(m.tick,v.setting.feeLegs*quoteFee(1,fair,m.fee)+v.session.config.reservePerShare+1.5*plan.sigmaPerSqrtSecond*Math.sqrt(v.setting.ttl/1000));
     const buy=Math.floor((Math.min(center-width,b.bestAsk-m.tick)+1e-10)/m.tick)*m.tick;
     const sell=Math.ceil((Math.max(center+width,b.bestBid+m.tick)-1e-10)/m.tick)*m.tick;
     if(buy>0&&buy<1&&net+5<=20)quotes.push({side:'BUY',price:buy,shares:5,postOnly:true,expiresAt:now+v.setting.ttl,outcomeIndex:i});
     if(held>=5&&sell>0&&sell<1&&net-5>=-20)quotes.push({side:'SELL',price:sell,shares:5,postOnly:true,expiresAt:now+v.setting.ttl,outcomeIndex:i});
    }
    const buys=quotes.filter(q=>q.side==='BUY');
    if(buys.length===2&&buys.reduce((s,q)=>s+q.price+quoteFee(1,q.price,m.fee),0)>1-v.session.config.reservePerShare)quotes=quotes.filter(q=>q.side==='SELL');
   }
   try{v.session.replace(d.conditionId,quotes,books,now);}catch(e){if(!String(e).includes('crosses'))throw e;v.invalidReplayBooks++;v.session.cancelMarket(d.conditionId,'replay_book_mismatch');}
  }
 }
}
const summaries=[];
for(const v of variants){
 v.session.cancelAll('session_end');const s=v.session,marks=new Map<string,number>();let liquidation=s.inventory.cashUsd,complete=true;
 for(const[token,h]of s.inventory.holdings){if(h.shares<=1e-9)continue;const b=state.snapshot(token,clock),m=[...markets.values()].find(m=>m.tokens.some((t:any)=>t.id===token));if(!b.usable||clock-b.serverAt>1500||clock-b.receivedAt>1500||!m){complete=false;continue;}
  marks.set(token,(b.bestBid+b.bestAsk)/2);const q=walkQuote(b.bids,h.shares,'sell',m.fee);if(!q.complete)complete=false;else liquidation+=q.premiumUsd-q.feeUsd;
 }
 const equity=s.inventory.equity(marks),report={schemaVersion:1,type:'offline-mm-revalidation',status:'completed',startedAt:first,updatedAt:clock,bankrollUsd:1000,config:s.config,queueModel:v.setting.queue,quoteScope:v.setting.scope,
  cashUsd:s.inventory.cashUsd,midEquityUsd:equity,midPnlUsd:equity==null?null:equity-1000,liquidationEquityUsd:complete?liquidation:null,liquidationPnlUsd:complete?liquidation-1000:null,realizedPnlUsd:s.inventory.realizedPnlUsd,feesUsd:s.inventory.feesUsd,
  simulatedFills:s.simulatedFills,simulatedMerges:s.simulatedMerges,quotesPlaced:s.quotesPlaced,quotesCancelled:s.quotesCancelled,printsSeen:s.printsSeen,printsRejected:s.printsRejected,ordersSubmitted:0,actualSpendUsd:0,
  inventory:[...s.inventory.holdings].filter(([,h])=>h.shares>1e-9).map(([token,h])=>({token,...h})),invalidReplayBooks:v.invalidReplayBooks,matchingPrints:v.matchingPrints,matchingVolume:v.matchingVolume,performanceClaimEligible:false};
 v.record('final',report);v.gzip.end();await once(v.output,'close');fs.writeFileSync(path.join(v.dir,'report.json'),JSON.stringify(report,null,2));summaries.push({id:v.setting.id,...report});
}
const legacy=summaries[0];const result={sourceSha256:createHash('sha256').update(fs.readFileSync(input)).digest('hex'),records,durationHours:(clock-first)/3600000,decisions,eligiblePairDecisions:eligible,eligiblePairFraction:eligible/decisions,
 original:{quotesPlaced:originalOrders,quotesCancelled:originalCancels,simulatedFills:originalFills},legacyReproduced:legacy.quotesPlaced===originalOrders&&legacy.simulatedFills===originalFills&&legacy.invalidReplayBooks===0,
 reconstructedBookIssues:issues,httpCounts,variants:summaries,limitations:['This is a frozen contiguous prefix of an ongoing session, not its final journal.','Original history/readiness decisions and print health are held fixed; prices, lifetimes and queue models are counterfactual.','REST seed/WS races are not fully recorded; legacy reproduction is required before interpreting comparisons.','Quotes at better prices can change other traders behavior; replay cannot verify real fills.','No incentives or settlement proceeds are assumed.']};
fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({legacyReproduced:result.legacyReproduced,decisions,eligiblePairDecisions:eligible,variants:summaries.map(v=>({id:v.id,quotes:v.quotesPlaced,fills:v.simulatedFills,matchingPrints:v.matchingPrints,invalidBooks:v.invalidReplayBooks,pnl:v.midPnlUsd}))},null,2));
if(!result.legacyReproduced)process.exitCode=1;
