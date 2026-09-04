import { execFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { hooksInstalled, hooksOutdated, installHooks, uninstallHooks } from "./hooks"
import { SharedTabs } from "./tabshare"
import { killSessionProcess } from "./live"
import { ChatTabs, chatTabs } from "./tabs"
import { canonical, claudeRoot, findClaudeExecutable, projectName, projectsDir, slugify } from "./paths"
import { RemoteControl } from "./remote"
import type { PanelData, SessionRow } from "./types"
import { needsAttention, Monitor, type MonitorConfig } from "./watcher"
import { SessionsView } from "./webview"

// --- CONSTANTS ---

const OPEN_COMMAND = "claude-vscode.editor.open"		// internal to the Claude Code extension: (sessionId, initialPrompt, viewColumn)
const REMOTE_COMMAND = "/remote-control"
const USAGE_COMMAND = "/usage"
const PROMPTED_KEY = "claudeMonitor.hooksPrompted"
const SEEN_KEY = "claudeMonitor.seenAt"
const STALE_KEY = "claudeMonitor.staleTabExplained"

let monitor: Monitor | undefined
let view: SessionsView | undefined
let remote: RemoteControl | undefined
let statusItem: vscode.StatusBarItem | undefined
let openCommandAvailable: boolean | undefined
let fallbackWarned = false
let usageRefreshing = false
let usageOutput: vscode.OutputChannel | undefined
let log: vscode.OutputChannel | undefined

// --- ACTIVATION ---

export function activate(context: vscode.ExtensionContext): void {
	statusItem = vscode.window.createStatusBarItem("claudeMonitor.waiting", vscode.StatusBarAlignment.Right, 100)
	statusItem.command = "claudeMonitor.showNeedsInput"
	statusItem.name = "Claude Control"
	context.subscriptions.push(statusItem)
	context.subscriptions.push({ dispose: () => usageOutput?.dispose() })
	log = vscode.window.createOutputChannel("Claude Control")
	context.subscriptions.push(log)

	remote = new RemoteControl(() => publishRemoteState())
	context.subscriptions.push({ dispose: () => remote?.dispose() })

	monitor = new Monitor(
		readConfig(),
		path.join(context.globalStorageUri.fsPath, "index.json"),
		activeWorkspaceCwd(),
		(data) => publish(data),
		(row) => announce(row)
	)
	context.subscriptions.push({ dispose: () => monitor?.dispose() })

	monitor.setSeen(context.globalState.get<Record<string, number>>(SEEN_KEY) || {})

	view = new SessionsView(context.extensionUri, {
		open: (sessionId) => void openSession(sessionId, context),
		toggleRemote: (cwd) => void toggleRemoteFor(cwd),
		remoteInSession: (sessionId) => void remoteInSession(sessionId),
		diffFile: (sessionId, file, version) => void diffChangedFile(sessionId, file, version),
		refreshUsage: () => void refreshUsage(true),
		reveal: (sessionId) => void revealTranscript(sessionId),
		copyId: (sessionId) => void copySessionId(sessionId),
		kill: (sessionId) => void killSession(sessionId),
		openFolder: (cwd) => void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow: true }),
		enablePreciseStatus: () => void vscode.commands.executeCommand("claudeMonitor.enablePreciseStatus")
	}, (visible) => monitor?.setVisible(visible))
	context.subscriptions.push(vscode.window.registerWebviewViewProvider("claudeMonitor.sessions", view, { webviewOptions: { retainContextWhenHidden: true } }))

	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => "" }))

	registerCommands(context)
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration("claudeMonitor")) return
		monitor?.setConfig(readConfig())
	}))
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => monitor?.setActiveCwd(activeWorkspaceCwd())))
	watchChatTabs(context)

	monitor.start()
	syncPreciseStatusSetting()
	void maybeOfferHooks(context)
}

export function deactivate(): void {
	monitor?.dispose()
	monitor = undefined
}

// --- COMMANDS ---

function registerCommands(context: vscode.ExtensionContext): void {
	const register = (id: string, handler: (...args: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, handler))
	register("claudeMonitor.refresh", () => { monitor?.refresh(); void refreshUsage(false) })		// the toolbar refresh covers usage too
	register("claudeMonitor.remoteControl.start", () => remote?.start())
	register("claudeMonitor.remoteControl.stop", () => remote?.stop())
	register("claudeMonitor.remoteControl.why", () => remote?.explain())
	register("claudeMonitor.enablePreciseStatus", () => enablePrecise(context))
	register("claudeMonitor.disablePreciseStatus", () => disablePrecise())
	register("claudeMonitor.showNeedsInput", () => view?.showWaiting())
	register("claudeMonitor.openSession", (sessionId?: string) => openSession(String(sessionId || ""), context))
	register("claudeMonitor.revealTranscript", (sessionId?: string) => revealTranscript(String(sessionId || "")))
	register("claudeMonitor.killSession", (sessionId?: string) => killSession(String(sessionId || "")))
}

