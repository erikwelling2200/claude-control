# Internals

Notes on Claude Code's on-disk formats and why the extension reads them the way it does. None of this is a published API, so every reader is defensive: per-line `try`/`catch`, every field optional, unknown record types ignored. A format change should degrade a title or a status, never crash the panel.

Verified against `anthropic.claude-code` 2.1.220 on Linux.

## Architecture

```
claude agents --json (60s, authoritative) ─┐
~/.claude/sessions/*.json + /proc (5s)   ──┼─► scanner ─► store ─► webview
~/.claude/projects/**.jsonl (fs.watch)   ──┤            (globalStorage)  │
~/.claude/claude-monitor/events/ (hooks) ──┤                             │
~/.claude/projects/*/bridge-pointer.json ──┘                             ▼
                                    click ─► claude-vscode.editor.open <sessionId>
```

| File | Role |
|---|---|
| `src/paths.ts` | `~/.claude` locations, project slug, NFC/realpath comparison, binary resolution |
| `src/live.ts` | which sessions are actually running |
| `src/scanner.ts` | bounded reads of transcripts into records |
| `src/status.ts` | hook-spool drain and the state machine |
| `src/store.ts` | schema-versioned cache in global storage |
| `src/watcher.ts` | `Monitor` — owns all observation, produces panel rows |
| `src/hooks.ts` | consented, reversible edits to `settings.json` |
| `src/bridge.ts` `src/remote.ts` | Remote Control detection and lifecycle |
| `src/trust.ts` | workspace-trust state |
| `src/webview.ts` `media/` | the panel |
| `src/extension.ts` | activation, commands, diffs, status bar |

## Which sessions are live

Four independent signals, **unioned** — a session is live the moment any one of them notices. An earlier version let each source overwrite the last, so a resumed conversation could keep reading as `closed` until something else happened to agree.

1. **`~/.claude/sessions/<PID>.json`** — the registry, read on the 5 s tick. These files are **not** reliably cleaned up after a crash, so liveness is `/proc/<pid>` existing **and** field 22 of `/proc/<pid>/stat` matching the recorded `procStart` — the same pid+procStart check the Claude binary performs. Field 22 is read by slicing after the *last* `)` in the stat line, because the comm field can itself contain spaces and parens.
2. **The process table** — walk `/proc/*/cmdline` for claude processes and pull the id out of `--resume=<id>` or `--session-id <id>`. Verified: resuming a conversation reuses the **same** session id, so this recovers it even if the registry file was never written or was cleaned up. ~6 ms for a full walk, Linux only.
3. **`claude agents --json`** — documented for scripting, needs no TTY, filters liveness itself. Costs ~0.7–2 s per spawn, so it runs on the 60 s reconcile and its answer is then trusted for 120 s rather than discarded on the next tick.
4. **A transcript written in the last 45 s** — whatever is appending to it is by definition alive, and this needs no process bookkeeping at all.

Scanning idles while the view is hidden, but liveness is refreshed and re-emitted immediately when it becomes visible again, so a conversation resumed behind your back is never still grey when you look back at it.

## Transcripts

`~/.claude/projects/<slug>/<sessionId>.jsonl`, one JSON object per line. Record types seen: `assistant`, `user`, `ai-title`, `custom-title`, `last-prompt`, `mode`, `attachment`, `queue-operation`, `file-history-snapshot`, `file-history-delta`, `system`.

- `custom-title` (user-set, wins) and `ai-title` are re-appended repeatedly — 330× in one file — so the newest is always near the tail. That's why a 128 KB tail read suffices, and why whole files are never read: transcripts reach 16 MB.
- `last-prompt` drives the prompt preview. Slash-command turns wrap text in `<command-name>` / `<command-message>`, and injected context arrives in `<system-reminder>` / `<ide_selection>`. `sanitize()` strips exactly those known wrappers, so a prompt that genuinely mentions `<div>` survives.
- `isSidechain: true` records and the nested `subagents/*.jsonl` files are subagent chatter, not the conversation's own state, and are excluded.
- `system` + `subtype: "api_error"` drives the error state, cleared by any later assistant record.

