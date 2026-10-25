// D1-compatible prepared statements; the caller supplies StudioService's actual
// domain statements unchanged. Never inspect, rewrite, or intercept their SQL.
// Applying authoritative-schema.sql and schema.sql is a separate reviewed step.
export const unsupportedWake = () => Object.assign(new Error('unsupported_transactional_d1_wakeup'),
  {code:'unsupported_transactional_d1_wakeup'});

export function prepareAuthoritativeBatch(db, domainStatements, { messageId, nowMs }) {
  if (!db?.prepare || !Array.isArray(domainStatements) || !domainStatements.length ||
      typeof messageId!=='string' || !/^[A-Za-z0-9_:-]{1,100}$/.test(messageId) || !Number.isSafeInteger(nowMs))
    throw new Error('invalid_authoritative_batch');
  // Events derive exclusively from committed domain rows in this SAME batch.
  // IDs are generated once in the persisted event row; retries reuse exact bytes.
  const event = db.prepare(`INSERT OR IGNORE INTO native_source_events(mention_id,event_id,occurred_at_ms,body)
    SELECT n.id,'evt_'||lower(hex(randomblob(24))),?,json_object(
      'name','mention.created','timestamp',m.created_at,
      'data',json_object('mention_id',n.id,'message_id',m.id,'recipient_agent_id',a.id,
        'channel_id',m.channel_id,'thread_id',coalesce(m.parent_id,m.id)),'cursor',NULL)
    FROM mentions n JOIN messages m ON m.id=n.message_id
      JOIN agents a ON a.id=n.agent_id JOIN members owner ON owner.id=a.owner_id
    WHERE m.id=? AND m.author_kind='human' AND owner.user_id IS NOT NULL`).bind(nowMs,messageId);
  // Persist the eventId inside the same serialized envelope before outbox copy.
  const envelope = db.prepare(`UPDATE native_source_events SET body=json_set(body,'$.eventId',event_id)
    WHERE mention_id IN (SELECT id FROM mentions WHERE message_id=?) AND json_extract(body,'$.eventId') IS NULL`).bind(messageId);
  const outbox = db.prepare(`INSERT OR IGNORE INTO native_outbox
      (id,owner_id,subscription_id,subscription_version,mention_id,event_id,event_name,body,state,due_at)
    SELECT 'job_'||s.id||'_'||s.version||'_'||e.event_id,owner.user_id,s.id,s.version,n.id,e.event_id,
      'mention.created',e.body,'pending',?
    FROM native_source_events e JOIN mentions n ON n.id=e.mention_id
      JOIN messages m ON m.id=n.message_id JOIN agents a ON a.id=n.agent_id
      JOIN members owner ON owner.id=a.owner_id JOIN native_subscriptions s ON s.owner_id=owner.user_id
    WHERE m.id=? AND m.author_kind='human' AND s.name='mention.created' AND s.revoked=0 AND s.expires_at>?
      AND e.enqueued=0
      AND json_extract(s.arguments,'$.recipient_agent_id')=a.id
      AND (json_extract(s.arguments,'$.channel_id') IS NULL OR json_extract(s.arguments,'$.channel_id')=m.channel_id)
      AND (json_extract(s.arguments,'$.thread_id') IS NULL OR json_extract(s.arguments,'$.thread_id')=coalesce(m.parent_id,m.id))`)
    .bind(nowMs,messageId,nowMs);
  const mark=db.prepare(`UPDATE native_source_events SET enqueued=1
    WHERE mention_id IN (SELECT id FROM mentions WHERE message_id=?)`).bind(messageId);
  const wake = db.prepare(`INSERT INTO native_wake_intent(id,generation)
    SELECT 1,1 WHERE EXISTS(SELECT 1 FROM native_outbox o JOIN mentions n ON n.id=o.mention_id
      WHERE n.message_id=? AND o.state='pending')
    ON CONFLICT(id) DO UPDATE SET generation=generation+1`).bind(messageId);
  return [...domainStatements,event,envelope,outbox,mark,wake];
}

export async function commitAuthoritativeMessage(db, domainStatements, context, { localPrototype = false } = {}) {
  // Current Sites binding cannot transactionally register a durable wakeup.
  // The explicit local mode exists for same-store executable fault tests only.
  if (localPrototype !== true) throw unsupportedWake();
  return db.batch(prepareAuthoritativeBatch(db,domainStatements,context));
}