// --- WHO CAN STILL SEE A CONVERSATION ---

/* A conversation, its process and its chat tab are three different things (see tabs.ts). This wires the
   two halves the host owns: ChatTabs watches this window's tabs, and SharedTabs pools that with what
   every other window has published — so a tab closed in one window empties the row in all of them, and a
   tab merely sitting in another window, even one VS Code restored and nobody has clicked, still counts
   as somewhere the conversation can be seen. */
let sharedTabs: SharedTabs | undefined

function watchChatTabs(context: vscode.ExtensionContext): void {
	/* Reading the shared record and publishing to it are separate abilities, and a window can have one
	   without the other. A window with no folder open has no workspace database, so it can never say which
	   conversation its own tabs hold — but it still lists every conversation and its clicks still have to
	   reach the window that owns them. Gating both on the same condition left such a window unable to hand
	   anything over, silently opening every conversation a second time. */
	const shared = new SharedTabs(path.join(context.globalStorageUri.fsPath, "tabs.json"), () => {
		applySharedTabs()
		const wanted = shared.takeOpen(process.pid)		// another window is asking this one to show a conversation it has the tab for
		if (wanted) void revealHere(wanted, context).then(() => raiseWindow())
	})
	sharedTabs = shared
	shared.start()
	context.subscriptions.push({ dispose: () => shared.dispose() })
	applySharedTabs()
	if (!context.storageUri) return void log?.appendLine("no folder open in this window, so it reads the shared chat tabs without publishing any")
	new ChatTabs(context.storageUri, (tabbed) => {
		shared.publish(process.pid, activeWorkspaceCwd(), tabbed)		// the extension-host pid is this window's identity, and dies with it
		applySharedTabs()
	}, log).start(context.subscriptions)
}

function applySharedTabs(): void {
	if (!sharedTabs) return
	monitor?.setTabs(sharedTabs.tabbedNow(), sharedTabs.detached())
}

// --- ENDING A CONVERSATION ---

/* Stop a conversation for good: close the chat tab it is being held in, then kill the process behind it.
   Both halves are needed — closing the tab on its own can leave the process running, and killing the
   process on its own leaves a dead tab sitting there. */
async function killSession(sessionId: string): Promise<void> {
	if (!sessionId) return
	const row = monitor?.rowFor(sessionId)
	if (!row) return void vscode.window.showWarningMessage("Claude Control: that conversation is no longer listed.")
	const detail = row.pid ? `Its process (pid ${row.pid}) and anything it is still running are killed. The transcript is kept, so it can be resumed later.` : "No process is running for it, so only its tab is closed."
	const choice = await vscode.window.showWarningMessage(`End "${row.title}"?`, { modal: true, detail }, "End Conversation")
	if (choice !== "End Conversation") return
	log?.appendLine(`
--- end "${row.title}" (${row.sessionId}) pid=${row.pid || "none"} cwd=${row.cwd}`)
	const closed = await closeSessionTab(row)
	await killSessionProcess(row.pid)
	monitor?.markKilled(row.sessionId)		// the transcript was written seconds ago, so nothing else can tell that this session is over yet
	monitor?.refresh()
	if (closed || !row.pid) return
	log?.appendLine("could not close the tab; see the tabs listed above")
	void vscode.window.showWarningMessage(`Killed "${row.title}", but could not close its tab.`, "Show Log").then((pick) => { if (pick) log?.show(true) })
}

/* Close the editor tab holding a conversation. Nothing in the tab API carries a session id, so the only
   handle is the Claude extension's own reveal command: after it runs, the session's tab is the active
   one. Two things make that harder than it sounds. The tab model is mirrored into the extension host
   asynchronously, so the reveal resolves before `activeTab` catches up — hence the wait rather than a
   single read. And the chat can sit in a group that is not the active one, so every group is searched
   for its own active Claude tab. The viewType check is what keeps a reveal that did nothing from closing
   an unrelated tab. Which window owns the conversation is deliberately not consulted: a chat's cwd says
   nothing about where its tab lives — a session started in your home directory sits happily in a project
   window — and the label match already fails harmlessly when the tab is somewhere else. */
