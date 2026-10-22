import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
describe('market-making research boundaries',()=>{
 it('keeps research modules and entrypoints away from funded account and order clients',()=>{
  const files=[...fs.readdirSync('src/research/mm').filter(f=>f.endsWith('.ts')).map(f=>path.join('src/research/mm',f)),'scripts/audit-public-mm.ts','scripts/observe-mm.ts','scripts/paper-mm.ts'];
  for(const file of files){const source=fs.readFileSync(file,'utf8');const imports=[...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(m=>m[1]);
   expect(imports.filter(i=>/polymarket\/|clob-client|dotenv|sqliteStore|liveAccount|orderCanary|\/ledger\//.test(i)),file).toEqual([]);
   expect(source,file).not.toMatch(/process\.env|\.postOrder\(|\.createAndPostOrder\(/);
  }
 });
});
