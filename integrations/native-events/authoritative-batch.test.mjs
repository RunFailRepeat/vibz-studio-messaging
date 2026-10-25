import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './authoritative-fixture.mjs';
import { commitAuthoritativeMessage,prepareAuthoritativeBatch } from './authoritative-batch.mjs';

test('actual StudioService statements preserve message, mention and UI activity with same-batch outbox',async t=>{
  const f=await fixture(t);await f.subscribe();const captured=await f.capture();
  const combined=prepareAuthoritativeBatch(f.db,captured.statements,captured.context);
  captured.statements.forEach((statement,index)=>assert.equal(combined[index],statement));
  await f.commit(captured);
  const state=await f.service.state(await f.service.member({userId:'user1',email:'one@example.invalid'}));
  assert.equal(state.messages.length,1);assert.equal(state.messages[0].id,captured.context.messageId);
  assert.equal(state.messages[0].mentions.length,1);assert.equal(state.activity.length,2);
  const job=f.jobs()[0],event=JSON.parse(job.body);
  assert.equal(event.data.message_id,captured.context.messageId);assert.equal(event.data.thread_id,captured.context.messageId);
  assert.equal(event.data.recipient_agent_id,'run');assert.equal(job.owner_id,'user1');
  assert.match(event.eventId,/^[A-Za-z0-9_-]{1,200}$/);
  assert.equal(f.db.sqlite.prepare('SELECT generation FROM native_wake_intent').get().generation,1);
});
test('outbox or wake-intent failure rolls back ALL actual source and activity statements',async t=>{
  const f=await fixture(t);await f.subscribe();
  for(const table of ['native_outbox','native_wake_intent']) {
    const c=await f.capture();
    f.db.sqlite.exec(`CREATE TRIGGER injected BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
    await assert.rejects(f.commit(c));
    for(const name of ['messages','mentions','activity','native_source_events','native_outbox','native_wake_intent'])
      assert.equal(f.db.sqlite.prepare(`SELECT count(*) n FROM ${name}`).get().n,0,name);
    f.db.sqlite.exec('DROP TRIGGER injected');
  }
});
test('replayed same batch preserves event bytes and does not backfill later subscriptions',async t=>{
  const f=await fixture(t);await f.subscribe();const c=await f.capture();await f.commit(c);
  const original=f.jobs()[0];f.now+=1000;
  await f.subscribe({recipient_agent_id:'run',channel_id:'room'});
  await f.commit(c);
  assert.equal(f.jobs().length,1);assert.equal(f.jobs()[0].event_id,original.event_id);assert.equal(f.jobs()[0].body,original.body);
});
test('room/thread filters and owner derive from real mentions, not supplied routing',async t=>{
  const f=await fixture(t);const root=await f.capture({body:'root'});await f.commit(root);
  await f.subscribe({recipient_agent_id:'run',channel_id:'room',thread_id:root.context.messageId});
  await f.subscribe({recipient_agent_id:'other'},'user2');
  const reply=await f.capture({body:'@Run @Other',parentId:root.context.messageId});await f.commit(reply);
  assert.equal(f.jobs().length,2);
  for(const job of f.jobs())assert.equal(JSON.parse(job.body).data.thread_id,root.context.messageId);
  const nonmatching=await f.capture({body:'@Run',channelId:'elsewhere'});await f.commit(nonmatching);
  assert.equal(f.jobs().length,2);
});
test('real agent post preserves domain activity but produces no mention event loop',async t=>{
  const f=await fixture(t);await f.subscribe();const c=await f.capture({},true);await f.commit(c);
  assert.equal(f.jobs().length,0);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM activity').get().n,1);
});
test('production commit fails closed before mutation without transactional D1 wake support',async t=>{
  const f=await fixture(t),c=await f.capture();
  await assert.rejects(commitAuthoritativeMessage(f.db,c.statements,c.context),{code:'unsupported_transactional_d1_wakeup'});
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM messages').get().n,0);
});