async function closeSessionTab(row: SessionRow): Promise<boolean> {
	logTabs("before")
	if (openCommandAvailable === undefined) openCommandAvailable = (await vscode.commands.getCommands(true)).includes(OPEN_COMMAND)
	if (!openCommandAvailable) { log?.appendLine(`skipped: ${OPEN_COMMAND} is not registered`); return false }
	const before = new Set(chatTabs())
	try { await vscode.commands.executeCommand(OPEN_COMMAND, row.sessionId) } catch (err) { openCommandAvailable = false; log?.appendLine(`reveal failed: ${String(err)}`); return false }
	const tab = await waitForRevealedTab(before)
	logTabs("after reveal")
	if (!tab) { log?.appendLine("no tab identified"); return false }
	return closeTab(tab, `closing "${tab.label}"`)
}

/* close() reports false when the workbench declines rather than throwing. Closing the focused editor runs
   in the workbench itself, so it does not depend on the mirrored tab model being current — but it is only
   safe while the tab we picked is the active one, which is checked rather than assumed. */
async function closeTab(tab: vscode.Tab, why: string): Promise<boolean> {
	log?.appendLine(why)
	let closed = false
	try { closed = await vscode.window.tabGroups.close(tab) } catch (err) { log?.appendLine(`close threw: ${String(err)}`) }
	if (!closed && tab.isActive) {
		log?.appendLine("close() declined; falling back to closeActiveEditor")
		try { await vscode.commands.executeCommand("workbench.action.closeActiveEditor") } catch (err) { log?.appendLine(`closeActiveEditor threw: ${String(err)}`) }
		await delay(TAB_POLL_MS)
		closed = !chatTabs().includes(tab)
	}
	log?.appendLine(`closed=${closed}`)
	return closed
}

/* Every Claude chat tab in this window, as the extension host currently sees it. */
function logTabs(when: string): void {
	if (!log) return
	const all = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
	log.appendLine(`${when}: ${all.length} tabs open, ${chatTabs().length} of them Claude chats`)
	for (const tab of all) log.appendLine(`  ${tab.isActive ? "*" : " "} ${describeInput(tab)} label="${tab.label}" group=${tab.group.viewColumn}`)
}

function describeInput(tab: vscode.Tab): string {
	if (tab.input instanceof vscode.TabInputWebview) return `webview(${tab.input.viewType})`
	if (tab.input instanceof vscode.TabInputText) return "text"
	if (tab.input instanceof vscode.TabInputCustom) return `custom(${tab.input.viewType})`
	return tab.input ? tab.input.constructor?.name || "other" : "none"
}

const TAB_WAIT_MS = 3000
const TAB_POLL_MS = 100

/* The revealed chat tab, once the tab model has caught up with the reveal. A tab that was not open before
   is the one the reveal just created, which is unambiguous; otherwise it is the active Claude tab, and a
   single one across the whole window still counts even if focus never landed on it. Matching on the label
   is not among the options: every chat tab is called "Claude Code" until someone renames it by hand. */
