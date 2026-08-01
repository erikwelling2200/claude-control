import * as fs from "fs"
import * as path from "path"
import { spoolDir } from "./paths"
import type { HookSignal, HookState, LiveSession, SessionState, TranscriptRecord } from "./types"

// --- TUNING ---

const FRESHNESS_TOLERANCE_MS = 2000		// a hook fires within a whisker of the transcript write it belongs to
const SIGNAL_TTL_MS = 86400000
const SPOOL_GRACE_MS = 30000		// long enough for every open window to have drained a file before it is removed
const MAX_DRAIN = 2000

/* Tools whose whole purpose is to stop and ask. A pending one is definitive, so it never has to age into an uncertain guess. */
const ALWAYS_ASKS = new Set(["ExitPlanMode", "AskUserQuestion"])

// --- HOOK EVENT MAPPING ---

const EVENT_STATE: Record<string, HookState> = {
	UserPromptSubmit: "busy",
	PreToolUse: "busy",		// hooked for its live permission_mode; a starting tool also means the model is working

	PermissionRequest: "needs-input",
	Elicitation: "needs-input",
	Notification: "needs-input",
	Stop: "finished",
	SessionEnd: "closed"
}

/* Hook payloads the extension has consumed, newest per session. */
export class HookSignals {
	private signals = new Map<string, HookSignal>()
	private consumed = new Set<string>()		// spool filenames already read by this window

	get(sessionId: string): HookSignal | undefined { return this.signals.get(sessionId) }

	get size(): number { return this.signals.size }

	/* Read every spooled payload, then delete only those old enough that any other window has had its chance too. Deleting on sight would let two IDE windows steal each other's events, so reads are non-destructive and cleanup is time-based. */
	drain(): Set<string> {
		const touched = new Set<string>()
		const dir = spoolDir()
		let entries: string[]
		try { entries = fs.readdirSync(dir) } catch { return touched }
		const now = Date.now()
		const present = new Set<string>()
		let handled = 0
		for (const name of entries) {
			if (!name.endsWith(".json")) continue
			present.add(name)
			const file = path.join(dir, name)
			if (!this.consumed.has(name) && handled++ < MAX_DRAIN) {
				this.consumed.add(name)
				const signal = readSignal(file)
				if (signal) {
					const previous = this.signals.get(signal.sessionId)
					if (!previous || signal.at >= previous.at) {
						this.signals.set(signal.sessionId, signal)
						touched.add(signal.sessionId)
					}
				}
			}
			let mtimeMs = now
			try { mtimeMs = fs.statSync(file).mtimeMs } catch { continue }
			if (now - mtimeMs > SPOOL_GRACE_MS) { try { fs.unlinkSync(file) } catch { /* another window got there first */ } }
		}
		for (const name of this.consumed) { if (!present.has(name)) this.consumed.delete(name) }		// bound the set to what is still on disk
		this.prune()
		return touched
	}

	private prune(): void {
		const cutoff = Date.now() - SIGNAL_TTL_MS
		for (const [sessionId, signal] of this.signals) {
			if (signal.at < cutoff) this.signals.delete(sessionId)
		}
	}
}

interface StoredSignal extends HookSignal { sessionId: string }

/* Parse one spooled hook payload. The file's mtime is the event time — payloads carry no timestamp. */
function readSignal(file: string): StoredSignal | undefined {
	let raw: any
	let at = Date.now()
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"))
		at = fs.statSync(file).mtimeMs
	} catch { return undefined }
	const sessionId = String(raw?.session_id || "")
	const event = String(raw?.hook_event_name || "")
	const state = EVENT_STATE[event]
	if (!sessionId || !state) return undefined
	return { sessionId, state, at, event, tool: String(raw?.tool_name || ""), permissionMode: String(raw?.permission_mode || "") }
}

// --- STATE MACHINE ---

export interface StateInput {
	record: TranscriptRecord
	live: LiveSession | undefined
	signal: HookSignal | undefined
	preciseStatus: boolean
	staleToolSeconds: number
	now: number
}

/* Resolve one conversation's state. Hook signals only win while they are at least as fresh as the transcript, so a stale event can never pin a row. */
export function resolveState(input: StateInput): SessionState {
	const { record, live, signal, now } = input
	if (!live) return "closed"
	const fresh = !!signal && signal.at + FRESHNESS_TOLERANCE_MS >= record.lastRecordAt
	if (fresh && signal!.state === "closed") return "closed"
	if (fresh && signal!.state === "needs-input") return "needs-input"
	if (record.errorMessage) return "error"
	if (fresh && signal!.state === "finished") return "finished"
	if (record.interrupted) return "finished"		// the user hit stop; no end_turn or Stop hook is ever written for an interrupted run
	if (record.pendingTool) {
		if (ALWAYS_ASKS.has(record.pendingTool)) return "needs-input"		// these tools exist to ask, so no waiting on a timer
		const stalled = now - Math.max(record.pendingToolAt, record.lastRecordAt) > input.staleToolSeconds * 1000
		if (stalled && !(input.preciseStatus && signal)) return "needs-input?"		// without a trustworthy hook this is the honest answer
		return "busy"
	}
	if (fresh && signal!.state === "busy") return "busy"
	if (record.lastUserTurnAt > record.lastAssistantAt) return "busy"		// the user spoke last, so a reply is being generated
	if (record.endTurn) return "finished"
	return "busy"
}

/* Short label describing what the conversation is doing right now. */
export function activityLabel(state: SessionState, record: TranscriptRecord): string {
	switch (state) {
		case "busy": return record.pendingTool ? `Running: ${record.pendingTool}` : "Thinking"
		case "needs-input": return record.pendingTool ? `Needs input: ${record.pendingTool}` : "Needs input"
		case "needs-input?": return record.pendingTool ? `Waiting? ${record.pendingTool}` : "Waiting?"
		case "error": return record.errorMessage || "API error"
		case "finished": return record.interrupted ? "Interrupted" : "Finished"
		case "reviewed": return record.interrupted ? "Interrupted" : "Finished"
		case "closed": return "Closed — click to resume"
	}
}
