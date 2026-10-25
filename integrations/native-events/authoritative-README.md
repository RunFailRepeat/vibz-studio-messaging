# Authoritative transaction seam and local executor candidate

This addition is not deployed and does not activate an agent. No production
StudioService, UI, transport, or lifecycle files are changed. Local base is
`326d2b19cc861e819e5996f90cffaf0b67d116e4`; public stacking base is PR11
`e16265265546f6a4c7b38b7cdb391de4255124e7` (not locally available at implementation).

## What executes

`prepareAuthoritativeBatch` appends event, outbox and wake-intent statements to
the caller's unchanged D1 prepared statements. One `db.batch` transaction contains
the real message, mention and activity/UI writes alongside native rows. Recipient,
owner, room, thread, and occurrence timestamp come from domain joins, not callback
request fields. Persisted event IDs use SQLite random bytes once, are compatible
with the signed transport, and remain stable with identical serialized bytes on
retries. A persisted enqueue marker prevents replaying the same domain batch from
backfilling new subscriptions. No SQL text inspection or DB interception is used
in this production helper.

Apply existing domain migrations, native `schema.sql`, then
`authoritative-schema.sql` to one authoritative database when evaluating locally.
The tests capture actual `StudioService` prepared statement objects without
rewriting them, remove only the capture's rows, and execute those same objects
through the composition helper. They exercise real SQLite transactions, including
rollback of message, mentions and activity on outbox or wake-intent failure.
This is D1-compatible SQL tested through the SQLite-backed D1 harness, not evidence
of deployed D1 behavior.

`authoritative-integration.patch` is an **unapplied review proposal** for the
Portfolio-owned `lib/studio.ts` call site. It adds the helper import and wraps only
the existing writeMessage batch. All original domain statements remain intact.
The proposed call intentionally fails closed by default:
`unsupported_transactional_d1_wakeup`. Clearing source ownership alone does not
clear this hosting gate. The explicit `localPrototype:true` option is only for
isolated, same-store local tests; do not enable it in Sites to bypass the gate.
The zero-context proposal can be checked without applying it using
`git apply --unidiff-zero --check integrations/native-events/authoritative-integration.patch`.

## Executor and crash models

`LocalOutboxExecutor` reads persisted due/lease deadlines at supervised startup,
after explicit local commit notification, and after a dispatched batch. It arms
one exact local timer and remains idle with no timer when no jobs exist. It does
not periodically scan mentions or source messages. A whole-process crash after
commit but before notification is recoverable at restart because the outbox and
retry/lease deadlines share the authoritative SQLite store. Tests include this
complete path using the real captured StudioService mutation and fake callbacks.

These timers are not durable by themselves. If a Sites Worker request dies after
D1 commit while a separate Node supervisor stays alive, there is neither a wake
nor a startup scan. An explicit negative test preserves that gap. Persisting a
wake-intent row is not registering an alarm/queue. Current bindings have no
verified operation to register durable execution atomically with the D1 batch;
both production commit and executor construction fail closed unless explicitly
selected as a local prototype. No production scheduler or recovery guarantee is
claimed.

Stopping prevents later sends/rearming from old callbacks; it cannot retract
bytes already sent. Stop/start during an in-flight request rearms the current
generation after that request finishes.
Local cancellation fences settlement, leaving the claimed lease recoverable
instead of recording a false authorization revocation. An already-sent request
may consequently be retried with its stable event ID after lease expiry.
Unexpected store/authentication errors
stop the executor and report a sanitized error once, rather than immediately
retrying the same row forever. Durable rows remain for supervised intervention.

## Authentication and remaining release gates

`authenticatedHandler` requires an injected trusted verifier. The verifier must
validate credentials against configured trust, including signature, issuer and
revocation. The wrapper checks verified audience, expiry and human identity, then
copies only the verified subject into an immutable principal. Raw headers and
JSON fields never provide fallback identity. No credential, verifier service, or
HTTP route is provisioned.

Remaining gates: approved call-site ownership and integration, actual D1 validation,
transactionally registered durable wakeup or an approved same-store authoritative
host, real trusted authentication/key storage, secret rotation support, supervised
deployment, and fresh signed mention-to-invocation-to-same-thread-reply evidence.
The prior lifecycle secret-rotation rejection is unchanged.

## Validation

Run the three new suites plus the two existing native suites:

```sh
node integrations/native-events/authoritative-batch.test.mjs
node integrations/native-events/executor.test.mjs
node integrations/native-events/host-auth.test.mjs
node integrations/native-events/lifecycle.test.mjs
node integrations/native-events/native-events.test.mjs
```

All identities, encryption fixtures and callbacks are synthetic. No model, network
callback, service purchase, installation, access grant or deployment is used.