async function waitForRevealedTab(before: Set<vscode.Tab>): Promise<vscode.Tab | undefined> {
	for (let waited = 0; waited <= TAB_WAIT_MS; waited += TAB_POLL_MS) {
		const tabs = chatTabs()
		const fresh = tabs.filter((tab) => !before.has(tab))
		if (fresh.length === 1) { log?.appendLine("matched the tab the reveal just created"); return fresh[0] }		// safe to close whatever it holds: it was not open a moment ago
		const active = tabs.filter((tab) => tab.isActive)
		if (active.length === 1) { log?.appendLine("matched the active chat tab"); return active[0] }
		if (active.length > 1) { log?.appendLine("several chat tabs are active; taking the focused group's"); return active.find((tab) => tab.group === vscode.window.tabGroups.activeTabGroup) || active[0] }
		await delay(TAB_POLL_MS)
	}
	const remaining = chatTabs()
	return remaining.length === 1 ? remaining[0] : undefined		// last resort, and only once the wait is over: the sole chat tab in this window is the one we revealed
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

// --- OPENING A CONVERSATION ---

/* Open a conversation, in whichever window is the right one. A conversation another window already has a
   tab for is handed to that window rather than opened again here — two panels on one conversation is the
   thing this avoids. Everything else opens locally. */
async function openSession(sessionId: string, context?: vscode.ExtensionContext): Promise<void> {
	if (!sessionId) return
	const elsewhere = sharedTabs?.windowFor(sessionId) || 0
	log?.appendLine(`open ${sessionId.slice(0, 8)} — ${describeSharing()} → ${elsewhere && elsewhere !== process.pid ? `hand to ${elsewhere}` : "open here"}`)
	if (elsewhere && elsewhere !== process.pid) return void handOver(elsewhere, sessionId, context)
	await revealHere(sessionId, context)
}

/* Bring this window to the front. VS Code deliberately exposes no API for it — microsoft/vscode#51078 has
   been open since 2018 — so the only way is to ask its own CLI to open what this window already has open:
   the running instance recognises the workspace, opens nothing new, and raises the window. The workspace
   file is used when there is one, because a multi-root window is matched by that and not by its first
   folder. Code.exe takes the same arguments as the `code` shim, and using it avoids depending on the shim
   being on PATH or on a shell to run a .cmd. */
function raiseWindow(): void {
	const target = vscode.workspace.workspaceFile?.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!target) return		// nothing identifies this window, and a bare `code` would open an empty one
	log?.appendLine(`raising this window through ${process.execPath} ${target}`)
	/* The extension host is Electron running as Node, and it says so through ELECTRON_RUN_AS_NODE in its
	   own environment. A child inheriting that runs Code.exe as a bare Node interpreter, which treats the
	   workspace path as a script to execute — it does not raise anything. Dropping the variable is what
	   makes the same binary behave as the editor's CLI. */
	const env = { ...process.env }
	delete env.ELECTRON_RUN_AS_NODE
	try {
		const raiser = execFile(process.execPath, [target], { env }, () => { /* the CLI's own output is of no interest */ })
		raiser.unref()		// it outlives the call by design; nothing here waits for it
	} catch (err) { log?.appendLine(`could not raise the window: ${String(err)}`) }
}

/* Three different situations read the same in a log line unless they are spelled out: this window is not
   sharing at all, no window has published anything, or the windows are there and none of them holds the
   conversation that was clicked. */
function describeSharing(): string {
	if (!sharedTabs) return "cross-window sharing never started here"
	return sharedTabs.describeWindows() || "no window has published any chat tabs"
}

const HANDOVER_MS = 2500		// how long the other window gets to answer before this one opens it after all

/* Ask the window holding the tab to bring it up. It cannot be called into directly, so the request goes
   through the shared record and is answered on its file-change event. A window running an older build, or
   one wedged badly enough not to answer, leaves the request sitting there — so it is checked afterwards
   and the conversation opens here instead rather than the click doing nothing. */
function handOver(windowPid: number, sessionId: string, context?: vscode.ExtensionContext): void {
	const folder = sharedTabs?.folderOf(windowPid) || ""
	log?.appendLine(`handing ${sessionId} to the window on ${folder || windowPid}`)
	sharedTabs?.requestOpen(windowPid, sessionId)
	vscode.window.setStatusBarMessage(`Opening in the ${folder ? projectName(folder) : "other"} window`, 4000)
	setTimeout(() => {
		if (sharedTabs?.pendingOpen(windowPid) !== sessionId) return		// answered, as it should be
		log?.appendLine(`the window on ${folder || windowPid} did not answer; opening here instead`)
		void revealHere(sessionId, context)
	}, HANDOVER_MS)
}

/* Reveal the conversation in this window's Claude Code panel. That command is internal to the other
   extension, so it is probed once and falls back to a terminal resume. */
async function revealHere(sessionId: string, context?: vscode.ExtensionContext): Promise<void> {
	const row = monitor?.rowFor(sessionId)
	if (context && monitor) {
		monitor.markSeen(sessionId, Date.now())		// a finished conversation stops asking to be reviewed once opened
		void context.globalState.update(SEEN_KEY, monitor.pruneSeen())
	}
	await openPendingPlan(row)		// before the conversation, so the Claude panel ends up focused
	if (context && row?.state === "killed") void explainStaleTab(context)
	if (openCommandAvailable === undefined) openCommandAvailable = (await vscode.commands.getCommands(true)).includes(OPEN_COMMAND)
	if (openCommandAvailable) {
		try { return void await vscode.commands.executeCommand(OPEN_COMMAND, sessionId) }
		catch { openCommandAvailable = false }		// signature changed under us; never try it again this session
	}
	resumeInTerminal(sessionId, row?.cwd || "")
}

