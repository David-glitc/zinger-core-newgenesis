/** Isolated paper accounting. Quote touches never call fill(). No funded store dependencies. */
export interface PaperInventorySnapshot {
  schemaVersion:1;initialCashUsd:number;cashUsd:number;realizedPnlUsd:number;feesUsd:number;
  holdings:{token:string;shares:number;costUsd:number}[];pairs:[string,string,string][];appliedIds:string[];
}
export class MmPaperInventory {
  cashUsd: number;
  realizedPnlUsd=0;
  feesUsd=0;
  readonly holdings=new Map<string,{shares:number;costUsd:number}>();
  private applied=new Set<string>();
  private pairs=new Map<string,[string,string]>();
  private tokenMarkets=new Map<string,string>();
  constructor(readonly initialCashUsd:number){if(!Number.isFinite(initialCashUsd)||initialCashUsd<=0)throw Error('Invalid paper capital');this.cashUsd=initialCashUsd;}
  snapshot():PaperInventorySnapshot{return{schemaVersion:1,initialCashUsd:this.initialCashUsd,cashUsd:this.cashUsd,realizedPnlUsd:this.realizedPnlUsd,feesUsd:this.feesUsd,
    holdings:[...this.holdings].map(([token,h])=>({token,...h})),pairs:[...this.pairs].map(([condition,[yes,no]])=>[condition,yes,no]),appliedIds:[...this.applied]};}
  /** Restore once into a pristine ledger; validate everything before mutation. */
  restore(s:PaperInventorySnapshot){
    if(this.applied.size||this.holdings.size||this.cashUsd!==this.initialCashUsd)throw Error('Restore requires a pristine paper ledger');
    if(s.schemaVersion!==1||s.initialCashUsd!==this.initialCashUsd||![s.cashUsd,s.realizedPnlUsd,s.feesUsd].every(Number.isFinite)||s.cashUsd<0||s.feesUsd<0)throw Error('Invalid recovered paper capital');
    const candidate=new MmPaperInventory(s.initialCashUsd);
    for(const pair of s.pairs)candidate.registerMarket(...pair);
    if(candidate.pairs.size!==s.pairs.length)throw Error('Repeated recovered market identity');
    for(const h of s.holdings){
      if(!candidate.tokenMarkets.has(h.token)||candidate.holdings.has(h.token)||![h.shares,h.costUsd].every(Number.isFinite)||h.shares<0||h.costUsd<0||(h.shares<=1e-9&&h.costUsd>1e-7))throw Error('Invalid recovered inventory');
      candidate.holdings.set(h.token,{shares:h.shares,costUsd:h.costUsd});
    }
    if(s.appliedIds.some(id=>!id||typeof id!=='string')||new Set(s.appliedIds).size!==s.appliedIds.length)throw Error('Invalid recovered execution identities');
    const costs=s.holdings.reduce((sum,h)=>sum+h.costUsd,0);
    if(Math.abs(s.cashUsd+costs-s.initialCashUsd-s.realizedPnlUsd)>1e-7)throw Error('Recovered cash and inventory do not reconcile');
    this.cashUsd=s.cashUsd;this.realizedPnlUsd=s.realizedPnlUsd;this.feesUsd=s.feesUsd;this.pairs=candidate.pairs;this.tokenMarkets=candidate.tokenMarkets;
    for(const[token,h]of candidate.holdings)this.holdings.set(token,h);this.applied=new Set(s.appliedIds);
  }
  registerMarket(condition:string,yes:string,no:string){
    if(!condition||!yes||!no||yes===no)throw Error('Invalid binary market registration');
    const old=this.pairs.get(condition);
    if(old&&(old[0]!==yes||old[1]!==no))throw Error('Market tokens changed');
    if([yes,no].some(token=>this.tokenMarkets.has(token)&&this.tokenMarkets.get(token)!==condition))throw Error('Token belongs to another condition');
    this.pairs.set(condition,[yes,no]);this.tokenMarkets.set(yes,condition);this.tokenMarkets.set(no,condition);
  }
  /** Charged collateral conversion, never an exchange fill or free inventory. */
  split(id:string,condition:string,shares:number,feeUsd=0){
    const pair=this.pairs.get(condition);
    if(!id||!pair||![shares,feeUsd].every(Number.isFinite)||shares<=0||feeUsd<0)throw Error('Invalid paper split');
    if(this.applied.has(id))return false;
    if(shares+feeUsd>this.cashUsd+1e-9)throw Error('Paper split overdraft');
    this.cashUsd-=shares+feeUsd;
    for(const token of pair){const held=this.holdings.get(token)??{shares:0,costUsd:0};held.shares+=shares;held.costUsd+=(shares+feeUsd)/2;this.holdings.set(token,held);}
    this.feesUsd+=feeUsd;this.applied.add(id);return true;
  }
  fill(id:string,token:string,side:'BUY'|'SELL',shares:number,price:number,feeUsd:number){
    if(!id||!token||!['BUY','SELL'].includes(side)||![shares,price,feeUsd].every(Number.isFinite)||shares<=0||price<=0||price>=1||feeUsd<0)throw Error('Invalid paper fill');
    if(this.applied.has(id))return false;
    const held=this.holdings.get(token)??{shares:0,costUsd:0},premium=shares*price;
    if(side==='BUY'){
      if(premium+feeUsd>this.cashUsd+1e-9)throw Error('Paper overdraft');
      this.cashUsd-=premium+feeUsd;held.shares+=shares;held.costUsd+=premium+feeUsd;
    }else{
      if(shares>held.shares+1e-9||premium<feeUsd)throw Error('Paper oversell or fee overdraft');
      const cost=held.costUsd*shares/held.shares;held.shares=Math.max(0,held.shares-shares);held.costUsd=Math.max(0,held.costUsd-cost);
      this.cashUsd+=premium-feeUsd;this.realizedPnlUsd+=premium-feeUsd-cost;
    }
    this.feesUsd+=feeUsd;this.holdings.set(token,held);this.applied.add(id);return true;
  }
  merge(id:string,yes:string,no:string,shares:number,feeUsd=0){
    if(!id||yes===no||![shares,feeUsd].every(Number.isFinite)||shares<=0||feeUsd<0||feeUsd>shares)throw Error('Invalid paper merge');
    if(this.applied.has(id))return false;
    const condition=this.tokenMarkets.get(yes),pair=condition?this.pairs.get(condition):null;
    if(!pair||this.tokenMarkets.get(no)!==condition||!pair.includes(no))throw Error('Unregistered complete-set pair');
    const a=this.holdings.get(yes),b=this.holdings.get(no);
    if(!a||!b||a.shares<shares-1e-9||b.shares<shares-1e-9)throw Error('Unpaired paper inventory');
    const costA=a.costUsd*shares/a.shares,costB=b.costUsd*shares/b.shares;
    a.shares=Math.max(0,a.shares-shares);b.shares=Math.max(0,b.shares-shares);a.costUsd=Math.max(0,a.costUsd-costA);b.costUsd=Math.max(0,b.costUsd-costB);
    this.cashUsd+=shares-feeUsd;this.realizedPnlUsd+=shares-feeUsd-costA-costB;this.feesUsd+=feeUsd;this.applied.add(id);return true;
  }
  settle(id:string,condition:string,payouts:[number,number],feeUsd=0){
    const pair=this.pairs.get(condition);
    if(!id||!pair||payouts.length!==2||payouts.some(p=>!Number.isFinite(p)||p<0||p>1)||Math.abs(payouts[0]+payouts[1]-1)>1e-9||!Number.isFinite(feeUsd)||feeUsd<0)throw Error('Invalid paper resolution');
    if(this.applied.has(id))return false;
    const held=pair.map(token=>this.holdings.get(token)??{shares:0,costUsd:0});
    const proceeds=held.reduce((s,h,i)=>s+h.shares*payouts[i],0),cost=held.reduce((s,h)=>s+h.costUsd,0);
    if(feeUsd>proceeds)throw Error('Resolution fee exceeds proceeds');
    this.cashUsd+=proceeds-feeUsd;this.realizedPnlUsd+=proceeds-feeUsd-cost;this.feesUsd+=feeUsd;
    for(const token of pair)this.holdings.set(token,{shares:0,costUsd:0});this.applied.add(id);return true;
  }
  equity(marks:Map<string,number>){let equityUsd=this.cashUsd;for(const[token,h]of this.holdings){if(h.shares<=1e-9)continue;const p=marks.get(token);if(p==null||!Number.isFinite(p)||p<0||p>1)return null;equityUsd+=h.shares*p;}return equityUsd;}
}

