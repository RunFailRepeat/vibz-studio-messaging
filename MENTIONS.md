# Agent mentions

Fix requested: the user cannot tag their agent from the message composer.

## Ownership

Root: lib/types.ts, lib/mentions.ts, backend/schema/migrations/MCP, publication.
UI agent: app/Studio.tsx and app/globals.css only.
Review agent: tests/ only.
Bridge agent: integrations/ only.

## Contract

- Type `@` in room or thread composer to choose Run, Portfolio, ColdFire, or ZingDot; filter case-insensitively while typing. Preserve cursor/editing; support Up/Down, Enter/Tab to select, Escape to close. Selecting never sends the message. Also provide an explicit @ button for mouse/mobile users.
- Insert canonical plain text handles (`@Run`, `@Portfolio`, `@ColdFire`, `@ZingDot`). Server resolves handles using the actual roster; client cannot choose a forged mention target. Shared parser `findAgentMentions(text, agents)` returns spans `{agentId,agentName,start,end}`. It ignores email addresses, URLs, inline code and fenced code; recognizes punctuation and case-insensitive exact handles. No @everyone and no partial-name notifications.
- Message adds optional `mentions: MessageMention[]`; each mention `{id,agentId,agentName,status:'pending'|'replied',replyMessageId:string|null,createdAt:string,repliedAt:string|null}`. UI highlights recognized handles and shows real pending/replied states beneath message. The same agent mentioned twice creates one inbox item. Only human messages enqueue inbox items; agent replies never cause automatic tag loops.
- Agent adds optional `pendingMentions:number` to current snapshot, available for cards and sidebar badges.
- New shared durable `mentions` table. Messages, mentions and events created in same transaction; clientId retries never double-enqueue.
- Agent HTTP `POST /api/agent` accepts `{action:'mentions',limit?:number}` => `{mentions: AgentMention[]}` scoped to authenticated agent only (1..20, default20, oldest first). No mutation/receipt claim from a read. `AgentMention={id,status,agentId,channelId,message:Message,rootMessage:Message,context:Message[],createdAt}`; context latest20 thread messages, chronological.
- Agent HTTP `{action:'reply_mention',mentionId,body,requestId}` => `{message:Message,mention:MessageMention}`. Replies in original source thread (root parent if tag was in a reply). Authenticated agent must own the mention. Atomic first response wins; identical retries return same message, conflicting request reuse errors; a different attempt after resolved returns409 mention_already_replied. Reply body max10000. No arbitrary other-agent attribution. Agent response completes mention, not any work task.
- MCP adds `studio_get_mentions` (read-only) and `studio_reply_to_mention` (write). Existing `studio_snapshot` returns pending counts. Authenticated caller can only act as own agent. No sign-in bypass, automatic schedule or external provider introduced.
- Bridge gets manual `mentions` and `reply-to-mention` commands using same credentials/request journal. Existing task execution loop remains explicit task-only; a mention is not authorization to execute filesystem/code tasks. No fake auto-replies or background connection claims.

## Honest UI behavior

Mentioning queues attention for the chosen agent; it cannot itself wake a closed ChatGPT chat. Show a concise helper such as 'Queued for the agent’s next active session.' A pending tag must not claim delivery, reading, or a reply. The new native tools enable an active ChatGPT/Codex agent to read and answer mentions. Do not pretend there is a running listener.

## Validation

Focused tests: exact names/boundaries and ignored code/URLs/emails; atomic durable enqueue/retries; multi-agent and own-agent isolation; no agent-message ping loops; thread reply placement; duplicate/concurrent reply protection; direct recipient spoofing ignored. Existing migrations immutable; new schema-only migration.
