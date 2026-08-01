import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { bridgesByCwd, type BridgeInfo } from "./bridge"
import { readAgents, readProcesses, readRegistry } from "./live"
import { canonical, projectName, projectsDir, sessionsDir, spoolDir } from "./paths"
import { listTranscripts, scan, scanOne } from "./scanner"
import { activityLabel, HookSignals, resolveState } from "./status"
import { Store } from "./store"
import { configFile } from "./trust"
import { readUsage } from "./usage"
import type { ChangedFile, LiveSession, PanelData, ProjectOption, SessionRow, SessionState, TranscriptRecord } from "./types"

// --- TUNING ---

const DEBOUNCE_MS = 300
const FAST_TICK_MS = 5000
const RECONCILE_MS = 60000

export interface MonitorConfig {
	tailBytes: number
	staleToolSeconds: number
	preciseStatus: boolean
	showClosed: boolean
	pinNeedsInput: boolean
	groupByProject: boolean
	promptPreviewLines: number
	claudePath: string
}

// --- MONITOR ---

/* Owns all filesystem observation and turns transcripts + live processes into panel rows. Deliberately free of any vscode import so the probe can drive it headlessly. */
export class Monitor {
	private readonly store: Store
	private readonly signals = new HookSignals()
	private live = new Map<string, LiveSession>()
	private agents = new Map<string, LiveSession>()		// last answer from the claude CLI, trusted for AGENTS_TTL_MS
	private agentsAt = 0
	private states = new Map<string, SessionState>()
	private seen = new Map<string, number>()		// sessionId -> when the user last opened it
	private excluded = new Set<string>()		// sessions the extension created itself and must not show
	private watchers = new Map<string, fs.FSWatcher>()
	private timers: NodeJS.Timeout[] = []
	private debounce: NodeJS.Timeout | undefined
	private touched = new Set<string>()
	private running = false
	private active = true

	constructor(
		private config: MonitorConfig,
		storeFile: string,
		private activeCwd: string,
		private readonly onChange: (data: PanelData) => void,
		private readonly onNeedsInput?: (row: SessionRow) => void
	) {
		this.store = new Store(storeFile)
	}

	// --- LIFECYCLE ---

	/* Paint from cache immediately. Everything expensive is deferred off the activation path — installing watchers alone can take hundreds of ms. */
	start(): void {
		if (this.running) return
		this.running = true
		this.store.load()
		try { fs.mkdirSync(spoolDir(), { recursive: true }) } catch { /* hooks tolerate a missing spool */ }
		this.live = this.liveNow()
		this.emit()
		this.timers.push(setTimeout(() => {
			if (!this.running) return
			this.watch()
			void this.reconcile(true)
		}, 0))
		this.timers.push(setInterval(() => this.fastTick(), FAST_TICK_MS))
		this.timers.push(setInterval(() => void this.reconcile(true), RECONCILE_MS))
	}

	dispose(): void {
		this.running = false
		for (const watcher of this.watchers.values()) { try { watcher.close() } catch { /* already gone */ } }
		this.watchers.clear()
		for (const timer of this.timers) { clearInterval(timer); clearTimeout(timer) }
		this.timers = []
		if (this.debounce) clearTimeout(this.debounce)
		this.store.dispose()
	}

	setConfig(config: MonitorConfig): void {
		const rescan = config.tailBytes !== this.config.tailBytes
		this.config = config
		if (rescan) void this.reconcile(false)
		else this.emit()
	}

	setActiveCwd(cwd: string): void { this.activeCwd = cwd; this.emit() }

	/* Idle the scanning while the view is hidden, but refresh liveness the instant it comes back — a conversation resumed while hidden must not still read as closed. */
	setVisible(visible: boolean): void {
		this.active = visible
		if (!visible) return
		this.live = this.liveNow()
		this.emit()
		void this.reconcile(false)
	}

	refresh(): void { void this.reconcile(true) }

	// --- OBSERVATION ---

	/* Transcripts live exactly one level deep, at projects/<slug>/<sessionId>.jsonl, so a flat watch per project dir is enough. Recursive watching is avoided deliberately: on this platform fs.watch({recursive:true}) took 55s to install for 68 directories, and it would descend into subagents/ and tool-results/ which we ignore anyway. */
	private watch(): void {
		this.addWatcher(projectsDir(), () => this.syncProjectWatchers())
		this.addWatcher(sessionsDir(), () => { this.live = this.liveNow() })
		this.addWatcher(spoolDir(), () => { this.signals.drain() })
		this.watchFile(configFile())		// usage limits live in ~/.claude.json, so watch the file rather than all of $HOME
		this.syncProjectWatchers()
	}

