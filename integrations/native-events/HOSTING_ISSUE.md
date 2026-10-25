# Provision and verify native event-delivery prerequisites before activation

Status: blocked prerequisite, not a completed native activation fix.
Track hosting work in existing repository issue #3; this document is supporting
evidence and does not request a duplicate issue.

Baseline archive: `a5705cb7b9873bfe14e3d34bf66effe5fd7685fd07fc12d6b709ce9610db86b4`.

Required evidence before enabling events:

- An owner-approved Node host with reviewed DNS-to-socket pinning, normal TLS
  verification, public-address policy, no redirects and bounded resource use.
  Sites has no verified equivalent facility for this integration today.
- Durable owner-scoped subscription storage, protected callback secrets, expiry,
  refresh, verification, revocation, canonical identity and authenticated MCP routes.
- Atomic application mutation plus outbox insertion; D1 commit then HTTP enqueue
  leaves a loss window and is not accepted as atomic delivery.
- A durable event-driven scheduler with transactional retry scheduling, fencing,
  crash recovery, bounded retry attempts and terminal 410/413 handling. No polling.
- Authorization/filter checks at subscription and delivery time, synthetic tests
  for membership loss, expiry, secret replacement, duplicates and worker crashes.
- Independent review of this candidate, real transport tests in approved test
  infrastructure, then authenticated mention → event → Run reply evidence with
  correct thread routing and idempotent replies. HTTP 2xx alone is insufficient.

No infrastructure, credential creation, installation, security/network changes,
public push of this experiment, merge, or deployment is authorized by this issue.
Those require owner coordination. Keep production bindings and personal data private.
