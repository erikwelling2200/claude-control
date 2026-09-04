# Claude Control — working in this repo

## What this is

A VS Code sidebar panel that lists **every Claude Code conversation on the machine**, not just the ones in
this window: what each is doing right now, which of them are waiting on you, and what they have changed.
From a row you can open the conversation, kill it, diff a file it touched, or hand it Remote Control.

It is a **reader**, not an integration. The Claude Code extension exports no API and Claude Code itself
offers no IPC, so everything here comes from watching files Claude and VS Code already write. That single
fact explains most of the design: no dependencies, no daemon, no protocol — just `fs.watch`, a scan, and a
webview. The exceptions are one internal command of the Claude extension (`claude-vscode.editor.open`,
probed once and falling back to a terminal resume) and one CLI call (`claude agents --json`, one of four
liveness sources, so losing it costs nothing).

## Where the facts come from

| What | Read from | Owner |
|---|---|---|
| conversations, titles, prompts, pending tool, edits | `~/.claude/projects/<slug>/<sessionId>.jsonl` | [scanner.ts](src/scanner.ts) |
| which conversations have a process | `~/.claude/sessions/*.json`, `/proc` argv, `claude agents --json` | [live.ts](src/live.ts) |
| exact status and live permission mode | hook payloads spooled to `~/.claude/claude-monitor/events` | [hooks.ts](src/hooks.ts), [status.ts](src/status.ts) |
| plan limits | `~/.claude.json` → `cachedUsageUtilization` | [usage.ts](src/usage.ts) |
| folder trust | `~/.claude.json` → `projects[dir].hasTrustDialogAccepted` | [trust.ts](src/trust.ts) |
| Remote Control bridge | `projects/<slug>/bridge-pointer.json` | [bridge.ts](src/bridge.ts), [remote.ts](src/remote.ts) |
| which conversation a chat tab shows | `workspaceStorage/<hash>/state.vscdb` | [panelstate.ts](src/panelstate.ts) |
| what the other windows can see | `globalStorage/…/tabs.json` | [tabshare.ts](src/tabshare.ts) |

`~/.claude` honours `CLAUDE_CONFIG_DIR`; always go through [paths.ts](src/paths.ts) rather than joining
paths by hand. `canonical()` there is not decoration: the same folder arrives as `C:\x` from a terminal
session and `c:\x` from the IDE, and rows, filters and bridges only line up because every cwd passes
through it.

## The shape of the thing

```
 disk  ──watch──▶  Monitor (watcher.ts)  ──PanelData──▶  SessionsView (webview.ts)  ──▶  media/panel.js
                        ▲                                        │
        ChatTabs, SharedTabs, hooks, usage                  messages back
```

- **[watcher.ts](src/watcher.ts) — `Monitor`** is the core. It installs the watchers, merges every source
  and builds `PanelData`. It deliberately imports nothing from `vscode`, so [paneltest](tools/paneltest.ts)
  can drive it headlessly. Cadence: a 300 ms debounce on file events, a 5 s tick that rescans only live
  conversations, and a 60 s full reconcile that also asks the CLI. `AGENTS_TTL_MS` (120 s) is how long the
  CLI's answer is trusted; `WRITING_WINDOW_MS` (45 s) treats a just-written transcript as alive.
- **[store.ts](src/store.ts)** caches `TranscriptRecord`s in `globalStorage/index.json` keyed by
  (size, mtime) so the panel paints instantly on activation; bump its schema constant when the record
  changes shape.
- **[scanner.ts](src/scanner.ts)** only ever reads the **tail** of a transcript (`tailBytes`, default
  128 KB). Transcripts reach tens of megabytes — never read one whole.
- **[status.ts](src/status.ts)** turns a record plus a hook signal plus liveness into one `SessionState`.
  Hook signals only win while at least as fresh as the transcript.
  A turn that ended while a background task is still out resolves to `waiting`, not `finished`: the
  scanner counts launches (`Monitor`, a background `Agent` or shell) that have not yet been answered by a
  `<task-notification>`, and a task the session will be woken for means it is not done.
- **[extension.ts](src/extension.ts)** is host wiring only: commands, dialogs, tabs, processes. Anything
  that could be reasoned about without `vscode` belongs in its own module instead.
- **[media/panel.js](media/panel.js)** renders and reconciles rows by key so a spinner never restarts.
  Host → webview: `data`, `focusSearch`, `showWaiting`. Webview → host: `ready`, `open`, `kill`, `reveal`,
  `copyId`, `diffFile`, `openFolder`, `remoteInSession`, `toggleRemote`, `refreshUsage`,
  `enablePreciseStatus`.

