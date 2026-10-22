/** Fixed-parameter comparisons on a common public tape and opening account. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {MakerMarkouts} from '../src/research/mm/markouts.js';
import {PaperEvidenceJournal} from '../src/research/mm/journal.js';
import {fullExitOrderSize} from '../src/research/mm/orderSize.js';

const[inputArg,planArg,outArg]=process.argv.slice(2);
if(!inputArg||!planArg||!outArg||process.argv.length!==5)throw Error('Pass CAPTURE_DIRECTORY PREDECLARED_PLAN_JSON NEW_OUTPUT_DIRECTORY');
const input=path.resolve(inputArg),out=path.resolve(outArg),plan=JSON.parse(fs.readFileSync(planArg,'utf8'));
const source=JSON.parse(fs.readFileSync(path.join(input,'source.json'),'utf8')),original=JSON.parse(fs.readFileSync(path.join(input,'report.json'),'utf8'));
if(!['completed','interrupted','risk_stopped'].includes(original.status)||!original.captureInputs)throw Error('Capture must be terminal and contain decision inputs');
const postCaptureCorrection=plan.analysisMode==='post-capture-placement-freshness-correction-v1';
if(!Number.isFinite(plan.createdAt)||!Array.isArray(plan.variants)||!plan.variants.length)throw Error('Invalid comparison plan');
if(!postCaptureCorrection&&plan.createdAt>original.startedAt)throw Error('Parameter plan must predate the live capture');
if(postCaptureCorrection&&plan.createdAt<=original.startedAt)throw Error('Post-capture correction plan must follow the live capture');
if(original.bankrollUsd!=null&&plan.bankrollPerIndependentVariantUsd!==original.bankrollUsd)throw Error('Comparison cannot replace captured capital');
for(const[file,hash]of Object.entries(plan.sourceSha256))if(source.files[file]!==hash)throw Error(`Predeclared implementation differs: ${file}`);
for(const[file,hash]of Object.entries(source.files))if(createHash('sha256').update(fs.readFileSync(path.join(input,'sources',file))).digest('hex')!==hash)throw Error(`Broken archived source: ${file}`);
const archived=async(file:string)=>import(pathToFileURL(path.join(input,'sources',file)).href);
const {MmPaperSession}=await archived('src/research/mm/paperSession.ts');
const {planMmPair,planMmIndependent}=await archived('src/research/mm/strategy.ts');
const {walkQuote}=await archived('src/research/bookArbitrage.ts');
const {DepthState}=await archived('src/research/depthState.ts');
const {confirmedBookFresh}=await archived('src/research/mm/bookConfirmation.ts');
const mmInputFreshAt=(x:any,at:number,maxAgeMs:number)=>{
 const confirmedAt=x.confirmedAt??x.serverAt;
 return Number.isFinite(at)&&Number.isFinite(maxAgeMs)&&maxAgeMs>0&&x.usable&&
  [x.receivedAt,x.serverAt,confirmedAt].every(Number.isFinite)&&at-x.receivedAt>=0&&at-x.receivedAt<=maxAgeMs&&
  at-x.serverAt>=-1000&&at-confirmedAt>=(x.confirmedAt==null?-1000:0)&&at-confirmedAt<=maxAgeMs;
};
let opening:any=null;
if(original.recovery){
 const {recoverPaperSession}=await archived('src/research/mm/recovery.ts');opening=await recoverPaperSession(original.recovery.directory);
 if(opening.evidence.prefixSha256!==original.recovery.prefixSha256||opening.evidence.records!==original.recovery.records)throw Error('Opening recovery checkpoint changed');
}
fs.mkdirSync(out,{recursive:true});if(fs.existsSync(path.join(out,'comparison.json')))throw Error('Use a new comparison directory');
const analysisFiles=['scripts/replay-mm-inputs.ts','src/research/mm/markouts.ts','src/research/mm/journal.ts','src/research/bookArbitrage.ts','src/research/mm/orderSize.ts'];
for(const file of analysisFiles){const dest=path.join(out,'analysis-sources',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}
fs.writeFileSync(path.join(out,'analysis-source.json'),JSON.stringify({files:Object.fromEntries(analysisFiles.map(f=>[f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')]))},null,2));
let clock=original.startedAt,records=0,frames=0,closing=false,released=false,recovered=!opening;
const cutoff=original.tradingStoppedAt??original.scheduledEndAt,tailEnd=original.observationEndAt??original.scheduledEndAt+250;
const metadata=new Map<string,any>(),lastInputs=new Map<string,any>(),summaries:any[]=[],books=new DepthState(),confirmations=new Map<string,any>(),rest=new Map<string,any>();
const restKey=(token:string,hash:string,at:number)=>`${token}:${hash}:${at}`;
const variants=plan.variants.map((v:any)=>{
 if(!/^[a-z0-9-]{1,60}$/.test(v.id)||!['touch','improve','model'].includes(v.quotePricing)||!['exact-price','price-through'].includes(v.fillRule))throw Error('Invalid comparison variant');
 const dir=path.join(out,v.id);fs.mkdirSync(dir);const journal=new PaperEvidenceJournal(path.join(dir,'events.jsonl.gz'));
 const write=(type:string,data:any)=>journal.append(type,data,clock);
 const matchingModel=v.matchingModel??original.matchingModel??'direct';
 if(!['direct','ctf-max-transaction-volume-v1'].includes(matchingModel))throw Error('Unknown comparison matching model');
 const expiryPolicy=v.expiryPolicy??original.expiryPolicy??'fixed-expiry';
 const markouts=new MakerMarkouts(data=>write('paper-markout',data));
 const record=(type:string,data:any)=>{write(type,data);if(type==='paper-fill')markouts.fill({orderId:data.orderId,token:data.token??data.print.token,side:data.side,price:data.price,shares:data.shares,at:data.receivedAt});};
 const config={...original.config},latency=v.activationLatencyMs??plan.sharedSettings.activationLatencyMs,cancelLatency=v.cancelLatencyMs??plan.sharedSettings.cancelLatencyMs;
 const session=new MmPaperSession(plan.bankrollPerIndependentVariantUsd,config,record,latency,'same-price',v.fillRule,cancelLatency,matchingModel,expiryPolicy);
 if(expiryPolicy!=='fixed-expiry'&&session.expiryPolicy!==expiryPolicy)throw Error('Archived actor does not implement this expiry policy');
 if(matchingModel!=='direct'&&session.matchingModel!==matchingModel)throw Error('Archived actor does not implement this matching model');
 for(const file of Object.keys(source.files)){const dest=path.join(dir,'sources',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(input,'sources',file),dest);}
 fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify(source,null,2));fs.copyFileSync(planArg,path.join(dir,'experiment-plan.json'));
 return{v,matchingModel,expiryPolicy,dir,journal,write,record,session,config,latency,cancelLatency,markouts};
});
function publicBook(row:any){
 const d=row.data;
 if(row.type==='paper-recovery'){
  books.reset();confirmations.clear();rest.clear();lastInputs.clear();
 }else if(row.type==='http'&&d.status===200&&d.url.includes('/book?')){
  const raw=JSON.parse(d.body),key=restKey(String(raw.asset_id),String(raw.hash),Number(raw.timestamp));rest.delete(key);rest.set(key,raw);if(rest.size>512)rest.delete(rest.keys().next().value!);
 }else if(row.type==='wire')books.ingest(JSON.parse(d.wire),d.receivedAt??row.at);
 else if(row.type==='book-seeded'){
  const raw=rest.get(restKey(d.token,d.hash,d.serverAt));if(!raw)throw Error('Applied REST snapshot absent from common capture');
  books.ingest({...raw,event_type:'book'},d.receivedAt);
 }else if(row.type==='book-confirmed')confirmations.set(d.token,d);
 else if(row.type==='book-reset'||row.type==='retired-socket-closed'){
  const m=metadata.get(d.conditionId);if(m){books.remove(m.tokens.map((t:any)=>t.id));for(const t of m.tokens)confirmations.delete(t.id);}
 }
}
function release(){if(released)return;released=true;const before=clock;clock=tailEnd;for(const v of variants){v.session.expire(clock);for(const m of metadata.values())v.session.releasePairedInventory(m.conditionId,clock);v.session.expire(clock);}clock=before;}
const stream=fs.createReadStream(path.join(input,'events.jsonl.gz')).pipe(createGunzip());
for await(const line of readline.createInterface({input:stream,crlfDelay:Infinity})){
 const row=JSON.parse(line);if(row.sequence!==++records)throw Error('Noncontiguous capture');const d=row.data,type=row.type;
 clock=type==='decision'?d.evaluationAt:row.at;
 if(type==='market')metadata.set(d.conditionId,{...d});
 publicBook(row);
 if(opening&&row.sequence<=opening.evidence.records){
  clock=row.at;
  for(const v of variants)v.write(type,d);
  for(const v of variants)await v.journal.drain();continue;
 }
 if(!recovered){
  if(type!=='paper-recovery'||row.sequence!==opening.evidence.records+1)throw Error('Continuation does not start at its declared checkpoint');
  for(const m of metadata.values())m.accepting=false;
  for(const v of variants)v.session.restoreRecovered(opening,clock,true);recovered=true;continue;
 }
 if(clock>=cutoff&&!closing){closing=true;const next=clock;clock=cutoff;for(const v of variants)v.session.cancelAll('session_end',clock);clock=next;}
 if(clock>=tailEnd)release();
 const publicRecord=type==='wire'||type==='book-seeded'||type==='book-confirmed'||type==='book-reset'||type==='print-book-health'||type==='retired-socket-closed'||(type==='http'&&d.url.includes('/book?'));
 if(publicRecord)for(const v of variants)v.record(type,d);
 if(clock>tailEnd){for(const v of variants)await v.journal.drain();continue;}
 for(const v of variants)v.session.expire(clock);
 if(type==='market'){
  for(const v of variants){v.session.register({conditionId:d.conditionId,event:d.event,tokens:d.tokens.map((t:any)=>t.id),fee:d.fee,minShares:d.minShares,tick:d.tick,mergeSupported:!d.negativeRisk,quoteDeadlineAt:d.eventAt-(d.eventBufferMs??original.config.eventBufferMs)});v.record(type,d);}
 }else if(type==='market-retired'||type==='halted'||type==='disconnected'||type==='connected'||type==='book-reset'){
  const m=metadata.get(d.conditionId);if(!m)continue;if(type==='market-retired'||type==='halted')m.accepting=false;
  for(const v of variants){v.session.cancelMarket(d.conditionId,type,clock);if(type==='market-retired')v.session.releasePairedInventory(d.conditionId,clock);if(!publicRecord)v.record(type,d);}
 }else if(type==='wire'){
  const events=JSON.parse(d.wire);
  for(const e of Array.isArray(events)?events:[events]){const p=e.payload??e;if((e.event_type??e.type)!=='market_resolved')continue;
   const condition=String(p.market??p.conditionId??''),winner=String(p.winning_asset_id??p.winningAssetId??''),m=metadata.get(condition);
   if(m?.tokens.some((t:any)=>t.id===winner))for(const v of variants)v.session.resolveMarket(condition,winner,clock);
  }
 }else if(type==='paper-print'){
  for(const v of variants)v.session.print(d.print,d.receivedAt,d.healthy,d.complementHealthy===true);
 }else if(type==='decision'){
  if(!Array.isArray(d.inputs)||d.inputs.length!==2)throw Error('Missing common decision inputs');frames++;
  const m=metadata.get(d.conditionId);if(!m||!m.accepting)continue;for(let i=0;i<2;i++)lastInputs.set(m.tokens[i].id,d.inputs[i]);
  for(const v of variants){
   clock=d.evaluationAt;
   for(let i=0;i<2;i++){const x=d.inputs[i],b=x.book;v.markouts.observe(m.tokens[i].id,clock,{bid:b.bestBid,ask:b.bestAsk,bids:b.bids,asks:b.asks,fresh:x.usable,fee:m.fee,minShares:m.minShares});}
   if(closing)continue;
   const s=v.session,cfg=v.config,planner=original.quoteScope==='independent'?planMmIndependent:planMmPair;
   const build=(extra=0)=>{
    const cap=s.exposure(m.conditionId,m.event,true),cost=extra?extra+.01:0,owned=m.tokens.map((t:any)=>(s.inventory.holdings.get(t.id)?.shares??0)+extra);
    const reserved=s.openQuotes().filter((q:any)=>q.conditionId!==m.conditionId&&q.side==='BUY').reduce((sum:number,q:any)=>sum+q.remaining*q.price,0);
    const cash=s.availableRiskCash?s.availableRiskCash(reserved):Math.max(0,s.inventory.cashUsd-reserved);
    return d.inputs.map((x:any,i:number)=>({...x,ownedShares:owned[i],netOutcomeShares:owned[i]-owned[1-i],cashAvailableUsd:Math.max(0,cash-cost),marketCommittedUsd:cap.marketUsd+cost,eventCommittedUsd:cap.eventUsd+cost,portfolioCommittedUsd:cap.portfolioUsd+cost}));
   };
   const existing=v.expiryPolicy==='renewable-client-lease-v1'?s.openQuotes().filter((q:any)=>q.conditionId===m.conditionId).map((q:any)=>({...q,outcomeIndex:m.tokens.findIndex((t:any)=>t.id===q.token)})):[];
   let inputs=build(),p=planner(inputs[0],inputs[1],cfg,v.v.quotePricing,existing);const placementAt=d.placementAt??clock;
   if(!inputs.every((x:any)=>mmInputFreshAt(x,placementAt,cfg.maxAgeMs))){
    clock=placementAt;s.replace(m.conditionId,[],inputs.map((x:any)=>x.book),placementAt);v.record('decision',{evaluationAt:d.evaluationAt,placementAt,conditionId:d.conditionId,plan:{...p,quotes:[],reason:'stale_at_placement'},placementRejection:'stale_at_placement'});continue;
   }
   if(original.inventoryMode==='split'&&d.inputs.every((x:any)=>x.usable)){
    const proposed=build(cfg.maxOrderShares);
    if(proposed.every((x:any)=>mmInputFreshAt(x,placementAt,cfg.maxAgeMs))&&planner(proposed[0],proposed[1],cfg,v.v.quotePricing).quotes.some((q:any)=>q.side==='SELL')){
     s.splitInventory(m.conditionId,cfg.maxOrderShares,.01);inputs=build();p=planner(inputs[0],inputs[1],cfg,v.v.quotePricing,existing);
    }
   }
   const quotes=p.quotes.map((q:any)=>({...q,expiresAt:Math.min(q.expiresAt,m.eventAt-(m.eventBufferMs??cfg.eventBufferMs))})).filter((q:any)=>q.expiresAt>placementAt+v.latency);
   clock=placementAt;s.replace(m.conditionId,quotes,inputs.map((x:any)=>x.book),placementAt);v.record('decision',{evaluationAt:d.evaluationAt,placementAt,conditionId:m.conditionId,plan:p});
  }
 }
 for(const v of variants)await v.journal.drain();
}
if(!frames||!recovered)throw Error('No common live phase; do not infer a comparison');
if(!closing){clock=cutoff;for(const v of variants)v.session.cancelAll('session_end',clock);}release();
const valuationAt=original.valuationAt??Math.max(tailEnd,cutoff+Math.max(...variants.map((v:any)=>v.cancelLatency))+1);
for(const v of variants){
 clock=valuationAt;const s=v.session;s.expire(clock);const marks=new Map<string,number>(),evidence:any[]=[];let liquidation=s.inventory.cashUsd,complete=true;
 for(const[token,h]of s.inventory.holdings){
  if(h.shares<=1e-9)continue;const m=[...metadata.values()].find(m=>m.tokens.some((t:any)=>t.id===token));
  const b=books.snapshot(token,clock),confirmation=confirmations.get(token)??null;evidence.push({token,snapshot:b,confirmation});
  const fresh=original.bookFreshness==='verified-snapshot'?confirmedBookFresh(b,clock,confirmation,v.config.maxAgeMs):b.usable&&clock-b.receivedAt<=v.config.maxAgeMs&&clock-b.serverAt<=v.config.maxAgeMs;
  if(!m||!fresh){complete=false;continue;}marks.set(token,(b.bestBid+b.bestAsk)/2);
  if(!fullExitOrderSize(h.shares,m.minShares).ok){complete=false;continue;}const q=walkQuote(b.bids,h.shares,'sell',m.fee);if(!q.complete)complete=false;else liquidation+=q.premiumUsd-q.feeUsd;
 }
 const equity=s.inventory.equity(marks);v.markouts.finish(clock);v.record('valuation-evidence',{at:clock,books:evidence});
 const tailComplete=tailEnd>=cutoff+v.cancelLatency;
 const report={schemaVersion:1,evidenceVersion:2,type:'common-input-mm-paper-comparison',liquidationConstraints:'ctf-minimum-and-two-decimal-size-v1',status:'completed',startedAt:original.startedAt,updatedAt:clock,valuationAt:clock,scheduledEndAt:original.scheduledEndAt,tradingStoppedAt:cutoff,observationEndAt:tailEnd,terminalTailComplete:tailComplete,
  bankrollUsd:plan.bankrollPerIndependentVariantUsd,expiryPolicy:v.expiryPolicy,initialExpiryPolicy:opening?original.initialExpiryPolicy??opening.report.expiryPolicy??'fixed-expiry':v.expiryPolicy,leasesRenewed:s.leasesRenewed??0,matchingModel:v.matchingModel,initialMatchingModel:opening?original.initialMatchingModel??opening.report.matchingModel??'direct':v.matchingModel,config:v.config,fillRule:v.v.fillRule,queueModel:'same-price',quotePricing:v.v.quotePricing,bookFreshness:original.bookFreshness,
  initialFillRule:opening?original.initialFillRule??opening.report.fillRule:v.v.fillRule,initialLatencyMs:opening?original.initialLatencyMs??opening.report.latencyMs:v.latency,initialCancelLatencyMs:opening?original.initialCancelLatencyMs??opening.report.cancelLatencyMs??0:v.cancelLatency,initialMaxCashLossUsd:opening?original.initialMaxCashLossUsd??null:v.config.maxCashLossUsd??null,
  recoveryParent:original.recovery?.directory??null,openingCashUsd:opening?.inventory.cashUsd??plan.bankrollPerIndependentVariantUsd,inheritedFills:opening?.counters.simulatedFills??0,phaseFills:s.simulatedFills-(opening?.counters.simulatedFills??0),
  latencyMs:v.latency,cancelLatencyMs:v.cancelLatency,cashUsd:s.inventory.cashUsd,midEquityUsd:equity,midPnlUsd:equity==null?null:equity-plan.bankrollPerIndependentVariantUsd,liquidationEquityUsd:complete?liquidation:null,liquidationPnlUsd:complete?liquidation-plan.bankrollPerIndependentVariantUsd:null,realizedPnlUsd:s.inventory.realizedPnlUsd,feesUsd:s.inventory.feesUsd,
  inventory:[...s.inventory.holdings].filter(([,h]:any)=>h.shares>1e-9).map(([token,h]:any)=>({token,...h})),simulatedFills:s.simulatedFills,simulatedMerges:s.simulatedMerges,simulatedSplits:s.simulatedSplits,simulatedSettlements:s.simulatedSettlements,quotesPlaced:s.quotesPlaced,quotesCancelled:s.quotesCancelled,printsSeen:s.printsSeen,printsRejected:s.printsRejected,markouts:v.markouts.summary(),ordersSubmitted:0,actualSpendUsd:0,performanceClaimEligible:false,
  limitations:['Counterfactual policy evaluation on one recorded public tape; real execution is not verified.','Every variant inherits the same opening account; no replacement bankroll.',postCaptureCorrection?'Post-capture diagnostic: applies the placement-time freshness correction to recorded decisions.':'Uses archived trading code and a parameter plan written before the live phase.','Price-through fills assume unchanged aggressive flow.',tailComplete?'Observed tail covers the declared cancel latency.':'Terminal cancel tail is incomplete; this stress variant cannot qualify.','Missing/stale books, order minimums and quantity precision can prevent full liquidation.']};
 v.record('final',report);await v.journal.finish();fs.writeFileSync(path.join(v.dir,'report.json'),JSON.stringify(report,null,2));
 summaries.push({id:v.v.id,quotes:report.quotesPlaced,fills:report.simulatedFills,phaseFills:report.phaseFills,openingCashUsd:report.openingCashUsd,realizedPnlUsd:report.realizedPnlUsd,liquidationPnlUsd:report.liquidationPnlUsd,midPnlUsd:report.midPnlUsd,terminalTailComplete:tailComplete});
}
const result={input,analysisMode:postCaptureCorrection?'post-capture-placement-freshness-correction-v1':'predeclared-forward-evaluation-v1',planCreatedAt:plan.createdAt,captureStartedAt:original.startedAt,records,commonInputFrames:frames,openingCashUsd:opening?.inventory.cashUsd??plan.bankrollPerIndependentVariantUsd,variants:summaries,performanceClaimEligible:false,actualSpendUsd:0};
fs.writeFileSync(path.join(out,'comparison.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