	/* Add a watcher for each project directory, and drop ones whose directory has gone. */
	private syncProjectWatchers(): void {
		let entries: fs.Dirent[]
		try { entries = fs.readdirSync(projectsDir(), { withFileTypes: true }) } catch { return }
		const wanted = new Set<string>()
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const dir = path.join(projectsDir(), entry.name)
			wanted.add(dir)
			if (this.watchers.has(dir)) continue
			this.addWatcher(dir, (file) => { if (file.endsWith(".jsonl")) this.touched.add(file) })
		}
		for (const [dir, watcher] of this.watchers) {
			if (!dir.startsWith(`${projectsDir()}${path.sep}`) || wanted.has(dir)) continue
			try { watcher.close() } catch { /* already gone */ }
			this.watchers.delete(dir)
		}
	}

	/* Watch one file directly — its parent here is $HOME, which must never be watched wholesale. */
	private watchFile(file: string): void {
		if (this.watchers.has(file)) return
		let watcher: fs.FSWatcher
		try { watcher = fs.watch(file, { persistent: false }) } catch { return }
		watcher.on("error", () => { /* replaced by an atomic rename; the reconcile timer is the backstop */ })
		watcher.on("change", () => this.schedule())
		this.watchers.set(file, watcher)
	}

	private addWatcher(dir: string, handle: (file: string) => void): void {
		if (this.watchers.has(dir)) return
		let watcher: fs.FSWatcher
		try { watcher = fs.watch(dir, { persistent: false }) } catch { return }
		watcher.on("error", () => { /* dir removed under us; the reconcile timer is the backstop */ })
		watcher.on("change", (_event, name) => {
			handle(typeof name === "string" && name ? path.join(dir, name) : dir)
			this.schedule()
		})
		this.watchers.set(dir, watcher)
	}

	private schedule(): void {
		if (this.debounce) return
		this.debounce = setTimeout(() => { this.debounce = undefined; this.applyTouched() }, DEBOUNCE_MS)
	}

	/* Rescan only the transcripts that actually changed. */
	private applyTouched(): void {
		this.signals.drain()
		const files = [...this.touched]
		this.touched.clear()
		for (const file of files) {
			if (!fs.existsSync(file)) { this.store.remove(file); continue }
			const record = scanOne(file, { tailBytes: this.config.tailBytes, cache: this.store.cache() })
			if (record) this.store.put(record)
		}
		this.emit()
	}

	private fastTick(): void {
		if (!this.active) return
		this.signals.drain()
		this.live = this.liveNow()
		let changed = false
		const bySession = new Map(this.store.all().map((record) => [record.sessionId, record]))
		for (const session of this.live.values()) {
			const record = bySession.get(session.sessionId)
			if (!record) { changed = true; continue }		// a brand-new session we have not indexed yet
			const rescanned = scanOne(record.file, { tailBytes: this.config.tailBytes, cache: this.store.cache() })
			if (rescanned && rescanned !== record) { this.store.put(rescanned); changed = true }
		}
		if (changed) void this.reconcile(false)
		else this.emit()
	}

	/* Full pass. `authoritative` also asks the claude CLI, which is the supported liveness source but costs ~0.7s. */
	private async reconcile(authoritative: boolean): Promise<void> {
		this.signals.drain()
		this.live = this.liveNow()
		const result = scan({ tailBytes: this.config.tailBytes, cache: this.store.cache() })
		this.store.replace(result.records)
		this.emit()
		if (!authoritative) return
		const agents = await readAgents(this.config.claudePath, os.homedir())		// home avoids tripping a workspace-trust prompt
		if (!agents) return
		this.agents = agents
		this.agentsAt = Date.now()
		this.live = mergeLive(agents, this.liveNow())
		this.emit()
	}

	// --- PANEL DATA ---

	/* Build the full view model and hand it to the host. */
	private emit(): void { this.onChange(this.build()) }

	/* Liveness from every source at once, rather than whichever ran last. A resumed conversation is live the moment any one of them notices: its registry file, its argv, the CLI's own answer, or its transcript still being written. */
	private liveNow(): Map<string, LiveSession> {
		const merged = new Map(readRegistry())
		for (const [sessionId, session] of readProcesses()) {
			if (!merged.has(sessionId)) merged.set(sessionId, session)
		}
		if (Date.now() - this.agentsAt < AGENTS_TTL_MS) {
			for (const [sessionId, session] of this.agents) {
				if (!merged.has(sessionId)) merged.set(sessionId, session)
			}
		}
		const now = Date.now()
		for (const record of this.store.all()) {
			if (merged.has(record.sessionId) || now - record.mtimeMs > WRITING_WINDOW_MS) continue
			merged.set(record.sessionId, { pid: 0, sessionId: record.sessionId, cwd: record.cwd, startedAt: 0, name: "", kind: "writing", procStart: "" })
		}
		return merged
	}

	build(): PanelData {
		const now = Date.now()
		const rows: SessionRow[] = []
		const bridges = this.activeBridges()
		for (const record of this.store.all()) {
			if (!record.sessionId || this.excluded.has(record.sessionId)) continue
			const live = this.live.get(record.sessionId)
			const signal = this.signals.get(record.sessionId)
			let state = resolveState({
				record,
				live,
				signal,
				preciseStatus: this.config.preciseStatus,
				staleToolSeconds: this.config.staleToolSeconds,
				now
			})
			if (state === "finished" && (this.seen.get(record.sessionId) || 0) >= record.lastActivity) state = "reviewed"		// already looked at since it stopped
			rows.push({
				sessionId: record.sessionId,
				title: record.title,
				lastPrompt: record.lastPrompt,
				cwd: record.cwd,
				projectName: record.projectName || projectName(record.cwd),
				gitBranch: record.gitBranch,
				state,
				tool: activityLabel(state, record),
				lastActivity: record.lastActivity,
				live: !!live,
				pid: live?.pid || 0,
				file: record.file,
				errorMessage: record.errorMessage,
				remoteActive: ownsBridge(bridges.get(canonical(record.cwd)), record.sessionId),
				planFile: record.planFile,
				permissionMode: signal?.permissionMode || record.permissionMode,
				/* permissionMode is stamped on the prompt record itself, so it only ever describes the mode as of some past prompt — flipping the picker mid-session is recorded nowhere. Anything a hook has not confirmed is therefore shown as "last known", never asserted. */
				permissionModeStale: !!(signal?.permissionMode || record.permissionMode) && !signal?.permissionMode,
				pendingMessages: live ? record.pendingMessages : 0,		// a queue only matters while the session can still drain it
				modelLabel: modelLabel(record.model),
				changed: changedInRun(record, state)
			})
		}
		this.notifyTransitions(rows)
		rows.sort(compareRows(this.config.pinNeedsInput))
		return {
			rows,
			projects: buildProjects(rows),
			activeCwd: canonical(this.activeCwd),
			selectedCwd: "",		// filled in by the host, which owns the remembered choice
			needsInputTotal: rows.filter((row) => isWaiting(row.state)).length,
			preciseStatus: this.config.preciseStatus,
			promptPreviewLines: this.config.promptPreviewLines,
			groupByProject: this.config.groupByProject,
			showClosed: this.config.showClosed,
			usage: readUsage()
		}
	}

	/* Which folders currently have a Remote Control bridge, and which conversation owns each. Checked once per distinct folder rather than per row. */
	private activeBridges(): Map<string, BridgeInfo> {
		return bridgesByCwd(this.store.all().map((record) => canonical(record.cwd)).filter(Boolean))
	}

	/* Record that the user has opened a conversation, which turns a green finished tick grey. */
	markSeen(sessionId: string, at: number): void {
		this.seen.set(sessionId, at)
		this.emit()
	}

	setSeen(seen: Record<string, number>): void {
		this.seen = new Map(Object.entries(seen))
	}

	/* Hide a session the extension itself created — the throwaway used to refresh usage limits would otherwise flash up as a row. */
	setExcluded(sessionId: string, hidden: boolean): void {
		if (hidden) this.excluded.add(sessionId)
		else this.excluded.delete(sessionId)
		this.emit()
	}

	/* Drop seen marks for conversations that no longer exist, so the persisted map cannot grow without bound. */
	pruneSeen(): Record<string, number> {
		const alive = new Set(this.store.all().map((record) => record.sessionId))
		for (const sessionId of this.seen.keys()) {
			if (!alive.has(sessionId)) this.seen.delete(sessionId)
		}
		return Object.fromEntries(this.seen)
	}

	/* Fire once per transition into a waiting state, never repeatedly while it stays there. */
	private notifyTransitions(rows: SessionRow[]): void {
		for (const row of rows) {
			const previous = this.states.get(row.sessionId)
			this.states.set(row.sessionId, row.state)
			if (previous && previous !== row.state && isWaiting(row.state) && !isWaiting(previous)) this.onNeedsInput?.(row)
		}
		const seen = new Set(rows.map((row) => row.sessionId))
		for (const sessionId of this.states.keys()) {
			if (!seen.has(sessionId)) this.states.delete(sessionId)
		}
	}

	/* Transcript path for a session, used by reveal/open commands. */
	fileFor(sessionId: string): string {
		return this.store.all().find((record) => record.sessionId === sessionId)?.file || ""
	}

	rowFor(sessionId: string): SessionRow | undefined {
		return this.build().rows.find((row) => row.sessionId === sessionId)
	}
}

