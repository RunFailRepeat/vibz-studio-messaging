# Authoritative store and executor release boundary

Scope: issue #1, prerequisite #3; public base PR11 e16265265546f6a4c7b38b7cdb391de4255124e7
(tree 72e70e002dcf604f2efc2d5483ebf1cc536cfbbd). Local implementation starts from
326d2b19cc861e819e5996f90cffaf0b67d116e4, the reviewed PR11-equivalent additions
on the integration checkout. Only new scoped files are published on the PR11 tree.
One implementation/reviewer pair; existing peer reviews are reused.

## Platform operation not established

The current Sites Worker provides D1/R2 and fetch handling, not a demonstrated
transactional durable wakeup facility. A D1 batch can append message, mention,
activity, event and wake-intent rows in one transaction. It cannot, through any
verified current binding, atomically register a durable external executor wakeup.
Persisting a wake-intent row is not evidence the executor will run.

A local Node process can re-arm pending work at startup and schedule exact due
jobs after local commits. This proves whole-process recovery only. A Sites
request can die after committing D1 while a separate Node process remains alive;
that process receives neither a wakeup nor a restart. A post-commit HTTP hint,
process timer, startup scan, or second SQLite database does not close that gap.
No periodic source scan is an accepted fallback.

Cloudflare documents transactional D1 batch behavior:
https://developers.cloudflare.com/d1/worker-api/d1-database/
Cloudflare also documents Durable Object alarms, but availability on Cloudflare
in general does not establish a binding or cross-store transaction in this Site:
https://developers.cloudflare.com/durable-objects/api/alarms/
References checked 2026-10-25. No new binding or infrastructure was provisioned.

## Production integration and ownership

The exact StudioService call-site patch is review-only and unapplied. It must be
reconciled with the separately owned lib/studio.ts revision before application.
Private third-party contribution review does not authorize public publication;
none of that private candidate is included in this independently authored work.
Tests may apply/capture it in isolated fixtures; that does not update the deployed
service. The candidate must preserve original domain and activity statements.
Schema additions require reviewed migration integration before deployment.

Host authentication must be verified by trusted server machinery, not accepted
from JSON user IDs or direct incoming Sites identity headers on an arbitrary
public host. The pure authentication adapter requires an injected verifier; it
provides no real credential or proof of production identity verification.

Existing PR11 secret-rotation rejection remains a protocol release blocker.
Existing PR4 IPv4-only destination restriction remains explicit. No event
capability, live subscription, credential, heartbeat or online status is enabled.

## Next concrete decision

The owner requires free-only hosting. HOSTING_PROPOSAL.md withdraws the paid
proposal and evaluates Workers Free with SQLite Durable Objects, without claiming
Sites exposes those capabilities or that callback security is proven. Production
needs a verified same-store durable wakeup and equivalent protected transport, or
an explicitly approved authoritative-store migration. No infrastructure or private
data changes, paid approval request, merge or deployment is made here.