/* A Claude tab left over from before a reload looks open but has no process behind it, and nothing in the API ties a webview tab to a session id — so the duplicate panel cannot be avoided. Say so once rather than letting it look like a bug. */
async function explainStaleTab(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(STALE_KEY)) return
	const choice = await vscode.window.showInformationMessage(
		"That conversation had no running process, so it was resumed in a new panel.",
		"Don't show again"
	)
	if (choice === "Don't show again") await context.globalState.update(STALE_KEY, true)
}

/* A conversation blocked on ExitPlanMode is asking you to read something, so show the plan too. */
async function openPendingPlan(row: SessionRow | undefined): Promise<void> {
	if (!row?.planFile || !needsAttention(row.state)) return
	if (!fs.existsSync(row.planFile)) return		// plan files are cleaned up independently of transcripts
	try {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(row.planFile)), { preview: false, viewColumn: vscode.ViewColumn.One })
	} catch { /* an unopenable plan must not block the conversation */ }
}

function resumeInTerminal(sessionId: string, cwd: string): void {
	const executable = findClaudeExecutable(vscode.workspace.getConfiguration("claudeMonitor").get<string>("claudePath", ""))
	if (!executable) return void vscode.window.showErrorMessage("Claude Control: could not find the claude executable. Set claudeMonitor.claudePath.")
	if (!fallbackWarned) {
		fallbackWarned = true
		vscode.window.showInformationMessage("Claude Control: the Claude Code panel could not be driven directly, so conversations open in a terminal instead.")
	}
	const terminal = vscode.window.createTerminal({ name: `Claude · ${sessionId.slice(0, 8)}`, cwd: cwd || undefined })
	terminal.show(true)
	terminal.sendText(`${shellQuote(executable)} --resume ${sessionId}`)
}

/* Start or stop a standalone bridge for a folder — the terminal route, used by the title-bar toggle. */
async function toggleRemoteFor(cwd: string): Promise<void> {
	if (!cwd || !remote) return
	remote.setTarget(cwd)
	if (remote.state() === "on") await remote.stop()
	else await remote.start()
}

/* Turn Remote Control on inside an existing conversation by sending it /remote-control, which is what the bridge's "repl" source means. Far closer to the intent than a separate directory-scoped session: the conversation you are already having becomes the one on your phone. */
async function remoteInSession(sessionId: string): Promise<void> {
	if (!sessionId) return
	const row = monitor?.rowFor(sessionId)
	if (!row) return
	if (openCommandAvailable === undefined) openCommandAvailable = (await vscode.commands.getCommands(true)).includes(OPEN_COMMAND)
	if (!openCommandAvailable) return void vscode.window.showWarningMessage(`Claude Control: cannot drive the Claude panel, so type ${REMOTE_COMMAND} in the conversation yourself.`)
	await vscode.env.clipboard.writeText(REMOTE_COMMAND)

	/* A live conversation already has a panel, and createPanel throws the prompt away in that case with its own baffling "your prompt was not applied" notice. So the prompt is only ever passed for a session being resumed, where it genuinely lands.
	   The text cannot be sent directly: /remote-control is rejected in print mode ("isn't available in this environment"), and the extension's insert commands only ever emit an @file reference derived from the active editor. But the reveal above makes the panel the active editor, and editor.action.clipboardPasteAction has a webview implementation, so the clipboard copy can be dropped into the focused input — leaving only Enter for the user. */
	try { await vscode.commands.executeCommand(OPEN_COMMAND, sessionId, row.live ? undefined : REMOTE_COMMAND) }
	catch { openCommandAvailable = false; return void vscode.window.showWarningMessage(`Claude Control: type ${REMOTE_COMMAND} in the conversation to start Remote Control.`) }
	if (!row.live) return void vscode.window.setStatusBarMessage(`Sent ${REMOTE_COMMAND} to "${row.title}"`, 6000)
	await new Promise((resolve) => setTimeout(resolve, 600))		// the reveal hands focus to the webview asynchronously
	try {
		await vscode.commands.executeCommand("editor.action.clipboardPasteAction")
		vscode.window.setStatusBarMessage(`Press Enter in "${row.title}" to start Remote Control — ${REMOTE_COMMAND} is pasted and on your clipboard`, 10000)
	} catch {
		vscode.window.showInformationMessage(`Press paste then Enter in "${row.title}" — ${REMOTE_COMMAND} is on your clipboard.`)
	}
}

// --- USAGE LIMITS ---

