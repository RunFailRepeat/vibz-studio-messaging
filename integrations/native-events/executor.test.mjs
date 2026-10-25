import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,fakeTimers } from './authoritative-fixture.mjs';
import { LocalOutboxExecutor } from './executor.mjs';

function executor(f,timers,send=async input=>{assert.equal(await input.authorize(),true);return {status:204};},extra={}) {
  return new LocalOutboxExecutor({store:f.store,ownerId:'user1',send,now:()=>f.now,timers,localPrototype:true,...extra});
}
test('whole-process crash after actual authoritative commit before wake recovers SAME store on restart',async t=>{
  const f=await fixture(t);await f.subscribe();const source=await f.capture();
  await f.commit(source); // Crash boundary: no notify, no timer, no second DB.
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM activity').get().n,2);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM mentions').get().n,1);
  const id=f.jobs()[0].id;f.reopen();
  const timers=fakeTimers(f),e=executor(f,timers);t.after(()=>e.stop());e.start();
  assert.equal(timers.next(),f.now);await timers.fire();
  assert.equal(f.jobs().find(j=>j.id===id).state,'delivered');
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM activity').get().n,2);
  assert.equal(timers.pending.size,0); // idle: no recurring scan/poll
});
test('durable retry deadline survives whole-process restart and fires exactly when due',async t=>{
  const f=await fixture(t);await f.subscribe();await f.commit(await f.capture());
  let timers=fakeTimers(f),e=executor(f,timers,async()=>({status:503}));e.start();await timers.fire();
  const due=f.jobs()[0].due_at;assert.equal(due,f.now+60000);assert.equal(timers.next(),due);
  e.stop();f.reopen();timers=fakeTimers(f);e=executor(f,timers);t.after(()=>e.stop());e.start();
  f.now=due-1;assert.equal(await timers.fire(),false);
  f.now=due;await timers.fire();assert.equal(f.jobs()[0].state,'delivered');assert.equal(f.jobs()[0].attempt,2);
});
test('restart arms expired-lease recovery and stale worker cannot settle',async t=>{
  const f=await fixture(t);await f.subscribe();await f.commit(await f.capture());
  const id=f.jobs()[0].id,old=await f.store.claim(id,f.now,1000,'user1');
  f.reopen();const timers=fakeTimers(f),e=executor(f,timers);t.after(()=>e.stop());e.start();
  assert.equal(timers.next(),f.now+1000);f.now+=1000;await timers.fire();
  assert.equal(f.jobs()[0].state,'delivered');assert.equal(f.jobs()[0].attempt,2);
  assert.equal(await f.store.settle(id,old.leaseToken,{state:'terminal'}),false);
});
test('notify after local commit arms idle executor; stopped stale callback cannot send or rearm',async t=>{
  const f=await fixture(t);await f.subscribe();let sends=0;
  const timers=fakeTimers(f),e=executor(f,timers,async()=>{sends++;return {status:204};});t.after(()=>e.stop());
  e.start();assert.equal(timers.pending.size,0);
  await f.commit(await f.capture());e.notifyCommitted();assert.equal(timers.pending.size,1);
  const stale=[...timers.pending.values()][0].callback;e.stop();await stale();
  assert.equal(sends,0);assert.equal(timers.pending.size,0);assert.equal(f.jobs()[0].state,'pending');
});
test('stop/start while old send awaits does not strand newer pending work',async t=>{
  const f=await fixture(t);await f.subscribe();await f.commit(await f.capture());await f.commit(await f.capture());
  let release,sends=0;const ids=[],timers=fakeTimers(f);
  const e=executor(f,timers,async input=>{ids.push(input.id);sends++;if(sends===1)await new Promise(resolve=>{release=resolve;});return {status:204};});
  t.after(()=>e.stop());e.start();const old=timers.fire();
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  e.stop();e.start();assert.equal(timers.pending.size,0);release();await old;
  assert.equal(timers.pending.size,1);await timers.fire();
  assert.equal(sends,2);assert.equal(f.jobs().filter(j=>j.state==='leased').length,1);
  f.now+=30000;await timers.fire();assert.equal(sends,3);assert.equal(ids[2],ids[0]);
  assert.ok(f.jobs().every(j=>j.state==='delivered'));
});
test('revoked owner stops executor instead of hot-looping a due row',async t=>{
  const f=await fixture(t);await f.subscribe();await f.commit(await f.capture());
  const errors=[],timers=fakeTimers(f),e=executor(f,timers,undefined,{onError:error=>errors.push(error)});
  t.after(()=>e.stop());e.start();f.db.sqlite.prepare('UPDATE members SET user_id=NULL WHERE id=?').run('member1');
  await timers.fire();assert.equal(errors.length,1);assert.equal(e.active,false);assert.equal(timers.pending.size,0);
  assert.equal(f.jobs()[0].state,'pending');
});
test('local stop after claim does not misclassify cancellation as revoked authorization',async t=>{
  const f=await fixture(t);await f.subscribe();await f.commit(await f.capture());let sends=0;
  const timers=fakeTimers(f),e=executor(f,timers,async()=>{sends++;return {status:204};});t.after(()=>e.stop());
  e.start();const running=timers.fire();e.stop();await running;
  assert.equal(sends,0);assert.equal(f.jobs()[0].state,'leased');
  e.start();f.now+=30000;await timers.fire();assert.equal(sends,1);assert.equal(f.jobs()[0].state,'delivered');
});
test('lost Worker wake while external supervisor survives is explicitly NOT repaired by local timers',async t=>{
  const f=await fixture(t);await f.subscribe();const timers=fakeTimers(f),e=executor(f,timers);t.after(()=>e.stop());
  e.start();await f.commit(await f.capture()); // producer request dies; supervisor does NOT restart
  assert.equal(timers.pending.size,0);assert.equal(await timers.fire(),false);assert.equal(f.jobs()[0].state,'pending');
  assert.throws(()=>new LocalOutboxExecutor({store:f.store,ownerId:'user1',send:async()=>({status:204})}),
    {code:'unsupported_transactional_d1_wakeup'});
});
