# Public source template

Sanitized, history-free derivative of original source commit `cdd11a92a63f1515c3c33cda9cdd522e85219646`. This snapshot is not byte-identical to that commit, the deployment TAR, or the earlier review ZIP. It contains no original Git history and does not include later activation patches.

## Required private configuration

The hosting manifest deliberately has no project_id. Register your own new Site and configure its identity using the supported Sites workflow before deployment. Never substitute an existing production identifier without that owner's authorization. D1 binding DB and MCP capability declarations remain as template settings; migrations are schema-only.

Configure OWNER_EMAIL and the four bootstrap roster entries in lib/studio.ts using privately verified sign-in addresses. The example.invalid addresses cannot authenticate as real users. Keep actual personal addresses and deployment bindings out of the public repository; production operators should manage private configuration in their deployment process. Site sharing and application roster membership are separate explicit actions. This template grants no access and connects no external agents automatically.

Install dependencies with the documented project installer and run the tests listed in tests/README.md and integrations/README.md. Existing synthetic test identities are independent of platform authentication. Production gateway behavior still needs deployed integration verification.

## Redaction manifest

- Four personal email literals replaced consistently with member1..4@example.invalid.
- Human roster names and corresponding sample identifiers generalized consistently in source, fixtures, and documentation. Agent names retained.
- Live Site URL removed from documentation; original project_id removed from .openai/hosting.json.
- Private project relationship/access-history narrative generalized.
- Original Git metadata/history, dependencies, runtime databases, logs, credentials, and local state excluded.
- Existing copyright and third-party license notices preserved unchanged. No new blanket license is asserted.

Changed original paths:
- `.openai/hosting.json`
- `IMPLEMENTATION.md`
- `README.md`
- `lib/mcp-tools.ts`
- `lib/studio.ts`
- `tests/studio-core.test.mjs`
- `tests/studio-mentions.test.mjs`
- `tests/studio-routes.test.mjs`

## Snapshot verification (2026-10-25)

Tests executed on this sanitized public copy itself with Node v24.22.1: 20 core + 7 HTTP/MCP + 12 mention cases passed, zero failures/skips. Sixteen offline Python adapter tests passed. TypeScript `tsc --noEmit` exited 0. These are local source checks, not live deployment, agent-connectivity, or gateway-authentication evidence.

All 140 candidate text files were screened for secret prefixes/private keys, signed token URLs, live hosting/account identifiers, personal email domains, private machine paths, Slack IDs, runtime files, and credential assignments. The only broad identifier-pattern match was the ordinary UI word CONVERSATION (false positive). URL/email matches were inspected: remaining addresses and endpoints are synthetic examples, loopback/local development, public dependency/license links, or generic protocol paths. Schema migrations contain no user rows. Both third-party license files retain their original SHA-256 digests. No security/privacy scan can prove absence of all unknown secrets; future changes require re-review.