/* Claude refreshes cachedUsageUtilization only when something asks it to — it is routinely a day stale. Running `claude -p /usage` headlessly updates the cache without touching any of your conversations. It writes a throwaway transcript, so the session id is ours, hidden from the panel while it runs, and deleted afterwards. */
async function refreshUsage(showReport: boolean): Promise<void> {
	if (usageRefreshing) return
	const executable = findClaudeExecutable(vscode.workspace.getConfiguration("claudeMonitor").get<string>("claudePath", ""))
	if (!executable) return void vscode.window.showErrorMessage("Claude Control: could not find the claude executable. Set claudeMonitor.claudePath.")
	usageRefreshing = true
	const sessionId = randomUUID()
	monitor?.setExcluded(sessionId, true)
	try {
		const report = await vscode.window.withProgress({ location: { viewId: "claudeMonitor.sessions" }, title: "Refreshing usage" }, () => runUsage(executable, sessionId))
		if (showReport && report.trim()) showUsageReport(report)		// Claude's own breakdown, which no API can pop open for us
	} catch (err) {
		vscode.window.showWarningMessage(`Claude Control: could not refresh usage — ${String(err).slice(0, 160)}`)
	} finally {
		discardUsageTranscript(sessionId)
		monitor?.setExcluded(sessionId, false)
		usageRefreshing = false
		monitor?.refresh()
	}
}

function runUsage(executable: string, sessionId: string): Promise<string> {
	const script = findUsageScript()
	/* Preferred: a direct fetch of /api/oauth/usage. Seconds instead of ~25s, spends no tokens, and it
	   actually updates a file the panel reads — `claude -p /usage` cannot, because a slash command in
	   print mode is just a prompt and the usage cache is only written by an interactive session. */
	if (script) return new Promise((resolve, reject) => {
		const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" }		// process.execPath is Code itself; this makes it behave as plain node
		execFile(process.execPath, [script, "--force"], { cwd: os.homedir(), env, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
			if (err && !stdout) reject(err)
			else resolve(String(stdout || ""))
		})
	})
	return new Promise((resolve, reject) => {
		execFile(executable, ["-p", USAGE_COMMAND, "--session-id", sessionId], { cwd: os.homedir(), timeout: 90000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
			if (err && !stdout) reject(err)
			else resolve(String(stdout || ""))
		})
	})
}

let cachedUsageScript: string | undefined

/* The session-usage skill, installed personally or carried by a plugin. The plugin's own version is never
   pinned here: it is read from Claude Code's install manifest, and the cache scan is only the fallback. */
function findUsageScript(): string {
	/* Re-resolve a vanished hit instead of trusting the cache forever: a plugin update replaces its version
	   directory, so a path resolved earlier in this window can point at a version that no longer exists. */
	if (cachedUsageScript && fs.existsSync(cachedUsageScript)) return cachedUsageScript
	const tail = path.join("skills", "session-usage", "scripts", "usage.js")
	const personal = path.join(claudeRoot(), tail)
	if (fs.existsSync(personal)) return cachedUsageScript = personal
	for (const installPath of installedPluginPaths()) {
		const candidate = path.join(installPath, tail)
		if (fs.existsSync(candidate)) return cachedUsageScript = candidate
	}
	const found: { candidate: string, version: string }[] = []
	const cacheRoot = path.join(claudeRoot(), "plugins", "cache")
	const dirs = (dir: string): string[] => {
		try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)) } catch { return [] }
	}
	for (const owner of dirs(cacheRoot)) {
		for (const plugin of dirs(owner)) {
			for (const version of dirs(plugin)) {
				const candidate = path.join(version, tail)
				if (fs.existsSync(candidate)) found.push({ candidate, version: path.basename(version) })
			}
		}
	}
	found.sort((left, right) => compareVersions(left.version, right.version))
	return cachedUsageScript = found.length ? found[found.length - 1].candidate : ""
}

/* installPath per installed plugin, newest-installed manifest order preserved. Missing or unreadable
   manifest just means the cache scan below decides instead. */
function installedPluginPaths(): string[] {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(claudeRoot(), "plugins", "installed_plugins.json"), "utf8"))
		const entries: any[] = Object.values(manifest && manifest.plugins ? manifest.plugins : {})
		return entries.flat().map((entry) => entry && entry.installPath).filter((installPath) => typeof installPath === "string" && installPath)
	} catch { return [] }
}

/* Segment-wise numeric compare — a plain string sort puts 0.10.0 before 0.2.0. */
function compareVersions(left: string, right: string): number {
	const parts = (value: string) => String(value).split(".").map((part) => parseInt(part, 10) || 0)
	const a = parts(left), b = parts(right)
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const diff = (a[index] || 0) - (b[index] || 0)
		if (diff) return diff
	}
	return String(right).length - String(left).length
}

