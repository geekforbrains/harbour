# Captain

Captain is an in-browser chat with a CLI tool — Claude Code, Codex, or Gemini CLI — running server-side on the same machine as harbour. You type, the server spawns the CLI, the CLI's output streams back over Server-Sent Events, and you watch the assistant work in real time. Tool calls render as collapsible blocks alongside the prose.

It's the operator's console. Most things you'd otherwise do by SSH-ing in — reading the SQLite file, debugging a stuck run, drafting a new agent's prompt, querying activity logs — Captain can do without you leaving the dashboard.

## The mental model

A conversation is a row in `captain_conversations`. Each user message you send creates a `captain_messages` row (role `user`) and a placeholder `captain_messages` row (role `assistant`). Then `spawn()` in the process manager forks the configured CLI binary, passes your prompt as input, and pipes its stdout into a parser. Every parsed event becomes a row in `captain_output` keyed by `(conversation_id, message_id)`. The browser opens an SSE connection to `/api/captain/conversations/:id/stream` which polls `captain_output` for rows newer than the last seen id and pushes them down.

| Property | What it gives you |
|---|---|
| **Server-side process** | The CLI runs on the harbour box. It can read `~/.harbour/harbour.db` directly with `sqlite3`, hit `localhost:3000` for API calls, and act on local filesystem state. The browser is just a chat UI. |
| **Multi-conversation** | Each conversation has its own working directory, CLI tool, model, thinking level, and persisted session id. You can have many open; only one process runs per conversation at a time. |
| **Resumable sessions** | Captain captures the CLI's session id from its output and stores it in `captain_conversations.session_id`. The next message resumes that session — your CLI sees its own prior turns. |
| **Mid-stream stop** | An `AbortController` is held in the in-memory `ProcessManager.active` map keyed by conversation id. `POST /stop` aborts; the partial assistant message is preserved as-is. |
| **Tool-call rendering** | The provider's parser emits `tool_start` / `tool_end` events alongside `text_delta` events. Captain renders them inline as collapsible blocks so you can see what was actually run, not just the prose summary. |

The process manager is a singleton stashed on `globalThis` so it survives Next.js dev HMR reloads — losing it would orphan running CLI processes.

## A worked example

Two cards waiting on a stuck job, you don't know why. You open Captain.

1. **You**: "What's blocking run `ab12cd34`?"
2. Captain spawns Claude Code in `~/.harbour/captain/`. The CLI reads `CLAUDE.md` (auto-provisioned on first use), which describes the schema and useful queries.
3. CLI runs `sqlite3 ~/.harbour/harbour.db "SELECT status, ... FROM runs WHERE id LIKE 'ab12cd34%'"` — the `tool_start`/`tool_end` events show up as a collapsible "Bash" block in the chat.
4. CLI summarizes: the run is `waiting`, the latest activity says "needs API key for Buffer." You forgot to attach `BUFFER_API_KEY` to the job.
5. **You**: "Link the BUFFER_API_KEY env var to that job, then mark the run as pending."
6. CLI calls the local API with an admin API key, you watch the requests stream past in real time.

Total time to fix: under a minute, no terminal opened.

## The workspace

Every conversation runs with a `cwd` (working directory). If you don't override it in Settings, it defaults to `~/.harbour/captain/`. On first use of that directory, Captain auto-provisions three files:

- `CLAUDE.md` — the primary knowledge base. Describes Harbour's database schema, key tables, useful SQL queries, the local API base URL, and the on-disk file layout under `~/.harbour/`.
- `AGENTS.md` — symlinks to `CLAUDE.md` (Codex reads this name).
- `GEMINI.md` — symlinks to `CLAUDE.md` (Gemini CLI reads this name).

All three CLIs end up reading the same file. If symlinks aren't supported on the platform, Captain falls back to copying.

