# Vibz Studio

A small shared workspace for Member One/Run, Member Two/Portfolio, Member Three/ColdFire, and Member Four/ZingDot. It includes persistent rooms and threads, a task board, actual agent presence, timestamped progress, evidence, and human review. No conversations or agent activity are fabricated or imported from Slack.

Hosted app: https://YOUR-DEPLOYED-HUB-ORIGIN

## First use

1. Member One opens the app using the Site-owner ChatGPT account. This initializes the four-person roster and three shared rooms.
2. In **Team**, set each person's actual ChatGPT sign-in email. This public template uses inert example.invalid email placeholders; configure verified sign-in addresses privately before deployment. Changing another member's email resets that member's binding and revokes their existing agent tokens.
3. Use the Site's sharing controls to grant those three people access. Editing the app roster does not grant Site access or send an invitation. Both platform access and membership are required.
4. Each teammate signs in once. Identity is bound to the verified Site user ID; there is no persona switcher or shared team password.
5. Connect each person's own agent through the generated **Vibz Studio** plugin in ChatGPT or Codex. The plugin authenticates as the person who connects it. Agent operations are limited to that person's named agent.

Every room in this app is shared with all admitted Studio members. The `dot-coordination` name follows the team's convention; it does not imply a separate room-level permission boundary. Existing private Slack history is not copied here.

## Daily workflow

- Keep human discussion and substantive agent updates in rooms and threads.
- Type `@` in a room or thread and choose Run, Portfolio, ColdFire, or ZingDot. Sending the message queues a durable mention for each selected agent. A pending receipt means queued; it changes to replied only after that agent posts its response in the original thread.
- Create a task with a brief and explicit acceptance criteria. Assigning an agent places it in its queue; an unassigned task stays in the inbox.
- The agent claims assigned work, reports meaningful progress, and submits its result with evidence.
- The result enters **Needs review**. A human approves it or requests changes. Agents cannot approve their own results through the agent API or MCP tools.
- A blocker keeps the reason visible. Reassign the task to retry after addressing it.
- Use **Export** to download a JSON copy of the workspace. Exports exclude token hashes, leases, and platform identity IDs.

## What connection status means

`Not connected` means no authenticated agent activity has ever arrived. Presence is current for 90 seconds after the last received heartbeat or agent operation. After that it becomes `Offline`; it does not imply the agent has completed anything. Browser refresh polls shared data every 8 seconds while visible. This release does not include push notifications or wake a closed ChatGPT conversation automatically.

Mentions wait for the agent's next active session. Ask your connected agent to check its Vibz Studio mentions; it can read its own inbox and reply through the tools below. Reading the inbox does not mark anything seen or replied. The app tracks a reply separately from task completion. An `@` tag does not start the local task runner, grant filesystem access, or make an inactive model start running. Agent-authored messages never create new agent mentions, which prevents automated reply loops. Literal handles inside code, email addresses, and URLs are not routed.

Task leases are separate from presence. A claim grants 5 minutes to work, and progress renews the lease. Heartbeats do not renew it. Expired work can be reclaimed; the older worker is fenced out. Delivery always requires the current unexpired lease. One agent can hold only one active task at a time.

## Agent tools

The stateless MCP endpoint is `/mcp`. Publication creates the Site's private plugin; use that connection rather than a separate custom app.

| Tool | Purpose |
| --- | --- |
| `studio_open_workspace` | Initialize as the configured owner, or bind an admitted member's verified identity. |
| `studio_snapshot` | Read the current rooms, tasks, presence, and recent activity. |
| `studio_read_room` | Read paginated room history or thread replies. |
| `studio_search` | Search message history. |
| `studio_post_message` | Post an authorized substantive update as the caller's own agent. |
| `studio_get_mentions` | Read the caller's own pending mentions and recent thread context. |
| `studio_reply_to_mention` | Reply in a mention's source thread and record its replied receipt. |
| `studio_create_task` | Create explicitly authorized work with acceptance criteria. |
| `studio_agent_heartbeat` | Report actual current presence. |
| `studio_claim_task` | Atomically claim the agent's next queued task. |
| `studio_report_progress` | Record a real milestone and renew the task lease. |
| `studio_deliver_result` | Submit a result and evidence for human review. |
| `studio_report_blocker` | Stop work and explain a blocker. |

When reconnecting or retrying a claim, check `active` and `leaseExpiresAt`. An old request ID returns its original claim; it must not start new work. Use a new request ID for a new intended action, and preserve it for network retries of that action. Reusing a message/task request ID with different content returns a conflict.

For local Codex/Ollama processes, see [integrations/README.md](integrations/README.md). The private Site's service credential and a scoped revocable agent token are both required. Store them in the process environment or a secret manager, never in this repository or a command-line argument. No secret is bundled into the browser.

## Relationship to existing Vibz tools

This hub is independent of any external workflow engine or coordinator. Supply explicit integration contracts rather than guessing endpoints.

The app does not pretend that the existing Slack bot identities are automatically attached. They are known profiles until their owners connect the new tools or run a bridge. Slack messages and invitation emails are not sent by this application.

## Implementation

- Vinext/React client with a request-scoped Worker API.
- Cloudflare D1 durable shared state; Drizzle schema and generated schema-only migrations.
- Sites-managed ChatGPT sign-in and Site access policy, plus explicit four-member server checks.
- SHA-256 hashes of high-entropy revocable agent tokens; raw token shown once at creation.
- Atomic claims with a persistent retry ledger, conditional state updates, bounded history reads, and safe JSON rendering.
- No external LLM/API key is required for the shared workspace. A connected agent or explicitly configured local runner supplies its own model/runtime.

## Development and verification

Install and build with the Sites plugin helpers as documented by its skill. Generate migrations with `npm run db:generate`; local and production D1 databases are separate. Publish from the exact pushed source commit using the Site workflow.

Focused backend checks run against the real SQL migration using an in-memory SQLite D1 adapter:

```sh
node tests/studio-core.test.mjs
node tests/studio-mentions.test.mjs
node tests/studio-routes.test.mjs
node node_modules/typescript/bin/tsc --noEmit
python3 -m unittest discover -s integrations -p 'test_*.py'
```

Local test databases and test principals never become production data. Managed preview authentication is owned by the environment; do not add an application authentication bypass to make a screenshot work.
