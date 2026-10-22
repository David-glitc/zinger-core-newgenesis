import fs from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { publicJson, walkPublicPages } from '../src/research/mm/publicData.js';
import { auditPnl, makerRowEstimate, TradeAudit } from '../src/research/mm/walletAudit.js';
const args = Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')]}));
if (Object.keys(args).some(k=>!['hours','pages','position-pages','out'].includes(k))) throw Error('Public audit supports --hours, --pages, --position-pages and --out only');
const hours=Number(args.hours??24), pages=Number(args.pages??100),positionPages=Number(args['position-pages']??100);
if (!Number.isFinite(hours)||hours<=0||hours>168||![pages,positionPages].every(p=>Number.isInteger(p)&&p>=1&&p<=500)) throw Error('Invalid audit bounds');
const dir=path.resolve(args.out??`tmp/commercial-evidence/mm-wallet-audit-${Date.now()}`);
fs.mkdirSync(dir,{recursive:true});if(fs.existsSync(path.join(dir,'requests.jsonl.gz')))throw Error('Choose a new output directory');
const gzip=createGzip(), output=fs.createWriteStream(path.join(dir,'requests.jsonl.gz'),{flags:'wx'});gzip.pipe(output);
const read=(url:string)=>publicJson(url,entry=>gzip.write(JSON.stringify(entry)+'\n'));
const end=Math.floor(Date.now()/1000),start=end-Math.round(hours*3600),wallets=[
  {name:'ferrariChampions2026',wallet:'0xfe787d2da716d60e8acff57fb87eb13cd4d10319'},
  {name:'RN1',wallet:'0x2005d16a84ceefa912d4e380cd32e7ff827875ea'},
  {name:'Flaznorp',wallet:'0x821dab0565ebf5b327f51db06223fdcfe01acf16'}];