/* There is no way to open Claude's usage dialog from outside — it is a CLI component — so its own report text is shown verbatim instead. */
function showUsageReport(report: string): void {
	if (!usageOutput) usageOutput = vscode.window.createOutputChannel("Claude Control: Usage")
	usageOutput.clear()
	usageOutput.appendLine(report.trimEnd())
	usageOutput.show(true)
}

/* Remove the transcript the refresh created. The path is rebuilt from our own uuid and the name must match it exactly, so nothing else can be touched. */
function discardUsageTranscript(sessionId: string): void {
	const file = path.join(projectsDir(), slugify(os.homedir()), `${sessionId}.jsonl`)
	if (path.basename(file) !== `${sessionId}.jsonl`) return
	try { fs.rmSync(file, { force: true }) } catch { /* leaving it only costs one hidden row */ }
	try { fs.rmSync(path.join(claudeRoot(), "file-history", sessionId), { recursive: true, force: true }) } catch { /* nothing was edited */ }
}

// --- DIFFING A CHANGED FILE ---

const BACKUP_LOOKBACK = 25
const EMPTY_SCHEME = "claude-monitor-empty"		// backs the left-hand side when the run created the file

/* Claude keeps post-edit snapshots at ~/.claude/file-history/<sessionId>/<sha256(path)[:16]>@v<n>. The hash derivation was confirmed against every backup in a real session. */
function backupPath(sessionId: string, file: string, version: number): string {
	const hash = createHash("sha256").update(file).digest("hex").slice(0, 16)
	return path.join(claudeRoot(), "file-history", sessionId, `${hash}@v${version}`)
}

/* Versions are per-session and a backup holds the content from *before* its change, so the run's own lowest version already is the "before" state — v1 is the file as the session found it, not a newly created file. Walk downwards only because old versions get pruned. */
function priorBackup(sessionId: string, file: string, version: number): string {
	for (let candidate = version; candidate >= 1 && candidate > version - BACKUP_LOOKBACK; candidate--) {
		const backup = backupPath(sessionId, file, candidate)
		if (fs.existsSync(backup)) return backup
	}
	return ""		// nothing was backed up, so the run created this file
}

/* Open VS Code's diff for one file the run touched, falling back to git and then to the plain file. */
async function diffChangedFile(sessionId: string, file: string, version: number): Promise<void> {
	if (!file) return
	const right = vscode.Uri.file(file)
	if (!fs.existsSync(file)) return void vscode.window.showWarningMessage(`Claude Control: ${path.basename(file)} no longer exists.`)
	const before = priorBackup(sessionId, file, version)
	if (before) return void await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(before), right, `${path.basename(file)} — Before ↔ After`)
	if (insideGitRepo(file)) {
		try { return void await vscode.commands.executeCommand("git.openChange", right) }		// snapshots pruned, so compare against the repo instead
		catch { /* fall through to the empty diff */ }
	}
	const empty = vscode.Uri.parse(`${EMPTY_SCHEME}:${path.basename(file)}`)
	await vscode.commands.executeCommand("vscode.diff", empty, right, `${path.basename(file)} — new in this run`)
}

/* git.openChange resolves without doing anything for a file outside a repository, which would silently swallow the click — so check first rather than relying on it to throw. */
function insideGitRepo(file: string): boolean {
	let dir = path.dirname(file)
	for (let depth = 0; depth < 40; depth++) {
		if (fs.existsSync(path.join(dir, ".git"))) return true		// a worktree uses a .git file, not a directory
		const parent = path.dirname(dir)
		if (parent === dir) return false
		dir = parent
	}
	return false
}

async function revealTranscript(sessionId: string): Promise<void> {
	const file = monitor?.fileFor(sessionId)
	if (!file) return void vscode.window.showWarningMessage("Claude Control: no transcript on disk for that conversation.")
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: true })
}

async function copySessionId(sessionId: string): Promise<void> {
	if (!sessionId) return
	await vscode.env.clipboard.writeText(sessionId)
	vscode.window.setStatusBarMessage(`Copied ${sessionId}`, 2500)
}

// --- PANEL STATE ---

function publish(data: PanelData): void {
	view?.post(data)
	remote?.setTarget(data.activeCwd)		// the list shows every workspace, so a bridge belongs to the folder this window has open
	updateStatusItem(data.needsInputTotal)
	publishRemoteState()
}