// --- HELPERS ---

export function isWaiting(state: SessionState): boolean { return state === "needs-input" || state === "needs-input?" }

const AGENTS_TTL_MS = 120000		// how long the CLI's answer is trusted after it was taken
const WRITING_WINDOW_MS = 45000		// a transcript appended this recently is being written by something alive

/* A bridge belongs to one conversation. "repl" bridges record the session that ran /remote-control, so only that row lights up; a "standalone" bridge serves the whole folder, so every row in it counts. */
function ownsBridge(bridge: BridgeInfo | undefined, sessionId: string): boolean {
	if (!bridge?.running) return false
	if (bridge.source === "standalone") return true
	return bridge.sessionId === sessionId
}

const MAX_CHIPS = 40

/* Files touched by the run that just finished. Only offered once the run is over, and scoped to edits after the last user prompt so a chip list describes one run rather than the whole session. Claude also edits its own scratch files (throwaway .mjs scripts under /tmp) and creates-then-deletes working files, so only edits inside the project that still exist are news. */
function changedInRun(record: TranscriptRecord, state: SessionState): ChangedFile[] {
	if (state !== "finished" && state !== "reviewed") return []
	const since = record.lastUserTurnAt || 0
	const inRun = record.changed.filter((file) => file.at >= since)
	return (inRun.length ? inRun : record.changed)		// a run whose prompt fell outside the tail still lists what we saw
		.filter((file) => inProject(file.path, record.cwd) && fs.existsSync(file.path))
		.slice(0, MAX_CHIPS)
}

