import {describe,it,expect} from 'vitest';
import {fullExitOrderSize} from '../../src/research/mm/orderSize.js';
describe('full position exit constraints',()=>{
 it('does not call below-minimum or unencodable inventory fully liquidatable',()=>{
  expect(fullExitOrderSize(3.079364,5)).toMatchObject({ok:false,reason:'below_minimum_order'});
  expect(fullExitOrderSize(5.079364,5)).toMatchObject({ok:false,reason:'unencodable_full_position_size'});
  expect(fullExitOrderSize(5,undefined).ok).toBe(false);
  expect(fullExitOrderSize(5.08,5).ok).toBe(true);expect(fullExitOrderSize(5.00000000001,5).ok).toBe(true);
 });
});
