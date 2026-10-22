import {describe,it,expect} from 'vitest';
import {discoverDeepMmUniverse} from '../../src/research/mm/deepDiscovery.js';

const condition=`0x${'a'.repeat(64)}`;
function fixture(change:(x:any)=>void=()=>{}){
  const now=Date.now();
  const x:any={now,market:{conditionId:condition,question:'Will an event occur?',slug:'event',active:true,closed:false,acceptingOrders:true,negRisk:false,endDate:new Date(now+3600000).toISOString(),clobTokenIds:'["1","2"]',events:[{slug:'event'}]},
    metadata:{c:condition,ao:true,v:'v1',t:[{t:'1',o:'Yes'},{t:'2',o:'No'}],mts:.01,mos:5,fd:{r:.05,e:1}},
    books:['1','2'].map(id=>({market:condition,asset_id:id,neg_risk:false,tick_size:'.01',min_order_size:'5',timestamp:String(now-50),hash:'b'.repeat(40),bids:[{price:'.49',size:'2000'}],asks:[{price:'.51',size:'2000'}]})),
    trades:{data:[1,2,3].map(i=>({condition_id:condition,token_id:'1',side:'BUY',price:.5,size:100,timestamp:Math.floor(now/1000)-i,transaction_hash:`0x${String(i).padStart(64,'0')}`})),pagination:{has_more:false}},fee:{base_fee:0}};
  change(x);
  const read=async(url:string)=>{
    const u=new URL(url);
    if(u.hostname==='gamma-api.polymarket.com')return[x.market];
    if(u.pathname.includes('/clob-markets/'))return x.metadata;
    if(u.pathname==='/fee-rate')return x.fee;
    if(u.pathname==='/book')return x.books[u.searchParams.get('token_id')==='1'?0:1];
    if(u.hostname==='data-api.polymarket.com')return u.searchParams.has('condition_id')?x.trades:{data:[],pagination:{has_more:false}};
    throw Error(`Unexpected URL ${url}`);
  };
  return{x,read};
}
describe('deep live-book discovery',()=>{
  it('requires measured bid/ask depth and bounded recent flow, with an explicit close-time lifecycle',async()=>{
    const {x,read}=fixture();const r=await discoverDeepMmUniverse({now:x.now},read);
    expect(r.selected).toHaveLength(1);const m=r.selected[0];expect(m.lifecycle).toBe('market-close');
    expect(m.discovery.depth[0].nearBidUsd).toBe(980);expect(m.discovery.flow.notionalUsd).toBe(150);expect(m.discovery.flow.complete).toBe(true);
  });
  it.each(['thin','old-flow','wrong-market','negative-risk','ended','unknown-fee','protocol','minimum','book-identity'])('excludes %s candidates instead of substituting unknown economics',async(kind)=>{
    const {x,read}=fixture(x=>{
      if(kind==='thin')x.books[0].bids[0].size='5';
      if(kind==='old-flow')x.trades.data.forEach((t:any)=>t.timestamp-=3600);
      if(kind==='wrong-market')x.trades.data[0].condition_id=`0x${'c'.repeat(64)}`;
      if(kind==='negative-risk')x.market.negRisk=true;
      if(kind==='ended')x.market.endDate=new Date(x.now-1000).toISOString();
      if(kind==='unknown-fee'){delete x.metadata.fd;x.fee.base_fee=1000;}
      if(kind==='protocol')x.metadata.v='v2';
      if(kind==='minimum')x.metadata.mos=100;
      if(kind==='book-identity')x.books[0].asset_id='other';
    });
    const r=await discoverDeepMmUniverse({now:x.now},read);expect(r.selected).toHaveLength(0);
  });
  it('does not infer a zero taker fee just because metadata omits the curve',async()=>{
    const {x,read}=fixture(x=>{delete x.metadata.fd;});const r=await discoverDeepMmUniverse({now:x.now},read);expect(r.selected[0].fee).toEqual({rate:0,exponent:1});
    const bad=fixture(x=>{delete x.metadata.fd;delete x.fee.base_fee;});expect((await discoverDeepMmUniverse({now:bad.x.now},bad.read)).selected).toHaveLength(0);
  });
  it('keeps sports start guards separate from short crypto close guards',async()=>{
    const sports=fixture(x=>{x.market.gameStartTime=new Date(x.now+300000).toISOString();});
    expect((await discoverDeepMmUniverse({now:sports.x.now},sports.read)).selected).toHaveLength(0);
    const crypto=fixture(x=>{x.market.slug='btc-updown-5m-123';x.market.endDate=new Date(x.now+180000).toISOString();});
    const r=await discoverDeepMmUniverse({now:crypto.x.now},crypto.read);expect(r.selected[0].eventBufferMs).toBe(60000);
  });
  it('deduplicates public flow and does not promote duplicate rows to multiple trades',async()=>{
    const {x,read}=fixture(x=>{x.trades.data=[x.trades.data[0],x.trades.data[0],x.trades.data[0]];});
    const r=await discoverDeepMmUniverse({now:x.now},read);expect(r.selected).toHaveLength(0);expect(r.evaluated[0].discovery.flow.rows).toBe(1);
  });
});
