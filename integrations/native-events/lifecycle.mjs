// Review-only lifecycle functions, NOT an HTTP route or event capability advertisement.
// Wire reference checked 2026-10-25: https://developers.openai.com/plugins/build/mcp-events
// Host must authenticate principal out of band, use the secure transport verifier,
// protect seal/open keys, and supply durable event-driven scheduling. No defaults.
import { createHash } from 'node:crypto';
import { callbackURL, signature } from './transport.mjs';

export const EVENT_NAME = 'mention.created';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])));
export function failure(reason, code = -32602) {
  return Object.assign(new Error(reason), { code, data: { reason } });
}
export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_:-]{1,100}$/.test(value)) throw failure('invalid_identifier');
  return value;
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw failure('invalid_arguments');
}
export function filters(value) {
  exact(value, ['recipient_agent_id', 'channel_id', 'thread_id']);
  const result = { recipient_agent_id: identifier(value.recipient_agent_id) };
  for (const key of ['channel_id', 'thread_id']) if (value[key] !== undefined) result[key] = identifier(value[key]);
  if (result.thread_id && !result.channel_id) throw failure('thread_requires_channel');
  return result;
}
const subscriptionId = (owner, url, args) => 'sub_' + hash(JSON.stringify([owner, url, EVENT_NAME, canonical(args)]));

export class NativeLifecycle {
  constructor({ store, verify, now = Date.now }) {
    if (!store || typeof verify !== 'function') throw failure('host_adapters_required');
    Object.assign(this, { store, verify, now });
  }
  list(principal, params = {}) {
    exact(params, ['cursor']);
    if (params.cursor != null) throw failure('unsupported_cursor');
    const agents = this.store.ownedAgents(principal);
    return { events: agents.length ? [{ name: EVENT_NAME,
      description: 'A human message mentions one of the connected account’s agents in its source room and thread.',
      delivery: ['webhook'], inputSchema: { type: 'object', additionalProperties: false,
        properties: { recipient_agent_id: { type: 'string', enum: agents.map(a => a.id) },
          channel_id: { type: 'string' }, thread_id: { type: 'string' } }, required: ['recipient_agent_id'] },
      payloadSchema: { type: 'object', additionalProperties: false,
        properties: Object.fromEntries(['mention_id','message_id','recipient_agent_id','channel_id','thread_id'].map(k => [k,{type:'string'}])),
        required: ['mention_id','message_id','recipient_agent_id','channel_id','thread_id'] }
    }] : [] };
  }
  parse(principal, params, subscribing) {
    exact(params, subscribing ? ['name','arguments','delivery','cursor','ttlMs'] : ['name','arguments','delivery']);
    if (params.name !== EVENT_NAME || (subscribing && params.cursor != null)) throw failure('unsupported_event_or_cursor');
    const args = filters(params.arguments);
    exact(params.delivery, subscribing ? ['mode','url','secret'] : ['mode','url']);
    if (params.delivery.mode !== 'webhook') throw failure('unsupported_delivery');
    let url;
    try { url = callbackURL(params.delivery.url).href; } catch { throw failure('invalid_destination'); }
    // Unsubscribe is scoped by authenticated subscription owner, even when the
    // original room/thread or agent ownership no longer exists.
    const owner = subscribing ? this.store.authorize(principal, args) : this.store.member(principal).user_id;
    return { id: subscriptionId(owner, url, args), ownerId: owner, name: EVENT_NAME, args, url };
  }
  async subscribe(principal, params) {
    const sub = this.parse(principal, params, true), secret = params.delivery.secret;
    try { signature(secret, 'validation', '0', '{}'); } catch { throw failure('invalid_secret'); }
    // Non-expiring subscriptions are not granted. Short requested lifetimes are honored.
    const ttl = params.ttlMs == null ? 3600000 : params.ttlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1) throw failure('invalid_ttl');
    const duration = Math.min(ttl, 86400000), epoch = this.store.epoch(sub.id);
    const existing = this.store.metadata(sub.id);
    const secretHash = hash(secret);
    // Existing transport is single-key: fail closed instead of pretending dual-sign rotation.
    if (existing && existing.secret_hash !== secretHash) throw failure('secret_rotation_requires_host_support');
    const cachedAt = this.store.verificationCached(sub.ownerId, sub.url, secretHash, this.now());
    if (cachedAt === null) {
      try {
        if (await this.verify({ ...sub, secret }, () => {
          try { this.store.authorize(principal, sub.args); return true; } catch { return false; }
        }) !== true) throw failure('challenge_failed');
      } catch (error) {
        throw failure(error.code === 'timeout' ? 'timeout' : 'challenge_failed', -32015);
      }
    }
    this.store.authorize(principal, sub.args); // Authentication/access can change during verification.
    const expiresAt = this.now() + duration;
    const grantedExpiry = this.store.activate({ ...sub, secret, secretHash, expiresAt, verifiedAt: cachedAt ?? this.now() }, epoch);
    return { id: sub.id, refreshBefore: new Date(grantedExpiry).toISOString(), cursor: null, truncated: false };
  }
  unsubscribe(principal, params) {
    const sub = this.parse(principal, params, false);
    this.store.revoke(sub.id, sub.ownerId);
    return {};
  }
}
