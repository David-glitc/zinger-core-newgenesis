import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGzip} from 'node:zlib';
import {once} from 'node:events';
import WebSocket from 'ws';
import {DepthState} from '../src/research/depthState.js';
import {quoteFee} from '../src/research/bookArbitrage.js';
import {publicJson} from '../src/research/mm/publicData.js';
import {marketFamily} from '../src/research/mm/walletAudit.js';
import {DEFAULT_MM_CONFIG,planMmPair,QuoteReservations,type MidObservation} from '../src/research/mm/strategy.js';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const[k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')]}));
if(Object.keys(args).some(k=>!['audit','seconds','markets','out'].includes(k)))throw Error('Observer supports --audit, --seconds, --markets, --out only');
const seconds=Number(args.seconds??180),maxMarkets=Number(args.markets??8);
if(!Number.isFinite(seconds)||seconds<10||seconds>3600||!Number.isInteger(maxMarkets)||maxMarkets<1||maxMarkets>20)throw Error('Invalid observer limits');
const auditDir=path.resolve(args.audit??'tmp/commercial-evidence/mm-wallet-audit-20261010-final');
const audit=JSON.parse(fs.readFileSync(path.join(auditDir,'report.json'),'utf8'));
if(audit.status!=='completed')throw Error('Wallet audit must be completed');
const metadata=JSON.parse(fs.readFileSync(path.join(auditDir,'market-metadata.json'),'utf8'));
const dir=path.resolve(args.out??`tmp/commercial-evidence/mm-shadow-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
const output=fs.createWriteStream(path.join(dir,'events.jsonl.gz'),{flags:'wx'}),gzip=createGzip();gzip.pipe(output);
let sequence=0,active=true,journalClosed=false,messages=0,updates=0,reconnects=0,planningStartedAt=0,observations=0,quoted=0,maxReservationUsd=0;
const record=(type:string,data:unknown)=>{if(journalClosed)return false;return gzip.write(JSON.stringify({sequence:++sequence,at:Date.now(),type,data})+'\n');};
const read=(url:string)=>publicJson(url,entry=>record('http',entry));
const state=new DepthState(),reservations=new QuoteReservations(),histories=new Map<string,MidObservation[]>(),sockets=new Map<string,WebSocket>();
const errors:string[]=[],selected:any[]=[],skipped:Record<string,number>={},stats=new Map<string,any>(),denials:Record<string,number>={};
const skip=(reason:string)=>skipped[reason]=(skipped[reason]??0)+1;
const turnover=new Map<string,number>();for(const w of audit.wallets)for(const m of w.all.markets)turnover.set(m.conditionId,(turnover.get(m.conditionId)??0)+m.grossUsd);
const families=new Map<string,number>(),events=new Set<string>();
for(const raw of metadata.sort((a:any,b:any)=>(turnover.get(b.conditionId)??0)-(turnover.get(a.conditionId)??0))){
 if(selected.length>=maxMarkets)break;
 const family=marketFamily(raw.question,raw.slug),event=String(raw.events?.[0]?.slug??'').replace(/-(more-markets|halftime-result|first-half|second-half)$/,'');
 if(!raw.active||raw.closed||!raw.acceptingOrders){skip('inactive');continue;}
 if(!event){skip('missing_event_identity');continue;}
 if(events.has(event)||(families.get(family)??0)>=3){skip('diversification');continue;}
 try{
  const detail=await read(`https://clob.polymarket.com/clob-markets/${raw.conditionId}`);
  const tokens=detail.t?.map((t:any)=>({id:String(t.t),outcome:String(t.o)})),fee={rate:Number(detail.fd?.r),exponent:Number(detail.fd?.e)},tick=Number(detail.mts),minShares=Number(detail.mos);
  if(!Array.isArray(tokens)||tokens.length!==2||tokens.some(t=>!t.id)||detail.ao!==true||![tick,minShares,fee.rate,fee.exponent].every(Number.isFinite)||tick<=0||minShares<=0){skip('invalid_market_constraints');continue;}
  quoteFee(1,.5,fee);
  const sports=!['crypto','macro','politics','unclassified'].includes(family);
  const eventAt=Date.parse(detail.gst??raw.gameStartTime??raw.endDate);
  if(!Number.isFinite(eventAt)||eventAt-Date.now()<=DEFAULT_MM_CONFIG.eventBufferMs){skip('event_time_guard');continue;}
  // Sports need an actual game start, not a later resolution deadline.
  if(sports&&!detail.gst&&!raw.gameStartTime){skip('missing_game_start');continue;}
  const m={conditionId:raw.conditionId,title:raw.question,slug:raw.slug,event,family,eventAt,tokens,fee,tick,minShares,accepting:true,negativeRisk:detail.nr===true};
  selected.push(m);events.add(event);families.set(family,(families.get(family)??0)+1);
  stats.set(m.conditionId,{conditionId:m.conditionId,title:m.title,family,event,observations:0,quoteIntents:0,quoteSides:0,bestPairBidCostPerShare:null,denials:{},freshPairs:0});record('market',m);
 }catch(e){errors.push(`discovery:${raw.slug}:${String(e)}`);}
}
fs.writeFileSync(path.join(dir,'universe.json'),JSON.stringify({selected,skipped,auditWindow:audit.window},null,2));
fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify({files:Object.fromEntries(['scripts/observe-mm.ts','src/research/mm/strategy.ts','src/research/mm/publicData.ts','src/research/mm/walletAudit.ts','src/research/depthState.ts','src/research/bookArbitrage.ts'].map(f=>[f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')]))},null,2));
for(const f of Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'source.json'),'utf8')).files)){const target=path.join(dir,'sources',f);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(f,target);}
function clearMarket(m:any){state.remove(m.tokens.map((t:any)=>t.id));reservations.release(m.conditionId);for(const t of m.tokens)histories.delete(t.id);}
function connect(m:any){
 if(!active)return;const old=sockets.get(m.conditionId);if(old&&(old.readyState===WebSocket.CONNECTING||old.readyState===WebSocket.OPEN))return;
 clearMarket(m);const socket=new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market',{perMessageDeflate:false,handshakeTimeout:8000});sockets.set(m.conditionId,socket);
 socket.on('open',()=>{if(active&&sockets.get(m.conditionId)===socket){record('connected',{conditionId:m.conditionId});socket.send(JSON.stringify({type:'market',assets_ids:m.tokens.map((t:any)=>t.id),custom_feature_enabled:true}));}});
 socket.on('message',raw=>{if(!active||sockets.get(m.conditionId)!==socket)return;const wire=raw.toString();if(wire==='PONG')return;messages++;record('wire',{conditionId:m.conditionId,wire});try{
  const payload=JSON.parse(wire);for(const e of Array.isArray(payload)?payload:[payload])if(['tick_size_change','market_resolved'].includes(e.event_type??e.type)){m.accepting=false;reservations.release(m.conditionId);record('market-halted',{conditionId:m.conditionId,reason:e.event_type??e.type});}
  updates+=state.ingest(payload,Date.now()).length;
 }catch(e){errors.push(`wire:${String(e)}`);socket.terminate();}});
 socket.on('error',e=>{if(active)errors.push(`socket:${String(e)}`)});
 socket.on('close',(code)=>{if(sockets.get(m.conditionId)!==socket)return;sockets.delete(m.conditionId);clearMarket(m);record('disconnected',{conditionId:m.conditionId,code});if(active){reconnects++;setTimeout(()=>connect(m),2000);}});
}
async function seed(m:any,t:any){const before=state.snapshot(t.id,Date.now()),socket=sockets.get(m.conditionId);try{
 const raw=await read(`https://clob.polymarket.com/book?token_id=${t.id}`);
 if(active&&socket===sockets.get(m.conditionId)&&state.snapshot(t.id,Date.now()).revision===before.revision&&Number(raw.timestamp)>=before.serverAt)state.ingest({...raw,asset_id:t.id,event_type:'book'},Date.now());
}catch(e){if(active)errors.push(`seed:${String(e)}`);}}
function evaluate(){const now=Date.now();for(const m of selected){
 const snaps=m.tokens.map((t:any)=>state.snapshot(t.id,now)),stat=stats.get(m.conditionId);
 for(let i=0;i<2;i++){const s=snaps[i],t=m.tokens[i];if(!s.usable||s.ageMs>1500||s.serverAgeMs>1500)continue;
  const h=histories.get(t.id)??[];if(!h.length||now-h.at(-1)!.at>=950)h.push({at:now,mid:(s.bestBid+s.bestAsk)/2});histories.set(t.id,h.filter(p=>p.at>=now-60_000));}
 reservations.release(m.conditionId);const capital=reservations.totals(m.conditionId,m.event);
 const inputs=snaps.map((s:any,i:number)=>({now,receivedAt:s.receivedAt,serverAt:s.serverAt,usable:s.usable,book:s,history:histories.get(m.tokens[i].id)??[],tick:m.tick,minShares:m.minShares,fee:m.fee,accepting:m.accepting,eventAt:m.eventAt,eventTimeRequired:true,
 cashAvailableUsd:1000-capital.portfolio,ownedShares:0,netOutcomeShares:0,marketCommittedUsd:0,eventCommittedUsd:capital.event,portfolioCommittedUsd:capital.portfolio}));
 const plan=planMmPair(inputs[0],inputs[1]);stat.observations++;observations++;
 if(snaps.every((s:any)=>s.usable&&s.ageMs<=1500&&s.serverAgeMs<=1500)&&Math.abs(snaps[0].serverAt-snaps[1].serverAt)<=250)stat.freshPairs++;
 const reason=plan.quotes.length?plan.reason:plan.plans.find(p=>p.reason!=='quote_intent_only')?.reason??plan.reason;
 if(plan.quotes.length&&reservations.reserve(m.conditionId,m.event,plan.buyReservationUsd)){
  stat.quoteIntents++;stat.quoteSides+=plan.quotes.length;quoted++;
  const buys=plan.quotes.filter(q=>q.side==='BUY');if(buys.length===2){const cost=buys.reduce((s,q)=>s+q.price+quoteFee(1,q.price,m.fee),0);if(stat.bestPairBidCostPerShare==null||cost<stat.bestPairBidCostPerShare)stat.bestPairBidCostPerShare=cost;}
 }else{stat.denials[reason]=(stat.denials[reason]??0)+1;denials[reason]=(denials[reason]??0)+1;}
 record('quote-plan',{evaluationAt:now,conditionId:m.conditionId,capital,snapshots:snaps,plan});
 }maxReservationUsd=Math.max(maxReservationUsd,reservations.totals('','').portfolio);}
function report(status:string){return{schemaVersion:1,status,startedAt:planningStartedAt,finishedAt:Date.now(),scheduledSeconds:seconds,markets:selected.length,tokenBooks:selected.length*2,messages,updates,reconnects,observations,quoteIntentObservations:quoted,maxReservationUsd,
  config:DEFAULT_MM_CONFIG,marketStats:[...stats.values()],denials,skipped,errors:errors.slice(-100),ordersSubmitted:0,amountSpentUsd:0,simulatedFills:0,realizedPnlUsd:null,portfolioSharpe:null,performanceClaimEligible:false,
  limitations:['Quotes are hypothetical intents, not resting orders or queue-confirmed fills.','No touches or public trades are booked as fills in this observer.','The quote reference is book microprice, not an independently calibrated probability.','Zero owned inventory: quote bids on both complementary outcomes; asks require acquired tokens.','Matched pairs can be merged only after both actual/simulated fills; isolated legs carry directional risk.','Both entry and exit fee curves are reserved conservatively; no rewards or rebates are assumed.','Event identity is Gamma event slug with known submarket suffixes removed; unresolved cross-event correlations remain.','No underlying ATR/ADX signal is applied to sports; sports external fair-value feeds remain unavailable.']};}
planningStartedAt=Date.now();let status='completed';
const timers:ReturnType<typeof setInterval>[]=[];
process.on('SIGINT',()=>{active=false;status='interrupted'});process.on('SIGTERM',()=>{active=false;status='interrupted'});
try{if(!selected.length)throw Error('No eligible audited markets');for(const m of selected)connect(m);await Promise.all(selected.flatMap(m=>m.tokens.map(t=>seed(m,t))));
 timers.push(setInterval(()=>{try{evaluate();fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report('running'),null,2));}catch(e){errors.push(`evaluate:${String(e)}`);status='failed';active=false;}},1000));
 timers.push(setInterval(()=>{for(const socket of sockets.values())if(socket.readyState===WebSocket.OPEN)socket.send('PING');},10_000));
 console.log(JSON.stringify({started:true,dir,markets:selected.length,seconds,ordersSubmitted:0}));
 const deadline=planningStartedAt+seconds*1000;while(active&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1000));
}catch(e){status='failed';errors.push(String(e));}
active=false;for(const timer of timers)clearInterval(timer);const retiring=[...sockets.values()];sockets.clear();for(const s of retiring)s.terminate();
journalClosed=true;gzip.end();await once(output,'close');const final=report(status);fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(final,null,2));console.log(JSON.stringify({dir,...final},null,2));if(status==='failed')process.exitCode=1;
