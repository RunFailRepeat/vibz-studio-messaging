// Offline production-service journey; only synthetic users/tasks and in-memory SQLite.
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SQLiteD1} from '../tests/sqlite-d1.mjs';
import {production} from '../tests/load-studio.mjs';
const db=new SQLiteD1();
try {
  for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  const s=new production.StudioService(db,{now:()=>new Date('2026-10-25T18:00:00Z')});
  const principal={userId:'fake-owner',email:'member1@example.invalid',name:'Fake Owner'};
  // Seed only synthetic membership; do not use production's fixed personal roster.
  await db.exec(`INSERT INTO members(id,name,email,user_id,role,agent_id) VALUES('synthetic-owner','Fake Owner','member1@example.invalid','fake-owner','owner','run');
    INSERT INTO agents(id,name,owner_id,description) VALUES('run','Run','synthetic-owner','Synthetic agent');
    INSERT INTO channels(id,name,description,created_at) VALUES('all-vibz-studio','synthetic-room','Synthetic','2026-10-25T18:00:00Z');`);
  const member=await s.member(principal),agent=await s.mcpAgent(member);
  const act=d=>s.agentAction(agent,d);
  await s.createTask(member,{channelId:'all-vibz-studio',title:'Synthetic test',brief:'Canonical synthetic brief',acceptance:'Canonical synthetic acceptance',assigneeAgentId:'run',clientId:randomUUID()});
  const first=await act({action:'claim',requestId:randomUUID()});
  await act({action:'deliver',taskId:first.task.id,leaseId:first.leaseId,summary:'First synthetic candidate',evidence:[{label:'Synthetic original evidence',url:'https://example.invalid/candidate'}],requestId:randomUUID()});
  await s.updateTask(member,first.task.id,{action:'review',decision:'changes_requested',note:'REVISION_REQUIRED: change the heading to purple.'});
  const second=await act({action:'claim',requestId:randomUUID()});
  assert.equal(second.task.attempt,2);assert.match(second.task.reviewNote,/REVISION_REQUIRED/);
  await writeFile(process.argv[2],JSON.stringify({first,second},null,2));
} finally {db.close();}
