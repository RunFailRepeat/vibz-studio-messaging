// Test-only shared fixture. Captures actual production prepared statements
// without inspecting/replacing their SQL, then removes that capture's rows so
// the unchanged batch can be executed through the explicit composition seam.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SQLiteD1 } from '../../tests/sqlite-d1.mjs';
import { production } from '../../tests/load-studio.mjs';
import { SQLiteNativeStore } from './sqlite-store.mjs';
import { NativeLifecycle } from './lifecycle.mjs';
import { commitAuthoritativeMessage } from './authoritative-batch.mjs';

export async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'vibz-authoritative-')),path=join(dir,'source.sqlite');
  const db=new SQLiteD1();db.sqlite.close();db.sqlite=new DatabaseSync(path);
  for(const name of readdirSync(new URL('../../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())
    await db.exec(readFileSync(new URL('../../drizzle/'+name,import.meta.url),'utf8'));
  const f={db,path,now:1700000000000};
  db.sqlite.exec(`INSERT INTO members(id,name,email,user_id,role,agent_id) VALUES
    ('member1','One','one@example.invalid','user1','owner','run'),
    ('member2','Two','two@example.invalid','user2','member','other');
    INSERT INTO agents(id,name,owner_id,description) VALUES('run','Run','member1','synthetic'),('other','Other','member2','synthetic');
    INSERT INTO channels(id,name,description,created_at) VALUES('room','room','synthetic','2026-01-01'),('elsewhere','elsewhere','synthetic','2026-01-01');`);
  const key=Buffer.alloc(32,4);
  const seal=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]).toString('base64');};
  const open=value=>{const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();};
  f.connect=()=>{
    f.store=new SQLiteNativeStore({db:db.sqlite,seal,open,now:()=>f.now});
    db.sqlite.exec(readFileSync(new URL('./authoritative-schema.sql',import.meta.url),'utf8'));
    f.lifecycle=new NativeLifecycle({store:f.store,now:()=>f.now,verify:async()=>true});
    f.service=new production.StudioService(db,{now:()=>new Date(f.now)});
  };
  f.connect();
  f.reopen=()=>{db.sqlite.close();db.sqlite=new DatabaseSync(path);f.connect();};
  f.subscribe=(args={recipient_agent_id:'run'},userId='user1')=>f.lifecycle.subscribe({userId},{name:'mention.created',arguments:args,
    delivery:{mode:'webhook',url:'https://callback.example.com/events',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
  f.capture=async(input={},agent=false)=>{
    let statements;const original=db.batch.bind(db);
    db.batch=async batch=>{statements=batch;return original(batch);};
    let result;
    try {
      const member=await f.service.member({userId:'user1',email:'one@example.invalid',name:'One'});
      const data={channelId:'room',body:'@Run source',clientId:randomBytes(8).toString('hex'),...input};
      result=agent?await f.service.agentAction(await f.service.mcpAgent(member),{action:'message',channelId:data.channelId,body:data.body,requestId:data.clientId,parentId:data.parentId}):await f.service.postMessage(member,data);
    } finally {db.batch=original;}
    const messageId=result.message.id;
    db.sqlite.exec('BEGIN IMMEDIATE');
    try {
      db.sqlite.prepare('DELETE FROM activity WHERE id=? OR id LIKE ?').run('message:'+messageId,'mention:'+messageId+':%');
      db.sqlite.prepare('DELETE FROM mentions WHERE message_id=?').run(messageId);
      db.sqlite.prepare('DELETE FROM messages WHERE id=?').run(messageId);db.sqlite.exec('COMMIT');
    } catch(error){db.sqlite.exec('ROLLBACK');throw error;}
    return {statements,context:{messageId,nowMs:f.now},result};
  };
  f.commit=captured=>commitAuthoritativeMessage(db,captured.statements,captured.context,{localPrototype:true});
  f.jobs=()=>db.sqlite.prepare('SELECT * FROM native_outbox ORDER BY id').all();
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return f;
}

export function fakeTimers(f) {
  let sequence=0;const pending=new Map();
  return {pending,
    arm(at,callback){const id=++sequence;pending.set(id,{at,callback});return id;},
    cancel(id){pending.delete(id);},
    async fire(){const entry=[...pending.entries()].filter(([,v])=>v.at<=f.now).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!entry)return false;pending.delete(entry[0]);await entry[1].callback();return true;},
    next(){return Math.min(...[...pending.values()].map(v=>v.at));}
  };
}
