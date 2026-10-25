import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { SQLiteD1 } from './sqlite-d1.mjs';
import { routes } from './load-routes.mjs';

const origin = 'https://studio.example.org';
const member1 = { userId: 'platform-member1', email: 'member1@example.invalid', name: 'Member One' };
const member2 = { userId: 'platform-member2', email: 'member2@example.invalid', name: 'Member Two' };

// These headers simulate an already-verified platform identity at the Worker.
// Tests cannot prove the external Sites gateway strips spoofed headers, checks
// service credentials, or prevents access to a direct Worker hostname.
function trustedIdentity(principal) {
  return principal ? {
    'oai-authenticated-user-id': principal.userId,
    'oai-authenticated-user-email': principal.email,
    'oai-authenticated-user-full-name': principal.name,
  } : {};
}

function request(path, { method = 'GET', principal, data, headers = {}, requestOrigin } = {}) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      ...trustedIdentity(principal),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

async function fixture(t, { initialize = true } = {}) {
  const db = new SQLiteD1();
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, directory), 'utf8'));
  }
  routes.env.DB = db;
  t.after(() => { delete routes.env.DB; db.close(); });
  const studio = new routes.StudioService(db);
  if (!initialize) return { db, studio };
  await studio.bootstrap(member1);
  await studio.bootstrap(member2);
  const owner = await studio.member(member1);
  return { db, studio, owner, state: await studio.state(owner) };
}

async function tool(name, args, principal) {
  const response = await routes.mcp.POST(request('/mcp', {
    method: 'POST', principal,
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } },
  }));
  const payload = await response.json();
  return { response, payload, value: payload.result?.content?.[0] && JSON.parse(payload.result.content[0].text) };
}

test('MCP workspace setup is a mutation restricted to the configured owner, then binds admitted identities without impersonation', async t => {
  await fixture(t, { initialize: false });
  const unauthenticated = await tool('studio_open_workspace', {});
  assert.equal(unauthenticated.payload.result.isError, true);
  assert.equal(unauthenticated.value.status, 401);
  const nonowner = await tool('studio_open_workspace', {}, member2);
  assert.equal(nonowner.payload.result.isError, true);
  assert.equal(nonowner.value.status, 403);
  assert.equal(nonowner.value.code, 'owner_setup_required');

  const initialized = await tool('studio_open_workspace', {}, member1);
  assert.equal(initialized.payload.result.isError, false);
  assert.equal(initialized.value.viewer.id, 'member1');
  assert.equal(initialized.value.viewer.role, 'owner');
  assert.equal(initialized.value.members.length, 4);
  assert.equal(initialized.value.tasks.length, 0);
  assert.equal(initialized.value.messages.length, 0);
  assert.ok(initialized.value.agents.every(agent => agent.status === 'not_connected'));

  const admitted = await tool('studio_open_workspace', {}, member2);
  assert.equal(admitted.payload.result.isError, false);
  assert.equal(admitted.value.viewer.id, 'member2');
  assert.equal(admitted.value.viewer.connected, true);
  const bodyImpersonation = await tool('studio_open_workspace', {
    userId: member1.userId, email: member1.email, memberId: 'member1', role: 'owner',
  }, member2);
  assert.equal(bodyImpersonation.payload.result.isError, false);
  assert.equal(bodyImpersonation.value.viewer.id, 'member2');
  assert.equal(bodyImpersonation.value.viewer.role, 'member');
  const reusedEmail = await tool('studio_open_workspace', {}, { ...member2, userId: 'different-platform-user' });
  assert.equal(reusedEmail.payload.result.isError, true);
  assert.equal(reusedEmail.value.status, 403);

  const listed = await routes.mcp.POST(request('/mcp', {
    method: 'POST', principal: member1,
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' },
  }));
  const setup = (await listed.json()).result.tools.find(item => item.name === 'studio_open_workspace');
  assert.ok(setup);
  assert.equal(setup.annotations.readOnlyHint, false);
});

