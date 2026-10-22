import fs from 'node:fs';
import path from 'node:path';
import {createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {MmPaperInventory,type PaperInventorySnapshot} from './paperInventory.js';
import type {PaperMarket} from './paperSession.js';
import {CTF_MATCHING_MODEL,economicQuote,microshares} from './ctfMatching.js';

interface Row {sequence:number;at:number;type:string;data:any}
export interface RecoveredPaperSession {
  schemaVersion:1;inventory:PaperInventorySnapshot;actorSequence:number;markets:PaperMarket[];marketMetadata:any[];
  splitMarkets:string[];resolvedMarkets:string[];pendingMerges:string[];forcedMerges:string[];inventoryReserves:[string,number][];seenPrints:string[];outstandingOrders:any[];
  counters:{simulatedFills:number;simulatedMerges:number;simulatedSplits:number;simulatedSettlements:number;quotesPlaced:number;quotesCancelled:number;printsSeen:number;printsRejected:number;leasesRenewed?:number};
  evidence:{directory:string;records:number;lastRecordedAt:number;prefixSha256:string;files:Record<string,string>;gzipComplete:boolean;truncatedRawTail:boolean;duplicatePrefixRows:number;receiptConsistencyVerified:boolean;sourceFilesVerified:boolean;dataGap:true;performanceClaimEligible:false};
  report:any;
}

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
/** Recover a stopped producer's durable prefix; never write to the input. */
export async function recoverPaperSession(directory:string,onRow:(row:Row)=>void|Promise<void>=()=>{},requireStopped=true):Promise<RecoveredPaperSession>{
  const root=path.resolve(directory),metadataFile=fs.existsSync(path.join(root,'report.json'))?'report.json':'bootstrap.json';
  const report=JSON.parse(fs.readFileSync(path.join(root,metadataFile),'utf8'));
  if(report.actualSpendUsd!==0||report.ordersSubmitted!==0)throw Error('Recovery only accepts a paper account');
  if(!['running','starting','completed','interrupted','risk_stopped','failed'].includes(report.status))throw Error('Unknown paper producer status');
  if(requireStopped&&['running','starting'].includes(report.status)){
    if(!Number.isInteger(report.pid)||report.pid<=0)throw Error('Cannot verify whether the paper producer stopped');
    // A PID check must not treat an alive or inaccessible process as stopped.
    let alive=true;try{process.kill(report.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}
    if(alive)throw Error('Paper producer is still alive; recovery refused');
  }
  const source=JSON.parse(fs.readFileSync(path.join(root,'source.json'),'utf8'));
  for(const[file,digest]of Object.entries(source.files)){
    if(path.isAbsolute(file)||file.split(/[\\/]/).includes('..'))throw Error('Invalid archived source path');
    if(hash(fs.readFileSync(path.join(root,'sources',file)))!==digest)throw Error(`Archived source changed: ${file}`);
  }
  const inventory=new MmPaperInventory(report.bankrollUsd),metadata=new Map<string,any>(),markets=new Map<string,PaperMarket>(),orders=new Map<string,any>();
  const split=new Set<string>(),resolved=new Set<string>(),pendingMerges=new Set<string>(),prints=new Set<string>();
  const reserves=new Map<string,number>(),forcedMerges=new Set<string>();
  const printBudgets=new Map<string,number>();
  const counters={simulatedFills:0,simulatedMerges:0,simulatedSplits:0,simulatedSettlements:0,quotesPlaced:0,quotesCancelled:0,printsSeen:0,printsRejected:0,leasesRenewed:0};
  let sequence=0,actorSequence=0,lastRecordedAt=0,gzipComplete=true,truncatedRawTail=false,duplicatePrefixRows=0;
  let recoveryCommitted=false;
  const partsDir=path.join(root,'events.jsonl.gz.parts');
  const parts=fs.existsSync(partsDir)?fs.readdirSync(partsDir).filter(name=>/^\d{8}\.jsonl$/.test(name)).sort().map(name=>path.join(partsDir,name)):[];
  const firstPart=parts.length?fs.readFileSync(parts[0],'utf8'):'';
  const firstRawSequence=firstPart.includes('\n')?Number(JSON.parse(firstPart.split('\n')[0]).sequence):Infinity;
  const overlap=new Map<number,string>();
  const prefix=createHash('sha256');
  const close=(actual:number,expected:number,label:string)=>{if(!Number.isFinite(actual)||Math.abs(actual-expected)>1e-7)throw Error(`Recovered ${label} does not match its receipt`);};
  async function consume(line:string){
    const row:Row=JSON.parse(line),digest=hash(line);
    if(row.sequence<=sequence){if(overlap.get(row.sequence)!==digest)throw Error('Conflicting compressed/raw evidence overlap');duplicatePrefixRows++;return;}
    if(row.sequence!==sequence+1||!Number.isFinite(row.at))throw Error('Noncontiguous recovery evidence');
    sequence=row.sequence;lastRecordedAt=row.at;if(row.sequence>=firstRawSequence)overlap.set(row.sequence,digest);
    const d=row.data;
    if(row.type==='paper-recovery'){
      if(d.parent.records!==sequence-1||d.parent.prefixSha256!==prefix.copy().digest('hex'))throw Error('Recovery ancestry prefix changed');
      if(d.bankrollUsd!==inventory.initialCashUsd)throw Error('Recovery ancestry reset capital');
      close(d.cashUsd,inventory.cashUsd,'opening cash');
      if(d.inventoryReserves)for(const[condition,shares]of d.inventoryReserves)reserves.set(condition,shares);
      if(d.pendingMerges){pendingMerges.clear();for(const condition of d.pendingMerges)pendingMerges.add(condition);}
      if(d.forcedMerges){forcedMerges.clear();for(const condition of d.forcedMerges)forcedMerges.add(condition);}
      if(!report.recoveryParent||path.resolve(d.parent.directory)===path.resolve(report.recoveryParent))recoveryCommitted=true;
    }
    prefix.update(line+'\n');
    if(row.type==='market'){
      const market:PaperMarket={conditionId:d.conditionId,event:d.event,tokens:d.tokens.map((t:any)=>t.id) as [string,string],fee:d.fee,minShares:d.minShares,tick:d.tick,mergeSupported:!d.negativeRisk,...(Number.isFinite(d.eventAt)?{quoteDeadlineAt:d.eventAt-(d.eventBufferMs??report.config.eventBufferMs)}:{})};
      inventory.registerMarket(market.conditionId,...market.tokens);markets.set(market.conditionId,market);metadata.set(market.conditionId,d);
    }else if(row.type==='paper-order'){
      actorSequence++;if(d.id!==`order-${actorSequence}`||orders.has(d.id))throw Error('Recovered order identity changed');
      orders.set(d.id,{...d,remaining:d.shares});counters.quotesPlaced++;
    }else if(row.type==='paper-cancel-request'){
      const q=orders.get(d.id);if(!q)throw Error('Recovered cancellation has no order');q.cancelAt=d.ackAt;q.cancelReason=d.reason;
      if(d.reason==='merge')pendingMerges.add(q.conditionId);
    }else if(row.type==='paper-lease-renewal'){
      const q=orders.get(d.id);if(!q||q.expiryPolicy!=='renewable-client-lease-v1'||q.cancelAt!=null||![d.renewedAt,d.previousExpiresAt,d.expiresAt,d.remainingShares,d.originalShares].every(Number.isFinite)||d.renewedAt>row.at||row.at-d.renewedAt>report.config.maxAgeMs||d.renewedAt>=q.expiresAt||d.previousExpiresAt!==q.expiresAt||d.token!==q.token||d.side!==q.side||d.price!==q.price||Math.abs(d.remainingShares-q.remaining)>1e-9||d.originalShares!==q.shares||d.expiresAt<=q.expiresAt||d.expiresAt>d.renewedAt+(report.config.quoteLifetimeMs??2000)||!Number.isFinite(q.quoteDeadlineAt)||d.expiresAt>q.quoteDeadlineAt)throw Error('Recovered lease changed its intent or deadline');
      q.expiresAt=d.expiresAt;counters.leasesRenewed++;
    }else if(row.type==='paper-merge-request'){
      pendingMerges.add(d.conditionId);
      if(d.force)forcedMerges.add(d.conditionId);
    }else if(row.type==='paper-cancel'){
      if(!orders.delete(d.id))throw Error('Recovered cancellation has no live order');counters.quotesCancelled++;
    }else if(row.type==='paper-print'){
      counters.printsSeen++;if(d.accepted){if(typeof d.print.id!=='string'||!d.print.id||prints.has(d.print.id))throw Error('Repeated or invalid accepted print in recovery');prints.add(d.print.id);if(d.matchingModel===CTF_MATCHING_MODEL){if(!Number.isFinite(d.volumeBudget?.availableShares)||d.volumeBudget.availableShares<0||d.volumeBudget.availableShares>d.print.shares)throw Error('Invalid recovered print budget');printBudgets.set(d.print.id,d.volumeBudget.availableShares);}}else counters.printsRejected++;
    }else if(row.type==='paper-fill'){
      const q=orders.get(d.orderId),token=d.token??d.print.token;if(!q||!prints.has(d.print.id)||q.token!==token||q.side!==d.side||Math.abs(q.price-d.price)>1e-9||d.shares>q.remaining+1e-9)throw Error('Recovered fill does not match its intent');
      if(d.matchingModel===CTF_MATCHING_MODEL){
        const m=markets.get(q.conditionId);if(!m||q.matchingModel!==CTF_MATCHING_MODEL)throw Error('Recovered CTF fill has no matching order');
        const axis=economicQuote(m.tokens,q.token,q.side,q.price),tape=economicQuote(m.tokens,d.print.token,d.print.aggressor,d.print.price);
        const route=q.token===d.print.token?'direct':q.side==='BUY'?'mint':'merge',reaches=Math.abs(axis.price-tape.price)<=1e-9||q.fillRule==='price-through'&&(axis.side==='BUY'?axis.price>tape.price:axis.price<tape.price);
        if(d.route!==route||axis.side===tape.side||!reaches||d.shares<1e-6-1e-9||d.shares>(printBudgets.get(d.print.id)??-1)+1e-9)throw Error('Recovered CTF route or volume is invalid');
        printBudgets.set(d.print.id,printBudgets.get(d.print.id)!-d.shares);
      }else if(token!==d.print.token)throw Error('Direct recovered fill changed token');
      if(!inventory.fill(`${d.orderId}:${d.print.id}`,token,d.side,d.shares,d.price,d.feeUsd))throw Error('Repeated recovered fill receipt');
      q.remaining=d.matchingModel===CTF_MATCHING_MODEL?(microshares(q.remaining,'down')-microshares(d.shares,'down'))/1e6:q.remaining-d.shares;if(q.remaining<=1e-9)orders.delete(d.orderId);counters.simulatedFills++;
      const market=markets.get(q.conditionId);
      if(market?.mergeSupported&&Math.min(...market.tokens.map(token=>inventory.holdings.get(token)?.shares??0))>(reserves.get(q.conditionId)??0)+1e-9)pendingMerges.add(q.conditionId);
      close(d.cashUsd,inventory.cashUsd,'cash');close(d.realizedPnlUsd,inventory.realizedPnlUsd,'realized P/L');
    }else if(row.type==='paper-split'){
      actorSequence++;if(d.id!==`split-${actorSequence}`)throw Error('Repeated recovered split');
      const market=markets.get(d.conditionId);if(split.has(d.conditionId)&&market?.tokens.some(token=>(inventory.holdings.get(token)?.shares??0)>1e-9))throw Error('Repeated split while inventory is still held');
      if(!inventory.split(d.id,d.conditionId,d.shares,d.feeUsd))throw Error('Repeated split identity');split.add(d.conditionId);counters.simulatedSplits++;
      reserves.set(d.conditionId,d.reserveShares??0);
      close(d.cashUsd,inventory.cashUsd,'cash');close(d.realizedPnlUsd,inventory.realizedPnlUsd,'realized P/L');
    }else if(row.type==='paper-merge'){
      actorSequence++;const id=d.id??`merge-${actorSequence}`;if(id!==`merge-${actorSequence}`)throw Error('Recovered merge identity changed');
      if(!inventory.merge(id,...d.tokens as [string,string],d.shares,d.feeUsd))throw Error('Repeated recovered merge');counters.simulatedMerges++;
      pendingMerges.delete(d.conditionId);
      forcedMerges.delete(d.conditionId);
      close(d.cashUsd,inventory.cashUsd,'cash');close(d.realizedPnlUsd,inventory.realizedPnlUsd,'realized P/L');
    }else if(row.type==='paper-settlement'){
      if(!inventory.settle(d.id,d.conditionId,d.payouts,d.feeUsd))throw Error('Repeated recovered settlement');resolved.add(d.conditionId);counters.simulatedSettlements++;
      pendingMerges.delete(d.conditionId);
      forcedMerges.delete(d.conditionId);
      close(d.cashUsd,inventory.cashUsd,'cash');close(d.realizedPnlUsd,inventory.realizedPnlUsd,'realized P/L');
    }
    await onRow(row);
  }
  async function lines(stream:AsyncIterable<Buffer>,raw=false){
    let pending='';const decoder=new TextDecoder();
    for await(const chunk of stream){pending+=decoder.decode(chunk,{stream:true});let end:number;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line)await consume(line);}}
    pending+=decoder.decode();if(pending.trim()){if(raw)truncatedRawTail=true;else throw Error('Compressed evidence lacks a complete final row');}
  }
  const input=fs.createReadStream(path.join(root,'events.jsonl.gz')),gunzip=createGunzip(),compression=pipeline(input,gunzip);void compression.catch(()=>{});
  try{await lines(gunzip);await compression;}catch(error){if((error as NodeJS.ErrnoException).code!=='Z_BUF_ERROR')throw error;gzipComplete=false;}finally{input.destroy();gunzip.destroy();}
  if(!gzipComplete&&!parts.length)throw Error('Truncated journal has no durable raw tail; account recovery refused');
  for(const file of parts)await lines(fs.createReadStream(file),true);
  if(!sequence)throw Error('No recoverable paper evidence');
  if(report.recoveryParent&&!recoveryCommitted)throw Error('Recovery bootstrap was not committed; recover from the unchanged parent');
  // The report is a projection, not authoritative after a crash. Receipts win.
  const snapshot=inventory.snapshot();new MmPaperInventory(report.bankrollUsd).restore(snapshot);
  const files=Object.fromEntries([metadataFile,'source.json','events.jsonl.gz',...parts.map(f=>path.relative(root,f))].map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
  return{schemaVersion:1,inventory:snapshot,actorSequence,markets:[...markets.values()],marketMetadata:[...metadata.values()],splitMarkets:[...split],resolvedMarkets:[...resolved],pendingMerges:[...pendingMerges],forcedMerges:[...forcedMerges],inventoryReserves:[...reserves],seenPrints:[...prints],outstandingOrders:[...orders.values()],counters,
    evidence:{directory:root,records:sequence,lastRecordedAt,prefixSha256:prefix.digest('hex'),files,gzipComplete,truncatedRawTail,duplicatePrefixRows,receiptConsistencyVerified:true,sourceFilesVerified:true,dataGap:true,performanceClaimEligible:false},report};
}