**The slug is lossy and never reversed.** `Γ Projects` becomes `---Projects` — every non-alphanumeric character maps to a dash. The forward direction is used only to locate a bridge pointer. Project identity always comes from the `cwd` field inside the records, compared via `realpath` + NFC normalisation (necessary on paths containing non-ASCII).

## State machine

Precedence, highest first. A hook signal only wins while it is at least as fresh as the newest transcript record (2 s tolerance), so a stale spooled event can never pin a row.

1. no live process → `closed`
2. fresh hook says needs-input → `needs-input`
3. unresolved `api_error` → `error`
4. fresh hook says finished → `finished`
5. pending `tool_use`:
   - `ExitPlanMode` or `AskUserQuestion` → `needs-input` immediately; these tools exist to ask
   - otherwise `busy`, or `needs-input?` if stalled beyond `staleToolSeconds` with no trustworthy hook signal
6. fresh hook says busy → `busy`
7. user spoke more recently than the assistant → `busy`
8. last assistant record was `end_turn` → `finished`, otherwise `busy`

**Interrupts.** Hitting stop writes a `user` record whose text is `[Request interrupted by user]` (or `… for tool use`), and nothing else — no `end_turn`, no `Stop` hook. Counted as the user speaking, rule 7 pins the row on "Thinking" forever, so that record instead sets an `interrupted` flag (cleared by any later real activity), closes out the orphaned `tool_use`, and resolves as `finished` with the label "Interrupted" — slotted just below the fresh-signal rules.

`finished` is then downgraded to `reviewed` if you have opened the conversation since it last changed. That step lives in the Monitor, so `resolveState` stays a pure function of transcript + liveness + hook signal — which is what makes `npm run statetest` possible.

**Why "waiting" can't be derived from files alone:** a pending `tool_use` with no matching `tool_result` is identical whether Claude is running a slow `Bash` or is blocked on a permission prompt. Nothing else is written at that moment. Hooks close the gap; without them a stalled tool call is reported as *uncertain*, never as a confident "needs input".

## Hooks

Seven events: `UserPromptSubmit` (busy), `PreToolUse` (busy), `PermissionRequest` / `Elicitation` / `Notification` (needs input), `Stop` (finished), `SessionEnd` (closed). All but one fire at most once per turn.

`PreToolUse` fires on every tool call, and an earlier version deliberately left it out — the running tool's name is already in the transcript. It is hooked anyway for one field: `permission_mode`. A mid-run Shift+Tab is recorded nowhere on disk (see below), so the payload on each tool call is the only reading that can surface it before the turn ends. The spooled `cat` costs a few ms per tool call. `PostToolUse` stays unhooked; it adds nothing PreToolUse doesn't. Installs made when there were six events are topped up silently at activation (`hooksOutdated()`), since without that the missing event would read as "not installed" and switch precise status off.

The hook does no parsing; it spools raw stdin:

```
mkdir -p '<spool>' && cat > '<spool>'/$$-$(date +%s)-$RANDOM.json
```

The directory is quoted (it may contain spaces) while the filename is not, so `$$` and `$RANDOM` still expand. One file per event avoids interleaved appends, and `cat` cannot meaningfully slow or fail a turn.

**Reads are non-destructive.** Several IDE windows can each run Claude Control, and deleting spool files on sight would let them steal each other's events — whichever read first would be the only one to see a permission prompt. So each window tracks the filenames it has consumed and only unlinks files older than a 30 s grace window. `CLAUDE_MONITOR_SPOOL_DIR` overrides the location, which is how tests avoid racing a live instance.

Installing copies `settings.json` into `~/.claude/backups/` first, writes via temp-file + atomic rename, and **merges** into existing `hooks.<Event>` arrays. Entries are identified for removal by the spool path inside their command, so no non-standard keys are added. Malformed existing settings are refused rather than clobbered. `npm run hooktest` asserts all of it, including byte-identical restore on uninstall.

Hook payloads also carry `permission_mode`, which matters because the transcript does not — see below.

## Permission mode and model

`permissionMode` appears **only on `user` records**, stamped at prompt submission (measured: 326 `acceptEdits`, 226 `bypassPermissions`, 45 `plan`, 16 `default`, all on `user`). `mode` records only ever say `"normal"` (1489×) and are useless.

