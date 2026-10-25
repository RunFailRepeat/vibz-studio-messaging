# Native events review candidate — not connected or deployed

This isolated addition is based on public archive SHA-256
`a5705cb7b9873bfe14e3d34bf66effe5fd7685fd07fc12d6b709ce9610db86b4`,
and public repository baseline `d39051a5f0ce6c1d9009f425fd5324fe4a187193`.
All original snapshot files remain unchanged. Exclusive added paths are this
directory's `transport.mjs`, `outbox.mjs`, `native-events.test.mjs`, `README.md`
and `HOSTING_ISSUE.md`. This code awaits independent review before public push.

No native activation is claimed. Sites currently lacks verified secure transport
and durable retry facilities for this integration. D1 commit followed by HTTP
enqueue is not atomic. Do not advertise event support or activate subscriptions
until the infrastructure and authenticated event → Run reply flow are proven.

## Transport

`createTransport()` sends a bounded signed HTTPS POST, with a total 10-second
deadline including DNS. Every attempt resolves all addresses anew, fails closed
if any address is disallowed, and pins one validated address without losing
Host, TLS SNI or certificate verification. Each request uses a fresh connection.
Redirect responses are returned, never followed. Request and response bounds
are 256 KiB and 16 KiB; response headers are capped at 16 KiB.

This conservative first candidate permits only public IPv4 DNS results, default
HTTPS port, and DNS hostnames. All IPv6 results (even public ones), literal IPs,
and alternate ports are rejected. Dual-stack destinations therefore fail closed.
Review the IPv4 deny policy against current IANA special-purpose registries and
implement a reviewed IPv6 policy before broadening compatibility. No host-supplied
proxy or custom agent is accepted. Trusted dependency injection exists for tests.

The signer uses HMAC-SHA256 over ID, Unix seconds and exact serialized bytes,
with canonical base64 `whsec_` keys of 24–64 bytes. Verification uses a fresh
random challenge and constant-time comparison. No logging is implemented.
Never log callback paths, secrets, payloads, headers, or raw network errors.

## Durable adapter contract — REQUIRED, not implemented here

The host must implement `DurableOutbox`; its abstract methods fail closed.
Do not substitute an in-memory store. A single transaction must commit the
domain mutation and matching immutable outbox rows, including owner ID,
subscription ID/version, unique event ID, event name, exact serialized body,
occurrence timestamp, attempt count, and next attempt time. Validate event schema
and owner-visible filters before insertion. IDs/bodies remain stable across retries.
Store callback secrets separately in protected subscription storage, not jobs.

`claim(id, now, leaseMs, principal)` must atomically select only that owner's due
nonterminal job, acquire a unique fencing token, and increment `attempt` exactly
once. Return null for a foreign owner, active lease, future retry, or terminal job.
`subscription(owner, id)` must return current owner-scoped state, including
`id, ownerId, name, version, verified, expiresAt, revoked, url, secret`.
`settle(id, leaseToken, outcome)` must compare-and-swap the live lease, persist the
outcome, and atomically schedule a durable delayed retry when required. It returns
false for a stale lease. An expired/crashed lease must receive a durable redelivery.
Host wakeups must be event-driven; there is no polling substitute in this module.

`deliverOne` requires a trusted principal and a host authorization callback that
rechecks event/filter access, including membership revocation. It reloads current
subscription state after DNS. Revocation cannot retract bytes already sent; define
and test transaction/dispatch ordering for in-flight operations. A secret/URL change
must bump subscription version so stale jobs stop; explicitly requeue retained
events under the newly verified version rather than silently changing recipients.
Only network errors, timeouts, 408, 429 and 5xx retry, at most eight attempts.
Once validated response headers arrive, the HTTP status controls delivery
classification even if reading the body aborts, times out, or exceeds 16 KiB.
The transport rejects those reads with a numeric `status` on the error; only
`deliverOne` uses it to settle delivery. Callback verification still rejects the
same errors and never accepts a partial challenge response.
410/413 are terminal for that delivery; subscription-level 410 handling belongs
in the host lifecycle policy. Stable IDs permit receiver deduplication after
delivery succeeds but acknowledgement persistence fails. Receipt is not a Run reply.

Subscription methods, canonical deterministic subscription identity, owner-only
unsubscribe, bounded verification cache, encrypted secret persistence, rotation,
schema validation, and scheduling are host prerequisites, not implemented routes.
This helper allows one key; a host must not claim rotation-window support until
reviewed multi-key signing is implemented. It does not advertise MCP capabilities.

## Offline verification

Run `node integrations/native-events/native-events.test.mjs` (or `node --test`).
Executed locally on Node v26.8.2: 22 tests passed, zero failures/skips on 2026-10-25.
The original 19 tests passed before the repair. Added regressions failed before
the repair and now exercise 20 status/body-failure combinations (204, 410, 413,
429, 503 against abort, error, deadline, and oversize response), strict challenge
failure even with a correct echo prefix, and malformed final response statuses.
Tests inject DNS and HTTPS doubles; no socket or real credential is used.
No dependencies are installed. These tests do not validate real DNS/TLS, a durable
database adapter, callback acceptance by ChatGPT, or an agent reply.

Protocol reference: [official MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events).

## Provenance and remaining integration evidence

Imported from the reviewed experimental archive. Input archive SHA-256:
`14e24b39ab3609d252aab1138937d7e8bfd219fe771f6b36697533f90b6eec07`.
The archive hash was verified before extraction. These files are an experimental
Node component, not a Worker-compatible deployment or an activation claim.

| Requirement | Implemented | Source-tested | Live-tested | Remaining blocker |
| --- | --- | --- | --- | --- |
| Signed bounded transport and callback challenge | Candidate | Injected DNS/HTTPS tests | No | Approved host and real TLS/DNS integration tests |
| Preserve status on response-body failure | Yes | 20-combination regression | No | Independent review |
| Subscription ownership, expiry, revocation checks | Adapter contract and dispatch checks | Synthetic store tests | No | Durable subscription implementation |
| Atomic domain mutation/outbox and durable retries | Contract only | No real adapter | No | Approved persistence/scheduler infrastructure |
| Authenticated event discovery/subscribe/unsubscribe | No | No | No | MCP 2.0 route and lifecycle implementation |
| Fresh mention → signed event → invocation → same-thread reply | No | No | No | All prior prerequisites and owner-approved live verification |

Official MCP Events documentation was checked on 2026-10-25. It requires MCP
2.0 (`2026-07-28`), authenticated discovery/subscription methods, persistent
subscriptions, verified callbacks, and stable event IDs. It explicitly excludes
polling. The current `app/mcp/route.ts` advertises `2026-07-28` alongside older
versions but only the tools capability; it has no native event methods. Keep this candidate disconnected
until the route, persistence, and host prerequisites are implemented and tested.