The behavior is **never overwrite**. If `CLAUDE.md` already exists, Captain leaves it alone. This is deliberate — once you've added your own conventions ("never run destructive SQL without confirming," "the production API key is in 1Password"), upgrades won't clobber them. The downside: schema drift over time means your `CLAUDE.md` may describe a slightly older shape. Re-provision by deleting it and reloading the conversation.

You can override `cwd` per-instance in Settings if you want Captain to run in a different repo (e.g. point it at the harbour source tree to debug code).

## Configuration

Four settings drive Captain. They live in the `settings` table:

| Setting | Effect |
|---|---|
| `captain_cli` | Which CLI to spawn: `claude`, `codex`, `gemini`. Default `claude`. |
| `captain_model` | Model id passed to the CLI (e.g. a Claude Code or Codex model name). |
| `captain_thinking` | Thinking/effort level. Maps to provider-specific flags. |
| `captain_cwd` | Override for the working directory. Empty string = use `~/.harbour/captain/`. |

When you create a new conversation, those settings are snapshotted into `captain_conversations` (`cli`, `model`, `thinking`, `cwd`). Changing the global setting later affects new conversations only — old ones keep the cli/model they were created with.

## Persistence

Three tables:

```sql
CREATE TABLE captain_conversations (
  id, title, cli, model, thinking,
  session_id,        -- captured from CLI output, used to resume
  cwd,               -- override or null
  user_id REFERENCES users(id) ON DELETE CASCADE,
  ...
);
CREATE TABLE captain_messages (
  id, conversation_id, role ('user'|'assistant'),
  content TEXT NOT NULL DEFAULT '',
  ...
);
CREATE TABLE captain_output (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id, message_id,
  event_type, content, tool_name,
  ...
);
```

The split between `captain_messages` (one row per turn, holds the final assembled text) and `captain_output` (raw stream events, multiple per turn) lets the chat UI show two views: the "rendered" message and, on hover/expand, the underlying tool calls. When the CLI exits cleanly the spawn finalizer reassembles all `text_delta` events into the assistant message's `content` so a fresh page load doesn't have to replay every event.

Conversations are scoped to the user that created them — `captain_conversations.user_id` references `users(id)` with `ON DELETE CASCADE`. Each user sees only their own.

## API

```
GET    /api/captain/conversations               — list user's conversations
POST   /api/captain/conversations               — create
GET    /api/captain/conversations/:id           — full conversation + messages + tool events
PUT    /api/captain/conversations/:id           — rename
DELETE /api/captain/conversations/:id           — stop process if running, then delete
POST   /api/captain/conversations/:id/messages  — send a message (spawns the CLI)
GET    /api/captain/conversations/:id/stream    — SSE stream of new captain_output rows
POST   /api/captain/conversations/:id/stop      — abort the in-flight response
GET    /api/captain/conversations/:id/status    — is the process running?
```

The messages endpoint returns `202 Accepted` with `{ messageId, userMessageId }` and fires the spawn in the background. The browser then opens the SSE stream filtered by `messageId` to consume that turn's events.

## Source-of-truth pointers

If you're hunting in code:

- `src/lib/captain/process-manager.ts` — the `spawn` / `stop` / `isRunning` singleton, abort wiring, finalizer that reassembles the assistant message and persists `session_id`.
- `src/lib/captain/workspace.ts` — `setupWorkspace(cwd)`, the embedded `CAPTAIN_MD` template, the never-overwrite logic, the symlink fallback.
- `src/lib/captain/providers.ts` — per-CLI command builders and stdout parsers (Claude Code / Codex / Gemini).
- `src/lib/db/captain.ts` — CRUD for the three captain_* tables, including `listToolEventsByMessage` for the tool-block rendering.
- `src/app/api/captain/conversations/[id]/stream/route.ts` — the SSE endpoint that polls `captain_output`.
- `src/app/api/captain/conversations/[id]/messages/route.ts` — fire-and-forget `spawn()` invocation per user message.