Worse, it is not stamped on *every* user record — a 1500-record session carried only **10** of them, and their values jump around (`bypassPermissions → acceptEdits → bypassPermissions → default → …`), consistent with being written on change rather than per turn. Combined with a 128 KB tail, a session can easily have **zero** mode records in the window, so the value is carried forward from the last scan that saw one.

So **a mid-run permission-mode change is recorded nowhere on disk** until your next prompt, and the newest reading available can be hours old. With hooks enabled the mode refreshes on every hook event — including `PreToolUse`, which fires on every tool call, so a mid-run Shift+Tab shows up within one tool call rather than at the end of the turn. That is as close to live as the data allows; no polling frequency can do better.

The field sits on the prompt record itself (`promptSource: "sdk"`, alongside `promptId` and `origin`), which is the crux: **its timestamp is always identical to the user turn it belongs to.** A first attempt at flagging staleness compared `permissionModeAt < lastUserTurnAt` and therefore never fired, so the icon always looked confident — which is how the panel showed a Manual hand for a conversation running in bypass.

The mode a transcript reports can only ever be "as of some past prompt", so anything a hook has not confirmed is rendered faded with a "last known" tooltip, unconditionally. Nothing else on disk helps: `session-env/<id>/` is empty, no `permissionMode` appears anywhere in the IDE's `state.vscdb`, and `mode` records only ever say `"normal"` (they track plan-vs-normal, not tool permissions).

The model comes from `message.model` on assistant records (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, …), reduced to the bare family. `<synthetic>` is ignored.

Permission-mode icons are the `iconV2Small` components extracted from the Claude Code webview bundle, along with Claude's own labels — `default` is "Manual", `acceptEdits` is "Edit automatically", plus Plan, Auto and Bypass permissions.

## Changed files and diffs

Sourced from `file-history-delta` records — Claude's own edit tracker, which is backed by real file backups, rather than inferred by scraping tool calls.

- `trackingPath` is **absolute** in current versions and **relative** in older ones. Both are handled, with relatives resolved against `cwd` *after* the scan pass, since `cwd` isn't known when the first delta is read.
- `backupFileName` is `null` in current transcripts, so the backup location is derived: `~/.claude/file-history/<sessionId>/<sha256(absolutePath)[:16]>@v<version>`. Verified against every backup in a real session (26/26 hashes matched).
- **Versions are per-session, and a backup holds the content from *before* its change.** Each session starts its own `file-history/<sessionId>/` directory, so the first time a session touches a file it writes `@v1` — the file as that session found it. A long-lived file is therefore reported at `v1` constantly: `src/entities/Player.js` reports `v1` in six different sessions, and in one of them has `v1`–`v7` on disk, none matching the current file.
- So the "before" side of a diff is the backup at the run's **own lowest version**, not one below it. Resolution walks *downwards* from there only because old versions get pruned.
- **`v1` does not mean "new file".** Reading it that way made every chip claim "new in this run". A file created by the run has nothing to back up, so it simply has no backup at or below its reported version — that absence, not the version number, is what identifies a new file. It then diffs against an empty document via a `TextDocumentContentProvider`, after trying `git.openChange` in case the snapshots were merely pruned.
- Because `min()` is taken per path when accumulating, a file's version collapses to the earliest the session recorded — which is exactly the pre-session state, and why starting *at* that version is correct.

Edits accumulate across scans (union by path, keeping the earliest version) because the tail is only a window — otherwise a long run's early edits would scroll out of sight. Bounded at 400 per session, with the per-run filter trimming the display. A *cold* start with no cache still only sees the tail. Files moved or deleted by `Bash` never appear, because Claude's tracker doesn't back those up.

The chips additionally show only edits **inside the project folder that still exist**: Claude's tracker also records its own scratch files (throwaway `.mjs` scripts under `/tmp`) and files it creates then deletes, neither of which is news about the project. The full set is still cached — only the display is filtered.

## Pending messages, and why "typing…" is impossible

A prompt submitted while Claude is mid-turn is queued, and the transcript records it:

