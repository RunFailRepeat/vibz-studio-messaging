import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedHandler } from './host-auth.mjs';
const claims={subject:'verified-user',kind:'human',audience:'vibz-test',expiresAt:2000};
test('mandatory trusted verifier rejects forged identity headers/body without fallback',async()=>{
  assert.throws(()=>authenticatedHandler({handle:()=>{},audience:'vibz-test'}),/trusted_verifier_required/);
  let calls=0;const run=authenticatedHandler({verify:async()=>null,handle:()=>{calls++;},audience:'vibz-test',now:()=>1000});
  await assert.rejects(run({headers:{'x-oai-user-id':'owner'},body:{userId:'owner',claims}}),{code:'unauthenticated'});
  assert.equal(calls,0);
});
test('only verified identity reaches handler, raw body cannot choose principal',async()=>{
  const request={body:{userId:'attacker',kind:'human'}},seen=[];
  const run=authenticatedHandler({verify:async r=>{assert.equal(r,request);return claims;},
    handle:(principal,r)=>{seen.push(principal);assert.equal(r,request);return 'ok';},audience:'vibz-test',now:()=>1000});
  assert.equal(await run(request),'ok');assert.deepEqual(seen,[{userId:'verified-user',kind:'human'}]);assert.equal(Object.isFrozen(seen[0]),true);
});
test('expired/wrong-audience/agent claims and verifier failures do not call handler or leak error details',async()=>{
  for(const value of [{...claims,expiresAt:1000},{...claims,audience:'other'},{...claims,kind:'agent'},{...claims,subject:''}]) {
    const run=authenticatedHandler({verify:async()=>value,handle:()=>assert.fail('must not dispatch'),audience:'vibz-test',now:()=>1000});
    await assert.rejects(run({}),{code:'unauthenticated'});
  }
  const run=authenticatedHandler({verify:async()=>{throw new Error('private verifier details');},handle:()=>assert.fail(),audience:'vibz-test'});
  await assert.rejects(run({}),error=>error.message==='unauthenticated');
});
