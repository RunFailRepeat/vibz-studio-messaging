# Vibz Studio implementation contract

Goal: an actual shared workspace for four humans and their named agents. No fabricated conversations, work, presence, or completion. New private Site with durable D1 storage and Site MCP tools. Keep an independent workflow engine's local workflow engine independent; optional links point to exact supplied evidence.

## Ownership

Root owns backend, schema, hosting, auth, source/deploy. UI agent owns `app/Studio.tsx`, `app/globals.css`, `public/favicon.svg` only. Bridge agent owns `integrations/` and their focused tests/docs only. Do not alter package inputs during installation.

## Types / HTTP

Shared types live in `lib/types.ts`; UI imports them. All browser calls same-origin with `credentials: 'same-origin'`. Responses JSON; errors `{error:string,code?:string}`. Do not display optimistic success before server confirms. API caching disabled. Client polls `/api/studio` every 8 seconds while visible and refreshes after successful mutations. Search is local over loaded bounded state, with an explicit full message search endpoint.

- POST `/api/bootstrap` `{}`: initialize seeded roster/channels if owner, then return `StudioState`. GET `/api/studio`: fresh state. Authentication is platform trusted identity. UI does not send identity headers or choose a persona.
- POST `/api/messages` `{channelId,body,parentId?:string|null,clientId:string}` => `{message}`; root and thread replies. `clientId` UUID provides idempotency. GET `/api/messages?channelId=...&before=...` pagination; GET `/api/search?q=...` => `{messages}`.
- POST `/api/channels` `{name,description}` => `{channel}`.
- POST `/api/tasks` `{channelId,title,brief,acceptance,assigneeAgentId:string|null,clientId}` => `{task}`. New task queued if assigned, otherwise inbox.
- POST `/api/tasks/:id` `{action:'assign',agentId:string|null}` OR `{action:'review',decision:'approve'|'changes_requested',note:string}` OR `{action:'cancel'}` => `{task}`. Human review only. Agent delivery always enters review; never auto-approved.
- POST `/api/agents/:id/token` `{label:string}` => `{token:string,tokenId:string}` secret displayed once in connect modal; caller owns agent or workspace. DELETE `/api/agents/:id/token` `{tokenId:string}` => `{ok:true}`. GET `/api/agents/:id/token` => `{tokens:[{id,label,createdAt,lastUsedAt,revokedAt}]}`. Token needs platform service access in addition for non-MCP callers; don't imply token alone can cross private Site access.
- POST `/api/members/:id` `{email:string}` => `{member}` owner updates expected verified sign-in email; does not send invitation or change Site access. Explain platform Share required for external visitors. Profile emails in this template are inert placeholders; configure verified sign-in addresses privately.
- GET `/api/export` authenticated JSON export of workspace, messages, tasks, events; no token hashes/secrets.

## Agent HTTP protocol

POST `/api/agent` takes `{action, ...args}`. Private Site callers need `OAI-Sites-Authorization: Bearer <platform service credential>` AND `Authorization: Bearer <scoped agent token>`. Both kept outside source. Agent tokens are stored hashed and revocable. MCP bypasses token via trusted visitor identity and may only act as that visitor's own agent.

- `{action:'heartbeat',status:'idle'|'working'|'blocked',detail?:string}` => `{ok:true,agentId,serverTime}`
- `{action:'claim',requestId:string}` => `{task:Task|null,leaseId?:string,leaseExpiresAt?:string}`; atomic oldest queued task for authenticated agent. Retried requestId returns same active claim. Expired running tasks are recoverable, not silently completed. Lease is renewed by progress only; heartbeat does not extend work lease.
- `{action:'progress',taskId,leaseId,detail:string}` => `{ok:true,leaseExpiresAt}`; record timestamped event and renew 5 minute lease.
- `{action:'deliver',taskId,leaseId,summary:string,evidence:[{label,url?}],requestId:string}` => `{task}`. Requires nonempty summary, at least one evidence item with meaningful label; URL only http(s). Records result and enters review.
- `{action:'block',taskId,leaseId,detail:string,requestId:string}` => `{task}`.
- `{action:'message',channelId,body,parentId?:string,requestId:string}` => `{message}` scoped attribution, cannot spoof human or other agent.

## Interface direction

Polished practical desktop workspace, mobile usable. Charcoal/navy sidebar with lime accent and cream/light center; typography clean and readable, restrained borders, no stock imagery. Brand `vibz` / `STUDIO`. Sidebar rooms and workspace navigation; top bar actual refresh state and search. Main views: room conversation + threads; work board with inbox/queued/working/review/done, task details and human approve/request changes; agents with real connection status and last received time; team and connection setup. Right activity rail on wide screens; hidden/sheet on mobile. Four named agents start not connected, no fake chat messages or task rows. Excellent empty states with direct actions. Persistent composer with add-task shortcut; errors and retries visible. No decorative buttons that do nothing.

Known pairs: Member One / Run, Member Two / Portfolio, Member Three / ColdFire, Member Four / ZingDot. Initial rooms #all-vibz-studio, #dot-coordination, #vibz-app. All rooms in this app are shared with admitted four-person team; do not imply per-room privacy. No Slack history imported. Link to Slack only for explicit legacy reference.
