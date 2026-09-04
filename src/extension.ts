import { execFile } from "child_process"
import { createHash, randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { hooksInstalled, hooksOutdated, installHooks, uninstallHooks } from "./hooks"
import { canonical, claudeRoot, findClaudeExecutable, projectName, projectsDir, slugify } from "./paths"
import { RemoteControl } from "./remote"
import type { PanelData, SessionRow } from "./types"
import { isWaiting, Monitor, type MonitorConfig } from "./watcher"
import { SessionsView } from "./webview"

// --- CONSTANTS ---

const OPEN_COMMAND = "claude-vscode.editor.open"		// internal to the Claude Code extension: (sessionId, initialPrompt, viewColumn)
const REMOTE_COMMAND = "/remote-control"
const USAGE_COMMAND = "/usage"
const SELECTED_KEY = "claudeMonitor.selectedCwd"
const PROMPTED_KEY = "claudeMonitor.hooksPrompted"
const SEEN_KEY = "claudeMonitor.seenAt"
const STALE_KEY = "claudeMonitor.staleTabExplained"

let monitor: Monitor | undefined
let view: SessionsView | undefined
let remote: RemoteControl | undefined
let statusItem: vscode.StatusBarItem | undefined
let latest: PanelData | undefined
let openCommandAvailable: boolean | undefined
let fallbackWarned = false
let usageRefreshing = false
let usageOutput: vscode.OutputChannel | undefined

// --- ACTIVATION ---

export function activate(context: vscode.ExtensionContext): void {
	statusItem = vscode.window.createStatusBarItem("claudeMonitor.waiting", vscode.StatusBarAlignment.Right, 100)
	statusItem.command = "claudeMonitor.showNeedsInput"
	statusItem.name = "Claude Control"
	context.subscriptions.push(statusItem)
	context.subscriptions.push({ dispose: () => usageOutput?.dispose() })

	remote = new RemoteControl(() => publishRemoteState())
	context.subscriptions.push({ dispose: () => remote?.dispose() })

	monitor = new Monitor(
		readConfig(),
		path.join(context.globalStorageUri.fsPath, "index.json"),
		activeWorkspaceCwd(),
		(data) => publish(context, data),
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
		openFolder: (cwd) => void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cwd), { forceNewWindow: true }),
		selectProject: (cwd) => selectProject(context, cwd),
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
}

// --- OPENING A CONVERSATION ---

/* Reveal the conversation in the Claude Code panel. That command is internal to the other extension, so it is probed once and falls back to a terminal resume. */
async function openSession(sessionId: string, context?: vscode.ExtensionContext): Promise<void> {
	if (!sessionId) return
	const row = monitor?.rowFor(sessionId)
	if (!(await confirmCrossWindow(row))) return
	if (context && monitor) {
		monitor.markSeen(sessionId, Date.now())		// a finished conversation stops asking to be reviewed once opened
		void context.globalState.update(SEEN_KEY, monitor.pruneSeen())
	}
	await openPendingPlan(row)		// before the conversation, so the Claude panel ends up focused
	if (context && row?.state === "closed") void explainStaleTab(context)
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
	if (!row?.planFile || !isWaiting(row.state)) return
	if (!fs.existsSync(row.planFile)) return		// plan files are cleaned up independently of transcripts
	try {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(row.planFile)), { preview: false, viewColumn: vscode.ViewColumn.One })
	} catch { /* an unopenable plan must not block the conversation */ }
}

/* A live session attached in another window would get a second panel on the same transcript, so ask first. */
async function confirmCrossWindow(row: SessionRow | undefined): Promise<boolean> {
	if (!row || !row.live || !row.cwd) return true
	const folders = vscode.workspace.workspaceFolders || []
	if (folders.some((folder) => canonical(folder.uri.fsPath) === canonical(row.cwd))) return true
	const choice = await vscode.window.showWarningMessage(
		`"${row.title}" is running in ${projectName(row.cwd)}, outside this window.`,
		{ modal: true, detail: "Opening it here attaches a second panel to the same conversation. Its own window is usually the better place to answer it." },
		"Open Anyway"
	)
	return choice === "Open Anyway"
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

/* Resolve which project the dropdown shows: the remembered choice, else the active workspace, else everything. */
function resolveSelected(context: vscode.ExtensionContext, data: PanelData): string {
	const remembered = context.workspaceState.get<string>(SELECTED_KEY)
	if (remembered !== undefined) return data.projects.some((project) => project.cwd === remembered) ? remembered : ""
	if (vscode.workspace.getConfiguration("claudeMonitor").get<string>("defaultProjectFilter", "active") !== "active") return ""
	return data.projects.some((project) => project.cwd === data.activeCwd) ? data.activeCwd : ""		// fall back to all rather than an empty panel
}

function selectProject(context: vscode.ExtensionContext, cwd: string): void {
	void context.workspaceState.update(SELECTED_KEY, cwd)
	if (latest) publish(context, latest)
}

function publish(context: vscode.ExtensionContext, data: PanelData): void {
	latest = data
	const selectedCwd = resolveSelected(context, data)
	view?.post({ ...data, selectedCwd })
	remote?.setTarget(selectedCwd || data.activeCwd)
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
	if (!isWaiting(row.state)) return
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
		showClosed: config.get<boolean>("showClosed", true),
		pinNeedsInput: config.get<boolean>("pinNeedsInput", true),
		groupByProject: config.get<boolean>("groupByProject", false),
		promptPreviewLines: config.get<number>("promptPreviewLines", 2),
		claudePath: config.get<string>("claudePath", "")
	}
}

function activeWorkspaceCwd(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]
	return folder ? canonical(folder.uri.fsPath) : ""
}

function shellQuote(value: string): string { return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'` }
