import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import WebSocket from 'ws';
import {DepthState} from '../src/research/depthState.js';
import {publicJson} from '../src/research/mm/publicData.js';
import {DEFAULT_MM_CONFIG,mmInputFreshAt,planMmPair,planMmIndependent,type MidObservation,type MmQuotePricing} from '../src/research/mm/strategy.js';
import {MmPaperSession,type PaperExpiryPolicy} from '../src/research/mm/paperSession.js';
import {CTF_MATCHING_MODEL,type CtfMatchingModel} from '../src/research/mm/ctfMatching.js';
import {discoverDeepMmUniverse} from '../src/research/mm/deepDiscovery.js';
import {PaperEvidenceJournal} from '../src/research/mm/journal.js';
import {confirmClosingBook} from '../src/research/mm/closingBook.js';
import {fullExitOrderSize} from '../src/research/mm/orderSize.js';
import {recoverPaperSession,type RecoveredPaperSession} from '../src/research/mm/recovery.js';
import {confirmedBookFresh,verifiedBookConfirmation,type BookConfirmation} from '../src/research/mm/bookConfirmation.js';
import {walkQuote} from '../src/research/bookArbitrage.js';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{const[k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')]}));
if(Object.keys(args).some(k=>!['universe','bankroll','seconds','out','reload-universe','queue-model','quote-lifetime-ms','fee-reserve-legs','quote-scope','book-freshness','quote-pricing','profile','discovery','inventory','fill-rule','cancel-latency-ms','capture-inputs','reserve-per-share','sigma-multiplier','resume-from','matching-model','expiry-policy','max-portfolio-usd','max-market-usd','max-event-usd','max-cash-loss-usd','max-order-shares','max-net-shares','activation-latency-ms','quote-offset-ticks','allow-concurrent','startup-timeout-ms','reward-sized','rest-tolerance-ticks'].includes(k)))throw Error('Unsupported paper argument');
const parentReport=args['resume-from']?JSON.parse(fs.readFileSync(path.resolve(args['resume-from'],'report.json'),'utf8')):null;
const profile=args.profile??'legacy';
if(!['legacy','deep-flow'].includes(profile))throw Error('Invalid paper profile');
const matchingModel=(args['matching-model']??'direct') as CtfMatchingModel;
if(!['direct',CTF_MATCHING_MODEL].includes(matchingModel)||matchingModel!== 'direct'&&profile!=='deep-flow')throw Error('CTF matching requires the explicit deep-flow profile');
const expiryPolicy=(args['expiry-policy']??'fixed-expiry') as PaperExpiryPolicy;
if(!['fixed-expiry','renewable-client-lease-v1','resting-tolerance-v1'].includes(expiryPolicy)||expiryPolicy!=='fixed-expiry'&&matchingModel!==CTF_MATCHING_MODEL)throw Error('Client lease policy requires joint CTF matching');
const deep=profile==='deep-flow',discovery=args.discovery??(deep?'deep-flow':'file');
if(!['file','deep-flow'].includes(discovery))throw Error('Invalid discovery policy');
const inventoryMode=args.inventory??(deep?'split':'cash');
if(!['cash','split'].includes(inventoryMode))throw Error('Invalid inventory policy');
const fillRule=args['fill-rule']??'exact-price';
if(!['exact-price','price-through'].includes(fillRule))throw Error('Invalid fill rule');
const quotePricing=args['quote-pricing']??(deep?'improve':'model');
if(!['model','touch','improve'].includes(quotePricing))throw Error('Invalid quote pricing');
const bookFreshness=args['book-freshness']??(deep?'verified-snapshot':'timestamp');
if(!['timestamp','verified-snapshot','connection-health'].includes(bookFreshness))throw Error('Invalid book freshness policy');
const quoteScope=args['quote-scope']??(deep?'independent':'pair');
if(!['pair','independent'].includes(quoteScope))throw Error('Invalid quote scope');
const queueModel=args['queue-model']??'same-price';
if(!['same-price','legacy-cumulative'].includes(queueModel))throw Error('Invalid queue model');
const quoteLifetimeMs=Number(args['quote-lifetime-ms']??(deep?10000:2000)),feeReserveLegs=Number(args['fee-reserve-legs']??(deep?1:2));
if(!Number.isFinite(quoteLifetimeMs)||quoteLifetimeMs<500||quoteLifetimeMs>60000||!Number.isInteger(feeReserveLegs)||feeReserveLegs<1||feeReserveLegs>2)throw Error('Invalid quote execution settings');
const cancelLatencyMs=Number(args['cancel-latency-ms']??(deep?250:0));
const captureInputs=args['capture-inputs']==='true';
const reservePerShare=Number(args['reserve-per-share']??DEFAULT_MM_CONFIG.reservePerShare),sigmaMultiplier=Number(args['sigma-multiplier']??1.5);
if(![cancelLatencyMs,reservePerShare,sigmaMultiplier].every(Number.isFinite)||cancelLatencyMs<0||cancelLatencyMs>2000||reservePerShare<0||reservePerShare>.1||sigmaMultiplier<=0||sigmaMultiplier>5)throw Error('Invalid execution risk settings');
const bankroll=Number(args.bankroll??parentReport?.bankrollUsd??500),seconds=Number(args.seconds??3600);
if(parentReport&&bankroll!==parentReport.bankrollUsd)throw Error('Recovery cannot replace the original deposit');
if(!Number.isFinite(bankroll)||bankroll<=0||bankroll>100_000||!Number.isFinite(seconds)||seconds<10||seconds>86400)throw Error('Invalid paper session limits');
if(discovery==='file'){
 if(!args.universe)throw Error('Pass a freshly discovered --universe JSON file');
 const universe=JSON.parse(fs.readFileSync(path.resolve(args.universe),'utf8'));
 if(!Array.isArray(universe.selected)||universe.selected.length<1||universe.selected.length>20)throw Error('Invalid paper universe');
}
const dir=path.resolve(args.out??`tmp/commercial-evidence/mm-paper-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
if(args['resume-from']&&(dir===path.resolve(args['resume-from'])||dir.startsWith(path.resolve(args['resume-from'])+path.sep)))throw Error('A continuation requires a separate evidence directory');
// One capture at a time by default: parallel captures overloaded the shared connection and caused seed timeouts and stalls.
const lockPath=path.resolve('tmp/commercial-evidence/.paper-mm.lock');let lockHeld=false;
function releaseLock(){if(!lockHeld)return;try{if(JSON.parse(fs.readFileSync(lockPath,'utf8')).pid===process.pid)fs.unlinkSync(lockPath);}catch{}lockHeld=false;}
if(args['allow-concurrent']!=='true'){
 fs.mkdirSync(path.dirname(lockPath),{recursive:true});
 let owner:any=null;try{owner=JSON.parse(fs.readFileSync(lockPath,'utf8'));}catch{}
 if(owner){let alive=false;try{process.kill(owner.pid,0);alive=true;}catch{}if(alive)throw Error(`Another paper capture is running (pid ${owner.pid}, ${owner.dir}); pass --allow-concurrent=true to override`);try{fs.unlinkSync(lockPath);}catch{}}
 fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,dir,at:Date.now()}),{flag:'wx'});lockHeld=true;
}
process.on('exit',releaseLock);
const startupTimeoutMs=Number(args['startup-timeout-ms']??60_000);
if(!Number.isFinite(startupTimeoutMs)||startupTimeoutMs<5000||startupTimeoutMs>600_000)throw Error('Invalid startup-timeout-ms');
const abortReads=new AbortController();
let active=true,draining=false,journalClosed=false,status='starting',sequence=0,messages=0,updates=0,reconnects=0,startedAt=Date.now(),lastWireAt=0;
let valuationAt:number|null=null,tradingStoppedAt:number|null=null,observationEndAt:number|null=null;
let bookTicks=0,staleBookTicks=0;
// Size each market's quotes to its reward minimum (paper only). Markets whose minimum exceeds maxOrderShares are not quoted.
const rewardSized=args['reward-sized']==='true';
// Projected maker-reward accrual: never credited to cash, reported separately from trading P/L.
const rewardStats=new Map<string,{samples:number,eligibleSamples:number,shareSum:number,accruedUsd:number}>();let rewardLastAt=0;
async function rewardParams(conditionId:string){
 try{const g=await read(`https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`);const x=Array.isArray(g)?g.find((r:any)=>r.conditionId===conditionId):null;
  if(!x||!Array.isArray(x.clobRewards))return null;
  const dailyPoolUsd=x.clobRewards.reduce((a:number,r:any)=>a+Number(r.rewardsDailyRate??0),0),maxSpread=Number(x.rewardsMaxSpread)/100,minSize=Number(x.rewardsMinSize??0);
  return dailyPoolUsd>0&&maxSpread>0&&minSize>0?{dailyPoolUsd,maxSpread,minSize}:null;
 }catch(e){errors.push(`rewards:${String(e)}`);return null;}
}
let recovery:RecoveredPaperSession|null=null,recoveryApplied=false;
const errors:string[]=[],denials:Record<string,number>={};
const recentEvents:any[]=[],cancelReasons:Record<string,number>={};
const journal=new PaperEvidenceJournal(path.join(dir,'events.jsonl.gz'),32*1024*1024,e=>{errors.push(String(e));status='failed';active=false;});
const record=(type:string,data:any)=>{if(journalClosed)return;const at=Date.now(),result=journal.append(type,data,at);sequence=result.sequence;if(result.overBudget&&!draining){if(active)errors.push(`journal_resource_limit:${result.pressureReason}`);status='failed';active=false;}
 if(type==='paper-cancel')cancelReasons[data.reason]=(cancelReasons[data.reason]??0)+1;
 if(['paper-order','paper-fill','paper-merge','paper-cancel'].includes(type)){recentEvents.push({at,type,data});if(recentEvents.length>50)recentEvents.shift();}
};
// Risk ceilings. Defaults are the original fixed-clamp rules; explicit flags let a larger baseline scale them (paper only).
const capFlag=(k:string,fallback:number)=>{if(args[k]==null||args[k]==='')return fallback;const v=Number(args[k]);if(!Number.isFinite(v)||v<=0)throw Error(`Invalid ${k}`);return v;};
// Simulated activation latency (ms) between a decision and the quote becoming active. Paper assumption, not a measured venue latency.
const activationLatencyMs=capFlag('activation-latency-ms',250);
const restToleranceTicks=Number(args['rest-tolerance-ticks']??1);if(!Number.isInteger(restToleranceTicks)||restToleranceTicks<0||restToleranceTicks>10)throw Error('Invalid rest-tolerance-ticks');
const quoteOffsetTicks=Number(args['quote-offset-ticks']??0);if(!Number.isInteger(quoteOffsetTicks)||quoteOffsetTicks<0||quoteOffsetTicks>5)throw Error('Invalid quote-offset-ticks');
const config={...DEFAULT_MM_CONFIG,quoteLifetimeMs,feeReserveLegs,reservePerShare,sigmaMultiplier,
 quoteOffsetTicks,restToleranceTicks,
 maxPortfolioUsd:capFlag('max-portfolio-usd',Math.min(100,bankroll*.1)),maxMarketUsd:capFlag('max-market-usd',Math.min(10,bankroll*.02)),
 maxEventUsd:capFlag('max-event-usd',Math.min(20,bankroll*.04)),maxCashLossUsd:capFlag('max-cash-loss-usd',bankroll*.05),
 maxOrderShares:capFlag('max-order-shares',DEFAULT_MM_CONFIG.maxOrderShares),maxNetShares:capFlag('max-net-shares',DEFAULT_MM_CONFIG.maxNetShares)};
const session=new MmPaperSession(bankroll,config,record,activationLatencyMs,queueModel as 'same-price'|'legacy-cumulative',fillRule as 'exact-price'|'price-through',cancelLatencyMs,matchingModel,expiryPolicy),state=new DepthState(),history=new Map<string,MidObservation[]>();
const sockets=new Map<string,WebSocket>(),wireTimes=new Map<string,number>(),markets:any[]=[],pending=new Set<Promise<any>>();
const confirmations=new Map<string,BookConfirmation&{revision:number}>();
const seedInFlight=new Set<string>();
const seedStats={started:0,completed:0,failed:0,skippedBusy:0};
const read=(url:string)=>publicJson(url,e=>record('http',e),fetch,abortReads.signal);
const sourceFiles=['scripts/paper-mm.ts','src/research/mm/paperSession.ts','src/research/mm/paperInventory.ts','src/research/mm/ctfMatching.ts','src/research/mm/strategy.ts','src/research/mm/bookConfirmation.ts','src/research/mm/publicData.ts','src/research/mm/deepDiscovery.ts','src/research/mm/walletAudit.ts','src/research/mm/journal.ts','src/research/depthState.ts','src/research/bookArbitrage.ts','scripts/audit-mm-paper.py','scripts/mm_depth_audit.py','scripts/mm_ctf_audit.py','src/research/mm/closingBook.ts','src/research/mm/orderSize.ts','src/research/mm/recovery.ts'];
fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify({files:Object.fromEntries(sourceFiles.map(f=>[f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')]))},null,2));
for(const f of sourceFiles){const target=path.join(dir,'sources',f);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(f,target);}
function track(p:Promise<any>){pending.add(p);void p.finally(()=>pending.delete(p)).catch(()=>{});}
const lastSeedOkAt=new Map<string,number>();
function marketOf(token?:string){return token?markets.find((m:any)=>m.tokens.some((t:any)=>t.id===token)):undefined;}
function liveAt(token?:string){const m=marketOf(token);return m?wireTimes.get(m.conditionId)??0:0;}
function connectionHealthy(s:any,now:number,token?:string){
 const m=marketOf(token);if(!m||!token)return false;const socket=sockets.get(m.conditionId),live=wireTimes.get(m.conditionId)??0,seeded=lastSeedOkAt.get(token)??0;
 return s.seeded&&!s.issue&&s.bids.length>0&&s.asks.length>0&&s.bestBid<s.bestAsk&&socket?.readyState===WebSocket.OPEN&&now-live>=0&&now-live<=config.maxAgeMs&&now-seeded>=0&&now-seeded<=30_000;
}
function fresh(s:any,now:number,token?:string){if(bookFreshness==='connection-health')return connectionHealthy(s,now,token);return bookFreshness==='verified-snapshot'?confirmedBookFresh(s,now,confirmations.get(token),config.maxAgeMs):s.usable&&now-s.receivedAt>=0&&now-s.receivedAt<=config.maxAgeMs&&now-s.serverAt>=-1000&&now-s.serverAt<=config.maxAgeMs;}
function clear(m:any,reason:string){session.cancelMarket(m.conditionId,reason,Date.now());state.remove(m.tokens.map((t:any)=>t.id));for(const t of m.tokens){history.delete(t.id);confirmations.delete(t.id);}record('book-reset',{conditionId:m.conditionId,reason});}
function closeUnusedMarketSockets(){
 for(const m of markets){
  if(m.accepting||m.tokens.some((t:any)=>(session.inventory.holdings.get(t.id)?.shares??0)>1e-9)||session.openQuotes().some(q=>q.conditionId===m.conditionId))continue;
  const socket=sockets.get(m.conditionId);if(!socket)continue;sockets.delete(m.conditionId);socket.terminate();
  state.remove(m.tokens.map((t:any)=>t.id));for(const t of m.tokens){history.delete(t.id);confirmations.delete(t.id);}
  record('retired-socket-closed',{conditionId:m.conditionId});
 }
}
async function refreshUniverse(initial=false){
 if(!initial&&!active)return;
 const universe=discovery==='deep-flow'?await discoverDeepMmUniverse({},read):JSON.parse(fs.readFileSync(path.resolve(args.universe),'utf8'));
 if(!initial&&!active)return;
 const candidates=universe.selected;
 if(discovery==='deep-flow'){record('discovery',universe);const p=path.join(dir,'discovery.json');fs.writeFileSync(p+'.next',JSON.stringify(universe,null,2));fs.renameSync(p+'.next',p);}
 if(!Array.isArray(candidates)||candidates.length>20)throw Error('Invalid refreshed MM universe');
 const eligible=new Set(candidates.map((c:any)=>c.conditionId));
 for(const m of markets){
  if(m.accepting&&(!eligible.has(m.conditionId)||m.eventAt-Date.now()<=(m.eventBufferMs??config.eventBufferMs))){
   m.accepting=false;m.retired=true;session.cancelMarket(m.conditionId,'universe_retired',Date.now());session.releasePairedInventory(m.conditionId,Date.now());record('market-retired',{conditionId:m.conditionId});
   if(m.tokens.every((t:any)=>(session.inventory.holdings.get(t.id)?.shares??0)<=1e-9)){
    const socket=sockets.get(m.conditionId);setTimeout(()=>{session.expire(Date.now());if(!m.accepting&&sockets.get(m.conditionId)===socket&&!session.openQuotes().some(q=>q.conditionId===m.conditionId)){sockets.delete(m.conditionId);socket?.terminate();state.remove(m.tokens.map((t:any)=>t.id));}},cancelLatencyMs+10);
   }
  }
 }
 for(const candidate of candidates){
  const existing=markets.find(m=>m.conditionId===candidate.conditionId);
  if(existing&&!existing.retired)continue;
  const d=await read(`https://clob.polymarket.com/clob-markets/${candidate.conditionId}`);
  if(!active&&!initial)return;
  const tokens=d.t?.map((t:any)=>({id:String(t.t),outcome:String(t.o)}));
  const eventAt=candidate.lifecycle==='market-close'?Number(candidate.eventAt):Date.parse(d.gst??new Date(candidate.eventAt).toISOString());
  const eventBufferMs=Number(candidate.eventBufferMs??config.eventBufferMs);
  if(d.ao!==true||!Array.isArray(tokens)||tokens.length!==2||!Number.isFinite(eventAt)||!Number.isFinite(eventBufferMs)||eventBufferMs<0||eventAt-Date.now()<=eventBufferMs)continue;
  if(candidate.tokens&&tokens.some((t:any,i:number)=>t.id!==candidate.tokens[i]?.id))throw Error('Market token mapping changed');
  let fee=d.fd?{rate:Number(d.fd.r),exponent:Number(d.fd.e)}:null;
  if(!fee){const rate=await read(`https://clob.polymarket.com/fee-rate?token_id=${tokens[0].id}`);if(rate.base_fee==null||Number(rate.base_fee)!==0)throw Error('Unknown live fee curve');fee={rate:0,exponent:1};}
  if(deep&&(candidate.negativeRisk!==false||d.v!=='v1'||d.c!==candidate.conditionId))throw Error('Unsupported deep-market inventory contract');
  const m:any={...candidate,tokens,eventAt,eventBufferMs,fee,tick:Number(d.mts),minShares:Number(d.mos),accepting:true,negativeRisk:deep?candidate.negativeRisk:d.nr===true};
  m.rewards=await rewardParams(m.conditionId);
  session.register({conditionId:m.conditionId,event:m.event,tokens:m.tokens.map((t:any)=>t.id) as [string,string],fee:m.fee,tick:m.tick,minShares:m.minShares,mergeSupported:!m.negativeRisk,quoteDeadlineAt:m.eventAt-(m.eventBufferMs??config.eventBufferMs)});
  if(existing){Object.assign(existing,m,{retired:false});record('market',existing);if(!initial){connect(existing);await Promise.all(existing.tokens.map((t:any)=>seed(existing,t)));}}
  else{markets.push(m);record('market',m);if(!initial){connect(m);await Promise.all(m.tokens.map(t=>seed(m,t)));}}
 }
 const dest=path.join(dir,'universe.json');fs.writeFileSync(dest+'.next',JSON.stringify({selected:markets},null,2));fs.renameSync(dest+'.next',dest);
}
function connect(m:any){
 const held=m.tokens.some((t:any)=>(session.inventory.holdings.get(t.id)?.shares??0)>1e-9);
 if(!active||(!m.accepting&&!held))return;const old=sockets.get(m.conditionId);if(old&&(old.readyState===WebSocket.CONNECTING||old.readyState===WebSocket.OPEN))return;
 clear(m,'connection_reset');const socket=new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market',{perMessageDeflate:false,handshakeTimeout:8000});sockets.set(m.conditionId,socket);wireTimes.set(m.conditionId,Date.now());
 socket.on('open',()=>{if(active&&sockets.get(m.conditionId)===socket){record('connected',{conditionId:m.conditionId});socket.send(JSON.stringify({type:'market',assets_ids:m.tokens.map((t:any)=>t.id),custom_feature_enabled:true}));}});
 socket.on('message',raw=>{
  if((!active&&!draining)||sockets.get(m.conditionId)!==socket)return;const at=Date.now(),wire=raw.toString();lastWireAt=at;wireTimes.set(m.conditionId,at);if(wire==='PONG')return;
  messages++;record('wire',{conditionId:m.conditionId,wire,receivedAt:at});
  try{const parsed=JSON.parse(wire);for(const e of Array.isArray(parsed)?parsed:[parsed]){
    const type=e.event_type??e.type,p=e.payload??e;
    if(['tick_size_change','market_resolved'].includes(type)){
      m.accepting=false;m.retired=true;clear(m,'market_constraints_changed');record('halted',{conditionId:m.conditionId,type});
      const winner=String(p.winning_asset_id??p.winningAssetId??'');
      if(type==='market_resolved'&&String(p.market??p.conditionId??'')===m.conditionId&&m.tokens.some((t:any)=>t.id===winner))session.resolveMarket(m.conditionId,winner,at);
    }
    if(type==='last_trade_price'){
      const token=String(p.asset_id??p.assetId??''),tx=String(p.transaction_hash??p.transactionHash??''),time=Number(p.timestamp),price=Number(p.price),shares=Number(p.size),aggressor=p.side;
      const s=state.snapshot(token,at);
      const healthy=m.tokens.some((t:any)=>t.id===token)&&fresh(s,at,token);
      record('print-book-health',{token,receivedAt:at,policy:bookFreshness,structural:s.seeded&&!s.issue&&s.bids.length>0&&s.asks.length>0&&s.bestBid<s.bestAsk,bookServerAt:s.serverAt,bookReceivedAt:s.receivedAt,bookRevision:s.revision,confirmation:confirmations.get(token)??null});
      // Missing transaction identities are skipped. Identical fragmented prints are conservatively deduplicated.
      const id=/^0x[0-9a-f]{64}$/i.test(tx)?`${tx}:${token}:${time}:${price}:${shares}:${aggressor}`:'';
      const counter=m.tokens.find((t:any)=>t.id!==token),other=counter?state.snapshot(counter.id,at):null;
      const complementHealthy=!!counter&&!!other&&fresh(other,at,counter.id);
      if(counter&&other)record('print-book-health',{token:counter.id,receivedAt:at,policy:bookFreshness,structural:other.seeded&&!other.issue&&other.bids.length>0&&other.asks.length>0&&other.bestBid<other.bestAsk,bookServerAt:other.serverAt,bookReceivedAt:other.receivedAt,bookRevision:other.revision,confirmation:confirmations.get(counter.id)??null});
      session.print({id,token,aggressor,price,shares,at:time},at,healthy,complementHealthy);
    }
   updates+=state.ingest(e,at).length;
  }
  }catch(e){errors.push(`wire:${String(e)}`);status='failed';active=false;}
 });
 socket.on('error',e=>{if(active)errors.push(`socket:${String(e)}`);});
 socket.on('close',code=>{if(sockets.get(m.conditionId)!==socket)return;sockets.delete(m.conditionId);clear(m,'disconnected');record('disconnected',{conditionId:m.conditionId,code});if(active&&(m.accepting||m.tokens.some((t:any)=>(session.inventory.holdings.get(t.id)?.shares??0)>1e-9))){reconnects++;setTimeout(()=>connect(m),2000);}});
}
async function seed(m:any,t:any){
 if(!active||(!m.accepting&&!m.tokens.some((token:any)=>(session.inventory.holdings.get(token.id)?.shares??0)>1e-9)))return;
 if(seedInFlight.has(t.id)){seedStats.skippedBusy++;return;}
 const socket=sockets.get(m.conditionId),before=state.snapshot(t.id,Date.now()),requestedAt=Date.now();if(fresh(before,requestedAt,t.id)&&requestedAt-Math.max(before.serverAt,confirmations.get(t.id)?.receivedAt??0)<config.maxAgeMs/2)return;
 seedInFlight.add(t.id);seedStats.started++;let headers:any=null;try{const url=`https://clob.polymarket.com/book?token_id=${t.id}`;
 const raw=bookFreshness!=='verified-snapshot'?await read(url):await publicJson(url,e=>record('http',e),async(u,o)=>{const r=await fetch(u,{...o,signal:AbortSignal.any([o.signal as AbortSignal,AbortSignal.timeout(config.maxAgeMs)]),cache:'no-store',headers:{'cache-control':'no-cache'}});headers={date:r.headers.get('date'),age:r.headers.get('age'),cacheStatus:r.headers.get('cf-cache-status')};return r;},abortReads.signal);
 const receivedAt=Date.now();
 if(String(raw.asset_id??raw.assetId??'')!==t.id||String(raw.market??raw.conditionId??'')!==m.conditionId)throw Error('Snapshot market/token mismatch');
 lastSeedOkAt.set(t.id,receivedAt);
 if(active&&sockets.get(m.conditionId)===socket&&state.snapshot(t.id,receivedAt).revision===before.revision&&Number(raw.timestamp)>=before.serverAt){
  state.ingest({...raw,event_type:'book',asset_id:t.id},receivedAt);
  record('book-seeded',{token:t.id,conditionId:m.conditionId,receivedAt,serverAt:Number(raw.timestamp),hash:raw.hash,revision:state.snapshot(t.id,receivedAt).revision});
  if(headers){const proof={requestedAt,receivedAt,...headers,hash:raw.hash,token:String(raw.asset_id??''),serverAt:Number(raw.timestamp),revision:state.snapshot(t.id,receivedAt).revision};
   if(verifiedBookConfirmation(proof,t.id,config.maxAgeMs)){confirmations.set(t.id,proof);record('book-confirmed',proof);}}
 }
}catch(e){seedStats.failed++;if(active)errors.push(`seed:${String(e)}`);}finally{seedInFlight.delete(t.id);seedStats.completed++;}}
function evaluate(){
 const now=Date.now();session.expire(now);closeUnusedMarketSockets();
 for(const m of markets){
  if(!active)break;
  if(!m.accepting)continue;
  if(m.eventAt-now<=(m.eventBufferMs??config.eventBufferMs)){m.accepting=false;session.cancelMarket(m.conditionId,'event_cutoff',now);session.releasePairedInventory(m.conditionId,now);continue;}
  const snaps=m.tokens.map((t:any)=>state.snapshot(t.id,now));
  bookTicks++;if(!snaps.every((s:any,i:number)=>fresh(s,now,m.tokens[i].id)))staleBookTicks++;
  for(let i=0;i<2;i++){
   const s=snaps[i],t=m.tokens[i];if(!fresh(s,now,t.id))continue;
   const h=history.get(t.id)??[];if(!h.length||now-h.at(-1)!.at>=950)h.push({at:now,mid:(s.bestBid+s.bestAsk)/2});history.set(t.id,h.filter(p=>p.at>=now-60_000));
  }
  const inputsFor=(extraShares=0)=>{
   const cap=session.exposure(m.conditionId,m.event,true),extraCost=extraShares?extraShares+.01:0;
   const owned=m.tokens.map((t:any)=>(session.inventory.holdings.get(t.id)?.shares??0)+extraShares);
   const otherReserved=session.openQuotes().filter(q=>q.conditionId!==m.conditionId&&q.side==='BUY').reduce((s,q)=>s+q.remaining*q.price,0);
   const healthAt=(i:number)=>bookFreshness==='connection-health'&&fresh(snaps[i],now,m.tokens[i].id)?liveAt(m.tokens[i].id):null;
   const inputs=snaps.map((s:any,i:number)=>({now,receivedAt:healthAt(i)??s.receivedAt,serverAt:s.serverAt,
    confirmedAt:healthAt(i)??(bookFreshness==='verified-snapshot'&&now-s.serverAt>config.maxAgeMs&&fresh(s,now,m.tokens[i].id)?confirmations.get(m.tokens[i].id)?.receivedAt:undefined),
    usable:fresh(s,now,m.tokens[i].id),book:s,history:history.get(m.tokens[i].id)??[],tick:m.tick,minShares:rewardSized&&m.rewards?Math.max(m.minShares,m.rewards.minSize):m.minShares,fee:m.fee,
    accepting:m.accepting,eventAt:m.eventAt,eventBufferMs:m.eventBufferMs,eventTimeRequired:true,
    cashAvailableUsd:Math.max(0,session.availableRiskCash(otherReserved)-extraCost),ownedShares:owned[i],netOutcomeShares:owned[i]-owned[1-i],
    marketCommittedUsd:cap.marketUsd+extraCost,eventCommittedUsd:cap.eventUsd+extraCost,portfolioCommittedUsd:cap.portfolioUsd+extraCost}));
   return{cap,owned,inputs};
  };
  const planner=quoteScope==='independent'?planMmIndependent:planMmPair;
  const rewardMin=rewardSized&&m.rewards?Math.max(m.minShares,m.rewards.minSize):null;
  if(rewardMin!=null&&rewardMin>config.maxOrderShares){denials.reward_min_size_above_cap=(denials.reward_min_size_above_cap??0)+1;session.replace(m.conditionId,[],snaps,now);continue;}
  const mcfg=rewardMin!=null?{...config,maxOrderShares:rewardMin}:config;
  let {cap,owned,inputs}=inputsFor();
  const existing=expiryPolicy==='renewable-client-lease-v1'?session.openQuotes().filter(q=>q.conditionId===m.conditionId).map(q=>({...q,outcomeIndex:m.tokens.findIndex((t:any)=>t.id===q.token)})):[];
  let plan=planner(inputs[0],inputs[1],mcfg,quotePricing as MmQuotePricing,existing);
  const placementAt=Date.now();
  if(!inputs.every(input=>mmInputFreshAt(input,placementAt,config.maxAgeMs))){
   denials.stale_at_placement=(denials.stale_at_placement??0)+1;session.replace(m.conditionId,[],snaps,placementAt);
   record('decision',{evaluationAt:now,placementAt,conditionId:m.conditionId,plan:{...plan,quotes:[],reason:'stale_at_placement'},placementRejection:'stale_at_placement',...(captureInputs?{inputs,existing}:{})});continue;
  }
  // Do not pay for a split until the quote can still be placed from fresh books.
  if(inventoryMode==='split'&&snaps.every((s:any,i:number)=>fresh(s,placementAt,m.tokens[i].id))){
   const proposed=inputsFor(mcfg.maxOrderShares);
   if(proposed.inputs.every(input=>mmInputFreshAt(input,placementAt,config.maxAgeMs))&&planner(proposed.inputs[0],proposed.inputs[1],mcfg,quotePricing as MmQuotePricing).quotes.some(q=>q.side==='SELL')){
    session.splitInventory(m.conditionId,mcfg.maxOrderShares,.01);({cap,owned,inputs}=inputsFor());plan=planner(inputs[0],inputs[1],mcfg,quotePricing as MmQuotePricing,existing);
   }
  }
  const reason=plan.quotes.length?plan.reason:plan.plans.find(p=>p.reason!=='quote_intent_only')?.reason??plan.reason;
  denials[reason]=(denials[reason]??0)+1;
  session.replace(m.conditionId,plan.quotes.map(q=>({...q,expiresAt:Math.min(q.expiresAt,m.eventAt-(m.eventBufferMs??config.eventBufferMs))})).filter(q=>q.expiresAt>placementAt+250),snaps,placementAt);
  record('decision',{evaluationAt:now,placementAt,conditionId:m.conditionId,capital:cap,owned,plan,...(captureInputs?{inputs,existing}:{} )});
 }
}
// Polymarket scores resting orders about once a minute: score = size * ((v - s) / v)^2 for orders within v of the midpoint,
// sized at or above the market's reward minimum. Uses the outcome-0 book only, so mirrored books are not counted twice.
// Two-sided rule: the smaller of our bid-side and ask-side shares counts; single-sided quoting earns nothing here (conservative).
function sampleRewards(){
 const now=Date.now(),minutes=rewardLastAt?Math.min(1,(now-rewardLastAt)/60_000):0;rewardLastAt=now;
 for(const m of markets){
  if(!m.accepting||!m.rewards)continue;
  const t0=m.tokens[0].id,s=state.snapshot(t0,now),st=rewardStats.get(m.conditionId)??{samples:0,eligibleSamples:0,shareSum:0,accruedUsd:0};rewardStats.set(m.conditionId,st);st.samples++;
  if(!fresh(s,now,t0)||s.bestBid==null||s.bestAsk==null)continue;
  const mid=(s.bestBid+s.bestAsk)/2,v=m.rewards.maxSpread,score=(p:number,size:number)=>{const d=Math.abs(p-mid);return d<=v?size*((v-d)/v)**2:0;};
  const cBid=s.bids.reduce((a:number,l:any)=>a+score(l.price,l.size),0),cAsk=s.asks.reduce((a:number,l:any)=>a+score(l.price,l.size),0);
  let oBid=0,oAsk=0;
  for(const q of session.openQuotes()){
   if(q.conditionId!==m.conditionId||q.remaining<m.rewards.minSize||now<(q.activateAt??0))continue;
   const onT0=q.token===t0,px=onT0?q.price:1-q.price,bidSide=onT0?q.side==='BUY':q.side==='SELL';
   if(bidSide)oBid+=score(px,q.remaining);else oAsk+=score(px,q.remaining);
  }
  const share=oBid>0&&oAsk>0?Math.min(oBid/(oBid+cBid),oAsk/(oAsk+cAsk)):0,usd=share*m.rewards.dailyPoolUsd/1440*minutes;
  if(share>0)st.eligibleSamples++;st.shareSum+=share;st.accruedUsd+=usd;
  record('reward-sample',{conditionId:m.conditionId,at:now,mid,ourBidScore:oBid,ourAskScore:oAsk,competitionBid:cBid,competitionAsk:cAsk,share,usd});
 }
}
function rewardReport(){
 const perMarket=markets.filter(m=>m.rewards).map(m=>{const st=rewardStats.get(m.conditionId)??{samples:0,eligibleSamples:0,shareSum:0,accruedUsd:0};
  return{conditionId:m.conditionId,title:m.title,dailyPoolUsd:m.rewards.dailyPoolUsd,maxSpread:m.rewards.maxSpread,minSize:m.rewards.minSize,samples:st.samples,eligibleSamples:st.eligibleSamples,meanShare:st.samples?st.shareSum/st.samples:0,accruedUsd:st.accruedUsd};});
 return{method:'projected-quadratic-two-sided-v1',creditedToCash:false,accruedUsd:perMarket.reduce((a,x)=>a+x.accruedUsd,0),marketsWithRewards:perMarket.length,perMarket};
}
function portfolio(){const now=valuationAt??Date.now(),marks=new Map<string,number>();let liquidationValue=session.inventory.cashUsd,liquidationComplete=true;
 for(const[token,h]of session.inventory.holdings){if(h.shares<=1e-9)continue;const s=state.snapshot(token,now),m=markets.find(m=>m.tokens.some((t:any)=>t.id===token));
  if(!fresh(s,now,token)||!m){liquidationComplete=false;continue;}marks.set(token,(s.bestBid+s.bestAsk)/2);if(!fullExitOrderSize(h.shares,m.minShares).ok){liquidationComplete=false;continue;}const walk=walkQuote(s.bids,h.shares,'sell',m.fee);if(!walk.complete)liquidationComplete=false;else liquidationValue+=walk.premiumUsd-walk.feeUsd;
 }const equity=session.inventory.equity(marks);
 return{cashUsd:session.inventory.cashUsd,midEquityUsd:equity,midPnlUsd:equity==null?null:equity-bankroll,liquidationEquityUsd:liquidationComplete?liquidationValue:null,liquidationPnlUsd:liquidationComplete?liquidationValue-bankroll:null,realizedPnlUsd:session.inventory.realizedPnlUsd,feesUsd:session.inventory.feesUsd,
  inventory:[...session.inventory.holdings].filter(([,h])=>h.shares>1e-9).map(([token,h])=>({token,...h})),capital:session.exposure('',''),openQuotes:session.openQuotes()};}
function report(){return{schemaVersion:1,evidenceVersion:2,type:'forward-paper-mm',liquidationConstraints:'ctf-minimum-and-two-decimal-size-v1',status,pid:process.pid,startedAt,updatedAt:Date.now(),valuationAt,tradingStoppedAt,observationEndAt,observationTailMs:Math.max(1000,cancelLatencyMs),scheduledEndAt:startedAt+seconds*1000,bankrollUsd:bankroll,accountId:recovery?.report.accountId??(args['resume-from']?path.basename(path.resolve(args['resume-from'])):path.basename(dir)),accountStartedAt:recovery?.report.accountStartedAt??recovery?.report.startedAt??parentReport?.accountStartedAt??parentReport?.startedAt??startedAt,recoveryParent:args['resume-from']?path.resolve(args['resume-from']):null,recovery:recovery?{...recovery.evidence,initialFillRule:recovery.report.initialFillRule??recovery.report.fillRule,initialLatencyMs:recovery.report.initialLatencyMs??recovery.report.latencyMs,initialCancelLatencyMs:recovery.report.initialCancelLatencyMs??recovery.report.cancelLatencyMs??0,openingCashUsd:recovery.inventory.cashUsd}:null,initialFillRule:recovery?.report.initialFillRule??recovery?.report.fillRule??fillRule,initialLatencyMs:recovery?.report.initialLatencyMs??recovery?.report.latencyMs??250,initialCancelLatencyMs:recovery?.report.initialCancelLatencyMs??recovery?.report.cancelLatencyMs??cancelLatencyMs,expiryPolicy,initialExpiryPolicy:recovery?(recovery.report.initialExpiryPolicy??recovery.report.expiryPolicy??'fixed-expiry'):expiryPolicy,leasesRenewed:session.leasesRenewed,restingKept:session.restingKept,matchingModel,initialMatchingModel:recovery?(recovery.report.initialMatchingModel??recovery.report.matchingModel??'direct'):matchingModel,initialMaxCashLossUsd:recovery?(Object.hasOwn(recovery.report,'initialMaxCashLossUsd')?recovery.report.initialMaxCashLossUsd:recovery.report.config.maxCashLossUsd??null):config.maxCashLossUsd,config,profile,discovery,inventoryMode,fillRule,queueModel,quoteScope,bookFreshness,quotePricing,latencyMs:250,cancelLatencyMs,captureInputs,journal:journal.stats(),seedStats:{...seedStats,inFlight:seedInFlight.size},bookCoverage:{marketSeconds:bookTicks,staleMarketSeconds:staleBookTicks,staleShare:bookTicks?staleBookTicks/bookTicks:null},rewardSized,projectedRewards:rewardReport(),bookHealth:markets.filter(m=>m.accepting).flatMap(m=>m.tokens.map((t:any)=>{const s=state.snapshot(t.id,Date.now());return{conditionId:m.conditionId,token:t.id,issue:s.issue,receivedAgeMs:s.ageMs,serverAgeMs:s.serverAgeMs,fresh:fresh(s,Date.now(),t.id),confirmedAt:confirmations.get(t.id)?.receivedAt??null};})),markets:markets.length,activeMarkets:markets.filter(m=>m.accepting).length,marketList:markets.map(m=>({conditionId:m.conditionId,title:m.title,family:m.family,tokens:m.tokens,accepting:m.accepting,eventAt:m.eventAt})),cancelReasons,recentEvents,tokenBooks:markets.length*2,messages,updates,reconnects,lastWireAt,simulatedFills:session.simulatedFills,simulatedMerges:session.simulatedMerges,simulatedSplits:session.simulatedSplits,simulatedSettlements:session.simulatedSettlements,quotesPlaced:session.quotesPlaced,quotesCancelled:session.quotesCancelled,printsSeen:session.printsSeen,printsRejected:session.printsRejected,denials,errors:errors.slice(-100),...(args['resume-from']&&!recoveryApplied?{cashUsd:null,midEquityUsd:null,midPnlUsd:null,liquidationEquityUsd:null,liquidationPnlUsd:null,realizedPnlUsd:null,feesUsd:null,inventory:[],openQuotes:[]}:portfolio()),ordersSubmitted:0,actualSpendUsd:0,portfolioSharpe:null,performanceClaimEligible:false,
 limitations:[expiryPolicy==='fixed-expiry'?'Legacy fixed-expiry simulation; this ten-second profile does not represent venue GTD minimums.':'Renewable GTC client lease: unchanged supported intents preserve priority; lease expiry requests cancellation and exposure remains until modeled acknowledgment. Late received prints after acknowledgment remain unqualified.','Print health uses current native books; existing order/cancel windows govern eligibility after the entry lifecycle cutoff.',matchingModel==='direct'?'Direct same-token matching control.':'Conservative joint CTF model: one economic quote per price; shared microshare queue/print budget; volume capped at the maximum observed within each condition/transaction, which can undercount multi-trade batches. True routing is unverified.','All orders and fills are simulated; queue priority and true execution are unknown.',`Declared ${fillRule} fill rule; price-through fills assume unchanged aggressor flow in a counterfactual book.`,`Initial inventory: ${inventoryMode}; complete-set splits debit collateral plus an assumed $0.01 cost, not a live gas quote.`,'Native last_trade_price.side is interpreted as aggressor side; fill attribution has not been independently reconciled on chain.',queueModel==='same-price'?`Only identified prints meeting the declared ${fillRule} rule consume displayed same-price depth; cancellations do not count.`:'Legacy cumulative-depth queue: retained only for baseline comparisons.',`250ms activation and ${cancelLatencyMs}ms cancel-ack delay; stale, late, duplicate and unidentified prints cannot fill an order.`,'Makers charged zero under current public fee policy; incentives zero; forced liquidation uses live taker fee curves.','One-cent paper cost per merge; negative-risk merges disabled pending separate lifecycle validation.','Outstanding inventory remains open at session end; no forced settlement price is invented.','Midpoint and finite-depth liquidation marks reported separately; missing or stale marks produce null equity.',discovery==='deep-flow'?'Public depth/flow discovery refreshed every minute; per-market lifecycle buffers apply.':args['reload-universe']==='true'?'Refreshed file universe; per-market lifecycle buffers apply.':'Fixed discovered universe; per-market lifecycle buffers apply.']};}
function save(){const p=path.join(dir,'report.json');fs.writeFileSync(p+'.tmp',JSON.stringify(report(),null,2));fs.renameSync(p+'.tmp',p);}
const timers:ReturnType<typeof setInterval>[]=[];
let forceExitTimer:ReturnType<typeof setTimeout>|undefined;
function failHard(reason:string){errors.push(reason);status='failed';try{save();}catch{}releaseLock();process.exit(1);}
const requestStop=(why:string)=>{status='interrupted';active=false;if(!forceExitTimer){forceExitTimer=setTimeout(()=>failHard(`forced_exit_after_${why}`),30_000);forceExitTimer.unref();}};
process.on('SIGINT',()=>requestStop('SIGINT'));process.on('SIGTERM',()=>requestStop('SIGTERM'));
try{
 fs.writeFileSync(path.join(dir,'bootstrap.json'),JSON.stringify({status:'starting',pid:process.pid,bankrollUsd:bankroll,ordersSubmitted:0,actualSpendUsd:0,config,matchingModel,expiryPolicy,initialExpiryPolicy:parentReport?(parentReport.initialExpiryPolicy??parentReport.expiryPolicy??'fixed-expiry'):expiryPolicy,initialMatchingModel:parentReport?(parentReport.initialMatchingModel??parentReport.matchingModel??'direct'):matchingModel,latencyMs:250,cancelLatencyMs,queueModel,fillRule,recoveryParent:args['resume-from']?path.resolve(args['resume-from']):null,initialFillRule:parentReport?.initialFillRule??parentReport?.fillRule??fillRule,initialLatencyMs:parentReport?.initialLatencyMs??parentReport?.latencyMs??250,initialCancelLatencyMs:parentReport?.initialCancelLatencyMs??parentReport?.cancelLatencyMs??cancelLatencyMs,initialMaxCashLossUsd:parentReport?(Object.hasOwn(parentReport,'initialMaxCashLossUsd')?parentReport.initialMaxCashLossUsd:parentReport.config.maxCashLossUsd??null):config.maxCashLossUsd}),{flag:'wx',mode:0o600});
 if(args['resume-from']){
  recovery=await recoverPaperSession(args['resume-from'],async row=>{const result=journal.append(row.type,row.data,row.at);if(result.overBudget||result.sequence!==row.sequence)throw Error('Recovery prefix resource or ordering failure');await journal.drain();});
  fs.writeFileSync(path.join(dir,'opening-account.json'),JSON.stringify(recovery,null,2),{flag:'wx',mode:0o600});
  session.restoreRecovered(recovery,Date.now(),true);recoveryApplied=true;
  for(const m of recovery.marketMetadata)markets.push({...m,accepting:false,retired:true});
  save();
 }
 await refreshUniverse(true);
 if(!markets.length)throw Error('No fresh eligible markets; rediscover a current universe');
 fs.writeFileSync(path.join(dir,'universe.json'),JSON.stringify({selected:markets},null,2));startedAt=Date.now();status='running';save();
 const hardStop=setTimeout(()=>failHard('stall:hard_deadline_exceeded'),seconds*1000+startupTimeoutMs+300_000);hardStop.unref();
 for(const m of markets)connect(m);
 let seedDeadline:ReturnType<typeof setTimeout>|undefined;
 const seedOutcome=await Promise.race([Promise.allSettled(markets.flatMap(m=>m.tokens.map((t:any)=>seed(m,t)))).then(()=>'done'),new Promise<string>(r=>{seedDeadline=setTimeout(()=>r('deadline'),startupTimeoutMs);})]);
 if(seedDeadline)clearTimeout(seedDeadline);
 if(seedOutcome==='deadline'){errors.push(`startup:initial_seed_deadline_${startupTimeoutMs}ms`);record('startup-warning',{reason:'initial_seed_deadline',inFlight:seedInFlight.size});}
 // Fail loudly if market data never arrives, or stops arriving for two minutes.
 timers.push(setInterval(()=>{if(!active)return;const now=Date.now();
  if(lastWireAt===0&&now-startedAt>startupTimeoutMs){errors.push('startup:no_market_data');status='failed';active=false;}
  else if(lastWireAt>0&&now-lastWireAt>120_000){errors.push('stall:no_market_data_120s');status='failed';active=false;}},5000));
 timers.push(setInterval(()=>{try{evaluate();const p=portfolio();if(p.liquidationPnlUsd!=null&&p.liquidationPnlUsd<=-bankroll*.05){session.cancelAll('drawdown');status='risk_stopped';active=false;}save();}catch(e){errors.push(String(e));status='failed';active=false;}},1000));
 timers.push(setInterval(()=>{if(!active)return;for(const m of markets.filter(m=>m.accepting||m.tokens.some((t:any)=>(session.inventory.holdings.get(t.id)?.shares??0)>0)))for(const t of m.tokens)track(seed(m,t));},bookFreshness==='verified-snapshot'?1000:bookFreshness==='connection-health'?10_000:15_000));
 if(args['reload-universe']==='true'||discovery==='deep-flow'){let refreshing=false;timers.push(setInterval(()=>{if(!active||refreshing)return;refreshing=true;track(refreshUniverse().catch(e=>{errors.push(`universe_refresh:${String(e)}`);}).finally(()=>refreshing=false));},60_000));}
 if(bookFreshness==='connection-health')timers.push(setInterval(()=>{for(const s of sockets.values())if(s.readyState===WebSocket.OPEN)s.send('PING');},1000));
 timers.push(setInterval(()=>{if(!active)return;try{sampleRewards();}catch(e){errors.push(`rewards:${String(e)}`);}},60_000));
 timers.push(setInterval(()=>{for(const[mId,s]of sockets){if(s.readyState===WebSocket.OPEN)s.send('PING');if(Date.now()-(wireTimes.get(mId)??0)>30_000)s.terminate();}},10_000));
 console.log(JSON.stringify({started:true,pid:process.pid,dir,bankrollUsd:bankroll,markets:markets.length,scheduledEndAt:new Date(startedAt+seconds*1000).toISOString(),actualSpendUsd:0}));
 while(active&&Date.now()<startedAt+seconds*1000)await new Promise(resolve=>setTimeout(resolve,1000));if(status==='running')status='completed';
}catch(e){errors.push(String(e));status='failed';}
tradingStoppedAt=Date.now();active=false;draining=true;abortReads.abort();for(const timer of timers)clearInterval(timer);session.cancelAll('session_end',Date.now());await new Promise(resolve=>setTimeout(resolve,Math.max(1000,cancelLatencyMs)+20));session.expire(Date.now());for(const m of markets)session.releasePairedInventory(m.conditionId,Date.now());session.expire(Date.now());draining=false;observationEndAt=Date.now();const retiring=[...sockets.values()];sockets.clear();for(const s of retiring)s.terminate();
await Promise.all([...session.inventory.holdings].filter(([,h])=>h.shares>1e-9).map(async([token])=>{const m=markets.find(m=>m.tokens.some((t:any)=>t.id===token));if(m)await confirmClosingBook({token,conditionId:m.conditionId},state,record,confirmations,config.maxAgeMs);}));
valuationAt=Date.now();record('valuation-evidence',{at:valuationAt,books:[...session.inventory.holdings].filter(([,h])=>h.shares>1e-9).map(([token])=>({token,snapshot:state.snapshot(token,valuationAt!),confirmation:confirmations.get(token)??null}))});let cleanupTimer:ReturnType<typeof setTimeout>|undefined;await Promise.race([Promise.allSettled([...pending]),new Promise<void>(resolve=>{cleanupTimer=setTimeout(resolve,25000);})]);if(cleanupTimer)clearTimeout(cleanupTimer);
record('final',report());journalClosed=true;try{await journal.finish();}catch(e){errors.push(String(e));status='failed';}save();const final=report();console.log(JSON.stringify({status,dir,bankrollUsd:bankroll,quotesPlaced:final.quotesPlaced,simulatedFills:final.simulatedFills,simulatedSplits:final.simulatedSplits,simulatedMerges:final.simulatedMerges,cashUsd:final.cashUsd,midPnlUsd:final.midPnlUsd,liquidationPnlUsd:final.liquidationPnlUsd,errors:final.errors.length,actualSpendUsd:0}));if(status==='failed')process.exitCode=1;
