import {DepthState} from '../depthState.js';
import {publicJson} from './publicData.js';
import {verifiedBookConfirmation,type BookConfirmation} from './bookConfirmation.js';

/** Read-only end-of-run quote confirmation after trading sockets stop. */
export async function confirmClosingBook(target:{token:string;conditionId:string},state:DepthState,
 record:(type:string,data:any)=>void,confirmations:Map<string,BookConfirmation&{revision:number}>,maxAgeMs=1500,fetcher=fetch){
 const requestedAt=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Closing quote deadline')),maxAgeMs);
 let headers:{date:string|null;age:string|null;cacheStatus:string|null}|null=null;
 try{
  const raw=await publicJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(target.token)}`,e=>record('http',e),async(url,options)=>{
   const response=await fetcher(url,{...options,cache:'no-store',headers:{accept:'application/json','cache-control':'no-cache'}});
   headers={date:response.headers.get('date'),age:response.headers.get('age'),cacheStatus:response.headers.get('cf-cache-status')};return response;
  },controller.signal);
  const receivedAt=Date.now();
  if(String(raw.asset_id??'')!==target.token||String(raw.market??'')!==target.conditionId)throw Error('Closing snapshot identity mismatch');
  const proof={requestedAt,receivedAt,...headers!,hash:String(raw.hash??''),token:target.token,serverAt:Number(raw.timestamp),revision:state.snapshot(target.token,receivedAt).revision+1};
  if(!headers||!verifiedBookConfirmation(proof,target.token,maxAgeMs))throw Error('Closing snapshot lacks a timely uncached confirmation');
  const valid=(levels:any)=>Array.isArray(levels)&&levels.length>0&&levels.every(l=>Number.isFinite(Number(l.price))&&Number(l.price)>0&&Number(l.price)<1&&Number.isFinite(Number(l.size))&&Number(l.size)>0);
  if(!valid(raw.bids)||!valid(raw.asks)||Math.max(...raw.bids.map((l:any)=>Number(l.price)))>=Math.min(...raw.asks.map((l:any)=>Number(l.price))))throw Error('Closing snapshot has unusable depth');
  const before=state.snapshot(target.token,receivedAt);if(Number(raw.timestamp)<before.serverAt)throw Error('Closing snapshot is older than the last observed book');
  state.ingest({...raw,event_type:'book'},receivedAt);proof.revision=state.snapshot(target.token,receivedAt).revision;
  record('book-seeded',{token:target.token,conditionId:target.conditionId,receivedAt,serverAt:proof.serverAt,hash:proof.hash,revision:proof.revision});
  confirmations.set(target.token,proof);record('book-confirmed',proof);return{token:target.token,confirmed:true,error:null};
 }catch(error){const result={token:target.token,confirmed:false,error:String(error)};record('closing-book-unavailable',result);return result;}
 finally{clearTimeout(timer);}
}
