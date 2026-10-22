/** Derive a stopped account's recovery snapshot without editing its evidence. */
import fs from 'node:fs';
import path from 'node:path';
import {recoverPaperSession} from '../src/research/mm/recovery.js';
const[directory,output]=process.argv.slice(2);
if(!directory||!output||process.argv.length!==4)throw Error('Pass STOPPED_CAPTURE_DIRECTORY NEW_RECOVERY_JSON');
const recovered=await recoverPaperSession(directory);
fs.writeFileSync(path.resolve(output),JSON.stringify(recovered,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output:path.resolve(output),cashUsd:recovered.inventory.cashUsd,holdings:recovered.inventory.holdings.filter(h=>h.shares>1e-9).length,records:recovered.evidence.records,gzipComplete:recovered.evidence.gzipComplete,dataGap:true,performanceClaimEligible:false,ordersSubmitted:0,actualSpendUsd:0}));