```
{"type":"queue-operation","operation":"enqueue"|"dequeue"|"popAll"|"remove","timestamp","sessionId","content"?}
```

Current versions stamp the queued text on the enqueue as `content` — and that matters, because the `last-prompt` record is only appended when a prompt is *consumed*, so while a message sits queued, `last-prompt` still holds the previous one. An earlier version prefixed `[pending]` to that and confidently labelled the wrong message. `content` is also how injected turns are told apart: a `<task-notification>` block queued by the harness sanitizes to nothing and is not treated as the user's message. Counting enqueues minus dequeues *within the tail* is safe, because anything written after an enqueue is necessarily inside the window too. The only loss is an enqueue old enough to have scrolled out, which needs a very long busy run. The count is zeroed for dead sessions, since a queue nobody can drain is not news.

**An unsent draft cannot be detected at all.** It lives in the Claude webview's in-memory DOM. Nothing under `~/.claude` changes while you type — verified by watching for modifications during an active draft — and the only persisted trace would be VS Code's webview state, which:

- holds no input value: the Claude sidebar memento is 78 bytes, and `memento/workbench.parts.editor` carries only panel metadata (`viewType`, `title`, `options`), no session id and no draft;
- is flushed periodically to `state.vscdb`, not per keystroke, so it could never be live anyway;
- would be another extension's private state, per-window.

There is also no hook for input changes. So the panel reports *submitted-but-unprocessed* messages, which is honest, and says "pending" rather than "typing".

## Usage limits

`~/.claude.json` → `cachedUsageUtilization`. Alongside the legacy `five_hour` / `seven_day` keys it carries a normalised `limits` array, which is what the footer renders:

```
{ kind: "session" | "weekly_all" | "weekly_scoped", group, percent,
  severity: "normal" | "warning" | "critical", resets_at, is_active,
  scope: { model: { display_name } } | null }
```

`weekly_scoped` is the model-specific cap and only its `scope.model.display_name` distinguishes an Opus cap from a Fable one, so the label comes from there. `is_active` marks the limit actually constraining you.

Severity is taken from Claude but never trusted downwards — a bar at ≥75% is shown as `warning` and ≥90% as `critical` even if the payload says `normal`.

**Claude only refreshes this cache on request** — not on an interval and not when a run starts. Observed ~24 h stale with eight sessions active, so the footer always shows how old the reading is and dims when older than 15 minutes.

Both the footer and the toolbar refresh button run `claude -p /usage --session-id <uuid>` headlessly, which does update the cache — the footer also shows Claude's own report text in an output channel, since `ExtraUsageDialog` and friends are CLI components that no external command can pop open. Injecting `/usage` into a live conversation was tried first and is wrong: `createPanel` discards the prompt whenever that session is already open in the window, so it reliably produced Claude's baffling *"Session is already open. Your prompt was not applied"* and never refreshed anything.

The headless run writes a throwaway transcript. A fixed session id cannot be reused (`Error: Session ID … is already in use`), so a fresh uuid is generated per refresh, hidden from the panel via `Monitor.setExcluded` while it runs, and its transcript deleted afterwards — the path is rebuilt from our own uuid and the filename must match it exactly, so nothing else can be removed.

The file is ~40 KB, so `readUsage()` is gated on its mtime rather than re-parsed each tick, and it is watched as a single file — its parent is `$HOME`, which must never be watched wholesale.

## Remote Control

`claude remote-control` (hidden, alias `rc`) is a persistent server for **one directory**. Live state is `~/.claude/projects/<slug>/bridge-pointer.json`:

```
{ sessionId, environmentId, source: "standalone" | "repl", pid?, procStart? }
```

Freshness is judged by the file's own mtime against a 4 h TTL, and `pid`+`procStart` are validated as above — so bridges started outside the extension are detected too.

`source` is the useful part. `"repl"` means the bridge was started by `/remote-control` inside a conversation, and `sessionId` names that conversation — so only that row lights up. `"standalone"` means a directory-scoped server, so every row in the folder counts.

Two distinct routes, and they must not be confused:

