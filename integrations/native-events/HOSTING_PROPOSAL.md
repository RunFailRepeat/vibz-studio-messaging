# Concrete native-event hosting proposal (approval not granted)

Prepared 2026-10-25 for issues #1 and #3. No infrastructure was provisioned.

## Source-backed boundary

Sites runs an HTTP-only Cloudflare Worker (128 MB; no raw TCP), with D1/R2
bindings. Its worker exports fetch only. D1 batch can atomically insert mentions
and an immutable event/outbox row, but no supported durable post-commit wakeup or
DNS-to-socket pinning facility has been verified in this deployment. An HTTP
call after D1 commit is not a reliable bridge. SQLite tests do not fix that gap.

## Proposed first approval: isolated native-event staging host

One DigitalOcean Basic regular CPU Droplet: 1 vCPU, 1 GiB RAM, 25 GiB SSD,
1,000 GiB/month transfer; listed price $6/month ($0.00893/hour), excluding tax.
Additional outbound transfer is $0.01/GiB. No paid backups, load balancer,
managed database, new domain purchase, or extra disk is included. This is a
single-node staging proposal, not a production availability claim. Provider
pricing checked 2026-10-25:
https://www.digitalocean.com/pricing/droplets
https://docs.digitalocean.com/products/droplets/details/pricing/

The owner would approve: creation of this one paid test VM; installation of a
pinned supported Node runtime and HTTPS reverse proxy; one existing owner-owned
DNS subdomain and certificate; inbound HTTPS 443 and owner-restricted SSH
administration; outbound DNS and HTTPS for verified event callbacks/package
installation; a service account, isolated persistent directory and protected
secret material; restart-supervised service. No collaborator grants, Framework
exposure, Site audience change or production migration is included.

Use synthetic test records only initially. Run lifecycle endpoint and SQLite
mutation/outbox in the same process/transaction boundary. An event-driven
executor schedules from committed jobs, persists lease/retry deadlines, and
re-arms exact pending deadlines after restart; it must not periodically scan
for new mentions. Wakeup is driven by successful local commit, with startup
recovery covering a crash between commit and wakeup. This executor still needs
implementation and real restart validation; durable rows alone are not enough.

Authenticate every MCP lifecycle request with reviewed identity verification;
never trust client-supplied owner IDs or Sites identity headers arriving directly
at the public Node host. Store callback secrets encrypted with a separate host
key. The current pure adapter injects those boundaries and cannot substitute
for them. Callback verification and delivery use reviewed PR4 transport, with
its explicit IPv4-only restriction. No real subscription is authorized yet.

## Production decision after staging evidence

This staging host does NOT solve D1-to-Node atomic dispatch. Production requires
either (a) a proven supported durable wakeup from the same Sites D1 transaction,
or (b) an owner-approved migration of authoritative messaging writes and outbox
to the same Node database boundary, with the private Site acting as an
authenticated frontend. Option (b) is the concrete fallback design; it requires
additional reviewed source work and explicit private-data migration approval.
Do not dual-write messages in D1 and outbox in SQLite or silently move data.

A $6 staging approval therefore buys a place to prove secure event lifecycle and
native activation against synthetic records, not a promise of a three-day
production release. If no infrastructure spending/access is approved, retain
local executable contracts and keep native activation marked blocked.
