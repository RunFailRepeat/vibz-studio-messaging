# Studio behavior and authentication checks

Run from the repository root with the installed dependencies and Node 24 (Node 24.22.1 was used for verification):

```sh
node tests/studio-core.test.mjs
node tests/studio-routes.test.mjs
node tests/studio-mentions.test.mjs
```

The three files register 20 core tests, 7 HTTP/MCP tests, and 12 mention tests with Node's built-in test runner. Direct execution prints each behavioral case and returns a nonzero exit status on a failure. The isolated `node --test` command in the hosted development environment reports only a file-level result, so the commands above are useful for reviewing individual outcomes.

## What executes

Every test creates a fresh in-memory SQLite database and applies the repository's generated `drizzle/*.sql` migrations. The small D1 transport in `sqlite-d1.mjs` executes the production SQL, including its indexes, constraints, conditional updates, and transactions. It does not return fabricated business outcomes. Each D1-style batch uses a real SQLite transaction and rolls back on failure.

`load-studio.mjs` transpiles the actual `lib/studio.ts` module. `load-routes.mjs` transpiles the actual HTTP and MCP handlers plus their dependencies. They temporarily write compiled modules inside this test directory and remove them after import. The route loader adapts module paths and supplies Cloudflare's `env.DB` binding; the production authentication and business functions run unchanged.

Core cases cover:

- Owner-only initialization, exactly four admitted humans, binding verified platform identities, and rejection of another identity reusing a bound email.
- Own-agent MCP identity, scoped token management, immediate revocation, and rejection of a revoked token's previously resolved principal.
- Server-derived human and agent attribution, valid room/thread boundaries, duplicate message/task creation, and conflicting idempotency keys.
- Concurrent claim requests, one live assignment per agent, stable active/inactive/empty claim replays, expired lease recovery, and stale-worker rejection.
- Progress-only lease renewal; heartbeat alone does not extend a task lease.
- Delivery into review, retry stability, evidence validation, human approval, cancellation/reassignment, and concurrent retries of a blocker report.
- Member sign-in email changes revoking agent credentials and fencing existing work.

The route cases cover owner-only MCP initialization and membership binding, missing and unknown identities, origin checks on browser mutations, separation of human and token-authenticated agent endpoints, MCP ownership and operation binding, absence of an approval tool, HTTP token revocation, and exports excluding token material. The setup tool is explicitly checked as a mutation rather than a read-only operation.

Mention cases execute the shared production parser and verify exact handle boundaries; exclusion of emails, URLs and inline/fenced code; atomic durable enqueue with rollback on an injected SQLite failure; deduplication; recipient isolation; pending counts; read-only inboxes; no agent-message loops; exact source-thread placement; reply retry and concurrency behavior; and bounded chronological context. The HTTP/MCP regression covers both new actions and checks the inbox tool's read-only annotation and reply tool's mutation annotation.

## Scope and limits

The HTTP fixtures simulate headers **after a trusted platform gateway has authenticated a request**. They do not establish that the external Sites gateway strips spoofed identity headers, enforces Site sharing, validates its service credential, or prevents access to a direct Worker hostname. Those are deployment properties and require platform configuration or deployed integration verification. The tests do not introduce a development identity bypass.

SQLite exercises actual SQL atomicity and JavaScript request interleavings in one process. These tests do not simulate D1 network failures, cross-region delivery, multiple Worker isolates, or the Sites MCP discovery system. They do not execute the real agents, prove their external runtimes are connected, or approve a delivered result on a person's behalf.

All test messages, tasks, credentials, and heartbeats are generated in isolated databases that are closed after each test. No test posts to Slack, sends an invitation, calls an external agent, or mutates a deployed workspace.
