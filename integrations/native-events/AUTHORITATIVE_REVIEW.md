# Authoritative transaction and executor independent review

Exact reviewed candidate: `373c7ad7f83bd8f0529a97fe5911876ab09a9d61`
(implementation commit `8aa3e65`), branch `repair/native-authoritative`.
Status: no blocking finding for review-only publication of the new additions and
unapplied source patch. Production activation remains blocked. Review covers only
new authoritative transaction, executor, and host-auth work; prior
lifecycle/transport review is not being repeated as a checklist.

The production reference is `StudioService.writeMessage` in `lib/studio.ts`:
one D1 batch inserts the message, conditional message activity, each unique
human-origin mention, and each conditional mention activity. Request identity
and content hashes prevent duplicate or conflicting mutations. The new seam must
preserve those business effects and add outbox insertion to that same database
transaction. A second SQLite transaction or post-commit HTTP call cannot provide
that atomicity. No SQL-text interception is an acceptable integration mechanism.

The platform worker remains HTTP-only with no proven supervised durable scheduler.
An injected local timer executor can prove scheduling/recovery code, not that the
current production host will wake it. The report will distinguish committed job
durability, startup rearming, and actual platform execution.

No runtime files, installs, live services, credentials, or deployment are part of
this review lane. Findings and exact test results will be recorded here.

## Transaction and identity findings

The production helper keeps the original prepared statement objects intact and
appends event, outbox, and wake-intent statements to the same D1-shaped batch.
The test fixture captures actual StudioService objects without inspecting or
rewriting their SQL, removes its temporary captured rows, then executes the
composed batch against one real SQLite database. This is an isolated fixture,
not a production interception mechanism.

The unapplied call-site proposal adds an import and replaces only the batch call
and its closing arguments; the original message, mention, and activity statement
bodies are unchanged. Production commit rejects with
`unsupported_transactional_d1_wakeup` before mutation unless explicitly selected
as a local prototype. Applying the patch alone would therefore not enable a
working production message path and must not be done as a hosting workaround.

Source event context comes from messages/mentions/agents/members joins. Subscription
owner and recipient are not taken from an external payload. Event IDs use 24
persisted random bytes encoded as hex with an `evt_` prefix: fixed 52 characters,
independent of maximum domain ID lengths and compatible with transport validation.
No unsupported SQL SHA function is assumed. Serialized events and IDs persist
unchanged on replay; an enqueue marker prevents later-subscription backfill.

The auth wrapper has no caller-header/JSON identity fallback. It requires a trusted
verifier, checks returned audience, expiry, and human kind, and passes only a
frozen verified subject to the handler. Actual credential verification is still
injected and unprovisioned; this factory is not proof of deployed authentication.

## Independently reproduced and corrected executor defects

1. Stop/start during an awaited send left a second pending job with zero timers.
   Final code defers startup rearm while a drain is active and rearms the current
   generation after the old request finishes, without sending the old drain's
   remaining work.
2. Revoking the owner after startup produced repeated immediate failed claims of
   the same pending row. Final code stops on drain storage/auth failures and
   reports one sanitized failure, retaining durable work for intervention.
3. Stopping immediately after claim made `authorize=false` permanently settle a
   still-authorized job as terminal without sending it. Final code fences
   settlement by executor generation, leaving the cancelled lease recoverable.
   An independent final probe now observes `leased`, advances to expiry, restarts,
   and delivers once with the original event ID.

All three were reproduced with the production executor and actual SQLite fixture,
not inferred only from mocks. The final suite covers the corrected cases.

## Exact independent verification

Node 26.8.2; no external callback/model calls:

```sh
node integrations/native-events/authoritative-batch.test.mjs
node integrations/native-events/executor.test.mjs
node integrations/native-events/host-auth.test.mjs
git apply --unidiff-zero --check integrations/native-events/authoritative-integration.patch
git diff --check
```

Results: **6 batch + 8 executor + 3 auth = 17 new tests pass**, zero failures/skips;
patch and diff checks pass. Integration owner separately reports the same exact
candidate passes the unchanged 22 lifecycle and 22 transport cases, for 61 total.

Crash/recovery evidence is precise: after a real same-database source/outbox commit
and no wake notification, the fixture closes/reopens the SQLite file and starts a
new executor with empty injected timers. Startup arms due work and dispatches it.
Other cases retain the retry deadline across reopen, wait until exactly due,
recover an expired lease, and reject its stale settlement. These are deterministic
fault simulations, not a killed deployed service or platform alarm test.

A deliberate negative test starts an idle supervisor, commits from a producer,
then omits the wake while the supervisor survives. No timer appears and the job
stays pending. That demonstrates the unrepaired production split-runtime gap.

## Release and ownership limits

- Wake intent is durable data, not a transactionally registered platform wakeup.
  The inspected Sites bindings still do not establish that capability. Local
  timers do not repair a D1 request failure while a separate supervisor survives.
- The integration patch remains unapplied and must be reconciled with Portfolio's
  exact source revision. Its zero-context apply check covers this baseline only.
- Real D1 execution, migrations, host identity verification, protected keys,
  rotation support, supervised hosting, and an unnudged authenticated source
  mention to same-thread agent reply remain unverified or unimplemented.
- Parent-owned free-only hosting notes explicitly withdraw the prior paid VM
  proposal. They describe Workers Free/SQLite Durable Objects as an untested
  candidate, keep Sites bindings and equivalent callback transport unresolved,
  and authorize no billing, access, account, or deployment action. No working
  no-cost route is claimed. The modified hosting/release notes were inspected
  separately from the committed implementation.

## Core file fingerprints

| Path under integrations/native-events | SHA-256 |
| --- | --- |
| authoritative-batch.mjs | `43a8490c60da6936e81e1bf8f8861cef4ff7b21dee58c6e6fe70ac1e4af7fb95` |
| executor.mjs | `e420081ebf19ad10893da9d39a0541fa5f1ad12f46013fcefa4c3a2c527af257` |
| host-auth.mjs | `3ac69ceaf207f49cd7dace10362bdba0a4f44b6186fce82d0d67ad8d3f5cf616` |
| authoritative-integration.patch | `110acdadefd330ad5172277ad330094166abc6201925f46b9425ec0a4133ee6d` |

Publication on another base must preserve reviewed contents and dependencies.
The transaction model is consistent with the documented
[D1 batch rollback contract](https://developers.cloudflare.com/d1/worker-api/d1-database/);
that documentation does not supply a durable executor wakeup for this Site.
