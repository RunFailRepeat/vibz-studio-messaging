import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SQLiteD1 } from './sqlite-d1.mjs';
import { production } from './load-studio.mjs';

const { StudioService } = production;
const ownerIdentity = {
  userId: 'verified-owner-platform-id',
  email: 'member1@example.invalid',
  name: 'Member One',
};
const jasonIdentity = {
  userId: 'verified-member2-platform-id',
  email: 'member2@example.invalid',
  name: 'Member Two',
};
const humanIdentities = [
  ownerIdentity,
  jasonIdentity,
  { userId: 'verified-member3-platform-id', email: 'member3@example.invalid', name: 'Member Three' },
  { userId: 'verified-member4-platform-id', email: 'member4@example.invalid', name: 'Member Four' },
];

async function database() {
  const db = new SQLiteD1();
  const directory = new URL('../drizzle/', import.meta.url);
  const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  assert.ok(migrations.length, 'Tests must execute the production SQL migration');
  for (const name of migrations) await db.exec(await readFile(new URL(name, directory), 'utf8'));
  return db;
}

async function fixture(t, { initialize = true } = {}) {
  const db = await database();
  t.after(() => db.close());
  let clock = new Date('2026-10-25T17:00:00.000Z');
  const service = new StudioService(db, { now: () => new Date(clock) });
  const f = { db, service, advance: ms => { clock = new Date(clock.getTime() + ms); } };
  if (!initialize) return f;
  await service.bootstrap(ownerIdentity);
  f.owner = await service.member(ownerIdentity);
  f.member2 = await service.member(jasonIdentity);
  f.state = await service.state(f.owner);
  f.channel = f.state.channels.find(channel => channel.name === 'all-vibz-studio') ?? f.state.channels[0];
  f.run = f.state.agents.find(agent => agent.name === 'Run');
  f.portfolio = f.state.agents.find(agent => /portfolio/i.test(agent.name));
  assert.ok(f.channel && f.run && f.portfolio, 'Production roster and channels must be present');
  f.agent = await service.mcpAgent(f.owner, f.run.id);
  f.otherAgent = await service.mcpAgent(f.member2, f.portfolio.id);
  return f;
}

function denied(promise, statuses = [400, 401, 403, 404, 409, 422]) {
  return assert.rejects(promise, error => {
    assert.ok(statuses.includes(error.status), `Expected a deliberate HTTP-domain rejection, received ${error?.stack ?? error}`);
    return true;
  });
}

async function task(f, overrides = {}) {
  const response = await f.service.createTask(f.owner, {
    channelId: f.channel.id,
    title: 'Review a concrete deliverable',
    brief: 'Independently inspect the supplied implementation and report exact outcomes.',
    acceptance: 'Return a result with evidence and distinguish remaining limitations.',
    assigneeAgentId: f.run.id,
    clientId: randomUUID(),
    ...overrides,
  });
  return response.task ?? response;
}

async function claim(f, agent = f.agent, requestId = randomUUID()) {
  return f.service.agentAction(agent, { action: 'claim', requestId });
}

function delivery(claimed, overrides = {}) {
  return {
    action: 'deliver',
    taskId: claimed.task.id,
    leaseId: claimed.leaseId,
    summary: 'Reviewed the requested behavior; the attached results identify the observed outcome.',
    evidence: [{ label: 'Executed behavioral verification result', url: 'https://example.org/results/42' }],
    requestId: randomUUID(),
    ...overrides,
  };
}

test('only the configured owner can initialize; an unknown visitor cannot create membership', async t => {
  const f = await fixture(t, { initialize: false });
  await denied(f.service.bootstrap(jasonIdentity), [401, 403]);
  await denied(f.service.bootstrap({ userId: 'outsider', email: 'outsider@example.org', name: 'Outsider' }), [401, 403]);
  await f.service.bootstrap(ownerIdentity);
  await denied(f.service.member({ userId: 'outsider', email: 'outsider@example.org', name: 'Outsider' }), [401, 403]);
  const owner = await f.service.member(ownerIdentity);
  const state = await f.service.state(owner);
  assert.equal(state.members.length, 4);
  assert.equal(state.agents.length, 4);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.messages.length, 0);
  assert.ok(state.agents.every(agent => agent.status === 'not_connected'));
});

test('the four verified members bind individually; a second platform identity cannot reuse a bound email', async t => {
  const f = await fixture(t);
  for (const identity of humanIdentities) await f.service.bootstrap(identity);
  const members = await Promise.all(humanIdentities.map(identity => f.service.member(identity)));
  assert.equal(new Set(members.map(member => member.id)).size, 4);
  for (const identity of humanIdentities) {
    await denied(f.service.member({ ...identity, userId: 'another-platform-user' }), [401, 403, 409]);
  }
  assert.equal((await f.service.state(f.owner)).members.length, 4);
});

