import fs from 'node:fs';
import path from 'node:path';
import {discoverDeepMmUniverse} from '../src/research/mm/deepDiscovery.js';
import {publicJson} from '../src/research/mm/publicData.js';

const args=Object.fromEntries(process.argv.slice(2).map(a=>{const[k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')]}));
if(Object.keys(args).some(k=>!['out','candidates','markets','min-depth-usd','min-prints','min-flow-usd'].includes(k)))throw Error('Unsupported discovery argument');
const output=path.resolve(args.out??`tmp/commercial-evidence/deep-mm-universe-${Date.now()}.json`);
if(fs.existsSync(output))throw Error('Use a new discovery output path');
const calls:any[]=[];
const result=await discoverDeepMmUniverse({candidateLimit:Number(args.candidates??80),limit:Number(args.markets??8),minDepthUsd:Number(args['min-depth-usd']??250),minRecentPrints:Number(args['min-prints']??3),minRecentNotionalUsd:Number(args['min-flow-usd']??100)},url=>publicJson(url,x=>calls.push(x)));
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({...result,httpEvidence:calls},null,2));
console.log(JSON.stringify({output,selected:result.selected.map(m=>({title:m.title,lifecycle:m.lifecycle,flow:m.discovery.flow,depth:m.discovery.depth.map(d=>({bid:d.bid,ask:d.ask,nearBidUsd:d.nearBidUsd,nearAskUsd:d.nearAskUsd}))})),skipped:result.skipped},null,2));
if(!result.selected.length)process.exitCode=1;
