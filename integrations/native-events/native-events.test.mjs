import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import { publicAddress, callbackURL, signature, createTransport, verifyCallback } from './transport.mjs';
import { DurableOutbox, deliverOne, disposition } from './outbox.mjs';

const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64'); // synthetic
const good = [{ address: '8.8.8.8', family: 4 }];
const input = { url: 'https://callback.example.com/events', secret,
  subscriptionId: 'sub_1', id: 'evt_1', body: '{"eventId":"evt_1"}', authorize: async () => true };
function harness({ addresses = good, status = 204, response = '', hang = false, bodyFailure } = {}) {
  const calls = []; let resolutions = 0;
  const send = createTransport({
    resolve: async () => { resolutions++; return addresses; }, timeoutMs: 30, now: () => 1700000000000,
    request: (options, callback) => {
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = body => {
        calls.push({ options, body });
        if (hang) return;
        queueMicrotask(() => {
          const res = new EventEmitter(); res.statusCode = status; res.destroy = () => {};
          callback(res);
          res.emit('data', Buffer.from(typeof response === 'function' ? response(body) : response));
          if (bodyFailure === 'stall') return;
          if (bodyFailure) { res.emit(bodyFailure, new Error('synthetic body failure')); return; }
          res.emit('end');
        });
      };
      return req;
    }
  });
  return { send, calls, resolutions: () => resolutions };
}

