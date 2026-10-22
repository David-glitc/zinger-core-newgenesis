/** REST confirmation time and book-change time are different clocks. */
export interface BookConfirmation {
  requestedAt:number; receivedAt:number; date:string|null; age:string|null;
  cacheStatus:string|null; hash:string; token:string; serverAt:number;
}
export function verifiedBookConfirmation(x:BookConfirmation,token:string,maxAgeMs=1500) {
  const dated=Date.parse(x.date??''),age=x.age==null?0:Number(x.age);
  return x.token===token && /^[0-9a-f]{40,64}$/i.test(x.hash??'')
    && [x.requestedAt,x.receivedAt,x.serverAt,dated,age,maxAgeMs].every(Number.isFinite)
    && x.receivedAt>=x.requestedAt && x.receivedAt-x.requestedAt<=maxAgeMs
    && x.serverAt>0 && x.serverAt<=x.receivedAt+1000
    && Math.abs(x.receivedAt-dated)<=2000 && age===0
    && ['DYNAMIC','MISS','BYPASS','NONE'].includes((x.cacheStatus??'NONE').toUpperCase());
}
export function confirmedBookFresh(s:any,now:number,confirmation:(BookConfirmation&{revision:number})|undefined,maxAgeMs=1500) {
  const structural=s.seeded&&!s.issue&&s.bids.length>0&&s.asks.length>0&&s.bestBid<s.bestAsk;
  if(!structural||now-s.receivedAt<0||s.serverAt>now+1000)return false;
  if(s.usable&&now-s.receivedAt<=maxAgeMs&&now-s.serverAt<=maxAgeMs)return true;
  // Do not rewrite the exchange timestamp or renew a confirmation on a heartbeat/trade.
  return !!confirmation && verifiedBookConfirmation(confirmation,confirmation.token,maxAgeMs)
    && s.revision===confirmation.revision && s.serverAt===confirmation.serverAt
    && now-confirmation.receivedAt>=0 && now-confirmation.receivedAt<=maxAgeMs;
}
