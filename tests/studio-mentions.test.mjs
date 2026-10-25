import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SQLiteD1 } from './sqlite-d1.mjs';
import { production, mentions } from './load-studio.mjs';

const { StudioService } = production;
const { findAgentMentions } = mentions;
const targets = [
  { id: 'run', name: 'Run' }, { id: 'portfolio', name: 'Portfolio' },
  { id: 'coldfire', name: 'ColdFire' }, { id: 'zingdot', name: 'ZingDot' },
];
const owner = { userId: 'verified-owner-platform-id', email: 'member1@example.invalid', name: 'Member One' };
const member2 = { userId: 'verified-member2-platform-id', email: 'member2@example.invalid', name: 'Member Two' };

async function fixture(t) {
  const db = new SQLiteD1();
  t.after(() => db.close());
  const directory = new URL('../drizzle/', import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  let now = new Date('2026-10-25T18:00:00.000Z');
  const studio = new StudioService(db, { now: () => new Date(now) });
  await studio.bootstrap(owner);
  await studio.bootstrap(member2);
  const member = await studio.member(owner);
  const otherMember = await studio.member(member2);
  const agent = await studio.mcpAgent(member);
  const otherAgent = await studio.mcpAgent(otherMember);
  return {
    db, studio, member, otherMember, agent, otherAgent,
    advance: () => { now = new Date(now.getTime() + 1); },
    state: () => studio.state(member),
  };
}

async function post(f, body, extra = {}) {
  return (await f.studio.postMessage(f.member, {
    channelId: 'all-vibz-studio', body, clientId: randomUUID(), ...extra,
  })).message;
}

async function inbox(f, agent = f.agent, extra = {}) {
  return (await f.studio.agentAction(agent, { action: 'mentions', ...extra })).mentions;
}

async function reply(f, mentionId, extra = {}, agent = f.agent) {
  return f.studio.agentAction(agent, {
    action: 'reply_mention', mentionId, body: 'I reviewed the question and supplied a concrete answer.',
    requestId: randomUUID(), ...extra,
  });
}

async function rejected(promise, status, code) {
  return assert.rejects(promise, error => {
    assert.equal(error.status, status, `Expected a deliberate domain rejection, received ${error?.stack ?? error}`);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test('mention parser resolves exact roster handles case-insensitively with usable source spans', () => {
  const text = '🙂 (@rUn), @PORTFOLIO! @ColdFire? @ZingDot. @Run';
  const found = findAgentMentions(text, targets);
  assert.deepEqual(found.map(item => item.agentId), ['run', 'portfolio', 'coldfire', 'zingdot', 'run']);
  assert.deepEqual(found.map(item => text.slice(item.start, item.end)), ['@rUn', '@PORTFOLIO', '@ColdFire', '@ZingDot', '@Run']);
  assert.deepEqual(found.map(item => item.agentName), ['Run', 'Portfolio', 'ColdFire', 'ZingDot', 'Run']);
});

test('mention parser excludes partial names, email/domain fragments, URLs, and unknown recipients', () => {
  const text = 'someone@Run.dev @Run.com me@Portfolio x@Run @@Run @Runner @Run_more @Run-away @ColdFire2 @everyone @Unknown https://example.org/@Run www.example.org/@Portfolio';
  assert.deepEqual(findAgentMentions(text, targets), []);
  assert.deepEqual(findAgentMentions('Review: @Run; then @Portfolio.', targets).map(item => item.agentId), ['run', 'portfolio']);
});

test('mention parser excludes inline code with different delimiter lengths and fenced code', () => {
  const text = [
    '`@Run` and ``@Portfolio``',
    '```js', '@ColdFire', '```',
    '~~~', '@ZingDot', '~~~',
    'Outside code: @Run.',
  ].join('\n');
  assert.deepEqual(findAgentMentions(text, targets).map(item => item.agentId), ['run']);
});

test('human message retries enqueue one durable inbox item per mentioned agent, including concurrent retries', async t => {
  const f = await fixture(t);
  const clientId = randomUUID();
  const body = '@Run please inspect this. @Run, return the evidence here.';
  const [a, b] = await Promise.all([post(f, body, { clientId }), post(f, body, { clientId })]);
  assert.equal(a.id, b.id);
  assert.equal(a.mentions.length, 1);
  assert.equal(a.mentions[0].id, b.mentions[0].id);
  assert.equal(a.mentions[0].status, 'pending');
  const queued = await inbox(f);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].message.id, a.id);
  assert.equal(queued[0].rootMessage.id, a.id);
  assert.equal((await f.state()).messages.length, 1);
  await rejected(post(f, '@Portfolio different content.', { clientId }), 409);
  assert.equal((await inbox(f, f.otherAgent)).length, 0);
});

test('message and mention enqueue roll back together when the durable inbox write fails', async t => {
  const f = await fixture(t);
  const baseline = await f.state();
  const clientId = randomUUID();
  await f.db.exec("CREATE TRIGGER reject_test_mention BEFORE INSERT ON mentions BEGIN SELECT RAISE(ABORT, 'injected inbox storage failure'); END");
  await assert.rejects(post(f, '@Run the whole operation must be atomic.', { clientId }), /injected inbox storage failure/);
  const after = await f.state();
  assert.equal(after.messages.length, baseline.messages.length);
  assert.equal(after.activity.length, baseline.activity.length);
  assert.equal((await inbox(f)).length, 0);
  await f.db.exec('DROP TRIGGER reject_test_mention');
  await post(f, '@Run the whole operation must be atomic.', { clientId });
  assert.equal((await inbox(f)).length, 1);
});

test('inboxes are scoped, ordered, bounded and read-only; client recipient fields cannot add targets', async t => {
  const f = await fixture(t);
  const first = await post(f, '@Run and @Portfolio, inspect this together. `@ZingDot`', {
    mentions: [{ agentId: 'coldfire' }], agentId: 'zingdot', recipientIds: ['zingdot'],
  });
  assert.deepEqual(first.mentions.map(item => item.agentId).sort(), ['portfolio', 'run']);
  f.advance();
  const second = await post(f, '@Run a later question.');
  const beforeRead = await f.state();
  const runItems = await inbox(f, f.agent, { agentId: 'portfolio' });
  assert.deepEqual(runItems.map(item => item.message.id), [first.id, second.id]);
  const portfolioItems = await inbox(f, f.otherAgent);
  assert.deepEqual(portfolioItems.map(item => item.message.id), [first.id]);
  assert.ok(portfolioItems.every(item => item.agentId === 'portfolio'));
  assert.deepEqual((await inbox(f, f.agent, { limit: 1 })).map(item => item.message.id), [first.id]);
  await rejected(inbox(f, f.agent, { limit: 0 }), 400);
  await rejected(inbox(f, f.agent, { limit: 21 }), 400);
  const afterRead = await f.state();
  assert.equal(afterRead.activity.length, beforeRead.activity.length);
  assert.equal(afterRead.agents.find(item => item.id === 'run').status, 'not_connected');
  assert.equal(afterRead.agents.find(item => item.id === 'run').lastSeenAt, null);
  assert.equal(afterRead.agents.find(item => item.id === 'run').pendingMentions, 2);
  assert.equal(afterRead.agents.find(item => item.id === 'portfolio').pendingMentions, 1);
  assert.equal(afterRead.agents.find(item => item.id === 'coldfire').pendingMentions, 0);
  assert.equal(afterRead.agents.find(item => item.id === 'zingdot').pendingMentions, 0);
});

test('ordinary agent messages and mention replies never create automatic agent-message loops', async t => {
  const f = await fixture(t);
  await f.studio.agentAction(f.agent, {
    action: 'message', channelId: 'all-vibz-studio', body: '@Portfolio and @Run, an agent-authored message.', requestId: randomUUID(),
  });
  assert.equal((await inbox(f)).length, 0);
  assert.equal((await inbox(f, f.otherAgent)).length, 0);
  await post(f, '@Run a human request.');
  const [pending] = await inbox(f);
  await reply(f, pending.id, { body: '@Portfolio appears in this answer; do not create a tag loop.' });
  assert.equal((await inbox(f, f.otherAgent)).length, 0);
  assert.equal((await f.state()).tasks.length, 0);
});

test('a mention reply uses the source root thread and authenticated recipient, ignoring placement and author spoofing', async t => {
  const f = await fixture(t);
  const root = await post(f, 'Root discussion.');
  const elsewhere = await post(f, 'Unrelated room discussion.', { channelId: 'vibz-app' });
  const taggedReply = await post(f, '@Run inspect this particular reply.', { parentId: root.id });
  const [pending] = await inbox(f);
  assert.equal(pending.message.id, taggedReply.id);
  assert.equal(pending.rootMessage.id, root.id);
  await rejected(reply(f, pending.id, {}, f.otherAgent), 403);
  const result = await reply(f, pending.id, {
    parentId: elsewhere.id, channelId: 'vibz-app', agentId: 'portfolio', authorId: 'member1', authorKind: 'human',
  });
  assert.equal(result.message.parentId, root.id);
  assert.equal(result.message.channelId, root.channelId);
  assert.equal(result.message.authorId, 'run');
  assert.equal(result.message.authorKind, 'agent');
  assert.equal(result.mention.replyMessageId, result.message.id);
  assert.equal(result.mention.status, 'replied');
  assert.equal((await f.state()).tasks.length, 0);
});

test('a root mention reply is durable, resolves the source badge, and retries do not create more replies', async t => {
  const f = await fixture(t);
  const original = await post(f, '@Run answer in this thread.');
  const [pending] = await inbox(f);
  const input = { body: 'A concrete answer to the original question.', requestId: randomUUID() };
  const delivered = await reply(f, pending.id, input);
  assert.equal(delivered.message.parentId, original.id);
  const before = await f.state();
  const repeated = await reply(f, pending.id, input);
  assert.equal(repeated.message.id, delivered.message.id);
  const after = await f.state();
  assert.equal(after.messages.length, before.messages.length);
  assert.equal(after.activity.length, before.activity.length);
  assert.equal(after.messages.find(item => item.id === original.id).mentions[0].replyMessageId, delivered.message.id);
  assert.equal(after.agents.find(item => item.id === 'run').pendingMentions, 0);
  await rejected(reply(f, pending.id, { ...input, body: 'Conflicting answer.' }), 409);
  await rejected(reply(f, pending.id), 409, 'mention_already_replied');
});

test('concurrent identical reply retries return one response; different attempts race to one winner', async t => {
  const f = await fixture(t);
  await post(f, '@Run first question.');
  const [first] = await inbox(f);
  const input = { requestId: randomUUID(), body: 'The same intended answer.' };
  const results = await Promise.all([reply(f, first.id, input), reply(f, first.id, input)]);
  assert.equal(results[0].message.id, results[1].message.id);
  await post(f, '@Run second question.');
  const [second] = await inbox(f);
  const competing = await Promise.allSettled([
    reply(f, second.id, { body: 'First competing response.' }),
    reply(f, second.id, { body: 'Second competing response.' }),
  ]);
  assert.equal(competing.filter(item => item.status === 'fulfilled').length, 1);
  const lost = competing.find(item => item.status === 'rejected').reason;
  assert.equal(lost.status, 409);
  assert.equal(lost.code, 'mention_already_replied');
  const state = await f.state();
  assert.equal(state.messages.filter(item => item.authorKind === 'agent').length, 2);
});

test('a reply request ID cannot be reused to resolve a different mention', async t => {
  const f = await fixture(t);
  await post(f, '@Run first request.');
  f.advance();
  await post(f, '@Run second request.');
  const [first, second] = await inbox(f);
  const input = { requestId: randomUUID(), body: 'A response bound to exactly one mention.' };
  await reply(f, first.id, input);
  await rejected(reply(f, second.id, input), 409);
  assert.deepEqual((await inbox(f)).map(item => item.id), [second.id]);
});

test('mention context returns the latest twenty thread messages in chronological order', async t => {
  const f = await fixture(t);
  const root = await post(f, 'A thread with a long conversation.');
  const replies = [];
  for (let i = 0; i < 22; i++) {
    f.advance();
    replies.push(await post(f, i === 0 ? '@Run a question near the start.' : `Relevant thread context ${i}.`, { parentId: root.id }));
  }
  const [pending] = await inbox(f);
  assert.equal(pending.rootMessage.id, root.id);
  assert.equal(pending.message.id, replies[0].id);
  assert.deepEqual(pending.context.map(item => item.id), replies.slice(-20).map(item => item.id));
});
