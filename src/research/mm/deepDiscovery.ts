import {publicJson} from './publicData.js';
import {marketFamily} from './walletAudit.js';

export interface DeepDiscoveryOptions {
  now?:number; candidateLimit?:number; limit?:number; minDepthUsd?:number;
  minRecentPrints?:number; minRecentNotionalUsd?:number; lookbackSeconds?:number;
}
type Read=(url:string)=>Promise<any>;
const parseArray=(x:any)=>Array.isArray(x)?x:JSON.parse(x??'[]');

/** Measured near-touch depth and bounded recent flow, not wallet-name selection. */
export async function discoverDeepMmUniverse(options:DeepDiscoveryOptions={},read:Read=publicJson){
  const now=options.now??Date.now(),candidateLimit=options.candidateLimit??80,limit=options.limit??8;
  const minDepthUsd=options.minDepthUsd??250,minRecentPrints=options.minRecentPrints??3;
  const minRecentNotionalUsd=options.minRecentNotionalUsd??100,lookbackSeconds=options.lookbackSeconds??900;
  if(![now,candidateLimit,limit,minDepthUsd,minRecentPrints,minRecentNotionalUsd,lookbackSeconds].every(Number.isFinite)||candidateLimit<1||candidateLimit>200||limit<1||limit>20||minDepthUsd<=0||minRecentPrints<1||minRecentNotionalUsd<0||lookbackSeconds<60||lookbackSeconds>3600)throw Error('Invalid deep discovery limits');
  const [ranked,tape]=await Promise.all([
    read(`https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${candidateLimit}`),
    read('https://data-api.polymarket.com/v2/trades?limit=500&taker_only=true'),
  ]);
  if(!Array.isArray(ranked)||!Array.isArray(tape.data))throw Error('Malformed discovery inputs');
  const rows=[...ranked],known=new Set(rows.map(m=>m.conditionId));
  const recentIds=[...new Set<string>(tape.data.filter((t:any)=>Number(t.timestamp)*1000<=now&&Number(t.timestamp)*1000>=now-lookbackSeconds*1000&&/^0x[0-9a-f]{64}$/i.test(String(t.condition_id))).map((t:any)=>String(t.condition_id)))].filter(id=>!known.has(id)).slice(0,40);
  for(let i=0;i<recentIds.length;i+=15){
    const ids=recentIds.slice(i,i+15),u=new URL('https://gamma-api.polymarket.com/markets');u.searchParams.set('limit','100');ids.forEach(id=>u.searchParams.append('condition_ids',id));
    const additional=await read(String(u));
    if(!Array.isArray(additional)||additional.some(m=>!ids.includes(m.conditionId)))throw Error('Unrequested live-flow market metadata');
    for(const m of additional)if(!known.has(m.conditionId)){rows.push(m);known.add(m.conditionId);}
  }
  const skipped:Record<string,number>={},evaluated:any[]=[],qualified:any[]=[];
  const reject=(reason:string)=>{skipped[reason]=(skipped[reason]??0)+1;};
  for(let offset=0;offset<rows.length;offset+=4){
    await Promise.all(rows.slice(offset,offset+4).map(async(m:any)=>{
      let condition=String(m.conditionId??'');
      try{
        if(!/^0x[0-9a-f]{64}$/i.test(condition)||!m.active||m.closed||!m.acceptingOrders){reject('inactive_or_invalid');return;}
        const tokens=parseArray(m.clobTokenIds).map(String);
        if(tokens.length!==2||tokens[0]===tokens[1]||tokens.some((t:string)=>!/^\d+$/.test(t))){reject('unsupported_outcomes');return;}
        if(m.negRisk!==false){reject('unsupported_inventory_lifecycle');return;}
        const start=Date.parse(m.gameStartTime??''),close=Date.parse(m.endDate??'');
        const crypto=/updown-\d+[mh]-/.test(String(m.slug));
        const eventAt=Number.isFinite(start)?start:close,eventBufferMs=Number.isFinite(start)?600_000:crypto?60_000:600_000;
        if(!Number.isFinite(eventAt)||eventAt-now<=eventBufferMs){reject('lifecycle_guard');return;}
        const metadata=await read(`https://clob.polymarket.com/clob-markets/${condition}`);
        if(metadata.c!==condition||metadata.ao!==true||metadata.v!=='v1'||!Array.isArray(metadata.t)||metadata.t.length!==2||metadata.t.some((t:any,i:number)=>String(t.t)!==tokens[i])){reject('unverified_market_contract');return;}
        const tick=Number(metadata.mts),minShares=Number(metadata.mos);
        if(!Number.isFinite(tick)||tick<=0||tick>=1||!Number.isFinite(minShares)||minShares<=0||minShares>5){reject('unsupported_tick_or_minimum');return;}
        let fee=metadata.fd&&{rate:Number(metadata.fd.r),exponent:Number(metadata.fd.e)};
        if(!fee){
          const result=await read(`https://clob.polymarket.com/fee-rate?token_id=${tokens[0]}`);
          if(Number(result.base_fee)!==0||result.base_fee==null){reject('unknown_fee_curve');return;}
          fee={rate:0,exponent:1};
        }
        if(![fee.rate,fee.exponent].every(Number.isFinite)||fee.rate<0||fee.exponent<=0){reject('unknown_fee_curve');return;}
        const books=await Promise.all(tokens.map((t:string)=>read(`https://clob.polymarket.com/book?token_id=${t}`)));
        const depth=books.map((b:any,i:number)=>{
          if(String(b.market)!==condition||String(b.asset_id)!==tokens[i]||b.neg_risk!==false||Number(b.tick_size)!==tick||Number(b.min_order_size)!==minShares||!Number.isFinite(Number(b.timestamp))||Number(b.timestamp)<=0||Number(b.timestamp)>Date.now()+1000)throw Error('Book identity/constraints mismatch');
          const side=(rs:any[],direction:number)=>rs.map(r=>({price:Number(r.price),size:Number(r.size)})).filter(r=>r.price>0&&r.price<1&&Number.isFinite(r.size)&&r.size>0).sort((a,b)=>direction*(a.price-b.price));
          const bids=side(b.bids,-1),asks=side(b.asks,1),bid=bids[0],ask=asks[0];
          if(!bid||!ask||bid.price>=ask.price)throw Error('Invalid deep book');
          const band=Math.max(2*tick,.01),nearBidUsd=bids.filter(l=>l.price>=bid.price-band-1e-9).reduce((s,l)=>s+l.price*l.size,0);
          const nearAskUsd=asks.filter(l=>l.price<=ask.price+band+1e-9).reduce((s,l)=>s+l.price*l.size,0);
          return{token:tokens[i],bid:bid.price,ask:ask.price,spread:ask.price-bid.price,bidQueueShares:bid.size,askQueueShares:ask.size,nearBidUsd,nearAskUsd,depthBandUsd:band,serverAt:Number(b.timestamp),hash:b.hash};
        });
        if(depth.some(b=>b.nearBidUsd<minDepthUsd||b.nearAskUsd<minDepthUsd||b.spread>.06||b.bid<.05||b.ask>.95)){reject('depth_spread_or_tail');return;}
        const url=new URL('https://data-api.polymarket.com/v2/trades');
        url.searchParams.set('condition_id',condition);url.searchParams.set('limit','100');url.searchParams.set('taker_only','true');
        url.searchParams.set('start',String(Math.floor(now/1000)-lookbackSeconds));url.searchParams.set('end',String(Math.floor(now/1000)));
        const trades=await read(String(url));
        if(!Array.isArray(trades.data)||!trades.pagination)throw Error('Malformed bounded market flow');
        const seen=new Set<string>(),recent:any[]=[];
        for(const t of trades.data){
          if(String(t.condition_id)!==condition||!tokens.includes(String(t.token_id)))throw Error('Unrequested market flow');
          const at=Number(t.timestamp)*1000,price=Number(t.price),shares=Number(t.size),tx=String(t.transaction_hash??'');
          if(!Number.isFinite(at)||at>now||at<now-lookbackSeconds*1000||!Number.isFinite(price)||price<=0||price>=1||!Number.isFinite(shares)||shares<=0||!['BUY','SELL'].includes(t.side)||!/^0x[0-9a-f]{64}$/i.test(tx))continue;
          const key=`${tx}:${t.token_id}:${t.side}:${price}:${shares}:${at}`;
          if(seen.has(key))continue;seen.add(key);recent.push({token:t.token_id,side:t.side,price,shares,at});
        }
        const notional=recent.reduce((s,t)=>s+t.price*t.shares,0);
        const flow={lookbackSeconds,rows:recent.length,notionalUsd:notional,shares:recent.reduce((s,t)=>s+t.shares,0),buys:recent.filter(t=>t.side==='BUY').length,sells:recent.filter(t=>t.side==='SELL').length,
          complete:trades.pagination.has_more===false,lastTradeAt:recent.length?Math.max(...recent.map(t=>t.at)):null};
        const reachability=depth.map(b=>{
          const buyShares=recent.filter(t=>t.token===b.token&&t.side==='BUY'&&t.price>=b.ask-tick-1e-9).reduce((s,t)=>s+t.shares,0);
          const sellShares=recent.filter(t=>t.token===b.token&&t.side==='SELL'&&t.price<=b.bid+tick+1e-9).reduce((s,t)=>s+t.shares,0);
          const insideRoom=b.spread>=2*tick-1e-9;
          return{token:b.token,buySharesNearAsk:buyShares,sellSharesNearBid:sellShares,insideRoom,
            askQueueClearSeconds:buyShares>0?(insideRoom?0:b.askQueueShares)*lookbackSeconds/buyShares:null,
            bidQueueClearSeconds:sellShares>0?(insideRoom?0:b.bidQueueShares)*lookbackSeconds/sellShares:null};
        });
        const clearTimes=reachability.flatMap(x=>[x.askQueueClearSeconds,x.bidQueueClearSeconds]).filter((x):x is number=>x!=null);
        const fastest=clearTimes.length?Math.min(...clearTimes):lookbackSeconds*100;
        const item={conditionId:condition,title:m.question,slug:m.slug,event:String(m.events?.[0]?.slug??condition),family:marketFamily(m.question,m.slug),eventAt,eventBufferMs,lifecycle:Number.isFinite(start)?'game-start':'market-close',negativeRisk:false,protocol:'v1',fee,tick,minShares,
          discovery:{volume24hUsd:Number(m.volume24hr)||0,depth,flow,reachability,score:Math.log1p(notional)*Math.min(...depth.map(b=>b.spread/tick))/(1+fastest/10),
            reachabilityAssumption:'Bounded observed taker flow / 900-second window; price improvement requires room inside the spread and still must pass runtime quote risk gates. Not a fill forecast.'}};
        evaluated.push(item);
        if(recent.length<minRecentPrints||notional<minRecentNotionalUsd){reject('insufficient_recent_flow');return;}
        qualified.push(item);
      }catch(error){reject('public_read_or_validation_failure');evaluated.push({conditionId:condition,error:String(error)});}
    }));
  }
  const selected:any[]=[],events=new Set<string>(),families=new Map<string,number>();
  for(const m of qualified.sort((a,b)=>b.discovery.score-a.discovery.score||a.conditionId.localeCompare(b.conditionId))){
    if(events.has(m.event)||(families.get(m.family)??0)>=3){reject('diversification');continue;}
    selected.push(m);events.add(m.event);families.set(m.family,(families.get(m.family)??0)+1);if(selected.length>=limit)break;
  }
  return{schemaVersion:1,policy:'deep-flow-v1',discoveredAt:now,selected,qualified:qualified.length,evaluated,skipped,
    criteria:{candidateLimit,liveTapeRows:500,extraLiveConditions:40,limit,minDepthUsd,minRecentPrints,minRecentNotionalUsd,lookbackSeconds},
    coverage:'Bounded Gamma volume-ranked candidates plus recent global tape conditions; actual CLOB near-touch depth; at most 100 public taker rows per condition in the stated window. No account/funded clients.'};
}
