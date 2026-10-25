# Native lifecycle contract evidence

Status: isolated executable adapter; not deployed, not advertised as MCP events.
Implementation commit: 9457d95040fcc481de833c3cf7835d188d0c8769.
Local base: 58c985c88195d3c8675fe1cfdd71b79421a6fbc2.
Public patch base is PR4 (see LIFECYCLE_SCOPE.md); only new files are published.

Node v26.8.2, built-in node:sqlite; no dependency installation or real callback.
Commands independently rerun by integration owner:

```
node integrations/native-events/lifecycle.test.mjs
node integrations/native-events/native-events.test.mjs
```

Results: 22/22 lifecycle cases and 22/22 transport cases pass. The lifecycle tests
use temporary SQLite files initialized with actual repository SQL migrations,
the original mention parser, synthetic accounts, an AES-GCM test key and injected
callback requests. They exercise verifyCallback composition without opening
sockets. Reopening the database proves persistence, not a supervised executor.

| Requirement | Implementation | Source evidence | Live evidence |
| --- | --- | --- | --- |
| Owner-filtered discovery and deterministic subscription identity | Pure lifecycle methods | Ownership, validation and canonical identity cases | None |
| Challenge, bounded cache, refresh and unsubscribe | Persisted lifecycle and fences | Challenge failure, concurrent completion, membership loss, refresh/reopen | None |
| Recipient, room and thread binding | Domain lookup and original mention parser | Forged fields rejected; source context preserved | None |
| Atomic source message, mention and immutable outbox | SQLite transaction seam | Forced outbox failure rolls all writes back; request retries dedupe | None |
| Durable claims and retry settlement | SQLite rows and fencing tokens | Reopen, lease expiry, stale settlement, retry deadline and attempt cap | None |
| Secret protection | Required seal/open host injection | AES-GCM synthetic fixture; plaintext fallback rejected | Host key management absent |
| Secret replacement rotation | Explicitly rejected | Fail-closed test | Not implemented; protocol release blocker |
| Authenticated MCP HTTP endpoint | Not connected | Existing Worker remains tools-only | None |
| Durable event-driven execution | Not implemented | Rows retain state; no timer/supervisor claimed | None |
| Sites D1 atomic delivery boundary | Not integrated | D1 transaction seam identified; Node DB is separate | None |
| Fresh mention → invocation → reply/readback | Not implemented end to end | No synthetic test substitutes for activation | None |

Source message/activity integration is intentionally incomplete: commitMessage is
an isolated transaction seam, not a replacement for StudioService. Existing D1
records are neither read nor migrated. Schema is additive Node/SQLite test code,
not an applied Sites migration. No agent heartbeat or online status is fabricated.

A same-secret refresh after expiry may resume retained, nonterminal outbox rows;
it does not replay messages created while the subscription was inactive. Revoked
or terminal jobs do not revive. Changed-key refresh fails closed because the
existing transport has no dual-signature rotation window.

Remaining owner decision and cost are in HOSTING_PROPOSAL.md. That proposal is
for synthetic staging, and does not authorize production migration or deployment.