The list is grouped into a foldout per workspace, the window's own folder first; there is no project
filter, and group labels are disambiguated host-side until unique.

## A process, a chat tab and a conversation are three things

Keep them apart; the code does, and every bug in this area came from merging two of them:

| | | |
|---|---|---|
| a process | one running `claude.exe` | `LiveSession`, [live.ts](src/live.ts) |
| a chat tab | one webview, in **one** window | [tabs.ts](src/tabs.ts) |
| a conversation | one transcript on disk | `TranscriptRecord`, [scanner.ts](src/scanner.ts) |

They come apart in both directions, so the panel needs both facts. A row's `state` answers only the
process question — `killed` means no process, whatever a tab still shows — and `Monitor.shows()` is the
single place where tab presence decides visibility: a tab with no process is listed as killed, a process
with no tab is hidden, and a conversation no window has ever claimed falls back to the `showClosed`
setting. Never fold tab presence into liveness: `pid` and `live` must stay usable, or an orphan cannot be
killed from the panel.

Closing a chat tab does **not** end the conversation — the Claude extension keeps the process alive so
Ctrl+Shift+T can restore the tab, so every liveness source still reports it as running. Orphans from a
window's previous extension host can survive for hours. Killing one is therefore two acts: close the tab,
then kill the process tree ([live.ts](src/live.ts) `killSessionProcess`).

## Talking between windows

Only the window holding a tab can see it, so every window publishes its own chat tabs to
`globalStorage/tabs.json` ([tabshare.ts](src/tabshare.ts)), keyed by its extension-host pid and pruned
when that process dies. That pool answers both questions: a tab closed in one window empties the row in
all of them, and a tab merely open in another window — including one VS Code restored that nobody has
clicked, which has no process behind it — keeps the conversation listed as killed rather than hidden.

The same file is the only channel between windows. Clicking a row whose tab lives elsewhere leaves a
request addressed to that window's pid; that window answers on its own file-change event, reveals the tab
and raises itself, so a conversation is never opened twice. If nobody answers within 2.5 s the click falls
back to opening locally.

**Reading the record and publishing to it are separate abilities.** A window with no folder open has no
workspace database and can never say what its own tabs hold, but it still lists every conversation and its
clicks must still reach the right window. Gating both on `context.storageUri` once left such a window
silently opening every conversation a second time.

## Finding which conversation a chat tab shows

Nothing in the VS Code API ties a tab to a session: `TabInputWebview` exposes only a viewType, chat tabs
all share `claudeVSCodePanel`, and the Claude extension exports no API. The mapping does exist in VS Code's
own workspace database, `workspaceStorage/<hash>/state.vscdb` (the parent of `context.storageUri`), where
each chat tab is stored under `memento/workbench.parts.editor` with `state: {"sessionID": "…"}`.

[panelstate.ts](src/panelstate.ts) reads that as text, and three properties of a SQLite file shape how —
each one cost a debugging round:

- superseded copies of the record survive in freed pages, so the file holds several layouts at once and
  candidates are scored against the labels of the tabs actually open;
- a value is not stored next to its key, so the layout is found by its own first field, not the memento
  key;
- a large value is split across pages, so it can never be `JSON.parse`d whole — the fields of one tab are
  read where they sit, and a page boundary costs one record instead of the whole window.

Two things about titles. The stored title is the **displayed**, already-ellipsised one (`"Erik Welling
milestone b…"`) while `tab.label` is the full summary, so matching must treat a truncated title as a
prefix — and only a truncated one, or `"hi"` claims the tab named `"hi2"`. And a brand-new chat is titled
`"Claude Code"` because it has no summary yet, so never key anything off the label alone. When matching
fails completely, a window with tabs open publishes **all** its mapped conversations rather than none:
over-claiming leaves a row listed slightly too long, under-claiming breaks every hand-over to that window.

## Raising another window

