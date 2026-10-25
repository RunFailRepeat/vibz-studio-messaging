# Exact source message and thread resolver

Base: `d39051a5f0ce6c1d9009f425fd5324fe4a187193`.
Branch: `repair/source-thread-resolver`. Integration owner: root.

This is original Vibz implementation motivated by public Slack interaction
documentation and recovered static research showing that notification activation
retains workspace/channel/message/thread targets. It contains no Slack code or
package excerpts. It is not native agent activation or proof of live Slack parity.

## Problem and result

Search can return an older reply while its root is absent from the latest 200
snapshot messages. The baseline UI asks the user to load older history instead
of resolving the target. The new authenticated GET `/api/message-target` accepts
`messageId`, with optional `channelId` and `rootId` assertions, and returns exactly
`{message, root}` including mention receipts. It does not traverse reply history.
Existing `/api/messages` thread pagination continues independently.

The resolver checks admitted membership before lookup, requires the target and
root to share a real channel, requires a top-level root, and returns 404 for
missing/deleted/inconsistent targets or mismatched context. Missing identity is
401 and an unadmitted or conflicting identity is 403. Responses remain private
and uncached. All admitted members still share all rooms: no new room ACL is
invented. A future room permission model must protect this resolver too.

Resolution performs no task, presence, message, mention-receipt, or activity
mutation. Existing membership resolution may update the member's last-seen
metadata, as other authenticated reads already do. The gateway identity-header
trust boundary is unchanged and not established by isolated route tests.

## Navigation and staged UI wiring

`lib/message-navigation.ts` owns a namespaced browser-history entry, preserving
other history keys, URL parameters, and fragment. It records the pre-navigation
snapshot, resolves initial message URLs, restores back/forward destinations,
deduplicates repeated clicks, permits retry after failure without duplicate
history, and fences late success/error responses on every navigation. Its
checkpoint predicate also fences older-room pagination completions.

`docs/patches/source-thread-resolver-ui.patch` is a standalone patch against the
base `app/Studio.tsx`. **It is not applied.** Portfolio's TaskDetail/review ownership
remains unresolved; integration must reconcile and review the exact combined
version before applying it. TaskDetail and review-submit bytes are unchanged in
the prepared candidate. No edits were made to `lib/studio.ts` or `lib/types.ts`.

The patch wires search and thread opening to the resolver, renders the returned
root/target, focuses the target, and routes non-message destinations through the
controller. A synchronous snapshot ref precedes React setters so history never
saves the old room merely because rendering is deferred. Room Tasks passes its
filter explicitly. Non-message modal navigation fences pending message requests.

A sparse resolved target never supplies a history cursor. Earlier-history loading
requires a real contiguous page cursor, is disabled while the latest room page
is pending, and ignores completion after navigation. Both latest-page and older-page callbacks
are fenced; committing a resolved target invalidates pending reads and starts
a fresh contiguous page even when the target remains in the same room. A room epoch forces reload
even for same-room transitions. Thread pagination's tail still comes from actual
API pages, not the far target inserted into the visible messages.

## Exclusive paths

- `lib/message-target.ts`
- `lib/message-navigation.ts`
- `app/api/message-target/route.ts`
- `tests/load-message-target.mjs` (approved additive test adapter)
- `tests/studio-message-target.test.mjs`
- `tests/message-navigation.test.mjs`
- `docs/source-thread-resolver.md`
- `docs/patches/source-thread-resolver-ui.patch` (approved standalone artifact)

## Validation

| Check | Result and scope |
| --- | --- |
| `node tests/studio-message-target.test.mjs` | 5 passed: old root/exact reply beyond snapshot; pagination; missing/deleted root/target; authentication; mismatched context; malformed IDs; cross-room corruption; receipt metadata; no business-state mutation. Production resolver and HTTP handler execute against migrated SQLite. |
| `node tests/message-navigation.test.mjs` | 10 passed: duplicate navigation; back/forward including non-message state; late success/error; popstate/disposal; retry; initial deep link; deferred-render snapshot model; task-modal/filter transitions; late older-page completion including a cross-room target commit. Production controller runs through a memory implementation of its History port. |
| Existing core/routes/mentions scripts | 20 + 7 + 12 = 39 passed. |
| Focused TypeScript check | Passed for new helper/controller/route and imported service/types using declared TypeScript 5.9.3, Node types 22.19.19, Workers types 4.20260515.1. External temporary config extends repository config with only new files, cloudflare-env, no incremental output/plugins. |
| `git apply --check docs/patches/source-thread-resolver-ui.patch` | Passed against exact base. No shared UI file edited. |
| Standalone patched UI transpilation | No TypeScript/JSX syntax diagnostics. This is not a complete UI typecheck or rendered-browser test. |
| TaskDetail preservation | Generator compared full TaskDetail-to-ConnectAgent slice byte-for-byte; unchanged. |

Node runtime: 26.8.2. Tests use isolated synthetic accounts/messages and no live
callbacks, agent invocations, browser controls, or deployment. Test adapter
changes module paths and the Cloudflare environment binding only. The deferred
render and pagination tests are controller/wiring models, not signed-in browser
proof. Framework precedence for the new exact route and the final reconciled UI
require build/runtime verification in the authorized deployment environment.

Independent review identified and prompted fixes for stale room filters, modal
navigation fencing, sparse-history cursor misuse, same-room reloads, and late
older-page responses. Final independent review belongs to the review lane.

Next action: review this exact commit and standalone patch; reconcile Portfolio's
UI changes; then verify the combined rendering, history, focus, and actual route
selection before publication/deployment approval. Native signed-event activation
remains a separate unresolved acceptance gate.