test('MCP acting identity is restricted to the caller’s own agent, including the workspace owner', async t => {
  const f = await fixture(t);
  assert.equal(f.agent.id, f.run.id);
  assert.equal(f.otherAgent.id, f.portfolio.id);
  await denied(f.service.mcpAgent(f.owner, f.portfolio.id), [403]);
  await denied(f.service.mcpAgent(f.member2, f.run.id), [403]);
});

test('token issuance is owner-scoped and a revoked token stops authenticating immediately', async t => {
  const f = await fixture(t);
  await denied(f.service.mintToken(f.member2, f.run.id, 'unauthorized bridge'), [403]);
  const issued = await f.service.mintToken(f.owner, f.run.id, 'Run local worker');
  assert.ok(issued.token && issued.tokenId);
  const authenticated = await f.service.authenticateAgent(issued.token);
  assert.equal(authenticated.id, f.run.id);
  await denied(f.service.revokeToken(f.member2, f.run.id, issued.tokenId), [403]);
  await f.service.revokeToken(f.owner, f.run.id, issued.tokenId);
  await denied(f.service.authenticateAgent(issued.token), [401, 403]);
  await denied(f.service.agentAction(authenticated, { action: 'heartbeat', status: 'idle' }), [401, 403]);
  await denied(f.service.authenticateAgent('invalid-token'), [401, 403]);
});

test('human message retries produce one message and conflicting key reuse cannot silently change it', async t => {
  const f = await fixture(t);
  const input = { channelId: f.channel.id, body: 'A real human-authored message.', clientId: randomUUID() };
  const a = await f.service.postMessage(f.owner, input);
  const b = await f.service.postMessage(f.owner, input);
  assert.equal((a.message ?? a).id, (b.message ?? b).id);
  await denied(f.service.postMessage(f.owner, { ...input, body: 'Different text under the same key.' }), [409]);
  const state = await f.service.state(f.owner);
  assert.equal(state.messages.filter(message => message.body === input.body).length, 1);
});

test('message authorship comes from authenticated identity and cross-room parent references are rejected', async t => {
  const f = await fixture(t);
  const response = await f.service.postMessage(f.owner, {
    channelId: f.channel.id, body: 'Attribution must be server-derived.', clientId: randomUUID(),
    authorId: f.portfolio.id, authorKind: 'agent', authorName: 'Impersonated',
  });
  const message = response.message ?? response;
  assert.equal(message.authorId, f.owner.id);
  assert.equal(message.authorKind, 'human');
  const otherChannel = f.state.channels.find(channel => channel.id !== f.channel.id);
  await denied(f.service.postMessage(f.owner, {
    channelId: otherChannel.id, parentId: message.id, body: 'An invalid cross-room reply.', clientId: randomUUID(),
  }));
});

test('task creation is idempotent and cannot reuse a request for another assignment or brief', async t => {
  const f = await fixture(t);
  const clientId = randomUUID();
  const a = await task(f, { clientId });
  const b = await task(f, { clientId });
  assert.equal(a.id, b.id);
  await denied(task(f, { clientId, brief: 'Different work.' }), [409]);
  assert.equal((await f.service.state(f.owner)).tasks.length, 1);
});

test('concurrent claims create at most one active assignment per agent, and its retry preserves the lease', async t => {
  const f = await fixture(t);
  await task(f, { title: 'First independent task' });
  f.advance(1);
  await task(f, { title: 'Second independent task' });
  const requestIds = [randomUUID(), randomUUID()];
  const results = await Promise.all(requestIds.map(id => claim(f, f.agent, id)));
  const index = results.findIndex(result => result.task);
  assert.equal(results.filter(result => result.task).length, 1);
  const active = results[index];
  assert.ok(active.leaseId && active.active);
  assert.equal((await f.service.state(f.owner)).tasks.filter(item => item.state === 'running').length, 1);
  const replay = await claim(f, f.agent, requestIds[index]);
  assert.equal(replay.task.id, active.task.id);
  assert.equal(replay.leaseId, active.leaseId);
  assert.equal(replay.active, true);
});

test('an agent cannot claim another agent’s queue or unassigned inbox work', async t => {
  const f = await fixture(t);
  await task(f, { assigneeAgentId: f.portfolio.id });
  await task(f, { assigneeAgentId: null });
  assert.equal((await claim(f)).task, null);
  assert.ok((await claim(f, f.otherAgent)).task);
});

