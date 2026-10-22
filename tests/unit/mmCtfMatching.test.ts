import {describe,it,expect} from 'vitest';
import {allocateCtfPrint,CtfTapeBudget,economicKey,microshares,syntheticCross} from '../../src/research/mm/ctfMatching.js';
const tokens=['yes','no'];
const print=(token='yes',aggressor:'BUY'|'SELL'='BUY',price=.6,shares=10)=>({id:`0x${'a'.repeat(64)}:${token}:2000:${price}:${shares}:${aggressor}`,token,aggressor,price,shares,at:2000});
const order=(id:string,token:string,side:'BUY'|'SELL',price:number,queueAhead=0)=>({id,token,side,price,queueAhead,remaining:5,activateAt:1000,expiresAt:5000});
describe('conservative joint CTF matching boundary',()=>{
 it('maps equivalent prices and detects cross-outcome mint/merge self-crosses',()=>{
  expect(economicKey(tokens,'yes','BUY',.4)).toBe(economicKey(tokens,'no','SELL',.6));
  expect(syntheticCross(tokens,order('a','yes','BUY',.6),order('b','no','BUY',.4))).toBe(true);
  expect(syntheticCross(tokens,order('a','yes','SELL',.6),order('b','no','SELL',.4))).toBe(true);
  expect(syntheticCross(tokens,order('a','yes','BUY',.59),order('b','no','BUY',.4))).toBe(false);
 });
 it.each([
  ['yes','SELL',.6,'direct'],['no','BUY',.4,'mint'],
 ] as const)('routes a BUY yes print to %s %s', (token,side,price,route)=>{
  const r=allocateCtfPrint(tokens,[order('a',token,side,price)],print(),2000,10,'exact-price',true);
  expect(r.allocations[0]).toMatchObject({route,shares:5,token});expect(r.usedShares).toBe(5);
 });
 it('routes SELL yes through a complementary SELL no merge and requires both books healthy',()=>{
  const q=order('a','no','SELL',.4),p=print('yes','SELL',.6);
  expect(allocateCtfPrint(tokens,[q],p,2000,10,'exact-price',true).allocations[0]).toMatchObject({route:'merge',shares:5});
  expect(allocateCtfPrint(tokens,[q],p,2000,10,'exact-price',false).usedShares).toBe(0);
 });
 it('shares one print budget across prices and direct/complementary routes',()=>{
  const r=allocateCtfPrint(tokens,[order('later','no','BUY',.4),order('first','yes','SELL',.59,2)],print(),2000,8,'price-through',true);
  expect(r.allocations.map(q=>[q.orderId,q.shares,q.externalConsumedShares])).toEqual([['first',5,2],['later',1,0]]);
  expect(r.usedShares).toBe(8);expect(r.unusedShares).toBe(0);
  expect(allocateCtfPrint(tokens,[order('a','yes','SELL',.59)],print(),2000,8,'exact-price',true).usedShares).toBe(0);
 });
 it('rejects mirrored duplicate queues instead of counting both as independent liquidity',()=>{
  expect(()=>allocateCtfPrint(tokens,[order('a','yes','SELL',.6),order('b','no','BUY',.4)],print(),2000,10,'exact-price',true)).toThrow(/Overlapping economic/);
 });
 it('does not round a nearby native price into an exact-price execution',()=>{
  const p=print('yes','BUY',.6000004),q=order('a','no','BUY',.4);
  expect(allocateCtfPrint(tokens,[q],p,2000,10,'exact-price',true).usedShares).toBe(0);
  expect(allocateCtfPrint(tokens,[q],p,2000,10,'price-through',true).allocations[0].shares).toBe(5);
 });
 it('uses one transaction maximum across token views and preserves it after recovery',()=>{
  const b=new CtfTapeBudget(),a=print(),mirror=print('no','BUY',.4),larger=print('no','BUY',.4,15);
  expect(b.observe('m',a).availableShares).toBe(10);expect(b.observe('m',mirror).availableShares).toBe(0);
  expect(b.observe('m',larger).availableShares).toBe(5);
  const restored=new CtfTapeBudget();restored.restore([a.id,mirror.id,larger.id],new Map([['yes','m'],['no','m']]));
  expect(restored.observe('m',larger).availableShares).toBe(0);
  expect(restored.observe('different-condition',larger).availableShares).toBe(15);
 });
 it('rejects unidentified volume, future prints, activation/cancel races and unknown tokens',()=>{
  expect(()=>new CtfTapeBudget().observe('m',{...print(),id:'made-up'})).toThrow(/identified/);
  expect(()=>allocateCtfPrint(tokens,[],print(),1999,10,'exact-price',true)).toThrow(/policy/);
  expect(()=>allocateCtfPrint(tokens,[],{...print(),token:'wrong'},2000,10,'exact-price',true)).toThrow(/identity/);
  const q=order('a','yes','SELL',.6);
  for(const altered of [{...q,activateAt:2000},{...q,cancelAt:2000},{...q,expiresAt:2000}])expect(allocateCtfPrint(tokens,[altered],print(),2000,10,'exact-price',true).usedShares).toBe(0);
  expect(()=>allocateCtfPrint(tokens,[q],print(),2000,11,'exact-price',true)).toThrow(/Invented/);
 });
 it('allocates integer microshares without converting floating residue into executions',()=>{
  const p=print('yes','BUY',.6,46.02),q=order('a','yes','SELL',.6,46.01999999999998);
  const r=allocateCtfPrint(tokens,[q],p,2000,46.02,'exact-price',true);expect(r.allocations[0].shares).toBe(0);expect(r.allocations[0].remaining).toBe(5);
  expect(microshares(1e-14,'down')).toBe(0);expect(microshares(.000001,'down')).toBe(1);
  expect(microshares(.0000015,'up')).toBe(2);expect(microshares(.0000015,'down')).toBe(1);
  expect(()=>microshares(Number.MAX_SAFE_INTEGER,'down')).toThrow(/range/);
 });
});
