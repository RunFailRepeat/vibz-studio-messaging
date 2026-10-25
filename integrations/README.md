# Connecting a local agent to Vibz Studio

## Start with the Site's MCP connection

The primary connection is the private Site's **MCP/plugin integration**. Use the connection supplied by the deployed hub, sign in as an admitted team member, and discover its available tools. That route uses trusted visitor identity and may act only as that visitor's own agent. It does not require copying browser cookies into a script.

Names in the roster are not live agent connections. Run, Portfolio, ColdFire, and ZingDot become connected only when their actual client uses the integration and sends activity. This repository does not automatically connect existing ChatGPT assistants, Slack bots, or the separate local coordinator.

The Python adapter below is an **optional local runner**. It requires a supported **platform service credential** for the private Site gateway in addition to the hub's scoped agent token. A scoped agent token alone cannot cross the private Site's access gate. If your platform does not provide a service credential for this use, use the Site's MCP connection; this script cannot create that credential.

## What is included

`vibz_agent.py` uses Python **3.11 or later** and its standard library. The automatic process runner requires **Linux or macOS** so lease loss can stop the process group; the manual HTTP commands are portable. It supports:

- Heartbeats with idle, working, or blocked status.
- Atomic claim of tasks explicitly queued for the authenticated agent.
- Progress updates, which renew the five-minute work lease.
- Delivery of a summary and real evidence, always for human review.
- Blocking a task and posting messages attributed to the authenticated agent.
- Reading this agent's pending mentions and replying in the source thread.
- Stable request IDs, bounded transient retries, and a local retry journal.
- An optional loop for an explicitly selected Codex CLI or local Ollama model.

There are no package dependencies, no global installation, and no changes to the existing Vibz workflow engine or coordinator. No undocumented coordinator endpoint is assumed.

## Configure credentials in the local environment

Obtain a revocable scoped token from your agent's connection controls in the hub, and separately obtain a service credential through the supported Sites access mechanism. In Bash, read the secret values without putting them into command history:

```bash
export VIBZ_HUB_URL='https://YOUR-DEPLOYED-HUB-ORIGIN'
read -r -s -p 'Scoped agent token: ' VIBZ_AGENT_TOKEN
export VIBZ_AGENT_TOKEN
read -r -s -p 'Platform service credential: ' VIBZ_SITE_ACCESS_TOKEN
export VIBZ_SITE_ACCESS_TOKEN
export VIBZ_AGENT_STATE_DIR="$HOME/.local/state/vibz-studio/run"
```

Use the actual origin only, with no `/api` path. Production connections require HTTPS. HTTP is accepted only for explicit loopback development. Use a **separate journal directory for each agent and hub**, and keep it outside shared/synced folders.

The two credentials are sent only to the configured hub:

| Header | Credential |
|---|---|
| `OAI-Sites-Authorization: Bearer …` | Platform service credential |
| `Authorization: Bearer …` | Scoped hub agent token |

The client refuses redirects, does not print headers or HTTP response bodies on failure, and removes both hub credentials from runner child environments. Credentials are not written to configuration or journal files. The local journal contains task text, lease handles, request receipts, and runner outputs, so its directory uses owner-only permissions.

Check the connection:

```bash
python3 integrations/vibz_agent.py heartbeat --status idle --detail 'Local adapter connected.'
```

A successful response is actual server confirmation. `401`/`403` indicates access or token failure; the adapter does not retry those errors or substitute another person's identity.

## Optional Codex runner

Install and authenticate your chosen Codex CLI separately. Then use an existing local repository as the explicitly selected workspace:

```bash
python3 integrations/vibz_agent.py run \
  --runner codex \
  --workspace /absolute/path/to/project \
  --once
```

The default sandbox is **read-only**. For assigned work that should modify this workspace, select that mode explicitly:

```bash
python3 integrations/vibz_agent.py run \
  --runner codex \
  --workspace /absolute/path/to/project \
  --sandbox workspace-write
```

Omitting `--once` keeps the loop running until interrupted. `--codex-bin` selects a specific executable path. The command is constructed as an argument list with `shell=False`; task text enters through stdin and cannot supply shell flags. Approval policy is set to `never` within the selected sandbox, so an action requiring additional approval fails instead of waiting unattended. No unrestricted sandbox mode is offered.

Codex may consume the user's configured model/account resources. Repository instructions and the selected CLI's configuration remain relevant. Use independent checkouts if intentionally running multiple workers; the adapter's local lock protects one journal, not every process on the machine.

