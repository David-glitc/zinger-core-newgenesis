import {walkQuote,type QuoteFee,type QuoteLevel} from '../bookArbitrage.js';
import {fullExitOrderSize} from './orderSize.js';

interface Fill {orderId:string;token:string;side:'BUY'|'SELL';price:number;shares:number;at:number}
interface Pending {fill:Fill;horizonMs:number;due:number}
/** Reporting-only future observations; never fed back into the quote policy. */
export class MakerMarkouts {
  private pending:Pending[]=[];
  private totals=new Map<number,{complete:number;missing:number;midComplete:number;midUsd:number;executableUsd:number}>();
  constructor(readonly emit:(data:any)=>void=()=>{},readonly horizons=[1000,5000,30000]){
    if(!horizons.length||horizons.some(h=>!Number.isFinite(h)||h<=0))throw Error('Invalid markout horizons');
    for(const h of horizons)this.totals.set(h,{complete:0,missing:0,midComplete:0,midUsd:0,executableUsd:0});
  }
  fill(fill:Fill){for(const horizonMs of this.horizons)this.pending.push({fill:{...fill},horizonMs,due:fill.at+horizonMs});}
  observe(token:string,now:number,book:{bid:number;ask:number;bids:QuoteLevel[];asks:QuoteLevel[];fresh:boolean;fee:QuoteFee;minShares?:number}){
    const remain:Pending[]=[];
    for(const p of this.pending){
      if(p.fill.token!==token||now<p.due){remain.push(p);continue;}
      const valid=book.fresh&&Number.isFinite(book.bid)&&Number.isFinite(book.ask)&&book.bid>0&&book.ask<1&&book.bid<book.ask&&now-p.due<=2000;
      const quote=valid?walkQuote(p.fill.side==='BUY'?book.bids:book.asks,p.fill.shares,p.fill.side==='BUY'?'sell':'buy',book.fee):null;
      const size=fullExitOrderSize(p.fill.shares,book.minShares),good=valid&&quote?.complete&&size.ok;
      const f=p.fill,mid=(book.bid+book.ask)/2;
      const midUsd=valid?f.shares*(f.side==='BUY'?mid-f.price:f.price-mid):null;
      const executableUsd=good?(f.side==='BUY'?quote!.premiumUsd-f.shares*f.price:f.shares*f.price-quote!.premiumUsd)-quote!.feeUsd:null;
      const total=this.totals.get(p.horizonMs)!;
      if(valid){total.midComplete++;total.midUsd+=midUsd!;}
      if(good){total.complete++;total.executableUsd+=executableUsd!;}else total.missing++;
      this.emit({orderId:f.orderId,token,horizonMs:p.horizonMs,fillAt:f.at,observedAt:now,midUsd,executableUsd,missingReason:good?null:valid&&!size.ok?size.reason:'stale_invalid_late_or_incomplete_depth'});
    }
    this.pending=remain;
  }
  finish(now:number){for(const p of this.pending){this.totals.get(p.horizonMs)!.missing++;this.emit({orderId:p.fill.orderId,token:p.fill.token,horizonMs:p.horizonMs,fillAt:p.fill.at,observedAt:now,midUsd:null,executableUsd:null,missingReason:'capture_ended_or_no_later_book'});}this.pending=[];}
  summary(){return [...this.totals].map(([horizonMs,t])=>({horizonMs,complete:t.complete,missing:t.missing,midComplete:t.midComplete,meanMidUsd:t.midComplete?t.midUsd/t.midComplete:null,meanExecutableUsd:t.complete?t.executableUsd/t.complete:null}));}
}