test('heartbeat does not extend a work lease; a recovered claim fences the old worker', async t => {
  const f = await fixture(t);
  await task(f);
  const original = await claim(f);
  f.advance(4 * 60 * 1000);
  await f.service.agentAction(f.agent, { action: 'heartbeat', status: 'working', detail: 'Worker still reachable.' });
  f.advance(2 * 60 * 1000);
  await denied(f.service.agentAction(f.agent, delivery(original)), [409]);
  const recovered = await claim(f);
  assert.equal(recovered.task.id, original.task.id);
  assert.notEqual(recovered.leaseId, original.leaseId);
  assert.ok(recovered.task.attempt > original.task.attempt);
  await denied(f.service.agentAction(f.agent, {
    action: 'progress', taskId: original.task.id, leaseId: original.leaseId, detail: 'Stale worker.',
  }), [409]);
});

test('progress renews only the current lease; another agent or a wrong lease cannot mutate work', async t => {
  const f = await fixture(t);
  await task(f);
  const held = await claim(f);
  f.advance(2 * 60 * 1000);
  await denied(f.service.agentAction(f.otherAgent, {
    action: 'progress', taskId: held.task.id, leaseId: held.leaseId, detail: 'Wrong agent.',
  }), [403, 409]);
  await denied(f.service.agentAction(f.agent, {
    action: 'progress', taskId: held.task.id, leaseId: 'wrong-lease', detail: 'Wrong lease.',
  }), [409]);
  const renewed = await f.service.agentAction(f.agent, {
    action: 'progress', taskId: held.task.id, leaseId: held.leaseId, detail: 'Completed the first verification step.',
  });
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(held.leaseExpiresAt));
});

test('delivery enters review, retries do not duplicate it, and only human review makes it done', async t => {
  const f = await fixture(t);
  await task(f);
  const held = await claim(f);
  const input = delivery(held);
  const delivered = await f.service.agentAction(f.agent, input);
  assert.equal(delivered.task.state, 'review');
  const beforeRetry = await f.service.state(f.owner);
  const repeated = await f.service.agentAction(f.agent, input);
  assert.equal(repeated.task.id, delivered.task.id);
  assert.equal(repeated.task.state, 'review');
  assert.equal((await f.service.state(f.owner)).activity.length, beforeRetry.activity.length);
  await denied(f.service.agentAction(f.agent, { ...input, summary: 'Altered result under the same request ID.' }), [409]);
  await denied(f.service.agentAction(f.agent, {
    action: 'review', taskId: held.task.id, decision: 'approve', note: 'Self approval.', requestId: randomUUID(),
  }));
  assert.equal((await f.service.state(f.owner)).tasks.find(item => item.id === held.task.id).state, 'review');
  const reviewed = await f.service.updateTask(f.member2, held.task.id, {
    action: 'review', decision: 'approve', note: 'Independently verified the supplied result.',
  });
  assert.equal((reviewed.task ?? reviewed).state, 'done');
});

test('empty evidence and unsafe result links are rejected without ending the current lease', async t => {
  const f = await fixture(t);
  await task(f);
  const held = await claim(f);
  await denied(f.service.agentAction(f.agent, delivery(held, { evidence: [] })), [400, 422]);
  await denied(f.service.agentAction(f.agent, delivery(held, {
    evidence: [{ label: 'Untrusted executable link', url: 'javascript:alert(1)' }],
  })), [400, 422]);
  assert.equal((await f.service.state(f.owner)).tasks.find(item => item.id === held.task.id).state, 'running');
  assert.equal((await f.service.agentAction(f.agent, delivery(held))).task.state, 'review');
});

test('human cancellation and reassignment invalidate a previously issued work lease', async t => {
  const f = await fixture(t);
  const cancelled = await task(f, { title: 'Cancel this task' });
  const oldCancellationLease = await claim(f);
  await f.service.updateTask(f.owner, cancelled.id, { action: 'cancel' });
  await denied(f.service.agentAction(f.agent, delivery(oldCancellationLease)), [409]);
  const reassigned = await task(f, { title: 'Reassign this task' });
  const oldAssignmentLease = await claim(f);
  await f.service.updateTask(f.owner, reassigned.id, { action: 'assign', agentId: f.portfolio.id });
  await denied(f.service.agentAction(f.agent, delivery(oldAssignmentLease)), [403, 409]);
  const replacement = await claim(f, f.otherAgent);
  assert.equal(replacement.task.id, reassigned.id);
  assert.notEqual(replacement.leaseId, oldAssignmentLease.leaseId);
});

