import {describe,it,expect} from 'vitest';
import {confirmedBookFresh,verifiedBookConfirmation} from '../../src/research/mm/bookConfirmation.js';
const now=100_000;
const proof={requestedAt:now-100,receivedAt:now,date:new Date(now).toUTCString(),age:null,cacheStatus:'DYNAMIC',hash:'a'.repeat(40),token:'yes',serverAt:now-60_000,revision:3};
const book={seeded:true,issue:null,bids:[{price:.4,size:10}],asks:[{price:.6,size:10}],bestBid:.4,bestAsk:.6,usable:false,receivedAt:now,serverAt:now-60_000,revision:3};
describe('verified MM book confirmations',()=>{
 it('distinguishes an old book-change timestamp from a recent verified snapshot',()=>{
  expect(verifiedBookConfirmation(proof,'yes')).toBe(true);expect(confirmedBookFresh(book,now,proof)).toBe(true);expect(book.serverAt).toBe(now-60_000);expect(confirmedBookFresh(book,now,undefined)).toBe(false);
 });
 it.each([{age:'1'},{cacheStatus:'HIT'},{date:new Date(now-10000).toUTCString()},{requestedAt:now-2000},{token:'other'},{hash:''},{serverAt:now+2000}])('rejects delayed, cached or mismatched confirmation %j',patch=>{
  expect(verifiedBookConfirmation({...proof,...patch},'yes')).toBe(false);
 });
 it('expires even if trade prints or heartbeats keep the connection active',()=>{
  expect(confirmedBookFresh(book,now+1501,proof)).toBe(false);expect(confirmedBookFresh({...book,receivedAt:now+2000},now+2000,proof)).toBe(false);
 });
 it('invalidates confirmation after a depth revision, reset or broken book',()=>{
  for(const patch of [{revision:4},{seeded:false},{issue:'out_of_order'},{bestBid:.7}])expect(confirmedBookFresh({...book,...patch},now,proof)).toBe(false);
 });
});