test('public address policy fails closed on special-use and all IPv6', () => {
  for (const ip of ['0.0.0.0','10.2.3.4','127.0.0.1','100.64.0.1','100.127.255.255',
    '169.254.169.254','172.16.0.1','172.31.255.255','192.168.0.1','192.0.0.9',
    '192.0.2.1','192.88.99.1','198.18.0.1','198.19.255.255','198.51.100.1','203.0.113.1',
    '224.0.0.1','255.255.255.255','::1','::ffff:8.8.8.8','2606:4700::1111','bad']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','172.32.0.1']) assert.equal(publicAddress(ip), true);
});
test('URL validation rejects credentials, plaintext, fragments and alternate ports', () => {
  for (const url of ['http://callback.example.com','https://u:p@callback.example.com',
    'https://callback.example.com/#x','https://callback.example.com:444',
    'https://127.0.0.1','https://[::1]','https://localhost']) assert.throws(() => callbackURL(url));
});
test('signature matches independent HMAC over exact bytes and rejects malformed keys', () => {
  const body = '{"text":"é"}';
  assert.equal(signature(secret, 'evt_1', '1700000000', body), 'v1,' + createHmac('sha256', Buffer.alloc(32, 7)).update('evt_1.1700000000.' + body).digest('base64'));
  for (const key of ['secret','whsec_YQ==','whsec_!!!!']) assert.throws(() => signature(key,'x','1','{}'));
});
test('pins resolved address and preserves TLS and Host; resolves every attempt', async () => {
  const h = harness(); await h.send(input); await h.send(input);
  assert.equal(h.resolutions(), 2);
  const { options, body } = h.calls[0];
  assert.equal(options.hostname, 'callback.example.com');
  assert.equal(options.servername, 'callback.example.com');
  assert.equal(options.headers.Host, 'callback.example.com');
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
  options.lookup('ignored.example', {}, (err, address, family) => {
    assert.equal(err, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  options.lookup('ignored.example', { all: true }, (err, addresses) => assert.deepEqual(addresses, good));
  assert.equal(body, input.body); assert.equal(options.headers['webhook-id'], 'evt_1');
  assert.equal(options.headers['Content-Length'], Buffer.byteLength(body));
});
test('mixed public/private DNS answer blocks before request', async () => {
  const h = harness({ addresses: [...good, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(h.send(input), { code: 'blocked_destination' }); assert.equal(h.calls.length, 0);
});
test('empty DNS and public IPv6 fail closed', async () => {
  for (const addresses of [[], [{ address:'2606:4700::1111',family:6 }]]) {
    const h = harness({ addresses }); await assert.rejects(h.send(input), { code: 'blocked_destination' });
    assert.equal(h.calls.length, 0);
  }
});
test('post-DNS authorization is mandatory and blocks request', async () => {
  const h = harness(); await assert.rejects(h.send({ ...input, authorize: async () => false }), { code: 'unauthorized' });
  assert.equal(h.resolutions(), 1); assert.equal(h.calls.length, 0);
});
test('redirects are not followed', async () => {
  const h = harness({ status:302 }); assert.equal((await h.send(input)).status,302); assert.equal(h.calls.length,1);
});
test('request and response bounds', async () => {
  const h = harness(); await assert.rejects(h.send({ ...input, body:'x'.repeat(262145) }), { code:'payload_size' }); assert.equal(h.calls.length,0);
  await assert.rejects(harness({ response:'x'.repeat(16385) }).send(input), { code:'response_size' });
});
test('total deadline bounds DNS and response stalls without late sends', async () => {
  await assert.rejects(harness({ hang:true }).send(input), { code:'timeout' });
  let finishDNS; let requests = 0;
  const send = createTransport({ timeoutMs:10, resolve:() => new Promise(r => {finishDNS=r;}), request:() => {requests++;} });
  await assert.rejects(send(input), { code:'timeout' }); finishDNS(good);
  await new Promise(r => setImmediate(r)); assert.equal(requests,0);
});
test('signed challenge accepts exact echo only', async () => {
  const sub = { ...input, id:'sub_1' };
  const h = harness({ status:200, response:body => JSON.stringify({ challenge:JSON.parse(body).challenge }) });
  assert.equal(await verifyCallback(h.send, sub, input.authorize),true);
  assert.match(h.calls[0].options.headers['webhook-id'], /^verify_/);
  await assert.rejects(verifyCallback(harness({status:200,response:'{"challenge":"wrong"}'}).send, sub,input.authorize),{code:'challenge_failed'});
  await assert.rejects(verifyCallback(harness({status:302,response:body=>JSON.stringify({challenge:JSON.parse(body).challenge})}).send,sub,input.authorize),{code:'challenge_failed'});
});

function fixture() {
  const event = { eventId:'evt_1',name:'mention.created',timestamp:'2026-10-25T00:00:00Z',data:{mentionId:'m_1'},cursor:null };
  const job = { id:'job_1',ownerId:'owner_1',subscriptionId:'sub_1',subscriptionVersion:1,eventId:event.eventId,eventName:event.name,body:JSON.stringify(event),attempt:1,leaseToken:'lease_1' };
  const sub = { id:'sub_1',ownerId:'owner_1',version:1,name:event.name,verified:true,expiresAt:2000,revoked:false,url:input.url,secret };
  const results = []; const sent = [];
  const store = {
    claim:async (_id,_now,_lease,principal) => principal === job.ownerId ? job : null,
    subscription:async () => sub,
    settle:async (_id,token,result) => { assert.equal(token,job.leaseToken); results.push(result); return true; }
  };
  const args = {store,id:job.id,principal:'owner_1',now:()=>1000,authorize:async()=>true,
    send:async value => { sent.push(value); assert.equal(await value.authorize(),true); return {status:204}; }};
  return {job,sub,results,sent,args};
}
test('durable adapter has no silent in-memory fallback', async () => {
  await assert.rejects(new DurableOutbox().claim('x',0,1),/durable_adapter_required/);
});
test('foreign owner cannot claim or send', async () => {
  const f=fixture(); assert.deepEqual(await deliverOne({...f.args,principal:'other'}),{state:'unavailable'}); assert.equal(f.sent.length,0);
});
test('expired, revoked, unverified and version-changed subscriptions stop delivery', async () => {
  for (const patch of [{expiresAt:1000},{revoked:true},{verified:false},{version:2},{ownerId:'other'}]) {
    const f=fixture(); Object.assign(f.sub,patch); assert.equal((await deliverOne(f.args)).state,'terminal'); assert.equal(f.sent.length,0);
  }
});
test('owner access loss stops delivery even for an active subscription', async () => {
  const f=fixture(); assert.equal((await deliverOne({...f.args,authorize:async()=>false})).state,'terminal'); assert.equal(f.sent.length,0);
});
test('revocation is rechecked inside transport callback', async () => {
  const f=fixture(); f.args.send=async value=>{f.sub.revoked=true;assert.equal(await value.authorize(),false);throw Object.assign(new Error('no'),{code:'unauthorized'});};
  assert.equal((await deliverOne(f.args)).state,'terminal');
});
test('410/413 and redirects are terminal; 429/5xx retry with bound', async () => {
  for (const status of [410,413,302,401,429,503]) {
    const f=fixture(); f.args.send=async()=>({status}); const result=await deliverOne(f.args);
    assert.equal(result.state,disposition(status));
    if (result.state==='retry') assert.equal(result.nextAttemptAt,61000);
  }
  const f=fixture();f.job.attempt=8;f.args.send=async()=>({status:503});assert.equal((await deliverOne(f.args)).state,'terminal');
});
test('retry keeps event ID and exact body; signatures use new attempt time', async () => {
  const f=fixture();const bodies=[];f.args.send=async value=>{bodies.push([value.id,value.body]);return {status:503};};
  await deliverOne(f.args);f.job.attempt++;await deliverOne(f.args);assert.deepEqual(bodies[0],bodies[1]);
  assert.notEqual(signature(secret,'evt_1','1',f.job.body),signature(secret,'evt_1','2',f.job.body));
});
test('stale lease cannot acknowledge delivery and errors never retain secrets', async () => {
  const f=fixture();f.args.store.settle=async()=>false;assert.equal((await deliverOne(f.args)).state,'lease_lost');
  const g=fixture();g.args.send=async()=>{throw Object.assign(new Error(secret),{code:'network'});};
  const result=await deliverOne(g.args);assert.equal(result.state,'retry');assert.equal(JSON.stringify(g.results).includes(secret),false);
});

test('transport body failures retain HTTP disposition through durable settlement', async () => {
  for (const status of [204, 410, 413, 429, 503]) {
    for (const behavior of [{bodyFailure:'aborted'}, {bodyFailure:'error'},
      {bodyFailure:'stall'}, {response:'x'.repeat(16385)}]) {
      const f = fixture();
      f.args.send = harness({status, ...behavior}).send;
      const result = await deliverOne(f.args);
      assert.equal(result.state, disposition(status), `${status} ${JSON.stringify(behavior).slice(0,60)}`);
      assert.equal(result.status, status);
      assert.equal(f.results.length, 1);
      if (result.state === 'retry') assert.equal(result.nextAttemptAt, 61000);
    }
  }
});

test('a correct challenge prefix with an incomplete body never verifies', async () => {
  for (const behavior of [{bodyFailure:'aborted'}, {bodyFailure:'error'}, {bodyFailure:'stall'},
    {response:body => JSON.stringify({challenge:JSON.parse(body).challenge}) + ' '.repeat(16385)}]) {
    const h = harness({status:200, response:body => JSON.stringify({challenge:JSON.parse(body).challenge}), ...behavior});
    await assert.rejects(verifyCallback(h.send, {...input,id:'sub_1'}, input.authorize));
  }
});

test('invalid final status cannot be retained as an acknowledgement', async () => {
  for (const status of [null, '204', 204.5, 101, 600]) {
    const h = harness({status});
    await assert.rejects(h.send(input), error => error.code === 'network' && error.status === undefined);
  }
});
