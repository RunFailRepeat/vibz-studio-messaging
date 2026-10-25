# Native lifecycle independent review

Exact reviewed candidate: `9457d95040fcc481de833c3cf7835d188d0c8769` on
`repair/native-lifecycle`, based on local integration commit
`58c985c88195d3c8675fe1cfdd71b79421a6fbc2`.
Status: no blocking finding for publishing the four-file **review-only adapter**.
Production native activation remains blocked by the release prerequisites below.
Review scope is the new lifecycle/store/schema candidate, not a repeated broad
audit of the previously reviewed transport.

## Existing source boundary

`lib/studio.ts` already commits message, mention receipts, and activity in one
`db.batch` in `writeMessage`. An outbox record must join that same database
transaction, guarded by the committed message/mention identity. Creating a
separate local SQLite job after a remote D1 commit cannot make those operations
atomic. Offline SQLite can prove an equivalent same-database transaction, but
that does not prove deployed D1 integration.

Current `worker/index.ts` exports only a fetch handler. The inspected Vite
configuration declares D1/R2 and a development connector service; it supplies no
durable queue/scheduler implementation or verified DNS-to-socket-pinned callback
transport. Node compatibility flags are not evidence those facilities exist.
`app/mcp/route.ts` advertises tools only and has no events lifecycle methods.

Source binding must derive mention/message/root/channel/recipient from database
rows. Existing mention replies obtain the source message from the mention and
derive root as `source.parent_id ?? source.id`; event payload fields must not
override those values. Subscription owner must map to the authenticated member
and that member's agent, not a caller-provided owner or agent identity.

## Protocol and implementation review criteria

The [official MCP Events reference](https://developers.openai.com/plugins/build/mcp-events)
specifies authenticated lifecycle methods, deterministic principal-scoped
subscription identity, verified callback challenges, persisted expiry/revocation,
stable event IDs, and bounded retries. Refresh with a replacement secret includes
a short dual-signature rotation window. Receipt acknowledgment is not evidence
that the agent replied. Unsupported lifecycle features must remain explicit.

Candidate evidence must execute real SQLite for owner/filter isolation, canonical
identity, failed challenge handling, expiry/revoke/refresh races, server-derived
source context, atomic source/outbox rollback, duplicate insertion, restart after
commit-before-dispatch, leased claims, stale settlements, exhausted attempts, and
retry persistence. No synthetic result should be described as native activation.

No installs, credentials, services, access changes, or deployment were performed.

## Final independent implementation result

Reviewed `lifecycle.mjs`, `sqlite-store.mjs`, `schema.sql`, and
`lifecycle.test.mjs`. Tests use real temporary SQLite files, existing domain
migrations and the source mention parser; they reopen databases to exercise
persistence. Tested runtime: Node **26.8.2** (native TypeScript stripping is
needed for the parser import).

Commands independently run on the exact candidate:

```sh
node integrations/native-events/lifecycle.test.mjs
node integrations/native-events/native-events.test.mjs
git diff --check
```

Result: **22 lifecycle + 22 transport tests pass**, zero failures/skips;
diff check passes. Existing source mention tests also passed 12/12 earlier in
this review, confirming the source transaction/thread-binding baseline.

Review feedback corrected three draft behaviors: cached refreshes now preserve
the original successful-challenge time; unsubscribe remains scoped to the
authenticated owner after a resource or agent relationship disappears; concurrent
same-identity subscriptions converge to existing active state without overwriting
newer expiration. An independent SQLite probe initially reproduced the concurrent
CAS rejection before that correction. Final tests explicitly cover convergence,
revoke during verification, changed keys, and access loss.

Actual `verifyCallback` composition rejects a wrong echo and accepts an exact
echo. Stable owner-scoped identities, request deduplication, source-derived
recipient/room/root, transaction rollback on outbox failure, expired lease
reclaim, stale settlement rejection, persisted retry deadlines, and a crashed
eighth attempt are exercised. The eighth expired lease becomes terminal on the
next claim without a ninth delivery.

Same-secret refresh preserves the subscription version. After expiry, retained
undelivered jobs may resume if the subscription is explicitly refreshed before
those jobs become terminal; terminal jobs are never revived. Revocation terminates
pending/leased jobs, and reactivation increments the version. These policies are
tested rather than inferred from a feature list.

## Release blockers and hosting-note assessment

- **Secret rotation is deliberately rejected.** This is safe failure behavior for
  this adapter, not compliance with the official replacement-secret rotation
  lifecycle. Dual signatures and host key management remain release work.
- No authenticated HTTP lifecycle router or production event capability is
  enabled. The host must authenticate the supplied principal; the adapter cannot
  establish identity from a raw caller-provided user ID.
- `seal`/`open` are mandatory injected functions with no plaintext fallback.
  Tests use synthetic AES-GCM encryption. Production encryption, key protection,
  and the correctness of supplied adapters are not established by these tests.
- Durable rows and retry deadlines exist, but no event-driven executor or
  supervised wakeup/recovery service is implemented. Persistence alone is not
  reliable activation.
- `commitMessage` is an isolated same-SQLite transaction seam, not the existing
  D1 message path or a complete StudioService replacement. Activity/UI integration
  and the production atomic dispatch boundary remain unresolved.
- Real DNS/TLS, callback acceptance, authenticated lifecycle traffic, and a fresh
  source mention producing an unnudged same-thread Run reply remain unverified.

The inspected `HOSTING_PROPOSAL.md` and `LIFECYCLE_SCOPE.md` correctly separate
synthetic single-node staging from production D1 integration, require owner
approval, and state that the executor is still missing. This review approves
neither spending nor provisioning. Keep that separation in any public draft.

## Exact file fingerprints

| File under integrations/native-events | SHA-256 |
| --- | --- |
| lifecycle.mjs | `8017aa8911a2d935bbe5e676dd590464a29f934eabe0e5e25df9a22b5ad5c4ee` |
| sqlite-store.mjs | `4ebb747713e5647e298981842d80c236b290eb51110914457eeae44258b501af` |
| schema.sql | `8898a47e4a7c0fa41ce082adaf68dd2fb61b3a9e58765e6ae42fccfa8809594b` |
| lifecycle.test.mjs | `0feaf35b33a38916dab5b9ffdfaad959270e50679b37446d7661fa7c6fa6b44e` |

A publication assembled on a different Git base must preserve these contents and
compatible reviewed transport/outbox dependencies before inheriting this result.
