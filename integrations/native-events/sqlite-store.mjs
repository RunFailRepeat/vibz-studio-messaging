// Experimental Node >=24 SQLite host adapter. Uses the real Studio schema and
// mention parser, but is NOT connected to StudioService/D1 or production routes.
// commitMessage is an isolated transactional seam, not a complete replacement
// for StudioService (activity/UI updates still need integration). No timers,
// queue executor, secret key generation, or plaintext secret fallback exists.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { findAgentMentions } from '../../lib/mentions.ts';
import { DurableOutbox } from './outbox.mjs';
import { EVENT_NAME, canonical, failure, filters, hash, identifier } from './lifecycle.mjs';

export class SQLiteNativeStore extends DurableOutbox {
  constructor({ db, seal, open, now = Date.now }) {
    super();
    if (!db || typeof seal !== 'function' || typeof open !== 'function') throw failure('protected_storage_required');
    Object.assign(this, { db, seal, open, now });
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  member(principal) {
    if (!principal || typeof principal.userId !== 'string' || !principal.userId) throw failure('unauthenticated', -32001);
    if (principal.kind !== undefined && principal.kind !== 'human') throw failure('human_identity_required', -32003);
    const member = this.db.prepare('SELECT * FROM members WHERE user_id=?').get(principal.userId);
    if (!member) throw failure('forbidden', -32003);
    return member;
  }
  ownedAgents(principal) {
    return this.db.prepare('SELECT id,name FROM agents WHERE owner_id=? ORDER BY id').all(this.member(principal).id);
  }
  authorize(principal, rawArgs) {
    const args = filters(rawArgs), member = this.member(principal);
    const agent = this.db.prepare('SELECT owner_id FROM agents WHERE id=?').get(args.recipient_agent_id);
    if (!agent || agent.owner_id !== member.id) throw failure('forbidden', -32003);
    if (args.channel_id && !this.db.prepare('SELECT id FROM channels WHERE id=?').get(args.channel_id)) throw failure('unknown_channel');
    if (args.thread_id && !this.db.prepare('SELECT id FROM messages WHERE id=? AND channel_id=? AND parent_id IS NULL').get(args.thread_id, args.channel_id)) throw failure('invalid_thread');
    // Existing domain policy shares rooms among admitted members; no new grants.
    return member.user_id;
  }
  epoch(id) { return this.db.prepare('SELECT epoch FROM native_subscription_fences WHERE id=?').get(id)?.epoch ?? 0; }
  metadata(id) { return this.db.prepare('SELECT * FROM native_subscriptions WHERE id=?').get(id); }
  verificationCached(owner, url, secretHash, now) {
    return this.db.prepare(`SELECT verified_at FROM native_subscriptions WHERE owner_id=? AND url=? AND secret_hash=?
      AND revoked=0 AND expires_at>? AND verified_at>? ORDER BY verified_at DESC LIMIT 1`)
      .get(owner,url,secretHash,now,now-300000)?.verified_at ?? null;
  }
  activate(sub, expectedEpoch) {
    return this.transaction(() => {
      this.authorize({userId:sub.ownerId}, sub.args);
      const old = this.metadata(sub.id);
      if (this.epoch(sub.id) !== expectedEpoch) {
        // Identical concurrent creation/refresh may converge without changing
        // newer state. Never reactivate revoked state, change a key, or grant
        // more than this request allowed after a stale verification completes.
        if (old && !old.revoked && old.owner_id===sub.ownerId && old.name===sub.name
            && old.url===sub.url && old.arguments===canonical(sub.args) && old.secret_hash===sub.secretHash
            && old.expires_at>this.now() && old.expires_at<=sub.expiresAt) return old.expires_at;
        throw failure('subscription_changed', -32000);
      }
      const sealed = this.seal(sub.secret);
      if (typeof sealed !== 'string' || !sealed || sealed === sub.secret) throw failure('protected_storage_required');
      // Same-key TTL refresh (even after expiry) preserves undelivered rows, but
      // terminal rows never revive. Revocation/reactivation fences old work.
      // This is retained-outbox retry, not cursor replay of missed source events.
      const version = old ? old.version + Number(Boolean(old.revoked)) : 1;
      this.db.prepare(`INSERT INTO native_subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,0)
        ON CONFLICT(id) DO UPDATE SET sealed_secret=excluded.sealed_secret,
          verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked=0,version=excluded.version`)
        .run(sub.id,sub.ownerId,sub.name,canonical(sub.args),sub.url,sealed,sub.secretHash,version,sub.verifiedAt,sub.expiresAt);
      this.db.prepare('INSERT INTO native_subscription_fences VALUES(?,1) ON CONFLICT(id) DO UPDATE SET epoch=epoch+1').run(sub.id);
      return sub.expiresAt;
    });
  }
  revoke(id, owner) {
    this.transaction(() => {
      this.member({userId:owner});
      const old = this.metadata(id);
      if (old && old.owner_id !== owner) throw failure('forbidden', -32003);
      this.db.prepare('INSERT INTO native_subscription_fences VALUES(?,1) ON CONFLICT(id) DO UPDATE SET epoch=epoch+1').run(id);
      this.db.prepare('UPDATE native_subscriptions SET revoked=1 WHERE id=? AND owner_id=?').run(id,owner);
      this.db.prepare("UPDATE native_outbox SET state='terminal',lease_token=NULL,lease_expires_at=NULL,result=? WHERE subscription_id=? AND owner_id=? AND state NOT IN ('delivered','terminal')")
        .run(JSON.stringify({state:'terminal',reason:'revoked'}),id,owner);
    });
  }
  async subscription(owner, id) {
    const row = this.metadata(id);
    if (!row || row.owner_id !== owner) return null;
    try { this.authorize({userId:owner}, JSON.parse(row.arguments)); } catch { return null; }
    return { id, ownerId:owner, name:row.name, args:JSON.parse(row.arguments), url:row.url,
      secret:this.open(row.sealed_secret), version:row.version, verified:true,
      revoked:Boolean(row.revoked), expiresAt:row.expires_at };
  }
  authorizeDelivery(owner, sub, job) {
    try {
      this.authorize({userId:owner}, sub.args);
      const row = this.db.prepare(`SELECT m.channel_id,m.parent_id,m.id,n.agent_id,a.owner_id
        FROM mentions n JOIN messages m ON m.id=n.message_id JOIN agents a ON a.id=n.agent_id
        WHERE n.id=? AND m.author_kind='human'`).get(job.mentionId);
      return Boolean(row && row.owner_id === this.member({userId:owner}).id && row.agent_id === sub.args.recipient_agent_id
        && (!sub.args.channel_id || sub.args.channel_id === row.channel_id)
        && (!sub.args.thread_id || sub.args.thread_id === (row.parent_id ?? row.id)));
    } catch { return false; }
  }
  commitMessage(principal, input) {
    if (!input || Object.keys(input).some(k => !['requestId','channelId','parentId','body'].includes(k))) throw failure('invalid_message');
    const requestId=identifier(input.requestId), channelId=identifier(input.channelId);
    const parentId=input.parentId == null ? null : identifier(input.parentId);
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length>10000) throw failure('invalid_body');
    const body=input.body.trim();
    return this.transaction(() => {
      const member=this.member(principal), key=`human:${member.id}:${requestId}`;
      const requestHash=hash(JSON.stringify({channelId,body,parentId}));
      const existing=this.db.prepare('SELECT * FROM messages WHERE request_key=?').get(key);
      if (existing) {
        if(existing.request_hash!==requestHash) throw failure('request_conflict');
        return {id:existing.id};
      }
      if(!this.db.prepare('SELECT id FROM channels WHERE id=?').get(channelId)) throw failure('unknown_channel');
      if(parentId&&!this.db.prepare('SELECT id FROM messages WHERE id=? AND channel_id=? AND parent_id IS NULL').get(parentId,channelId)) throw failure('invalid_thread');
      const id='msg_'+randomUUID().replaceAll('-',''), now=this.now(), timestamp=new Date(now).toISOString();
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,channelId,parentId,member.id,'human',member.name,body,key,requestHash,timestamp);
      const roster=this.db.prepare('SELECT id,name FROM agents').all();
      const recipients=[...new Set(findAgentMentions(body,roster).map(m=>m.agentId))];
      for(const recipient of recipients) {
        const mentionId=id+':'+recipient;
        this.db.prepare('INSERT INTO mentions(id,message_id,agent_id,created_at) VALUES(?,?,?,?)').run(mentionId,id,recipient,timestamp);
        const owner=this.db.prepare('SELECT m.user_id FROM agents a JOIN members m ON m.id=a.owner_id WHERE a.id=?').get(recipient)?.user_id;
        if(!owner) continue;
        const subscriptions=this.db.prepare('SELECT * FROM native_subscriptions WHERE owner_id=? AND revoked=0 AND expires_at>?').all(owner,now);
        for(const sub of subscriptions) {
          const args=JSON.parse(sub.arguments), threadId=parentId??id;
          if(args.recipient_agent_id!==recipient || (args.channel_id&&args.channel_id!==channelId) || (args.thread_id&&args.thread_id!==threadId)) continue;
          this.authorize({userId:owner},args);
          const eventId='evt_'+hash(mentionId);
          const event={eventId,name:EVENT_NAME,timestamp,data:{mention_id:mentionId,message_id:id,
            recipient_agent_id:recipient,channel_id:channelId,thread_id:threadId},cursor:null};
          this.db.prepare(`INSERT INTO native_outbox(id,owner_id,subscription_id,subscription_version,mention_id,event_id,event_name,body,state,due_at)
            VALUES(?,?,?,?,?,?,?,?,'pending',?)`).run('job_'+hash(sub.id+':'+sub.version+':'+eventId),owner,sub.id,sub.version,mentionId,eventId,EVENT_NAME,JSON.stringify(event),now);
        }
      }
      return {id};
    });
  }
  async claim(id, now, leaseMs, principal) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs<1 || leaseMs>30000) throw failure('invalid_lease');
    return this.transaction(() => {
      this.member({userId:principal});
      const row=this.db.prepare(`SELECT * FROM native_outbox WHERE id=? AND owner_id=? AND due_at<=?
        AND (state IN ('pending','retry') OR (state='leased' AND lease_expires_at<=?))`).get(id,principal,now,now);
      if(!row) return null;
      if(row.attempt>=8) {
        this.db.prepare("UPDATE native_outbox SET state='terminal',lease_token=NULL,lease_expires_at=NULL,result=? WHERE id=?").run(JSON.stringify({state:'terminal',reason:'attempt_limit'}),id);
        return null;
      }
      const token=randomUUID();
      this.db.prepare("UPDATE native_outbox SET state='leased',attempt=attempt+1,lease_token=?,lease_expires_at=? WHERE id=?").run(token,now+leaseMs,id);
      return {id,ownerId:principal,subscriptionId:row.subscription_id,subscriptionVersion:row.subscription_version,
        mentionId:row.mention_id,eventId:row.event_id,eventName:row.event_name,body:row.body,attempt:row.attempt+1,leaseToken:token};
    });
  }
  async settle(id, token, result) {
    if(!['retry','delivered','terminal'].includes(result.state)) throw failure('invalid_outcome');
    if(result.state==='retry' && (!Number.isSafeInteger(result.nextAttemptAt)||result.nextAttemptAt<=this.now())) throw failure('invalid_retry');
    const safe={state:result.state};
    if(Number.isInteger(result.status)&&result.status>=200&&result.status<=599) safe.status=result.status;
    const reasons=['network','timeout','delivery_rejected','authorization_or_subscription','attempt_limit'];
    if(reasons.includes(result.reason)) safe.reason=result.reason;
    if(result.state==='retry') safe.nextAttemptAt=result.nextAttemptAt;
    return this.transaction(() => Boolean(this.db.prepare(`UPDATE native_outbox SET state=?,due_at=?,result=?,lease_token=NULL,lease_expires_at=NULL
      WHERE id=? AND lease_token=? AND state='leased' AND lease_expires_at>?`)
      .run(safe.state,safe.nextAttemptAt??this.now(),JSON.stringify(safe),id,token,this.now()).changes));
  }
}