/** Conservative queue model: only identified aggressor prints consume queue; cancellations do not. */
export class PaperQueue {
  static readonly MIN_FILL_SHARES=1e-6;
  private seen=new Set<string>();
  remaining:number;
  constructor(readonly side:'BUY'|'SELL',readonly price:number,shares:number,public queueAhead:number,readonly placedAt:number,readonly expiresAt:number,readonly fillRule:'exact-price'|'price-through'='exact-price'){
    if(!['BUY','SELL'].includes(side)||![price,shares,queueAhead,placedAt,expiresAt].every(Number.isFinite)||price<=0||price>=1||shares<=0||queueAhead<0||expiresAt<=placedAt)throw Error('Invalid paper queue');this.remaining=shares;
    if(!['exact-price','price-through'].includes(fillRule))throw Error('Invalid paper fill rule');
  }
  print(id:string,aggressor:'BUY'|'SELL',price:number,shares:number,at:number){
    if(!id||this.seen.has(id)||!['BUY','SELL'].includes(aggressor)||![price,shares,at].every(Number.isFinite)||price<=0||price>=1||shares<=0||at<=this.placedAt||at>=this.expiresAt||aggressor===this.side)return 0;
    // Exact-price volume avoids treating unknown routing at another price as our fill.
    const exact=Math.abs(price-this.price)<=1e-9;
    // A price-improved quote is absent from the observed book. A subsequent
    // identified opposing print through its limit is counterfactual evidence,
    // not an actual exchange fill. Retain the exact-price control explicitly.
    const through=this.fillRule==='price-through'&&(this.side==='BUY'?price<this.price:price>this.price);
    if(!exact&&!through)return 0;
    this.seen.add(id);const consumed=Math.min(this.queueAhead,shares);this.queueAhead-=consumed;
    const filled=Math.min(this.remaining,shares-consumed);
    // Native CTF amounts cannot represent sub-microshare executions. Binary
    // subtraction of equal displayed volumes can leave a positive epsilon;
    // it must not become a receipt or increment the fill counter.
    if(filled<PaperQueue.MIN_FILL_SHARES-1e-9)return 0;
    this.remaining-=filled;return filled;
  }
}