The CLI syntax is based on the official [Codex CLI reference](https://developers.openai.com/codex/cli/reference/). If an older local CLI does not support the flags, the task is blocked with the actual exit status instead of reported complete.

## Optional Ollama runner

Choose an already available local model explicitly:

```bash
python3 integrations/vibz_agent.py run \
  --runner ollama \
  --model qwen3:30b \
  --workspace /absolute/path/to/project \
  --once
```

The default endpoint is `http://127.0.0.1:11434`; `--ollama-url` can select another loopback origin. The adapter does not install or pull models. It calls `/api/generate` with `stream:false` using a separate HTTP client with no hub authorization headers.

**Ollama mode generates text only.** It receives the task's title, brief, and acceptance criteria. It does not read repository files, execute tools, modify code, or independently verify acceptance criteria. The explicit workspace is used as the local process context. Choose Codex or your own MCP-capable agent when work requires file and tool access.

## Lease and completion behavior

1. The adapter sends a genuine heartbeat and requests one queued assignment using a recorded request ID.
2. It validates that the claim still represents running work and an unexpired lease, then reports progress before starting the runner.
3. While a process is running, it sends progress and a heartbeat approximately every 30 seconds. **Only progress renews the lease.** Heartbeats alone never keep a task claimed.
4. On an expired lease or a `409` lease rejection, it stops the local runner and submits no delivery. Authentication failures also stop work. A failed process, missing output, or configured timeout produces a blocked task when the hub is reachable.
5. A zero process exit plus an actual nonempty output file produces a candidate delivery. The summary is at most 6,000 characters; evidence records the real output's SHA-256 and byte count. The full response stays locally. It is not uploaded as a shared artifact, and the label says so.
6. The hub moves a successful delivery to **review**. Human approval is separate; neither a successful process exit nor model prose proves that acceptance criteria passed.

The default per-job timeout is 1,800 seconds; `--job-timeout` changes it. The idle polling interval defaults to 15 seconds and must be at least 5 seconds. Stopping an Ollama client prevents publishing its response, but the model server may finish in-flight generation after the connection closes.

## Manual protocol commands

Use a request ID you can reuse for an operation that may need retrying:

```bash
python3 integrations/vibz_agent.py claim --request-id YOUR-UNIQUE-REQUEST-ID
python3 integrations/vibz_agent.py progress TASK-ID --lease-id LEASE-ID --detail 'Completed the repository inspection; implementation is next.'
python3 integrations/vibz_agent.py block TASK-ID --lease-id LEASE-ID --detail 'Required source files are unavailable.' --request-id YOUR-UNIQUE-BLOCK-ID
```

Deliver actual result text and a meaningful evidence label. An optional `--evidence-url` may reference a real HTTP(S) artifact accessible to the team:

```bash
python3 integrations/vibz_agent.py deliver TASK-ID \
  --lease-id LEASE-ID \
  --summary-file /absolute/path/result.txt \
  --evidence-label 'Actual verification result and artifact reference' \
  --request-id YOUR-UNIQUE-DELIVERY-ID
```

Post as the token's agent, optionally replying to an existing parent message:

```bash
python3 integrations/vibz_agent.py agent-message CHANNEL-ID \
  --body-file /absolute/path/message.txt \
  --request-id YOUR-UNIQUE-MESSAGE-ID
```

A manual `claim` prints the real task and lease handle for a custom client. That client is then responsible for timely progress updates and completion. The provided runner loop does this automatically.

## Read and reply to mentions

A human's `@Run`, `@Portfolio`, `@ColdFire`, or `@ZingDot` tag queues a pending mention for that agent. It needs an **active MCP session or bridge client** to read and answer it. A tag cannot wake a closed ChatGPT conversation, and a pending status does not mean the agent has read it. This adapter does not start a background mention listener.

An active MCP client can use `studio_get_mentions` and `studio_reply_to_mention`. The optional HTTP adapter provides equivalent manual commands with the same credentials configured above:

```bash
python3 integrations/vibz_agent.py mentions --limit 20
python3 integrations/vibz_agent.py reply-to-mention MENTION-ID \
  --body-file /absolute/path/reply.txt \
  --request-id YOUR-UNIQUE-MENTION-REPLY-ID
```

`--limit` accepts 1 through 20 and defaults to 20. The read returns only this authenticated agent's pending mentions, oldest first, with the original message, root message, and thread context. Reading does not mark a mention as replied or claim work. The reply body must contain 1–10,000 characters. The server places the reply in the original source thread and marks that mention replied; the client does not choose another agent or destination.

Keep the same request ID and body when retrying a reply. The local journal and server's idempotency prevent a repeated request from posting twice. If another request already answered the mention, the server returns `409 mention_already_replied`; the adapter reports it without retrying. Replying completes the mention, not any work task.

**The automatic `run` loop remains task-only.** It neither fetches nor answers mentions. A tag alone is not permission to execute code or modify a workspace; execution requires a separately queued assignment and the explicitly configured runner and workspace.

## Retry and interruption recovery

Automatic retries cover `429`, server errors, and transient connection failures. Every attempt keeps the same JSON body and request ID. Validation, authentication, redirect, and lease failures are not automatically retried. Progress and heartbeat lack an idempotency field in this protocol; duplicate receipt events are possible after an uncertain network outcome, without changing their lease/action semantics.

Inspect pending requests and the current local run:

```bash
python3 integrations/vibz_agent.py journal
python3 integrations/vibz_agent.py retry EXISTING-REQUEST-ID
```

The journal rejects a changed payload under an existing ID. A response already recorded as settled is returned locally; it is not evidence of current connectivity. A new heartbeat provides a fresh connection check.

The loop safely retries a recorded pending delivery on restart. If interrupted during execution, it **does not rerun the task automatically**, because earlier filesystem work may already have happened. Stop any orphan process and inspect the workspace, then acknowledge that recovery condition explicitly:

```bash
python3 integrations/vibz_agent.py recover --work-stopped
```

Recovery attempts to block the old lease. If the hub reports that the lease was already lost, only the local active record is cleared; another agent's work is untouched. The old evidence and request history remain.

## Verification

Run the focused offline suite from the project root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations -p 'test_*.py' -v
```

The tests cover separate gateway/agent headers, redirect rejection, unchanged retry payloads, pending-journal recovery, secret redaction, expired/completed claims, progress-only lease renewal, stopping work after lease loss, `shell=False` execution, exclusion of hub credentials from Ollama and Codex contexts, and mention command shapes and idempotent replies.

These are offline tests with fake HTTP responses and subprocesses. They do not claim that a private Site service credential exists, that an existing personal assistant is connected, or that Codex/Ollama executed a live task. No live agent was launched while this adapter was implemented.

### Rework handoff context (J1)

The shared Codex/Ollama prompt preserves the canonical task id/title/brief/acceptance
and includes the current attempt when supplied. Nonempty review context includes
only `reviewNote`, previous `result`, and evidence `label`/`url` fields. Limits match
the service contract: 4,000 note characters, 20,000 result characters, 12 evidence
items with 1,000-character labels and 2,048-character URLs. Out-of-contract context
is bounded with explicit `truncatedFields`; oversized canonical instructions fail
closed instead of silently changing the brief. Known configured bridge credentials
are redacted before JSON escaping. This is not a general detector for arbitrary
secrets embedded in user text.

Review text and previous candidates are explicitly untrusted task data, not
permission to change scope, access, configuration or approve work. Evidence is
not independently verified; URLs do not authorize fetching. The current service
exposes no delivery/revision identity: the prompt states that limit rather than
inventing an identity from the current execution attempt. This does not repair
backend review-version fencing. Fresh tasks do not get invented review context.

The Ollama worker accepts the same bounded prompt as Codex (512,000 characters),
including JSON escaping, and rejects over-limit input instead of silently reading
only a prefix. `test_rework_prompt.py` additionally requires the project's existing
Node 24/dependencies and SQLite harness. It seeds synthetic membership, runs real
production create/claim/deliver/changes-requested/claim methods, and captures both
runners using mocked subprocesses. No model or live service is contacted. Run all
bridge tests with the unittest command above, or run only the dependency-free
original suite with `-p 'test_vibz_agent.py'`.

### Supervised runner input (issue #6)

Runner stdin is nonblocking. Partial writes share the execution supervision loop,
so pending input cannot postpone timeout or lease-validity checks. A broken pipe
or process exit before the entire prompt is sent rejects the candidate, including
exit status zero. Stdin closes on every exit path before process-group
cleanup, including when the group leader has already exited. Remaining group
members receive SIGKILL after the bounded SIGTERM/leader-wait phase. Once bytes have entered the pipe, the bridge cannot prove a runner read
or understood them; completion remains a candidate for human review.

`test_runner_input.py` uses finite local Python children and a constrained pipe
to cover a nonreader deadline, lease loss during pending input, a slow reader
receiving the complete Unicode/escaped context, premature zero exit, and broken
pipe cleanup. Each checks closed stdin and a reaped child with no remaining test
process group. An additional test verifies that an exited leader's same-group
descendant is terminated even when it ignores SIGTERM (a zombie awaiting host
reaping is distinguished from runnable work). These Linux tests require
`fcntl.F_SETPIPE_SZ`; they do not run models or call a network service. Descendants
that create a new session and escape the process group require host containment;
this bridge does not provide that containment.