/* Both sides come from the same transcript records, so a plain prefix check is enough — no realpath needed. */
function inProject(file: string, cwd: string): boolean {
	return !!cwd && file.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep)
}

/* Reduce a model id such as claude-opus-5[1m] or claude-haiku-4-5-20251001 to the bare family for the gutter. */
export function modelLabel(model: string): string {
	const family = /(opus|sonnet|haiku|fable)/i.exec(model)
	return family ? family[1].toUpperCase() : ""
}

/* Trust the CLI's membership, but keep procStart from the registry where we have it. */
function mergeLive(agents: Map<string, LiveSession>, registry: Map<string, LiveSession>): Map<string, LiveSession> {
	const out = new Map(agents)
	for (const [sessionId, session] of agents) {
		const known = registry.get(sessionId)
		if (known) out.set(sessionId, { ...session, procStart: known.procStart, name: session.name || known.name })
	}
	return out
}

function compareRows(pinNeedsInput: boolean): (a: SessionRow, b: SessionRow) => number {
	return (a, b) => {
		if (pinNeedsInput) {
			const waiting = Number(isWaiting(b.state)) - Number(isWaiting(a.state))
			if (waiting) return waiting
		}
		return b.lastActivity - a.lastActivity
	}
}

/* Distinct projects with counts, ordered by how recently each was active. */
function buildProjects(rows: SessionRow[]): ProjectOption[] {
	const byCwd = new Map<string, ProjectOption & { recent: number }>()
	for (const row of rows) {
		if (!row.cwd) continue
		const key = canonical(row.cwd)
		const existing = byCwd.get(key)
		if (existing) {
			existing.count++
			existing.recent = Math.max(existing.recent, row.lastActivity)
		} else byCwd.set(key, { cwd: key, name: row.projectName || projectName(row.cwd), count: 1, recent: row.lastActivity })
	}
	const projects = [...byCwd.values()].sort((a, b) => b.recent - a.recent)
	return disambiguate(projects).map(({ cwd, name, count }) => ({ cwd, name, count }))
}

/* Different folders can share a basename — several sessions run in a "scratchpad". Qualify only the colliding ones with their parent, so the dropdown never shows two identical labels. */
function disambiguate<T extends { cwd: string, name: string }>(projects: T[]): T[] {
	const counts = new Map<string, number>()
	for (const project of projects) counts.set(project.name, (counts.get(project.name) || 0) + 1)
	for (const project of projects) {
		if ((counts.get(project.name) || 0) < 2) continue
		const parent = path.basename(path.dirname(project.cwd))
		if (parent) project.name = `${project.name} · ${parent}`
	}
	return projects
}

/* Exposed for the probe so it can report scan cost without duplicating the pipeline. */
export function scanAll(tailBytes: number, cache?: Map<string, TranscriptRecord>) {
	return scan({ tailBytes, cache })
}

export { listTranscripts }
