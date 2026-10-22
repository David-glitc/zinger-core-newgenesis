/** Explicit conservative public-tape model, never an exchange fill assertion. */
export const CTF_MATCHING_MODEL='ctf-max-transaction-volume-v1' as const;
export type CtfMatchingModel='direct'|typeof CTF_MATCHING_MODEL;
type Side='BUY'|'SELL';
type Print={id:string;token:string;aggressor:Side;price:number;shares:number;at:number};
export interface CtfMatchingOrder {id:string;token:string;side:Side;price:number;remaining:number;queueAhead:number;activateAt:number;expiresAt:number;cancelAt?:number}
const SCALE=1e6;
/** Round away from inventing liquidity; snap only binary floating-point noise. */
export function microshares(value:number,round:'up'|'down'){
 if(!Number.isFinite(value)||value<0)throw Error('Invalid CTF share quantity');
 const scaled=value*SCALE,nearest=Math.round(scaled);
 const units=Math.abs(scaled-nearest)<1e-4?nearest:round==='up'?Math.ceil(scaled):Math.floor(scaled);
 if(!Number.isSafeInteger(units))throw Error('CTF quantity exceeds exact integer range');
 return units;
}
export function economicQuote(tokens:readonly string[],token:string,side:Side,price:number){
 if(tokens.length!==2||tokens[0]===tokens[1]||!tokens.includes(token)||!['BUY','SELL'].includes(side)||!Number.isFinite(price)||price<=0||price>=1)throw Error('Invalid CTF quote identity');
 const inverse=token===tokens[1];
 return{side:inverse?(side==='BUY'?'SELL':'BUY'):side,price:inverse?1-price:price,priceUnits:Math.round((inverse?1-price:price)*SCALE)};
}
export function economicKey(tokens:readonly string[],token:string,side:Side,price:number){const q=economicQuote(tokens,token,side,price);return`${q.side}:${q.priceUnits}`;}
export function syntheticCross(tokens:readonly string[],a:{token:string;side:Side;price:number},b:{token:string;side:Side;price:number}){
 const x=economicQuote(tokens,a.token,a.side,a.price),y=economicQuote(tokens,b.token,b.side,b.price);
 return x.side!==y.side&&(x.side==='BUY'?x.priceUnits>=y.priceUnits:y.priceUnits>=x.priceUnits);
}
export function nativeTransaction(p:Print){
 const tx=p.id.split(':')[0];
 if(!/^0x[0-9a-f]{64}$/i.test(tx)||p.id!==`${tx}:${p.token}:${p.at}:${p.price}:${p.shares}:${p.aggressor}`)throw Error('CTF matching requires an identified native print');
 return tx.toLowerCase();
}
/** Max, not sum: token views/batched rows never grant the same volume twice. */
export class CtfTapeBudget {
 private maxima=new Map<string,number>();
 observe(condition:string,p:Print){
  if(!condition)throw Error('Missing CTF condition');
  const key=`${condition}:${nativeTransaction(p)}`,observed=microshares(p.shares,'down'),previous=this.maxima.get(key)??0;
  this.maxima.set(key,Math.max(previous,observed));
  return{key,previousShares:previous/SCALE,observedShares:observed/SCALE,availableShares:Math.max(0,observed-previous)/SCALE};
 }
 restore(seen:string[],conditionForToken:Map<string,string>){
  if(this.maxima.size)throw Error('Tape budget recovery requires a pristine budget');
  for(const id of seen){const parts=id.split(':');if(parts.length!==6)continue;
   const[tx,token,at,price,shares,aggressor]=parts,condition=conditionForToken.get(token);if(!condition||!/^0x[0-9a-f]{64}$/i.test(tx))continue;
   this.observe(condition,{id,token,at:Number(at),price:Number(price),shares:Number(shares),aggressor:aggressor as Side});
  }
 }
}

/** One resting representative per economic side/price is a required policy. */
export function allocateCtfPrint(tokens:readonly string[],orders:CtfMatchingOrder[],p:Print,receivedAt:number,availableShares:number,fillRule:'exact-price'|'price-through',complementHealthy:boolean){
 const tape=economicQuote(tokens,p.token,p.aggressor,p.price),keys=new Set<string>();
 if(!['exact-price','price-through'].includes(fillRule)||![receivedAt,p.at].every(Number.isFinite)||p.at>receivedAt)throw Error('Invalid CTF print policy');
 let budget=microshares(availableShares,'down');if(budget>microshares(p.shares,'down'))throw Error('Invented CTF print volume');
 const initial=budget;
 const candidates=orders.map(order=>{
  const axis=economicQuote(tokens,order.token,order.side,order.price),key=`${axis.side}:${axis.priceUnits}`;
  if(keys.has(key))throw Error('Overlapping economic CTF quotes');keys.add(key);
  return{order,axis};
 }).filter(({order,axis})=>{
  if(axis.side===tape.side||!(order.activateAt<p.at&&order.activateAt<=receivedAt&&receivedAt<Math.min(order.expiresAt,order.cancelAt??Infinity)))return false;
  if(order.token!==p.token&&!complementHealthy)return false;
  const exact=Math.abs(axis.price-tape.price)<=1e-9,through=fillRule==='price-through'&&(axis.side==='BUY'?axis.price>tape.price:axis.price<tape.price);
  return exact||through;
 }).sort((a,b)=>(a.axis.side==='BUY'?b.axis.priceUnits-a.axis.priceUnits:a.axis.priceUnits-b.axis.priceUnits)||a.order.activateAt-b.order.activateAt||a.order.id.localeCompare(b.order.id));
 const allocations=[];
 for(const{order}of candidates){
  if(!budget)break;const ahead=microshares(order.queueAhead,'up'),remaining=microshares(order.remaining,'down');
  const consumed=Math.min(ahead,budget);budget-=consumed;const filled=Math.min(remaining,budget);budget-=filled;
  allocations.push({orderId:order.id,token:order.token,side:order.side,price:order.price,
   route:order.token===p.token?'direct':order.side==='BUY'?'mint':'merge',shares:filled/SCALE,
   queueAhead:(ahead-consumed)/SCALE,remaining:(remaining-filled)/SCALE,externalConsumedShares:consumed/SCALE});
 }
 return{allocations,usedShares:(initial-budget)/SCALE,unusedShares:budget/SCALE};
}