test('humans cannot approve work that has not been delivered for review', async t => {
  const f = await fixture(t);
  const queued = await task(f);
  await denied(f.service.updateTask(f.owner, queued.id, {
    action: 'review', decision: 'approve', note: 'Premature approval.',
  }), [409]);
  await claim(f);
  await denied(f.service.updateTask(f.owner, queued.id, {
    action: 'review', decision: 'approve', note: 'Still not delivered.',
  }), [409]);
});

test('a stale claim request is replayed as inactive and never takes another task or renews its lease', async t => {
  const f = await fixture(t);
  const first = await task(f);
  const requestId = randomUUID();
  const original = await claim(f, f.agent, requestId);
  f.advance(5 * 60 * 1000 + 1);
  const expired = await claim(f, f.agent, requestId);
  assert.equal(expired.task.id, first.id);
  assert.equal(expired.leaseId, original.leaseId);
  assert.equal(expired.active, false);
  const recovered = await claim(f);
  assert.notEqual(recovered.leaseId, original.leaseId);
  const oldReplay = await claim(f, f.agent, requestId);
  assert.equal(oldReplay.active, false);
  assert.equal(oldReplay.leaseId, original.leaseId);
  assert.equal((await f.service.state(f.owner)).tasks.find(item => item.id === first.id).attempt, 2);
});

test('an empty queue result is stable for its request ID; new work requires a new claim request', async t => {
  const f = await fixture(t);
  const requestId = randomUUID();
  assert.equal((await claim(f, f.agent, requestId)).task, null);
  const queued = await task(f);
  assert.equal((await claim(f, f.agent, requestId)).task, null);
  assert.equal((await claim(f)).task.id, queued.id);
});

test('concurrent retries of one blocker report succeed once without duplicating its event', async t => {
  const f = await fixture(t);
  await task(f);
  const held = await claim(f);
  const input = {
    action: 'block', taskId: held.task.id, leaseId: held.leaseId,
    detail: 'The required fixture is unavailable; a human needs to provide it.',
    requestId: randomUUID(),
  };
  const results = await Promise.all([
    f.service.agentAction(f.agent, input),
    f.service.agentAction(f.agent, input),
  ]);
  assert.ok(results.every(result => result.task.id === held.task.id && result.task.state === 'blocked'));
  const state = await f.service.state(f.owner);
  assert.equal(state.activity.filter(event => event.taskId === held.task.id && event.type === 'task_blocked').length, 1);
  await denied(f.service.agentAction(f.agent, { ...input, detail: 'Altered blocker under the same key.' }), [409]);
});

test('changing a member’s expected sign-in email revokes their credentials and fences existing work', async t => {
  const f = await fixture(t);
  await f.service.bootstrap(jasonIdentity);
  await denied(f.service.updateMember(f.member2, f.member2.id, { email: 'new-member2@example.org' }), [403]);
  await denied(f.service.updateMember(f.owner, f.member2.id, { email: ownerIdentity.email }), [409]);
  const issued = await f.service.mintToken(f.member2, f.portfolio.id, 'Member Two’s previous worker');
  const authenticated = await f.service.authenticateAgent(issued.token);
  const pending = await task(f, { assigneeAgentId: f.portfolio.id });
  const held = await claim(f, authenticated);
  await f.service.updateMember(f.owner, f.member2.id, { email: 'new-member2@example.org' });
  await denied(f.service.member(jasonIdentity), [403]);
  await denied(f.service.authenticateAgent(issued.token), [401]);
  await denied(f.service.agentAction(authenticated, delivery(held)), [401]);
  const state = await f.service.state(f.owner);
  assert.equal(state.members.length, 4);
  assert.equal(state.tasks.find(item => item.id === pending.id).state, 'blocked');
  assert.equal(state.agents.find(agent => agent.id === f.portfolio.id).status, 'not_connected');
  const newIdentity = { ...jasonIdentity, userId: 'replacement-platform-id', email: 'new-member2@example.org' };
  assert.equal((await f.service.bootstrap(newIdentity)).viewer.id, f.member2.id);
});

test('agent messages retain their agent identity, retry once, and cannot reuse content keys', async t => {
  const f = await fixture(t);
  const input = {
    action: 'message', channelId: f.channel.id, body: 'A real authenticated agent update.',
    requestId: randomUUID(), authorId: f.owner.id, authorKind: 'human', authorName: f.owner.name,
  };
  const [first, retry] = await Promise.all([
    f.service.agentAction(f.agent, input),
    f.service.agentAction(f.agent, input),
  ]);
  assert.equal(first.message.id, retry.message.id);
  assert.equal(first.message.authorId, f.run.id);
  assert.equal(first.message.authorKind, 'agent');
  await denied(f.service.agentAction(f.agent, { ...input, body: 'Conflicting update.' }), [409]);
  assert.equal((await f.service.state(f.owner)).messages.length, 1);
});