- **The row's context menu** sends `/remote-control` into *that conversation* via `claude-vscode.editor.open(sessionId, prompt)` — a path the Claude extension uses internally. This is the one that exposes a specific conversation.
- **The title-bar tower** starts a folder-wide standalone server in a terminal.

Caveat on the first: if the session is already open in this window, Claude reveals the panel and discards the prompt (`createPanel` shows "your prompt was not applied" whenever the session has a panel), and nothing can send text into it — `/remote-control` is rejected in print mode, and the insert commands only emit `@file` mentions. What does work: the reveal makes the panel the active editor, and `editor.action.clipboardPasteAction` has a webview implementation in the workbench, so `/remote-control` is copied to the clipboard and pasted into the input programmatically. Only Enter is left to the user — there is no way to synthesize a key press into a webview. The clipboard copy stays as the fallback if the paste route ever goes away.

**Never signal a bridge pid this window did not start.** `source:"standalone"` is the only writer that records `pid: process.pid`; the schema also allows `source:"repl"`, whose pid would be the conversation's own claude process — SIGINT-ing that would kill a live session. So stopping only signals a pid when we still hold the terminal that launched it, and otherwise just reports that it must be stopped where it was started.

### Workspace trust

Remote Control runs as a standalone `claude`, which requires the one-time workspace trust dialog. Conversations opened through the IDE **never** trigger it, so nothing is written to `projects[<dir>].hasTrustDialogAccepted` in `~/.claude.json`. On a machine that has only ever used the IDE that map is empty and *every* folder reads as untrusted.

The toggle checks trust first and offers both routes Claude's own error message names: open a terminal running `claude` there, or write the flag directly (backed up, atomic, only that key touched). The check walks **parent directories**, matching the binary — trusting a repo root covers its subdirectories. Home directories are permanently unavailable; the binary never saves trust for them.

## Opening a conversation

`claude-vscode.editor.open` is internal to the Claude Code extension: `async (sessionId, initialPrompt, viewColumn)`. Its `createPanel` looks the session up in a per-window `sessionPanels` map and reveals an existing panel, else opens one that resumes the session. The command is probed once via `getCommands(true)`; if it's ever missing or throws, the extension falls back permanently to a terminal `claude --resume <id>`.

Because that map is per-window, opening a session that's live in a *different* window would attach a second panel to the same transcript — detected and confirmed first.

**Stale tabs can't be reconciled.** A Claude panel restored after a reload looks open but has no process, so it correctly reports as `closed`, and clicking resumes it in a new panel. A restored panel with a dead process never registers a session id, and nothing in the VS Code API ties a webview tab to one — `TabInputWebview` exposes only `viewType`. So the stale tab can be neither focused nor identified for closing.

`claudeVSCodeSessionsList` is not reusable either: `resolveSessionListView` renders the Claude extension's own React bundle fed by a private `broadcastSessionStates()`. No exported API, command, or data contract.

## Performance

Recency is the file mtime; a record's own timestamps are used for hook freshness and staleness. A cached record whose `(size, mtime)` is unchanged is reused without any read, which is what makes reconciliation nearly free.

Measured on 49 transcripts / 159 MB: cold scan ~190–310 ms, warm reconcile ~1 ms, registry read ~4–16 ms, warm start-to-first-paint ~4–30 ms. The cache is schema-versioned, so a shape change self-invalidates.

**Never watch recursively.** `fs.watch(projectsDir, {recursive: true})` took **55 seconds** to install for only 68 directories, blocking activation the whole time. Transcripts live exactly one level deep, so the extension keeps one flat watcher per project directory — 61 ms for the same coverage — adding and dropping them as project directories appear. Watcher installation and the first scan are also deferred off the activation path, so the panel paints from cache in tens of milliseconds regardless.

## Status bar

VS Code honours only `statusBarItem.warningBackground` and `.errorBackground` for a status bar item's background — an arbitrary hex is ignored — and setting a background **forces** the matching foreground, so `color` has no effect. To pin exact colours:

```json
"workbench.colorCustomizations": {
  "statusBarItem.warningBackground": "#DE7552",
  "statusBarItem.warningForeground": "#FFFFFF"
}
```

There is also no hand among the 579 codicons, and `✋` renders as a colour emoji, hence the bell.