/* VS Code only honours statusBarItem.warningBackground and .errorBackground here — an arbitrary hex is ignored — and setting a background forces the matching foreground. So this takes the theme's warning colours (orange on white in the default themes) and uses the bell codicon, since none of the 579 codicons is a hand and a literal ✋ would render as a colour emoji. */
function updateStatusItem(waiting: number): void {
	if (!statusItem) return
	if (!waiting) return statusItem.hide()
	statusItem.text = `$(bell-dot) ${waiting} waiting`
	statusItem.tooltip = `${waiting} Claude conversation${waiting === 1 ? "" : "s"} waiting on you — click to show them`
	statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
	statusItem.show()
}

/* Drives which of the three title-bar icons is visible. */
function publishRemoteState(): void {
	const state = remote?.state() || "off"
	void vscode.commands.executeCommand("setContext", "claudeMonitor.rc", state)
}

function announce(row: SessionRow): void {
	if (!vscode.workspace.getConfiguration("claudeMonitor").get<boolean>("notifyOnNeedsInput", false)) return
	if (!needsAttention(row.state)) return
	void vscode.window.showInformationMessage(`${row.title} needs input — ${row.tool}`, "Open").then((choice) => {
		if (choice === "Open") void openSession(row.sessionId)
	})
}

// --- HOOKS CONSENT ---

/* Offer precise status once. Declining is remembered and the panel keeps working on heuristics. */
async function maybeOfferHooks(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(PROMPTED_KEY)) return
	if (hooksInstalled()) return
	await context.globalState.update(PROMPTED_KEY, true)
	const choice = await vscode.window.showInformationMessage(
		"Claude Control can detect exactly when a conversation is waiting on you.",
		{ modal: true, detail: "This adds seven hook entries to ~/.claude/settings.json (backed up first, removable at any time). Without them, a slow command and a permission prompt are indistinguishable and waiting rows are only a guess." },
		"Enable", "Not Now"
	)
	if (choice === "Enable") await enablePrecise(context)
}

async function enablePrecise(context: vscode.ExtensionContext): Promise<void> {
	const result = installHooks()
	if (!result.ok) return void vscode.window.showErrorMessage(`Claude Control: ${result.error}`)
	await context.globalState.update(PROMPTED_KEY, true)
	await vscode.workspace.getConfiguration("claudeMonitor").update("preciseStatus", true, vscode.ConfigurationTarget.Global)
	monitor?.setConfig(readConfig())
	const detail = result.backup ? ` Previous settings saved to ${path.basename(result.backup)}.` : ""
	vscode.window.showInformationMessage(`Claude Control: precise status enabled. It applies to conversations started from now on.${detail}`)
}

async function disablePrecise(): Promise<void> {
	const result = uninstallHooks()
	if (!result.ok) return void vscode.window.showErrorMessage(`Claude Control: ${result.error}`)
	await vscode.workspace.getConfiguration("claudeMonitor").update("preciseStatus", false, vscode.ConfigurationTarget.Global)
	monitor?.setConfig(readConfig())
	vscode.window.showInformationMessage("Claude Control: hooks removed from ~/.claude/settings.json.")
}

/* Keep the setting honest if hooks were added or removed by hand. An install from a version with fewer events is topped up first — the user consented to it, and without this the missing event would read as "not installed" and switch precise status off. */
function syncPreciseStatusSetting(): void {
	if (hooksOutdated()) installHooks()
	const config = vscode.workspace.getConfiguration("claudeMonitor")
	const installed = hooksInstalled()
	if (config.get<boolean>("preciseStatus", false) === installed) return
	void config.update("preciseStatus", installed, vscode.ConfigurationTarget.Global)
}

// --- CONFIG ---

function readConfig(): MonitorConfig {
	const config = vscode.workspace.getConfiguration("claudeMonitor")
	return {
		tailBytes: config.get<number>("tailBytes", 131072),
		staleToolSeconds: config.get<number>("staleToolSeconds", 90),
		preciseStatus: config.get<boolean>("preciseStatus", false),
		showClosed: config.get<boolean>("showClosed", false),
		pinNeedsInput: config.get<boolean>("pinNeedsInput", true),
		promptPreviewLines: config.get<number>("promptPreviewLines", 2),
		claudePath: config.get<string>("claudePath", "")
	}
}

function activeWorkspaceCwd(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]
	return folder ? canonical(folder.uri.fsPath) : ""
}

function shellQuote(value: string): string { return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'` }
