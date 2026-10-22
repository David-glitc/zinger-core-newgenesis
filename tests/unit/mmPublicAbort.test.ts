import {describe,it,expect,vi} from 'vitest';
import {publicJson} from '../../src/research/mm/publicData.js';

describe('public-read shutdown',()=>{
 it('aborts retry backoff immediately instead of holding final valuation behind network cleanup',async()=>{
  const controller=new AbortController(),read=vi.fn(async()=>new Response('',{status:503,headers:{'retry-after':'20'}}));
  const pending=publicJson('https://clob.polymarket.com/book',()=>{},read as typeof fetch,controller.signal);
  await new Promise(resolve=>setTimeout(resolve,10));controller.abort(new Error('shutdown'));
  await expect(pending).rejects.toThrow('shutdown');expect(read).toHaveBeenCalledTimes(1);
 });
 it('does not begin a request after shutdown',async()=>{
  const controller=new AbortController();controller.abort(new Error('already stopped'));const read=vi.fn();
  await expect(publicJson('https://clob.polymarket.com/book',()=>{},read,controller.signal)).rejects.toThrow('already stopped');expect(read).not.toHaveBeenCalled();
 });
});
