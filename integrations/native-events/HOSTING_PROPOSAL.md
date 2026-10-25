# Free-only native event hosting assessment

2026-10-25. This supersedes and WITHDRAWS the earlier paid VM proposal. No paid
approval is requested; no account, service, credential, subscription or network
change has been created. Authorized local implementation continues.

## Best documented no-cost candidate, not a working deployment

Cloudflare Workers Free with a SQLite-backed Durable Object is the focused
candidate. Its SQLite storage and durable alarms can place application state and
scheduled execution in one object rather than split D1 commits from an external
Node queue. This is an architectural candidate; it has not been deployed or tested
against real callbacks here. Node is not a product requirement: any runtime with
equivalent transaction, wakeup and callback security guarantees is acceptable.

Official free-plan limits: 100,000 requests/day (including alarms), 13,000 GB-s/day,
5 million rows read/day, 100,000 rows written/day and 5 GB stored/account. Exceeding
a free limit makes the corresponding operations fail; daily limits reset at
00:00 UTC. Do not upgrade to paid or accept automatic-charge terms.
https://developers.cloudflare.com/durable-objects/platform/pricing/

Objects may shut down when idle while retaining durable state; alarms provide
scheduled activation rather than requiring an always-on process. Alarms are
at-least-once and have bounded automatic retries. Idempotence, persisted retry
state, and alarm rearming must survive interruption. This is not permission to
run periodic mention polling.
https://developers.cloudflare.com/durable-objects/
https://developers.cloudflare.com/durable-objects/api/alarms/

## Existing Sites boundary

The inspected Site exposes D1/R2 and an HTTP fetch handler. Neither its current
manifest nor the supported Sites capability references establish a Durable Object
binding or a same-D1-transaction durable alarm. D1 plus an HTTP wakeup to another
service still has a loss window. Adding a generic Cloudflare feature does not
prove it is available through Sites. The local adapter rejects production commits
when the required transactional wake capability is absent.

Preferred next step is a supported Sites runtime capability confirmation, without
changing bindings or access. If unavailable, a standalone Workers Free/SQLite
Durable Object design would require a separately approved account/resource and
an explicit authoritative messaging migration, plus trusted identity integration.
No existing authorized account or migration permission has been established here.
The owner is not being asked to design that architecture.

## Callback security is an independent unresolved gate

Ordinary Workers fetch resolveOverride is restricted to names in the same zone;
it is not a general validated-IP pinning mechanism for arbitrary callback hosts.
https://developers.cloudflare.com/workers/runtime-apis/request/
The documented TCP API blocks private/localhost and Cloudflare destination IPs;
its documented interface does not establish the required validated-IP connection
with independent original-host TLS identity for arbitrary HTTPS callbacks here.
https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
Sites itself documents HTTP-only external connections and no raw TCP.

A DNS precheck followed by an unrelated fetch is not accepted as rebinding-safe.
Do not disable certificate validation, follow redirects, hardcode a callback
bypass, or assume a platform allowlist. Before implementation on this runtime,
prove an equivalent secure transport using supported provider primitives and
real controlled tests. The current Node transport is reference behavior, not a
mandate to purchase a Node server.

## Cost and permission hold

Target incremental hosting spend: $0 on the documented Free plan, with failures
rather than paid upgrades at quota exhaustion. No account onboarding was attempted;
card requirements and account eligibility were not verified. If setup requests a
card, enables billing/automatic charges, or needs an account, credential, security
rule or access grant, stop for specific owner approval. Do not expose the owner's
computer or use an unattended local workstation as a silent hosting substitute.

Conclusion: no tested no-cost end-to-end route can be claimed yet. The concrete
technical holds are Sites durable-wakeup availability and equivalent callback
transport protection. Local transaction/executor/auth fault tests can proceed
without either hold being bypassed. Secret rotation and live authenticated
mention → invocation → reply remain additional release gates.