test('private HTTP reads reject absent identity and outsiders, and browser writes require same origin', async t => {
  await fixture(t);
  assert.equal((await routes.api.GET(request('/api/studio'))).status, 401);
  assert.equal((await routes.api.GET(request('/api/studio', {
    principal: { userId: 'outsider', email: 'outsider@example.org', name: 'Outsider' },
  }))).status, 403);
  const data = { channelId: 'all-vibz-studio', body: 'A same-origin human message.', clientId: randomUUID() };
  assert.equal((await routes.api.POST(request('/api/messages', { method: 'POST', principal: member1, data }))).status, 403);
  assert.equal((await routes.api.POST(request('/api/messages', {
    method: 'POST', principal: member1, data, requestOrigin: 'https://elsewhere.example.org',
  }))).status, 403);
  const accepted = await routes.api.POST(request('/api/messages', {
    method: 'POST', principal: member1, data, requestOrigin: origin,
  }));
  assert.equal(accepted.status, 201);
  assert.match(accepted.headers.get('cache-control'), /no-store/);
  assert.equal((await accepted.json()).message.authorId, 'member1');
});

test('a scoped agent token cannot use human HTTP routes or invoke human review through its agent endpoint', async t => {
  const f = await fixture(t);
  const issued = await f.studio.mintToken(f.owner, 'run', 'route verification');
  const headers = { authorization: `Bearer ${issued.token}` };
  assert.equal((await routes.api.GET(request('/api/studio', { headers }))).status, 401);
  assert.equal((await routes.api.POST(request('/api/tasks/anything', {
    method: 'POST', headers, requestOrigin: origin,
    data: { action: 'review', decision: 'approve', note: 'Agent impersonating a reviewer.' },
  }))).status, 401);
  const forbiddenAction = await routes.api.POST(request('/api/agent', {
    method: 'POST', headers,
    data: { action: 'review', taskId: 'anything', decision: 'approve', note: 'Self approval.' },
  }));
  assert.equal(forbiddenAction.status, 400);
  assert.equal((await f.studio.state(f.owner)).tasks.length, 0);
});

test('MCP enforces membership and own-agent ownership and has no approval tool', async t => {
  const f = await fixture(t);
  assert.equal((await tool('studio_snapshot', {})).value.status, 401);
  assert.equal((await tool('studio_snapshot', {}, {
    userId: 'outsider', email: 'outsider@example.org', name: 'Outsider',
  })).value.status, 403);
  assert.equal((await tool('studio_agent_heartbeat', { agentId: 'run', status: 'idle' }, member2)).value.status, 403);
  assert.equal((await tool('studio_agent_heartbeat', { agentId: 'portfolio', status: 'idle' }, member1)).value.status, 403);
  const authorized = await tool('studio_agent_heartbeat', { status: 'working', detail: 'Actual request received.' }, member2);
  assert.equal(authorized.payload.result.isError, false);
  assert.equal(authorized.value.agentId, 'portfolio');
  const state = await f.studio.state(f.owner);
  assert.equal(state.agents.find(agent => agent.id === 'portfolio').status, 'working');
  assert.equal(state.agents.find(agent => agent.id === 'run').status, 'not_connected');
  const unavailable = await tool('studio_approve_task', { taskId: 'anything' }, member1);
  assert.equal(unavailable.payload.error.code, -32602);
});

test('HTTP and MCP dispatch bind operation and author identity instead of accepting caller overrides', async t => {
  const f = await fixture(t);
  const spoofed = await tool('studio_post_message', {
    channelId: 'all-vibz-studio', body: 'Portfolio sent this through MCP.', requestId: randomUUID(),
    authorId: 'member1', authorKind: 'human', action: 'heartbeat',
  }, member2);
  assert.equal(spoofed.payload.result.isError, false);
  assert.equal(spoofed.value.message.authorId, 'portfolio');
  assert.equal(spoofed.value.message.authorKind, 'agent');
  assert.equal((await f.studio.state(f.owner)).messages.length, 1);
});

