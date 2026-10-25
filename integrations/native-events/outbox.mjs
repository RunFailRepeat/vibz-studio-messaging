// Host-implemented durable adapter. See README.md for transaction/lease contract.
// No timer, service, credential store, or in-memory production fallback.
export class DurableOutbox {
  async claim(_id, _now, _leaseMs, _principal) { throw new Error('durable_adapter_required'); }
  async subscription(_ownerId, _subscriptionId) { throw new Error('durable_adapter_required'); }
  async settle(_id, _leaseToken, _result) { throw new Error('durable_adapter_required'); }
}

export function disposition(status) {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'retry';
  return 'terminal'; // Includes 410, 413 and all redirects. Never follow Location.
}

// Called by a durable event-driven scheduler for a specific outbox ID.
// principal is server-authenticated; it must not come from event payload fields.
export async function deliverOne({ store, send, authorize, id, principal, now = Date.now }) {
  if (!principal || typeof authorize !== 'function') throw new Error('unauthorized');
  // claim MUST scope by owner before changing state, preventing cross-owner DoS.
  const job = await store.claim(id, now(), 30000, principal);
  if (!job) return { state: 'unavailable' };
  if (job.ownerId !== principal) throw new Error('adapter_owner_violation');
  let outcome;
  const active = async () => {
    const sub = await store.subscription(principal, job.subscriptionId);
    if (!sub || sub.ownerId !== principal || sub.revoked || !sub.verified ||
      !Number.isFinite(sub.expiresAt) || sub.expiresAt <= now() ||
      sub.version !== job.subscriptionVersion || sub.name !== job.eventName) return null;
    return await authorize(principal, sub, job) ? sub : null;
  };
  try {
    const sub = await active();
    if (!sub) outcome = { state: 'terminal', reason: 'authorization_or_subscription' };
    else {
      const event = JSON.parse(job.body);
      if (event.eventId !== job.eventId || event.name !== job.eventName ||
          !Number.isInteger(job.attempt) || job.attempt < 1 || job.attempt > 8) throw new Error('invalid_job');
      const response = await send({ url: sub.url, secret: sub.secret,
        subscriptionId: sub.id, id: job.eventId, body: job.body,
        // Re-read authorization/expiry/revocation after DNS, just before request.
        authorize: async () => Boolean(await active()) });
      outcome = { state: disposition(response.status), status: response.status };
    }
  } catch (error) {
    // Never persist raw errors: they can contain destination URLs or credentials.
    if (Number.isInteger(error.status) && error.status >= 200 && error.status <= 599) {
      // The transport validated headers before the body failed. A body limit or
      // disconnect must not turn 410/413 into retries, or 429/5xx into terminal.
      outcome = { state: disposition(error.status), status: error.status };
    } else {
      const retry = ['network', 'timeout'].includes(error.code);
      outcome = { state: retry ? 'retry' : 'terminal', reason: retry ? error.code : 'delivery_rejected' };
    }
  }
  if (outcome.state === 'retry') {
    if (job.attempt >= 8) outcome = { state: 'terminal', reason: 'attempt_limit' };
    else outcome.nextAttemptAt = now() + Math.min(60000 * 2 ** (job.attempt - 1), 3600000);
  }
  // Atomic compare-and-swap on lease token. A stale worker must not settle.
  if (!(await store.settle(job.id, job.leaseToken, outcome))) return { state: 'lease_lost' };
  return outcome;
}
