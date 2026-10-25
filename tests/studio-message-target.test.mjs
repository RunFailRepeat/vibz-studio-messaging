import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SQLiteD1 } from './sqlite-d1.mjs';
import { routes } from './load-message-target.mjs';
const owner = { userId: 'target-owner', email: 'member1@example.invalid', name: 'Member One' };
const outsider = { userId: 'target-outsider', email: 'outsider@example.invalid', name: 'Outsider' };
async function fixture(t) {
  const db = new SQLiteD1(); routes.env.DB = db;
  t.after(() => { delete routes.env.DB; db.close(); });
  const dir = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(name, dir), 'utf8'));
  let millis = Date.parse('2026-10-25T10:00:00Z');
  const service = new routes.StudioService(db, { now: () => new Date(millis++) });
  await service.bootstrap(owner); const member = await service.member(owner);
  return { db, service, member, post: async (body, parentId = null, channelId = 'all-vibz-studio') =>
    (await service.postMessage(member, { channelId, body, parentId, clientId: randomUUID() })).message };
}
async function get(target, principal = owner) {
  const headers = principal ? { 'oai-authenticated-user-id': principal.userId, 'oai-authenticated-user-email': principal.email } : {};
  const response = await routes.target.GET(new Request(`https://studio.example.invalid/api/message-target?${new URLSearchParams(target)}`, { headers }));
  return { status: response.status, headers: response.headers, value: await response.json() };
}
function businessState(f) {
  return Object.fromEntries(['tasks', 'agents', 'activity', 'mentions', 'messages'].map(table =>
    [table, f.db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
test('old root and exact late reply resolve outside snapshot without traversing reply history', async t => {
  const f = await fixture(t), root = await f.post('Ancient root');
  const replies = [];
  for (let i = 0; i < 205; i++) replies.push(await f.post(`Old reply ${i}`, root.id));
  for (let i = 0; i < 201; i++) await f.post(`New root ${i}`);
  const snapshot = await f.service.state(f.member);
  assert.ok(!snapshot.messages.some(m => m.id === root.id || m.id === replies[150].id));
  const search = await f.service.search('Old reply 150');
  assert.equal(search.messages[0].id, replies[150].id);
  assert.ok(!snapshot.messages.find(m => m.id === search.messages[0].parentId), 'Reproduces old UI missing-parent case');
  const before = businessState(f);
  const exact = await get({ messageId: replies[150].id, channelId: root.channelId, rootId: root.id });
  assert.equal(exact.status, 200); assert.equal(exact.value.message.id, replies[150].id); assert.equal(exact.value.root.id, root.id);
  assert.deepEqual(Object.keys(exact.value).sort(), ['message', 'root']);
  assert.equal(exact.headers.get('cache-control'), 'private, no-store');
  const rootResult = await get({ messageId: root.id });
  assert.equal(rootResult.value.root.id, rootResult.value.message.id);
  assert.equal(rootResult.value.root.replyCount, 205);
  const page = await f.service.listMessages({ channelId: root.channelId, parentId: root.id });
  assert.equal(page.messages.length, 100);
  const next = await f.service.listMessages({ channelId: root.channelId, parentId: root.id, after: page.nextCursor });
  assert.equal(next.messages.length, 100); assert.equal(new Set([...page.messages, ...next.messages].map(m => m.id)).size, 200);
  assert.deepEqual(businessState(f), before, 'Resolution must not mutate work, presence, messages, receipts, or activity');
});
test('missing and deleted targets or roots return explicit 404', async t => {
  const f = await fixture(t), root = await f.post('Root'), reply = await f.post('Reply', root.id);
  assert.equal((await get({ messageId: 'msg_missing' })).status, 404);
  f.db.sqlite.prepare('DELETE FROM messages WHERE id=?').run(reply.id);
  assert.equal((await get({ messageId: reply.id })).status, 404);
  const orphan = await f.post('Orphan fixture', root.id);
  f.db.sqlite.prepare('DELETE FROM messages WHERE id=?').run(root.id);
  assert.equal((await get({ messageId: root.id })).status, 404);
  assert.equal((await get({ messageId: orphan.id })).status, 404);
});
test('membership authentication precedes message lookup, including inaccessible target IDs', async t => {
  const f = await fixture(t), root = await f.post('Protected fixture');
  const before = businessState(f);
  for (const messageId of [root.id, 'msg_missing']) {
    assert.equal((await get({ messageId }, null)).status, 401);
    assert.equal((await get({ messageId }, outsider)).status, 403);
  }
  // A verified identity cannot take over another member's already-bound email.
  assert.equal((await get({ messageId: root.id }, { ...owner, userId: 'different-owner-id' })).status, 403);
  assert.deepEqual(businessState(f), before);
});
test('wrong room/root and malformed IDs never redirect to a different context', async t => {
  const f = await fixture(t), root = await f.post('Root'), other = await f.post('Other root'), reply = await f.post('Reply', root.id);
  assert.equal((await get({ messageId: reply.id, channelId: 'wrong-room' })).status, 404);
  assert.equal((await get({ messageId: reply.id, rootId: other.id })).status, 404);
  for (const target of [{}, { messageId: '' }, { messageId: 'x'.repeat(101) }, { messageId: '../bad' }, { messageId: root.id, rootId: '' }]) {
    assert.equal((await get(target)).status, 400);
  }
  f.db.sqlite.prepare('UPDATE messages SET parent_id=? WHERE id=?').run(other.id, root.id);
  assert.equal((await get({ messageId: reply.id })).status, 404, 'A claimed root with its own parent is invalid');
});
test('cross-room corrupted parent link is rejected and valid target includes mention receipts', async t => {
  const f = await fixture(t), root = await f.post('@Run source'), reply = await f.post('Reply', root.id);
  assert.equal((await get({ messageId: root.id })).value.message.mentions[0].status, 'pending');
  const { channel } = await f.service.createChannel(f.member, { name: 'other-fixture', description: '' });
  f.db.sqlite.prepare('UPDATE messages SET channel_id=? WHERE id=?').run(channel.id, reply.id);
  assert.equal((await get({ messageId: reply.id })).status, 404);
});
