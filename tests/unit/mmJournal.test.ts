import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {PaperEvidenceJournal} from '../../src/research/mm/journal.js';

describe('paper evidence finalization and pressure',()=>{
  it('keeps every queued record through overload and closes a valid gzip stream',async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'mm-journal-'));
    try{
      const file=path.join(dir,'events.gz'),j=new PaperEvidenceJournal(file,1024);let pressure=false;
      for(let i=0;i<3000;i++)pressure=j.append('wire',{id:i,wire:'book'.repeat(100)},i).overBudget||pressure;
      j.append('paper-fill',{cashUsd:999},3000);j.append('final',{status:'failed'},3001);
      await j.finish();await j.finish();
      const rows=gunzipSync(readFileSync(file)).toString().trim().split('\n').map(x=>JSON.parse(x));
      expect(pressure).toBe(true);expect(rows).toHaveLength(3002);expect(rows.every((r,i)=>r.sequence===i+1)).toBe(true);
      expect(rows.at(-2).type).toBe('paper-fill');expect(rows.at(-1).type).toBe('final');expect(j.stats().compressionLevel).toBe(1);
      expect(()=>j.append('late',{},4000)).toThrow(/closed/);expect(()=>new PaperEvidenceJournal(file)).toThrow();
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('captures a burst larger than the old memory limit into independently complete gzip chunks',async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'mm-journal-burst-'));
    try{
      const file=path.join(dir,'events.gz'),j=new PaperEvidenceJournal(file,32*1024*1024,()=>{},{chunkBytes:1024*1024});
      const payload={wire:'0123456789'.repeat(400)};
      for(let i=0;i<10000;i++)expect(j.append('wire',payload,i).overBudget).toBe(false);
      j.append('final',{},10001);expect(j.rawBytes).toBeGreaterThan(32*1024*1024);expect(j.stats().peakBufferedBytes).toBeLessThan(70*1024);
      await j.finish();const rows=gunzipSync(readFileSync(file)).toString().trim().split('\n');expect(rows).toHaveLength(10001);
      expect(JSON.parse(rows.at(-1)!).sequence).toBe(10001);expect(j.stats().spoolBytes).toBe(0);expect(existsSync(file+'.parts')).toBe(false);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('retains an over-budget disk record and persists cash receipts before finish',async()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'mm-journal-disk-'));
    try{
      const file=path.join(dir,'events.gz'),j=new PaperEvidenceJournal(file,65536,()=>{},{maxSpoolBytes:100,chunkBytes:100000});
      const result=j.append('paper-fill',{cashUsd:999,print:'x'.repeat(100)},1000);
      expect(result.pressureReason).toBe('spool_bytes');expect(readFileSync(file+'.parts/00000000.jsonl','utf8')).toContain('paper-fill');
      await j.finish();expect(gunzipSync(readFileSync(file)).toString()).toContain('paper-fill');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
