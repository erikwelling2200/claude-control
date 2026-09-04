import * as fs from "fs"
import * as path from "path"
import { isAlive } from "./live"

// --- WHAT EVERY WINDOW CAN SEE ---

/* A window only knows its own chat tabs, but its panel lists every conversation on the machine. So each
   window writes down which conversations it has a tab for, and reads what the others wrote. This file is
   that shared record, kept in globalStorage and watched by all of them.

   It answers two different questions, and the panel needs both:

     tabbedNow   a tab for this conversation exists in some running window, open or not — including tabs
                 VS Code restored on startup and nobody has clicked yet, which have no process behind them
     detached    a window did have a tab for it and no running window does now, so nobody can reach it

   Windows are keyed by their extension-host process id and pruned once that process is gone: a window
   that has closed takes its tab list with it, rather than leaving rows nobody can open. */

interface WindowRecord {
	at: number
	folder: string		// the workspace this window has open, used to name it when a conversation is handed over
	tabs: string[]
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000		// a conversation tabless for a week is never coming back, and the file must not grow forever
const REQUEST_TTL_MS = 20000		// long enough for a busy window to notice, short enough that a click is never answered much later

export class SharedTabs {
	private windows = new Map<number, WindowRecord>()
	private history = new Map<string, number>()		// sessionId -> when the last window holding a tab for it let go
	private requests = new Map<number, { sessionId: string, at: number }>()		// window pid -> a conversation another window is asking it to reveal
	private watcher: fs.FSWatcher | undefined

	constructor(private readonly file: string, private readonly onChange: () => void) {}

	start(): void {
		try { fs.mkdirSync(path.dirname(this.file), { recursive: true }) } catch { /* the first write reports the real problem */ }
		this.load()
		try {
			this.watcher = fs.watch(path.dirname(this.file), { persistent: false })
			this.watcher.on("change", (_event, name) => { if (!name || String(name) === path.basename(this.file)) { this.load(); this.onChange() } })
			this.watcher.on("error", () => { /* another window replaced the file; the next publish reloads it anyway */ })
		} catch { /* without a watcher the panel still updates on this window's own changes */ }
	}

	dispose(): void {
		try { this.watcher?.close() } catch { /* already gone */ }
		this.watcher = undefined
	}

	/* Conversations some running window has a chat tab for. */
	tabbedNow(): Set<string> {
		const out = new Set<string>()
		for (const record of this.windows.values()) {
			for (const sessionId of record.tabs) out.add(sessionId)
		}
		return out
	}

	/* Conversations that had a tab and have none any more. */
	detached(): Set<string> {
		const tabbed = this.tabbedNow()
		return new Set([...this.history.keys()].filter((sessionId) => !tabbed.has(sessionId)))
	}

	/* Which running window has a chat tab for this conversation, if any. */
	windowFor(sessionId: string): number {
		for (const [pid, record] of this.windows) {
			if (record.tabs.includes(sessionId)) return pid
		}
		return 0
	}

	folderOf(windowPid: number): string { return this.windows.get(windowPid)?.folder || "" }

	/* For the log, so an unexpected hand-over decision can be read back against what the windows claimed. */
	describeWindows(): string {
		return [...this.windows].map(([pid, record]) => `${pid}:${record.folder || "?"}[${record.tabs.map((sessionId) => sessionId.slice(0, 8)).join(" ") || "none"}]`).join(" ")
	}

	/* Announce this window's chat tabs. Anything it used to list and no longer does becomes detached
	   unless another window has it, and anything listed again stops being detached. */
	publish(windowPid: number, folder: string, tabs: Set<string>): void {
		this.load()		// another window may have written since; never overwrite its record with a stale copy
		const previous = this.windows.get(windowPid)
		this.windows.set(windowPid, { at: Date.now(), folder, tabs: [...tabs] })
		for (const sessionId of previous?.tabs || []) {
			if (!tabs.has(sessionId)) this.history.set(sessionId, Date.now())
		}
		for (const sessionId of tabs) this.history.delete(sessionId)
		this.save()
	}

	// --- HANDING A CONVERSATION TO THE WINDOW THAT HAS IT ---

	/* Clicking a row in one window should reveal the tab where it already lives, not open a second panel
	   on the same conversation here. A window cannot call into another, so the request goes through the
	   same file: the asking window leaves it addressed to a pid, and that window picks it up on the next
	   change event. Requests expire quickly — one left behind by a window that never answered must not
	   fire when it starts up again much later. */
	requestOpen(windowPid: number, sessionId: string): void {
		this.load()
		this.requests.set(windowPid, { sessionId, at: Date.now() })
		this.save()
	}

	/* What another window is still waiting for this one to reveal, "" once it has been answered. */
	pendingOpen(windowPid: number): string {
		const request = this.requests.get(windowPid)
		return request && Date.now() - request.at < REQUEST_TTL_MS ? request.sessionId : ""
	}

	/* Take the request addressed to this window, clearing it so it is acted on exactly once. */
	takeOpen(windowPid: number): string {
		const sessionId = this.pendingOpen(windowPid)
		if (!this.requests.delete(windowPid)) return ""
		this.save()
		return sessionId
	}

	private load(): void {
		let raw: any
		try { raw = JSON.parse(fs.readFileSync(this.file, "utf8")) } catch { return }		// missing or half-written; keep what we have
		if (!raw || typeof raw !== "object") return
		const cutoff = Date.now() - MAX_AGE_MS
		this.windows = new Map(Object.entries(raw.windows || {})
			.map(([pid, record]: [string, any]) => [Number(pid), { at: Number(record?.at || 0), folder: String(record?.folder || ""), tabs: (record?.tabs || []).map(String) }] as [number, WindowRecord])
			.filter(([pid]) => isAlive(pid, "")))		// a window that has gone cannot still be showing anything
		this.history = new Map(Object.entries(raw.history || {})
			.map(([sessionId, at]) => [sessionId, Number(at)] as [string, number])
			.filter(([, at]) => at > cutoff))
		this.requests = new Map(Object.entries(raw.requests || {})
			.map(([pid, request]: [string, any]) => [Number(pid), { sessionId: String(request?.sessionId || ""), at: Number(request?.at || 0) }] as [number, { sessionId: string, at: number }])
			.filter(([pid, request]) => request.sessionId && Date.now() - request.at < REQUEST_TTL_MS && isAlive(pid, "")))
	}

	/* Written through a temporary file so a window reading mid-write sees the old content, not half of
	   the new one. */
	private save(): void {
		const temp = `${this.file}.${process.pid}.tmp`
		const data = { windows: Object.fromEntries(this.windows), history: Object.fromEntries(this.history), requests: Object.fromEntries(this.requests) }
		try {
			fs.writeFileSync(temp, JSON.stringify(data), "utf8")
			fs.renameSync(temp, this.file)
		} catch { try { fs.unlinkSync(temp) } catch { /* nothing to clean up */ } }
	}
}
