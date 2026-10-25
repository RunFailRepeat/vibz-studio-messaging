# Authoritative transaction/executor evidence

Implementation: 373c7ad7f83bd8f0529a97fe5911876ab09a9d61.
Local base: 326d2b19cc861e819e5996f90cffaf0b67d116e4.
Public patch base: PR11 e16265265546f6a4c7b38b7cdb391de4255124e7.
Only independent native-event additions and hosting-note updates are included;
no privately supplied review-fence contribution was copied or published.

Integration owner independently executed on Node 26.8.2:

```
node integrations/native-events/authoritative-batch.test.mjs   # 6 pass
node integrations/native-events/executor.test.mjs              # 8 pass
node integrations/native-events/host-auth.test.mjs             # 3 pass
node integrations/native-events/lifecycle.test.mjs             # 22 pass
node integrations/native-events/native-events.test.mjs         # 22 pass
git apply --unidiff-zero --check integrations/native-events/authoritative-integration.patch
```

Total: 61 behavioral cases pass. No install, live callback, real credential,
new account, provider service or deployment was used. The patch check passes
against this public baseline; it is not applied to protected source paths.

The integrated local fault journey uses the actual StudioService mutation
statements and the same physical SQLite store for message, mention, activity,
event/outbox and lease settlement. A process restart reconstructs pending work
and dispatches a fake callback with the stable event identity. This is stronger
than testing an independent toy domain, but does not emulate every D1 runtime
behavior or prove a hosted wakeup.

Independent review reproduced and drove fixes for stop/start stranding work,
revoked-member immediate retry loops, and cancellation after claim incorrectly
settling a valid event terminal. Regression tests distinguish local cancellation
from revoked authorization and retain recoverable leases. Activity rollback and
immutable event/body behavior are checked alongside those faults.

| Requirement | Source-tested status | Live status |
| --- | --- | --- |
| Same-store source/activity/outbox batch | Real source statements and SQLite rollback cases | Not applied to deployed D1 |
| Whole-process crash/restart, expired lease, scheduled retry | Integrated local fault cases | Supervisor not deployed |
| Worker request crash while separate executor remains alive | Explicit unsupported/loss-window case | Not solved |
| Trusted authentication adapter | Injected verifier tests; no raw identity fallback | Real issuer/signature/revocation verification not configured |
| Durable alarm registered with D1 commit | Production path fails closed | Current Sites capability unverified |
| Secure callback transport on free runtime | Existing Node reference tests only | Equivalent free-runtime protection unverified |
| Fresh tag → signed event → unnudged reply | Not established | Not established |

The owner requires free hosting only. HOSTING_PROPOSAL.md supersedes the earlier
paid proposal and records official free-runtime limits and unresolved capability
gates. No paid approval is requested. Secret rotation remains explicitly blocked.