const files=['scripts/audit-public-mm.ts','src/research/mm/publicData.ts','src/research/mm/walletAudit.ts'];
fs.writeFileSync(path.join(dir,'source.json'),JSON.stringify({at:Date.now(),files:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')]))},null,2));
for(const f of files){const target=path.join(dir,'sources',f);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(f,target);}
const results:any[]=[], metadata=new Map<string,any>();let status='completed',failure:string|null=null;
try {
 for(const w of wallets){
  const flows:Record<string,any>={};
  for(const takerOnly of [false,true]){
   const audit=new TradeAudit(w.wallet,start,end);
   const coverage=await walkPublicPages(`https://data-api.polymarket.com/v2/trades?user=${w.wallet}&start=${start}&end=${end}&taker_only=${takerOnly}&limit=1000`,pages,rows=>audit.add(rows as any[]),read);
   flows[takerOnly?'taker':'all']=audit.summary(coverage);
   console.log(JSON.stringify({wallet:w.name,feed:takerOnly?'taker':'all',...coverage,markets:audit.markets.size}));
  }
  const pnl=await read(`https://data-api.polymarket.com/v2/user-pnl?user=${w.wallet}&interval=1m&fidelity=1d`);
  const positions:any[]=[],cashflows:any[]=[],lifecycleRows:any[]=[];
  const positionCoverage=await walkPublicPages(`https://data-api.polymarket.com/v2/positions?user=${w.wallet}&limit=1000`,positionPages,rows=>positions.push(...rows),read);
  const cashflowCoverage=await walkPublicPages(`https://data-api.polymarket.com/v2/activity?user=${w.wallet}&start=1&end=${end}&type=DEPOSIT,WITHDRAWAL,TIP&exclude_deposits_withdrawals=false&limit=1000`,10,rows=>cashflows.push(...rows),read);
  const lifecycleCoverage=await walkPublicPages(`https://data-api.polymarket.com/v2/activity?user=${w.wallet}&start=${start}&end=${end}&type=MERGE,SPLIT,REDEEM&limit=1000`,pages,rows=>lifecycleRows.push(...rows),read);
  const lifecycle:Record<string,{rows:number;shares:number;cashUsd:number}>={};let rejectedLifecycleRows=0;
  for(const f of lifecycleRows){const amount=Number(f.usdc_size),q=Number(f.size);if(!['MERGE','SPLIT','REDEEM'].includes(f.type)||![amount,q].every(Number.isFinite)||amount<0||q<0||f.timestamp<start||f.timestamp>end){rejectedLifecycleRows++;continue;}const a=lifecycle[f.type]??={rows:0,shares:0,cashUsd:0};a.rows++;a.shares+=q;a.cashUsd+=amount;}
  let deposits=0,withdrawals=0,tipsIn=0,tipsOut=0,rejectedFlows=0;
  for(const f of cashflows){const amount=Number(f.usdc_size);if(!Number.isFinite(amount)||amount<0){rejectedFlows++;continue;}if(f.type==='DEPOSIT')deposits+=amount;else if(f.type==='WITHDRAWAL')withdrawals+=amount;else if(f.type==='TIP'&&f.side==='IN')tipsIn+=amount;else if(f.type==='TIP'&&f.side==='OUT')tipsOut+=amount;else rejectedFlows++;}
  const result={...w,confirmedMarketMaker:false,all:flows.all,taker:flows.taker,makerEstimate:makerRowEstimate(flows.all,flows.taker),
    pnl:auditPnl(pnl.data.points,Math.floor(end/86400)*86400),sourceFidelity:pnl.data.source_fidelity,
    inventory:{coverage:positionCoverage,positions:positions.length,missingMarkRows:positions.filter(p=>p.current_value==null||!Number.isFinite(Number(p.current_value))).length,markedValueOfCoveredRowsUsd:positions.filter(p=>p.current_value!=null&&Number.isFinite(Number(p.current_value))).reduce((s,p)=>s+Number(p.current_value),0),topPositions:positions.slice(0,15)},
    lifecycle:{coverage:lifecycleCoverage,rejectedRows:rejectedLifecycleRows,types:lifecycle},
    externalFlows:{coverage:cashflowCoverage,rows:cashflows.length,deposits,withdrawals,tipsIn,tipsOut,rejectedFlows,verifiedCapital:false}};
  results.push(result);fs.writeFileSync(path.join(dir,`${w.wallet}.json`),JSON.stringify(result,null,2));
  // Enrich leading traded markets and current holdings, then share metadata across wallets.
  const ids=[...new Set([...flows.all.markets.slice(0,60).map((m:any)=>m.conditionId),...positions.slice(0,20).map(p=>p.condition_id)])].filter(id=>!metadata.has(id));
  for(let i=0;i<ids.length;i+=15){const u=new URL('https://gamma-api.polymarket.com/markets');for(const id of ids.slice(i,i+15))u.searchParams.append('condition_ids',id);u.searchParams.set('limit','100');
    const requested=new Set(ids.slice(i,i+15));for(const m of await read(String(u))){if(!requested.has(m.conditionId))throw Error('Gamma returned an unrequested condition');metadata.set(m.conditionId,m);}
    // Gamma defaults to open markets. Fetch the closed cohort separately.
    u.searchParams.set('closed','true');for(const m of await read(String(u))){if(!requested.has(m.conditionId))throw Error('Gamma returned an unrequested closed condition');metadata.set(m.conditionId,m);}}
 }
}catch(e){status='failed';failure=String(e);}
const metadataRows=[...metadata.values()];fs.writeFileSync(path.join(dir,'market-metadata.json'),JSON.stringify(metadataRows,null,2));
const report={schemaVersion:1,status,failure,startedAt:end,finishedAt:Math.floor(Date.now()/1000),window:{start,end,hours},pageBudgetPerTradeFeed:pages,pageBudgetPerPositionFeed:positionPages,wallets:results,marketsEnriched:metadata.size,
  ordersSubmitted:0,amountSpentUsd:0,performanceClaimEligible:false,limitations:['Wallet selection is prior monthly volume; not verified market-maker identities.','Trade rows are wallet-attributed executions; gross notional is turnover, not profit or capital.','Maker estimates require complete matching-window feeds; fills cannot establish continuous quoting.','Default positions endpoint is current holdings, not complete historical portfolio capital.','Flows can include migration/system transfers; no historical equity reconstruction is asserted.','Family classifications are labelled title/slug heuristics.','No wallet-level quote cancellations or queue priority are public in this sample.']};
fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));gzip.end();await once(output,'close');
console.log(JSON.stringify({status,failure,dir,marketsEnriched:metadata.size,wallets:results.map(w=>({name:w.name,allRows:w.all.rows,takerRows:w.taker.rows,complete:w.all.coverage.complete&&w.taker.coverage.complete,marketCount:w.all.marketCount,maker:w.makerEstimate,families:w.all.families,pnl:w.pnl}))},null,2));
if(status==='failed')process.exitCode=1;
