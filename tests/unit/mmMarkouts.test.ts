import {describe,it,expect} from 'vitest';
import {MakerMarkouts} from '../../src/research/mm/markouts.js';

describe('report-only maker markouts',()=>{
  const fill={orderId:'o',token:'yes',side:'BUY' as const,price:.5,shares:5,at:1000};
  const book={bid:.52,ask:.54,bids:[{price:.52,size:100}],asks:[{price:.54,size:100}],fresh:true,fee:{rate:.05,exponent:1},minShares:5};
  it('waits for the named horizon and subtracts executable unwind fees',()=>{
    const rows:any[]=[];const m=new MakerMarkouts(d=>rows.push(d),[1000]);m.fill(fill);
    m.observe('yes',1999,book);expect(rows).toHaveLength(0);m.observe('yes',2000,book);
    expect(rows[0].midUsd).toBeCloseTo(.15);expect(rows[0].executableUsd).toBeCloseTo(.0376);
    expect(m.summary()[0].complete).toBe(1);
  });
  it('keeps missing and late marks unavailable instead of imputing favorable returns',()=>{
    const m=new MakerMarkouts(()=>{},[1000]);m.fill(fill);m.observe('yes',5000,book);
    expect(m.summary()[0]).toMatchObject({complete:0,missing:1,meanMidUsd:null,meanExecutableUsd:null});
  });
  it('marks a sold token against future repurchase cost and records adverse selection',()=>{
    const m=new MakerMarkouts(()=>{},[1000]);m.fill({...fill,side:'SELL'});m.observe('yes',2000,book);
    expect(m.summary()[0].meanMidUsd).toBeCloseTo(-.15);expect(m.summary()[0].meanExecutableUsd).toBeLessThan(-.2);
  });
  it('does not count an unfinished future horizon as a zero return',()=>{
    const m=new MakerMarkouts(()=>{},[30000]);m.fill(fill);m.finish(2000);
    expect(m.summary()[0].missing).toBe(1);expect(m.summary()[0].meanExecutableUsd).toBeNull();
  });
  it('does not value an executable unwind at a touch lacking sufficient shares',()=>{
    const m=new MakerMarkouts(()=>{},[1000]);m.fill(fill);m.observe('yes',2000,{...book,bids:[{price:.52,size:1}]});
    expect(m.summary()[0].meanExecutableUsd).toBeNull();expect(m.summary()[0].missing).toBe(1);
  });
  it('retains midpoint observations without calling partial-fill dust executable',()=>{
    const m=new MakerMarkouts(()=>{},[1000]);m.fill({...fill,shares:1.920636});m.observe('yes',2000,book);
    expect(m.summary()[0]).toMatchObject({complete:0,missing:1,midComplete:1,meanExecutableUsd:null});expect(m.summary()[0].meanMidUsd).not.toBeNull();
  });
});