VS Code exposes no API to bring a window to the front ([microsoft/vscode#51078](https://github.com/microsoft/vscode/issues/51078),
open since 2018). The working substitute is to have the target window run its own CLI against the
workspace it already has open — `Code.exe <workspace>` — which the running instance recognises, opens
nothing new for, and raises. Verified here: the main-window count does not change.

Two traps. Pass the **workspace file** when the window has one, since a multi-root window is matched by
that and not by its first folder. And **delete `ELECTRON_RUN_AS_NODE` from the child's environment**: the
extension host sets it, and a child that inherits it runs `Code.exe` as a bare Node interpreter, which
resolves the workspace path to its `package.json` main and executes *that* — in this repo it ran
`dist/extension.js` and died on `Cannot find module 'vscode'`.

## The running extension is not this repo

VS Code loads the extension from the installed copy under
`~/.vscode/extensions/erikwelling2200.claude-control-pane-<version>`, which was unzipped from a `.vsix` at
install time. Editing a file here changes nothing in the running panel, and no amount of reloading will
pick it up — this is the single most likely reason a change "does not work".

`npm run deploy` ([tools/deploy.mjs](tools/deploy.mjs)) bridges the gap: it builds and copies
`dist/extension.js`, `package.json` and all of `media/` over that installed folder, resolving it by
`publisher.name-*` so a version bump does not break the path. That replaces build + `vsce package` +
reinstall with a file copy. `npm run package` is only for producing a shippable `.vsix`.

## After every change, say which reload the user must run

The reload needed depends on what was touched, the user cannot tell from the diff, and the wrong one looks
like a broken edit. So end any turn that changed code with the instruction, explicitly:

| Changed | Deploy step | Reload |
|---|---|---|
| `media/*` only (`panel.js`, `panel.css`) | `npm run deploy` | **Developer: Reload Webviews** |
| anything in `src/*` | `npm run deploy` | **Ctrl+R in the extension development host** |

Webview assets are fetched over `vscode-webview://` at load time rather than baked into the bundle, which
is why they reload on their own. `dist/extension.js` is in Node's module cache in the extension host, so
only a host restart picks it up. Anything touching [tabshare.ts](src/tabshare.ts) or the hand-over needs
**every** window restarted, not just the one being tested — the other window is half the feature.

## Never restart the extension host in the user's main window

**Developer: Restart Extension Host** and **Reload Window** restart *every* extension in that window,
Claude Code among them — so they kill the session you are talking through. Do not suggest either as the
iteration step for `src/*` work. Use the extension development host instead:

- **Ctrl+Shift+D → Run Extension**, or
  `code --extensionDevelopmentPath="c:\Tools\claude-control" --new-window "c:\Tools\claude-control"`
- It loads the extension from this repo, so Ctrl+R there reloads the new bundle with the main window's
  host untouched.
- Do not put a `preLaunchTask` in [.vscode/launch.json](.vscode/launch.json). A background `npm: watch`
  task makes VS Code wait for a problem-matcher pattern `esbuild.mjs` never prints, and the launch hangs
  with no error — Run Extension simply appears to do nothing. Build from the Bash tool instead.

Running the dev host alongside the installed copy is safe by design: [status.ts](src/status.ts) keeps hook
spool files for 30 s so every open window drains them before one deletes them. The two share
`globalStorage/index.json`, but that is a paint-fast cache that rebuilds from the transcripts.

## Webview constraints

- The webview CSP has no `unsafe-inline`, so a `style` attribute in generated markup is **dropped
  silently**. Set widths and other computed styles through the CSSOM after `innerHTML`, the way
  [panel.js](media/panel.js) applies the usage-bar fills.
- `renderUsage` and friends compare against `dataset.markup` and bail when it is unchanged, so a change
  that does not alter the generated string will not repaint.

## Debugging a cross-window problem

Guessing has lost every round in this area; the state is on disk, so read it:

- the **Claude Control** output channel, per window — it logs what that window publishes, every hand-over
  decision with the full window map, and why a tab could not be identified;
- `globalStorage/…/tabs.json` — which windows are registered, what each claims, pending requests;
- a window's `state.vscdb`, parsed by pointing a scratch script at
  [panelstate.ts](src/panelstate.ts) — that is how the two SQLite assumptions above were caught.

## Tests

`npm run test` runs all three: `paneltest`, `hooktest`, `statetest`. All pass as of 2026-09-04, so treat a
failure as real. `paneltest` reads your **real** `~/.claude`, so a failure can still come from the data
rather than the change — verify against a stash before assuming otherwise. `npm run probe` prints what the
scan sees without a UI; `npm run typecheck` is not part of the build, since esbuild only transpiles.

## Conventions

Match the surrounding style: tabs, no semicolons, comments that say *why*. Settings live under
`claudeMonitor.*` in [package.json](package.json); everything the Monitor needs goes through `readConfig()`
so it arrives as one `MonitorConfig`, and only the few the host acts on itself are read at their use site.
When a behaviour becomes the only sensible one, delete its setting rather than leaving a dead knob — the
project filter and `groupByProject` went that way.