test('revoked agent connections stop at the HTTP authentication boundary and credentials never appear in export', async t => {
  const f = await fixture(t);
  const issued = await f.studio.mintToken(f.owner, 'run', 'revocable bridge');
  const headers = { authorization: `Bearer ${issued.token}` };
  const data = { action: 'heartbeat', status: 'idle' };
  assert.equal((await routes.api.POST(request('/api/agent', { method: 'POST', headers, data }))).status, 200);
  await f.studio.revokeToken(f.owner, 'run', issued.tokenId);
  assert.equal((await routes.api.POST(request('/api/agent', { method: 'POST', headers, data }))).status, 401);
  const exported = await routes.api.GET(request('/api/export', { principal: member1 }));
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.equal(text.includes(issued.token), false);
  assert.equal(text.includes('token_hash'), false);
  assert.equal(text.includes('tokenHash'), false);
});

test('HTTP and MCP dispatch authenticated mention inboxes and replies with correct ownership and tool metadata', async t => {
  const f = await fixture(t);
  const original = (await f.studio.postMessage(f.owner, {
    channelId: 'all-vibz-studio', body: '@Run and @Portfolio, please answer in this thread.', clientId: randomUUID(),
  })).message;
  const runToken = await f.studio.mintToken(f.owner, 'run', 'mention route verification');
  const inboxResponse = await routes.api.POST(request('/api/agent', {
    method: 'POST', headers: { authorization: `Bearer ${runToken.token}` }, data: { action: 'mentions', agentId: 'portfolio' },
  }));
  assert.equal(inboxResponse.status, 200);
  const [runMention] = (await inboxResponse.json()).mentions;
  assert.equal(runMention.agentId, 'run');
  const runMcpInbox = await tool('studio_get_mentions', {}, member1);
  assert.equal(runMcpInbox.payload.result.isError, false);
  assert.deepEqual(runMcpInbox.value.mentions.map(item => item.id), [runMention.id]);
  assert.equal((await tool('studio_get_mentions', { agentId: 'portfolio' }, member1)).value.status, 403);
  assert.equal((await tool('studio_reply_to_mention', {
    mentionId: runMention.id, body: 'Attempted wrong-recipient response.', requestId: randomUUID(),
  }, member2)).value.status, 403);
  const replied = await tool('studio_reply_to_mention', {
    mentionId: runMention.id, body: 'Run’s actual response through MCP.', requestId: randomUUID(),
  }, member1);
  assert.equal(replied.payload.result.isError, false);
  assert.equal(replied.value.message.authorId, 'run');
  assert.equal(replied.value.message.parentId, original.id);
  assert.equal(replied.value.mention.status, 'replied');
  assert.equal((await tool('studio_get_mentions', {}, member1)).value.mentions.length, 0);

  const portfolioInbox = await tool('studio_get_mentions', {}, member2);
  const [portfolioMention] = portfolioInbox.value.mentions;
  const wrongRecipient = await routes.api.POST(request('/api/agent', {
    method: 'POST', headers: { authorization: `Bearer ${runToken.token}` },
    data: { action: 'reply_mention', mentionId: portfolioMention.id, agentId: 'portfolio', body: 'Run cannot answer Portfolio’s mention.', requestId: randomUUID() },
  }));
  assert.equal(wrongRecipient.status, 403);
  const portfolioToken = await f.studio.mintToken(await f.studio.member(member2), 'portfolio', 'Portfolio route verification');
  const httpReply = await routes.api.POST(request('/api/agent', {
    method: 'POST', headers: { authorization: `Bearer ${portfolioToken.token}` },
    data: { action: 'reply_mention', mentionId: portfolioMention.id, body: 'Portfolio’s actual HTTP response.', requestId: randomUUID() },
  }));
  assert.equal(httpReply.status, 200);
  const replyResult = await httpReply.json();
  assert.equal(replyResult.message.authorId, 'portfolio');
  assert.equal(replyResult.message.parentId, original.id);
  assert.equal(replyResult.mention.status, 'replied');
  assert.equal((await f.studio.state(f.owner)).tasks.length, 0);

  const listed = await routes.mcp.POST(request('/mcp', {
    method: 'POST', principal: member1,
    data: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' },
  }));
  const tools = (await listed.json()).result.tools;
  assert.equal(tools.find(item => item.name === 'studio_get_mentions')?.annotations.readOnlyHint, true);
  assert.equal(tools.find(item => item.name === 'studio_reply_to_mention')?.annotations.readOnlyHint, false);
});
