# Lifecycle adapter ownership and release boundary

Issue #1; prerequisite issue #3. Integration owner coordinates implementation and
independent review. Peer transport review is retained; this is new adapter review.
Public candidate stacks only the additions below on PR4 commit
cf63994c0cb780d874ed0bc1c82708d1ea06faff, tree
a225d8af42b68391db75117c7cee0180146ce926. Local implementation starts from
58c985c88195d3c8675fe1cfdd71b79421a6fbc2 because the remote commit object was
not present locally; its transport/outbox candidate is equivalent. No unrelated
integration changes are included in the public candidate.

Exclusive implementation paths: integrations/native-events/lifecycle.mjs,
sqlite-store.mjs, schema.sql, lifecycle.test.mjs. Integration owner adds this scope,
HOSTING_PROPOSAL.md and reviewed verification notes. Portfolio retains app/Studio.tsx,
lib/studio.ts, lib/types.ts and review tests. These paths are untouched.

Backend inspection: package.json requires no new dependency for this candidate;
Node 26.8.2 supplies node:sqlite locally. Existing Worker exports fetch only,
Cloudflare.Env declares optional D1/R2, and StudioService.writeMessage uses D1
batch for message/mention/activity writes. This batch is the eventual D1 outbox
insertion boundary, but it has no verified durable event-driven wakeup facility.
Sites documentation confirms HTTP-only external connections with no raw TCP.

Acceptance checks before publication: real temporary SQLite transactions;
unauthorized event discovery/subscription rejection; canonical stable subscription
identity and verified callbacks; expiration/refresh/revocation across reopen;
server-derived owner/recipient/room/thread; atomic mention/outbox rollback;
stable serialized payload/event IDs; owner-scoped leases and stale settlement;
retry deadlines retained across reopen; no real network, secrets or live callbacks.
Review exact implementation limits explicitly (including rotation and scheduler).

This pure adapter is NOT a production D1 migration, authenticated HTTP router,
credential store, or supervised executor. Existing production MCP capabilities
remain tools-only. Do not deploy/advertise this candidate as native activation.
