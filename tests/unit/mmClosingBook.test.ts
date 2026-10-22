import {describe,it,expect} from 'vitest';
import {DepthState} from '../../src/research/depthState.js';
import {confirmClosingBook} from '../../src/research/mm/closingBook.js';
import {confirmedBookFresh} from '../../src/research/mm/bookConfirmation.js';

describe('explicit closing quote confirmation',()=>{
 it('confirms a quiet book without rewriting its exchange clock',async()=>{
  const state=new DepthState(),proofs=new Map(),events:any[]=[],timestamp=Date.now()-30000;
  const raw={asset_id:'yes',market:'condition',timestamp:String(timestamp),hash:'a'.repeat(40),bids:[{price:'.48',size:'100'}],asks:[{price:'.52',size:'100'}]};
  const read=async()=>new Response(JSON.stringify(raw),{headers:{date:new Date().toUTCString(),'cf-cache-status':'DYNAMIC'}});
  const result=await confirmClosingBook({token:'yes',conditionId:'condition'},state,(type,data)=>events.push({type,data}),proofs,1500,read as typeof fetch);
  expect(result.confirmed).toBe(true);const book=state.snapshot('yes',Date.now());expect(book.serverAt).toBe(timestamp);expect(confirmedBookFresh(book,Date.now(),proofs.get('yes'))).toBe(true);
  expect(events.map(e=>e.type)).toEqual(['http','book-seeded','book-confirmed']);
 });
 it.each(['identity','cache','crossed'])('rejects %s without refreshing the book',async kind=>{
  const state=new DepthState(),proofs=new Map();const raw={asset_id:kind==='identity'?'wrong':'yes',market:'condition',timestamp:String(Date.now()),hash:'a'.repeat(40),bids:[{price:'.48',size:'100'}],asks:[{price:kind==='crossed'?'.47':'.52',size:'100'}]};
  const read=async()=>new Response(JSON.stringify(raw),{headers:{date:new Date().toUTCString(),'cf-cache-status':kind==='cache'?'HIT':'DYNAMIC'}});
  const result=await confirmClosingBook({token:'yes',conditionId:'condition'},state,()=>{},proofs,1500,read as typeof fetch);
  expect(result.confirmed).toBe(false);expect(state.snapshot('yes',Date.now()).seeded).toBe(false);expect(proofs.size).toBe(0);
 });
});
