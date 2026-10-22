/** Finish an existing prospective paper capture. Never starts or funds trading. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const [captureArg]=process.argv.slice(2);if(!captureArg||process.argv.length!==3)throw Error('Pass one existing capture directory');
const capture=path.resolve(captureArg),planFile=path.join(capture,'experiment-plan.json');
const plan=JSON.parse(fs.readFileSync(planFile,'utf8')),statusFile=path.join(capture,'completion-status.json');
if(fs.existsSync(statusFile))throw Error('A completion worker already owns this experiment');
const state:any={status:'waiting_for_capture',pid:process.pid,startedAt:Date.now(),capture,actualSpendUsd:0};
fs.writeFileSync(statusFile,JSON.stringify(state,null,2),{flag:'wx'});
const save=()=>{state.updatedAt=Date.now();fs.writeFileSync(statusFile+'.next',JSON.stringify(state,null,2));fs.renameSync(statusFile+'.next',statusFile);};
async function check(name:string,command:string,args:string[]){
 const log=path.join(capture,`${name}.log`),fd=fs.openSync(log,'wx');
 const child=spawn(command,args,{stdio:['ignore',fd,fd]});fs.closeSync(fd);
 const result=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 (state.checks??=[]).push({name,exitCode:result});save();return result;
}
try{
 let report:any;
 const waitDeadline=Date.now()+(plan.durationSeconds+180)*1000;
 while(true){
  try{report=JSON.parse(fs.readFileSync(path.join(capture,'report.json'),'utf8'));}catch{}
  if(report&&['completed','interrupted','risk_stopped','failed'].includes(report.status))break;
  if(Date.now()>waitDeadline)throw Error('Capture did not finish within its bounded observation period');
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 state.captureStatus=report.status;
 if(report.status==='failed')throw Error('Failed capture retained; performance comparisons refused');
 state.status='auditing_capture';state.auditorSha256=createHash('sha256').update(fs.readFileSync('scripts/audit-mm-paper.py')).digest('hex');save();
 if(await check('final-independent-audit','python3',['scripts/audit-mm-paper.py',capture]))throw Error('Independent capture audit failed');
 state.status='comparing';save();
 const out=path.join(capture,'comparisons');
 if(await check('common-input-comparison',process.execPath,['--import','tsx','scripts/replay-mm-inputs.ts',capture,planFile,out]))throw Error('Common-input comparison failed');
 state.status='auditing_comparisons';save();
 for(const variant of plan.variants)await check(`audit-${variant.id}`,'python3',['scripts/audit-mm-paper.py',path.join(out,variant.id)]);
 state.status=state.checks.every((check:any)=>check.exitCode===0)?'completed':'audit_failed';
 state.comparison=JSON.parse(fs.readFileSync(path.join(out,'comparison.json'),'utf8'));
 state.performanceClaimEligible=false;state.finishedAt=Date.now();save();console.log(JSON.stringify(state,null,2));
}catch(error){state.status='failed';state.error=String(error);save();console.error(String(error));process.exitCode=1;}
