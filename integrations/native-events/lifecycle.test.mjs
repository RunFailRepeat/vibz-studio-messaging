// Real temporary SQLite files + actual domain schema/parser; injected verifier,
// synthetic account identities/key only. No sockets, real callback or scheduler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SQLiteNativeStore } from './sqlite-store.mjs';
import { NativeLifecycle, EVENT_NAME } from './lifecycle.mjs';
import { deliverOne } from './outbox.mjs';
import { verifyCallback } from './transport.mjs';

const first={userId:'user1'}, second={userId:'user2'};
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
const request=(args={recipient_agent_id:'run'})=>({name:EVENT_NAME,arguments:args,
  delivery:{mode:'webhook',url:'https://callback.example.com/events',secret},cursor:null});
const unsubscribe=req=>({name:req.name,arguments:req.arguments,delivery:{mode:'webhook',url:req.delivery.url}});
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'vibz-lifecycle-')), path=join(dir,'store.sqlite');
  const key=Buffer.alloc(32,9); // Synthetic encryption fixture; no production keys.
  const seal=value=>{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
  };
  const open=value=>{
    const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString('utf8');
  };
  const f={now:1700000000000,verifications:0};
  f.db=new DatabaseSync(path);
  for(const name of readdirSync(new URL('../../drizzle/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())
    f.db.exec(readFileSync(new URL('../../drizzle/'+name,import.meta.url),'utf8'));
  f.db.exec(`INSERT INTO members(id,name,email,user_id,role,agent_id) VALUES
    ('member1','One','one@example.invalid','user1','owner','run'),
    ('member2','Two','two@example.invalid','user2','member','other');
    INSERT INTO agents(id,name,owner_id,description) VALUES('run','Run','member1','synthetic'),('other','Other','member2','synthetic');
    INSERT INTO channels(id,name,description,created_at) VALUES('room','room','synthetic','2026-01-01'),('elsewhere','elsewhere','synthetic','2026-01-01');`);
  f.connect=()=>{
    f.store=new SQLiteNativeStore({db:f.db,seal,open,now:()=>f.now});
    f.lifecycle=new NativeLifecycle({store:f.store,now:()=>f.now,verify:async(_sub,authorize)=>{f.verifications++;return authorize();}});
  };
  f.connect();
  f.reopen=()=>{f.db.close();f.db=new DatabaseSync(path);f.connect();};
  f.message=(body='@Run hello',extra={})=>f.store.commitMessage(first,{requestId:'request',channelId:'room',body,...extra});
  f.jobs=()=>f.db.prepare('SELECT * FROM native_outbox ORDER BY id').all();
  f.dispatch=id=>deliverOne({store:f.store,send:async()=>({status:204}),authorize:(...args)=>f.store.authorizeDelivery(...args),id,principal:first.userId,now:()=>f.now});
  t.after(()=>{f.db.close();rmSync(dir,{recursive:true,force:true});});
  return f;
}

test('discovery derives owner-scoped recipient catalog from authenticated identity',t=>{
  const f=fixture(t);
  assert.throws(()=>f.lifecycle.list(null),{code:-32001});
  assert.throws(()=>f.lifecycle.list({userId:'outsider'}),{code:-32003});
  assert.deepEqual(f.lifecycle.list(first).events[0].inputSchema.properties.recipient_agent_id.enum,['run']);
  assert.deepEqual(f.lifecycle.list(second).events[0].inputSchema.properties.recipient_agent_id.enum,['other']);
  assert.throws(()=>f.lifecycle.list(first,{cursor:'invented'}),{code:-32602});
});
test('subscribe verifies, stores encrypted secret, and refreshes stable identity across restart',async t=>{
  const f=fixture(t),req=request({recipient_agent_id:'run',channel_id:'room'});
  const a=await f.lifecycle.subscribe(first,req);
  f.message();const version=f.jobs()[0].subscription_version;
  f.reopen(); f.now+=1000;
  const b=await f.lifecycle.subscribe(first,request({channel_id:'room',recipient_agent_id:'run'}));
  assert.equal(a.id,b.id);assert.equal(f.verifications,1);
  assert.equal(f.store.metadata(a.id).version,version);
  assert.equal(f.db.prepare('SELECT count(*) n FROM native_subscriptions').get().n,1);
  assert.equal(f.store.metadata(a.id).sealed_secret.includes(secret),false);
  assert.equal((await f.store.subscription(first.userId,a.id)).secret,secret);
  assert.equal((await f.dispatch(f.jobs()[0].id)).state,'delivered');
});
test('TTL is bounded, null gets finite lifetime, and cache does not slide on refresh',async t=>{
  const f=fixture(t),req=request();
  const a=await f.lifecycle.subscribe(first,{...req,ttlMs:10});
  assert.equal(Date.parse(a.refreshBefore),f.now+10);
  await f.lifecycle.subscribe(first,{...req,ttlMs:null});
  f.now+=200000;await f.lifecycle.subscribe(first,req);assert.equal(f.verifications,1);
  f.now+=100001;await f.lifecycle.subscribe(first,req);assert.equal(f.verifications,2);
  assert.equal((await f.lifecycle.subscribe(first,{...req,ttlMs:1e9})).refreshBefore,new Date(f.now+86400000).toISOString());
  await assert.rejects(f.lifecycle.subscribe(first,{...req,ttlMs:0}),{code:-32602});
});
test('invalid filters, ownership, secrets, destinations and replay fail before verifier',async t=>{
  const f=fixture(t);
  for(const req of [request({recipient_agent_id:'other'}),request({recipient_agent_id:'run',ownerId:'spoof'}),
    request({recipient_agent_id:'run',thread_id:'missing'}),{...request(),cursor:'replay'},
    {...request(),delivery:{...request().delivery,secret:'bad'}},
    {...request(),delivery:{...request().delivery,url:'http://localhost'}}])
    await assert.rejects(f.lifecycle.subscribe(first,req));
  assert.equal(f.verifications,0);
});
test('failed verification stores no subscription and preserves categorized callback error',async t=>{
  const f=fixture(t);
  f.lifecycle.verify=async()=>{throw Object.assign(new Error('private transport detail'),{code:'timeout'});};
  await assert.rejects(f.lifecycle.subscribe(first,request()),e=>e.code===-32015&&e.data.reason==='timeout'&&!e.message.includes('private'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM native_subscriptions').get().n,0);
});
test('actual challenge verifier composition rejects wrong echo and activates exact echo',async t=>{
  const f=fixture(t);let correct=false;const sent=[];
  f.lifecycle.verify=(sub,authorize)=>verifyCallback(async input=>{
    assert.equal(await input.authorize(),true);sent.push(input);
    return {status:200,body:JSON.stringify({challenge:correct?JSON.parse(input.body).challenge:'wrong'})};
  },sub,authorize);
  await assert.rejects(f.lifecycle.subscribe(first,request()),{code:-32015});
  assert.equal(f.db.prepare('SELECT count(*) n FROM native_subscriptions').get().n,0);
  correct=true;const accepted=await f.lifecycle.subscribe(first,request());
  assert.equal(sent[1].subscriptionId,accepted.id);
  assert.equal(JSON.parse(sent[1].body).type,'verification');
  assert.notEqual(sent[0].id,sent[1].id);
});
test('unsubscribe fences an in-flight initial verification and is idempotent',async t=>{
  const f=fixture(t);let release;
  f.lifecycle.verify=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.lifecycle.subscribe(first,request());
  f.lifecycle.unsubscribe(first,unsubscribe(request()));release(true);
  await assert.rejects(pending,e=>e.data.reason==='subscription_changed');
  f.lifecycle.unsubscribe(first,unsubscribe(request()));
  assert.equal(f.db.prepare('SELECT count(*) n FROM native_subscriptions').get().n,0);
});
test('concurrent identical subscribe converges without overwriting newer expiration',async t=>{
  const f=fixture(t);const releases=[];
  f.lifecycle.verify=()=>new Promise(resolve=>releases.push(resolve));
  const old=f.lifecycle.subscribe(first,request());
  const newer=f.lifecycle.subscribe(first,{...request(),ttlMs:20});
  releases[1](true);const current=await newer;releases[0](true);
  assert.deepEqual(await old,current);
  assert.equal(f.store.metadata(current.id).expires_at,f.now+20);
});
test('simultaneous identical requests converge to one stable active subscription',async t=>{
  const f=fixture(t),releases=[];
  f.lifecycle.verify=()=>new Promise(resolve=>releases.push(resolve));
  const a=f.lifecycle.subscribe(first,request()),b=f.lifecycle.subscribe(first,request());
  releases[0](true);const firstResult=await a;releases[1](true);
  assert.deepEqual(await b,firstResult);
  assert.equal(f.db.prepare('SELECT count(*) n FROM native_subscriptions').get().n,1);
});
test('membership loss during verification cannot persist or discover',async t=>{
  const f=fixture(t);let release;
  f.lifecycle.verify=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.lifecycle.subscribe(first,request());
  f.db.prepare('UPDATE members SET user_id=NULL WHERE id=?').run('member1');release(true);
  await assert.rejects(pending,{code:-32003});
  assert.equal(f.db.prepare('SELECT count(*) n FROM native_subscriptions').get().n,0);
});
test('secret replacement fails closed until dual-sign rotation support exists',async t=>{
  const f=fixture(t),a=await f.lifecycle.subscribe(first,request());
  await assert.rejects(f.lifecycle.subscribe(first,{...request(),delivery:{...request().delivery,secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}}),
    e=>e.data.reason==='secret_rotation_requires_host_support');
  assert.equal((await f.store.subscription(first.userId,a.id)).secret,secret);
});
test('source parser and DB joins bind recipient, owner, channel, thread; same message retries dedupe',async t=>{
  const f=fixture(t),root=f.message('root',{requestId:'root'});
  await f.lifecycle.subscribe(first,request({recipient_agent_id:'run',channel_id:'room',thread_id:root.id}));
  await f.lifecycle.subscribe(second,request({recipient_agent_id:'other',channel_id:'room'}));
  const saved=f.message('@Run @Run @Other `@Run` https://example.invalid/@Other',{parentId:root.id});
  assert.equal(f.message('@Run @Run @Other `@Run` https://example.invalid/@Other',{parentId:root.id}).id,saved.id);
  const jobs=f.jobs();assert.equal(jobs.length,2);
  for(const row of jobs){const event=JSON.parse(row.body);assert.equal(event.data.thread_id,root.id);assert.equal(event.data.channel_id,'room');assert.equal(event.data.message_id,saved.id);}
  assert.equal(jobs.find(j=>JSON.parse(j.body).data.recipient_agent_id==='other').owner_id,'user2');
  assert.throws(()=>f.message('@Other changed',{parentId:root.id}),e=>e.data.reason==='request_conflict');
  assert.throws(()=>f.message('@Run',{requestId:'spoof',ownerId:'user2'}));
  assert.throws(()=>f.message('@Run',{requestId:'spoof',authorKind:'agent'}));
  assert.throws(()=>f.message('@Run',{requestId:'wrong-room',channelId:'elsewhere',parentId:root.id}));
  f.message('`@Run` https://example.invalid/@Run someone@Run',{requestId:'ignored'});
  assert.equal(f.jobs().length,2);
});
test('outbox insert failure rolls back message and mentions in the SAME SQLite transaction',async t=>{
  const f=fixture(t);await f.lifecycle.subscribe(first,request());
  f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON native_outbox BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>f.message());
  for(const table of ['messages','mentions','native_outbox'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});
test('subscription filters suppress unmatched rooms and unsubscribing cannot revoke another owner',async t=>{
  const f=fixture(t),req=request({recipient_agent_id:'run',channel_id:'room'});
  const a=await f.lifecycle.subscribe(first,req);
  f.message('@Run',{requestId:'other-room',channelId:'elsewhere'});assert.equal(f.jobs().length,0);
  assert.deepEqual(f.lifecycle.unsubscribe(second,unsubscribe(req)),{});
  assert.equal(f.store.metadata(a.id).revoked,0);
  f.message();const job=f.jobs()[0];await f.store.claim(job.id,f.now,1000,first.userId);
  f.lifecycle.unsubscribe(first,unsubscribe(req));assert.equal(f.jobs()[0].state,'terminal');
  assert.equal((await f.dispatch(job.id)).state,'unavailable');
});
test('owner may unsubscribe idempotently after source thread or agent ownership disappears',async t=>{
  const f=fixture(t),root=f.message('root',{requestId:'root'});
  const req=request({recipient_agent_id:'run',channel_id:'room',thread_id:root.id});
  const a=await f.lifecycle.subscribe(first,req);
  f.db.prepare('DELETE FROM messages WHERE id=?').run(root.id);
  f.db.prepare('UPDATE agents SET owner_id=? WHERE id=?').run('member2','run');
  assert.deepEqual(f.lifecycle.unsubscribe(first,unsubscribe(req)),{});
  assert.deepEqual(f.lifecycle.unsubscribe(first,unsubscribe(req)),{});
  assert.equal(f.store.metadata(a.id).revoked,1);
});
test('stale verification cannot overwrite a newer signing key or revive revoked state',async t=>{
  const f=fixture(t);const releases=[];
  f.lifecycle.verify=()=>new Promise(resolve=>releases.push(resolve));
  const old=f.lifecycle.subscribe(first,request());
  const replacement={...request(),delivery:{...request().delivery,secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}};
  const newer=f.lifecycle.subscribe(first,replacement);
  releases[1](true);const current=await newer;releases[0](true);
  await assert.rejects(old,e=>e.data.reason==='subscription_changed');
  assert.equal((await f.store.subscription(first.userId,current.id)).secret,replacement.delivery.secret);
});
test('agent-origin credentials cannot create human mentions through the isolated seam',async t=>{
  const f=fixture(t);await f.lifecycle.subscribe(first,request());
  assert.throws(()=>f.store.commitMessage({...first,kind:'agent'},
    {requestId:'loop',channelId:'room',body:'@Run'}),{code:-32003});
  assert.equal(f.db.prepare('SELECT count(*) n FROM messages').get().n,0);
  assert.equal(f.jobs().length,0);
});
test('durable lease claim scopes owner, excludes active lease, survives restart, fences stale settlement',async t=>{
  const f=fixture(t);await f.lifecycle.subscribe(first,request());f.message();const row=f.jobs()[0];
  assert.equal(await f.store.claim(row.id,f.now,1000,second.userId),null);
  const a=await f.store.claim(row.id,f.now,1000,first.userId);
  f.reopen();assert.equal(await f.store.claim(row.id,f.now,1000,first.userId),null);
  f.now+=1001;assert.equal(await f.store.settle(row.id,a.leaseToken,{state:'delivered'}),false);
  const b=await f.store.claim(row.id,f.now,1000,first.userId);
  assert.notEqual(a.leaseToken,b.leaseToken);assert.equal(b.attempt,2);assert.equal(a.body,b.body);
  assert.equal(await f.store.settle(row.id,a.leaseToken,{state:'delivered'}),false);
  assert.equal(await f.store.settle(row.id,b.leaseToken,{state:'delivered'}),true);
});
test('retry next-attempt time persists and drives claims after reopen without a pretend scheduler',async t=>{
  const f=fixture(t);await f.lifecycle.subscribe(first,request());f.message();const id=f.jobs()[0].id;
  const args={store:f.store,send:async()=>({status:503}),authorize:(...x)=>f.store.authorizeDelivery(...x),id,principal:first.userId,now:()=>f.now};
  const retry=await deliverOne(args);assert.equal(retry.state,'retry');assert.equal(retry.nextAttemptAt,f.now+60000);
  f.reopen();assert.equal(await f.store.claim(id,f.now,1000,first.userId),null);
  f.now+=60000;assert.equal((await f.dispatch(id)).state,'delivered');assert.equal(f.jobs()[0].attempt,2);
});
test('expiry and recipient ownership change prevent dispatch',async t=>{
  const f=fixture(t);await f.lifecycle.subscribe(first,{...request(),ttlMs:10});f.message();
  f.now+=10;assert.equal((await f.dispatch(f.jobs()[0].id)).state,'terminal');
  await f.lifecycle.subscribe(first,request());f.message('@Run',{requestId:'new'});
  const next=f.jobs().find(j=>j.state==='pending');
  f.db.prepare('UPDATE agents SET owner_id=? WHERE id=?').run('member2','run');
  assert.equal((await f.dispatch(next.id)).state,'terminal');
});
test('same-key refresh after expiry retains undelivered jobs but never revives terminal jobs',async t=>{
  const f=fixture(t);const sub=await f.lifecycle.subscribe(first,{...request(),ttlMs:10});f.message();
  const id=f.jobs()[0].id,version=f.store.metadata(sub.id).version;
  f.now+=20;await f.lifecycle.subscribe(first,request());
  assert.equal(f.store.metadata(sub.id).version,version);
  assert.equal((await f.dispatch(id)).state,'delivered');
  f.message('@Run',{requestId:'terminal'});const next=f.jobs().find(j=>j.state==='pending');
  f.now=f.store.metadata(sub.id).expires_at;
  assert.equal((await f.dispatch(next.id)).state,'terminal');
  await f.lifecycle.subscribe(first,request());
  assert.equal((await f.dispatch(next.id)).state,'unavailable');
});
test('attempt bound and mandatory protected-storage adapters fail closed',async t=>{
  const f=fixture(t);assert.throws(()=>new SQLiteNativeStore({db:f.db}));
  await f.lifecycle.subscribe(first,request());f.message();const id=f.jobs()[0].id;
  for(let i=1;i<=8;i++) { const job=await f.store.claim(id,f.now,1,first.userId);assert.equal(job.attempt,i);f.now+=2; }
  assert.equal(await f.store.claim(id,f.now,1,first.userId),null);assert.equal(f.jobs()[0].state,'terminal');
});
