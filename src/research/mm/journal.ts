import fs from 'node:fs';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';

interface JournalOptions {chunkBytes?:number;maxSpoolBytes?:number;diskReserveBytes?:number}
/** Bounded-memory capture; compression works through disk-backed chunks. */
export class PaperEvidenceJournal {
  private complete:Promise<void>=Promise.resolve();
  private closed=false;
  private error:Error|null=null;
  private sequence=0;
  private buffers:string[]=[];
  private bufferedBytes=0;
  private spoolBytes=0;
  private partBytes=0;
  private partIndex=0;
  private partFd:number;
  private partsDirectory:string;
  private partPath:string;
  private chunkBytes:number;
  private maxSpoolBytes:number;
  private diskReserveBytes:number;
  private diskFreeBytes:number;
  rawBytes=0;peakBufferedBytes=0;peakSpoolBytes=0;
  constructor(private file:string,readonly maxBufferedBytes=32*1024*1024,private onError:(error:Error)=>void=()=>{},options:JournalOptions={}){
    this.chunkBytes=options.chunkBytes??8*1024*1024;this.maxSpoolBytes=options.maxSpoolBytes??1024*1024*1024;this.diskReserveBytes=options.diskReserveBytes??1024*1024*1024;
    if(![maxBufferedBytes,this.chunkBytes,this.maxSpoolBytes].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(this.diskReserveBytes)||this.diskReserveBytes<0)throw Error('Invalid evidence resource bound');
    fs.closeSync(fs.openSync(file,'wx',0o600));this.partsDirectory=file+'.parts';fs.mkdirSync(this.partsDirectory,{mode:0o700});
    this.partPath=this.nextPath();this.partFd=fs.openSync(this.partPath,'wx',0o600);this.diskFreeBytes=this.freeBytes();
  }
  private nextPath(){return `${this.partsDirectory}/${String(this.partIndex++).padStart(8,'0')}.jsonl`;}
  private freeBytes(){const s=fs.statfsSync(this.partsDirectory);return s.bavail*s.bsize;}
  private failed(error:unknown){if(!this.error){this.error=error instanceof Error?error:new Error(String(error));this.onError(this.error);}}
  private flush(){
    if(!this.bufferedBytes)return;
    const data=Buffer.from(this.buffers.join(''));let offset=0;
    while(offset<data.length){const written=fs.writeSync(this.partFd,data,offset,data.length-offset);if(written<=0)throw Error('Evidence spool write made no progress');offset+=written;}
    this.partBytes+=data.length;this.spoolBytes+=data.length;this.peakSpoolBytes=Math.max(this.peakSpoolBytes,this.spoolBytes);
    this.buffers=[];this.bufferedBytes=0;
  }
  private rotate(openNext:boolean){
    this.flush();fs.fsyncSync(this.partFd);fs.closeSync(this.partFd);
    const file=this.partPath,bytes=this.partBytes;this.partBytes=0;
    if(bytes){
      this.complete=this.complete.then(async()=>{
        await pipeline(fs.createReadStream(file),createGzip({level:1}),fs.createWriteStream(this.file,{flags:'a'}));
        const fd=fs.openSync(this.file,'a');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.unlinkSync(file);this.spoolBytes-=bytes;
      });
      void this.complete.catch(error=>this.failed(error));
    }else fs.unlinkSync(file);
    this.diskFreeBytes=this.freeBytes();
    if(openNext){this.partPath=this.nextPath();this.partFd=fs.openSync(this.partPath,'wx',0o600);}
  }
  append(type:string,data:unknown,at:number){
    if(this.closed)throw Error('Evidence journal is closed');if(this.error)throw this.error;
    const line=JSON.stringify({sequence:this.sequence+1,at,type,data})+'\n',bytes=Buffer.byteLength(line);
    this.sequence++;this.rawBytes+=bytes;this.buffers.push(line);this.bufferedBytes+=bytes;
    this.peakBufferedBytes=Math.max(this.peakBufferedBytes,this.bufferedBytes);
    const memoryPressure=this.bufferedBytes>this.maxBufferedBytes;
    try{
      const durable=/^paper-(fill|split|merge|settlement|order|cancel|cancel-request|merge-request|recovery|lease-renewal)$/.test(type);
      if(this.bufferedBytes>=Math.min(64*1024,this.maxBufferedBytes)||type==='final'||durable)this.flush();
      // Money and order intents sync all preceding public input records.
      if(durable)fs.fsyncSync(this.partFd);
      if(this.partBytes>=this.chunkBytes)this.rotate(true);
    }catch(error){this.failed(error);throw error;}
    const pressureReason=memoryPressure?'memory':this.spoolBytes>this.maxSpoolBytes?'spool_bytes':this.diskFreeBytes<this.diskReserveBytes?'disk_reserve':null;
    return{sequence:this.sequence,overBudget:pressureReason!==null,pressureReason};
  }
  stats(){return{records:this.sequence,rawBytes:this.rawBytes,compressedBytes:fs.statSync(this.file).size,bufferedBytes:this.bufferedBytes,peakBufferedBytes:this.peakBufferedBytes,spoolBytes:this.spoolBytes,peakSpoolBytes:this.peakSpoolBytes,maxSpoolBytes:this.maxSpoolBytes,compressionLevel:1,captureStorage:'disk-backed-chunks',failed:!!this.error};}
  async drain(){if(this.spoolBytes>Math.min(this.maxSpoolBytes/2,this.chunkBytes*2))await this.complete;if(this.error)throw this.error;}
  async finish(){if(!this.closed){this.closed=true;try{this.rotate(false);}catch(error){this.failed(error);throw error;}}await this.complete;if(this.error)throw this.error;if(fs.existsSync(this.partsDirectory))fs.rmdirSync(this.partsDirectory);}
}
