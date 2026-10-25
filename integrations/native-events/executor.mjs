// Local single-authoritative-SQLite-store prototype. Persisted outbox deadlines
// survive WHOLE PROCESS restart; setTimeout itself is NOT durable. No polling.
// This cannot recover a lost D1 Worker wake while a separate supervisor survives.
import { deliverOne } from './outbox.mjs';
import { unsupportedWake } from './authoritative-batch.mjs';

export function localTimers(now = Date.now) {
  return { arm(at,callback) { return setTimeout(callback,Math.max(0,at-now())); }, cancel(handle) { clearTimeout(handle); } };
}

export class LocalOutboxExecutor {
  constructor({store,ownerId,send,now=Date.now,timers=localTimers(now),onError=()=>{},localPrototype=false}) {
    if(localPrototype!==true) throw unsupportedWake();
    if(!store?.db || typeof send!=='function' || !timers?.arm || !timers?.cancel || typeof onError!=='function') throw new Error('executor_adapters_required');
    store.member({userId:ownerId});
    Object.assign(this,{store,ownerId,send,now,timers,onError});
    this.generation=0;this.active=false;this.timer=null;this.running=false;
  }
  start() { if(this.active) return;this.active=true;this.generation++;if(!this.running)this.rearm(); }
  stop() { this.active=false;this.generation++;if(this.timer!==null)this.timers.cancel(this.timer);this.timer=null; }
  // A local producer may notify AFTER commit. Lost notification is recoverable
  // only through supervised process restart; do not use this as a D1 guarantee.
  notifyCommitted() { if(this.active&&!this.running)this.rearm(); }
  rearm() {
    if(!this.active)return;
    if(this.timer!==null)this.timers.cancel(this.timer);
    this.timer=null;
    const row=this.store.db.prepare(`SELECT min(CASE WHEN state='leased' THEN lease_expires_at ELSE due_at END) deadline
      FROM native_outbox WHERE owner_id=? AND state IN ('pending','retry','leased')`).get(this.ownerId);
    if(row.deadline===null)return;
    const generation=this.generation;
    const handle=this.timers.arm(Math.max(this.now(),row.deadline),async()=>{
      if(!this.active||generation!==this.generation||this.timer!==handle)return;
      this.timer=null;
      try {await this.drain(generation);} catch {this.onError(Object.assign(new Error('executor_failed'),{code:'executor_failed'}));}
    });
    this.timer=handle;
  }
  async drain(generation) {
    if(this.running)return;
    this.running=true;
    try {
      const rows=this.store.db.prepare(`SELECT id FROM native_outbox WHERE owner_id=? AND
        ((state IN ('pending','retry') AND due_at<=?) OR (state='leased' AND lease_expires_at<=?))
        ORDER BY due_at,id LIMIT 50`).all(this.ownerId,this.now(),this.now());
      for(const row of rows) {
        if(!this.active||generation!==this.generation)break;
        // A local stop is not a revoked subscription. Fence settlement for a
        // stopped generation; its lease remains recoverable after expiration.
        const generationStore={
          claim:(...args)=>this.store.claim(...args),
          subscription:(...args)=>this.store.subscription(...args),
          settle:(...args)=>this.active&&generation===this.generation?this.store.settle(...args):false
        };
        await deliverOne({store:generationStore,send:this.send,id:row.id,principal:this.ownerId,now:this.now,
          authorize:(...args)=>this.active&&generation===this.generation&&this.store.authorizeDelivery(...args)});
      }
    } catch(error) {
      // Unknown storage/auth failures require supervised intervention, not an
      // immediate same-row alarm loop. Durable rows remain for a later restart.
      this.stop();
      throw error;
    } finally {
      this.running=false;
      // start() may have resumed a newer generation while this send was pending.
      if(this.active)this.rearm();
    }
  }
}
