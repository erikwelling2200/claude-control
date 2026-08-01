import * as fs from "fs"
import * as path from "path"
import { projectName, projectsDir } from "./paths"
import type { ChangedFile, TitleSource, TranscriptRecord } from "./types"

// --- TUNING ---

const HEAD_BYTES = 65536
const TITLE_MAX = 120
const PROMPT_MAX = 400
const MAX_TRACKED = 400		// accumulated edits per session, bounding the cache

export interface ScanOptions {
	tailBytes: number
	cache?: Map<string, TranscriptRecord>
}

export interface ScanResult {
	records: TranscriptRecord[]
	scanned: number
	reused: number
}

// --- FILE DISCOVERY ---

/* Every top-level transcript. Subagent sidechains live in a nested subagents/ dir and are deliberately skipped. */
export function listTranscripts(): string[] {
	const out: string[] = []
	let slugs: fs.Dirent[]
	try { slugs = fs.readdirSync(projectsDir(), { withFileTypes: true }) } catch { return out }
	for (const slug of slugs) {
		if (!slug.isDirectory()) continue
		const dir = path.join(projectsDir(), slug.name)
		let entries: fs.Dirent[]
		try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
			out.push(path.join(dir, entry.name))
		}
	}
	return out
}

// --- SCAN ---

/* Build a record per transcript, reusing cached records whose (size, mtime) are unchanged. */
export function scan(options: ScanOptions): ScanResult {
	const result: ScanResult = { records: [], scanned: 0, reused: 0 }
	for (const file of listTranscripts()) {
		const cached = options.cache?.get(file)
		const record = scanOne(file, options)
		if (!record) continue
		result.records.push(record)
		if (record === cached) result.reused++		// identity means scanOne short-circuited on an unchanged file
		else result.scanned++
	}
	return result
}

/* Read one transcript, or hand back the cached record when the file has not changed. */
export function scanOne(file: string, options: ScanOptions): TranscriptRecord | undefined {
	let stat: fs.Stats
	try { stat = fs.statSync(file) } catch { return undefined }
	const cached = options.cache?.get(file)
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached
	const record = emptyRecord(file, stat)
	applyTail(record, readTail(file, stat.size, options.tailBytes))
	if (!record.title) applyHeadTitle(record, file)
	if (!record.title) { record.title = record.sessionId.slice(0, 8); record.titleSource = "id" }
	if (!record.cwd && cached?.cwd) record.cwd = cached.cwd		// a tail of pure title records carries no cwd
	if (!record.lastPrompt && cached?.lastPrompt) record.lastPrompt = cached.lastPrompt
	if (cached?.permissionMode && cached.permissionModeAt >= record.permissionModeAt) { record.permissionMode = cached.permissionMode; record.permissionModeAt = cached.permissionModeAt }		// the tail rarely contains a mode record, so keep the newest ever seen
	if (!record.model && cached?.model) record.model = cached.model
	mergeChanged(record, cached?.changed)		// the tail is a window, so edits are accumulated across scans
	record.projectName = record.cwd ? projectName(record.cwd) : ""
	return record
}

function emptyRecord(file: string, stat: fs.Stats): TranscriptRecord {
	return {
		sessionId: path.basename(file, ".jsonl"),
		file,
		slug: path.basename(path.dirname(file)),
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		title: "",
		titleSource: "id",
		lastPrompt: "",
		cwd: "",
		projectName: "",
		gitBranch: "",
		version: "",
		permissionMode: "",
		permissionModeAt: 0,
		model: "",
		lastActivity: stat.mtimeMs,
		lastRecordAt: 0,
		lastAssistantAt: 0,
		pendingTool: "",
		pendingToolAt: 0,
		planFile: "",
		lastErrorAt: 0,
		errorMessage: "",
		endTurn: false,
		interrupted: false,
		lastUserTurnAt: 0,
		pendingMessages: 0,
		pendingMessageAt: 0,
		changed: []
	}
}

// --- BOUNDED READS ---

/* Last `bytes` of the file as whole lines. The leading fragment is dropped because it is almost certainly a partial record. */
function readTail(file: string, size: number, bytes: number): string[] {
	const from = Math.max(0, size - bytes)
	const length = size - from
	if (length <= 0) return []
	const buffer = Buffer.allocUnsafe(length)
	let fd: number
	try { fd = fs.openSync(file, "r") } catch { return [] }
	let read = 0
	try { read = fs.readSync(fd, buffer, 0, length, from) } finally { fs.closeSync(fd) }
	const lines = buffer.subarray(0, read).toString("utf8").split("\n")
	if (from > 0) lines.shift()
	return lines
}

/* First `HEAD_BYTES` of the file as whole lines, dropping a trailing partial. */
function readHead(file: string): string[] {
	const buffer = Buffer.allocUnsafe(HEAD_BYTES)
	let fd: number
	try { fd = fs.openSync(file, "r") } catch { return [] }
	let read = 0
	try { read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0) } finally { fs.closeSync(fd) }
	const lines = buffer.subarray(0, read).toString("utf8").split("\n")
	if (read === HEAD_BYTES) lines.pop()
	return lines
}

// --- RECORD EXTRACTION ---

/* Single forward pass over the tail. Forward order lets tool_result cancel its tool_use naturally. */
function applyTail(record: TranscriptRecord, lines: string[]): void {
	const pending = new Map<string, PendingTool>()
	let aiTitle = ""
	let customTitle = ""
	let queuedPrompt = false		// lastPrompt holds a still-queued message, which re-appended last-prompt records (they carry the *consumed* prompt) must not clobber
	for (const line of lines) {
		if (line.length < 2) continue
		let entry: any
		try { entry = JSON.parse(line) } catch { continue }		// truncated or interleaved write
		if (!entry || typeof entry !== "object") continue
		switch (entry.type) {
			case "custom-title": if (typeof entry.customTitle === "string") customTitle = entry.customTitle; break
			case "ai-title": if (typeof entry.aiTitle === "string") aiTitle = entry.aiTitle; break
			case "last-prompt": if (!queuedPrompt && typeof entry.lastPrompt === "string") record.lastPrompt = entry.lastPrompt; break
			case "queue-operation": queuedPrompt = applyQueue(record, entry, queuedPrompt); break
			case "file-history-delta": applyDelta(record, entry); break
			case "system": applySystem(record, entry); break
			case "assistant": applyAssistant(record, entry, pending); break
			case "user": applyUser(record, entry, pending); break
		}
		const at = timestampOf(entry)
		if (at > record.lastRecordAt) record.lastRecordAt = at
		if (entry.cwd) record.cwd = String(entry.cwd)
		if (entry.gitBranch && entry.gitBranch !== "HEAD") record.gitBranch = String(entry.gitBranch)
		if (entry.version) record.version = String(entry.version)
		if (entry.permissionMode) { record.permissionMode = String(entry.permissionMode); record.permissionModeAt = at || record.lastRecordAt }		// dedicated "permission-mode" records carry no timestamp of their own
		if (entry.type === "mode" && entry.mode === "plan") { record.permissionMode = "plan"; record.permissionModeAt = at }		// plan mode is recorded separately from the tool-permission mode
	}
	if (customTitle) { record.title = clip(customTitle, TITLE_MAX); record.titleSource = "custom" }
	else if (aiTitle) { record.title = clip(aiTitle, TITLE_MAX); record.titleSource = "ai" }
	record.lastPrompt = clip(record.lastPrompt, PROMPT_MAX)
	const oldest = [...pending.values()].sort((a, b) => a.at - b.at)[0]
	if (oldest) { record.pendingTool = oldest.name; record.pendingToolAt = oldest.at; record.planFile = oldest.planFile }
	for (const file of record.changed) {
		if (!path.isAbsolute(file.path)) file.path = path.join(record.cwd || "", file.path)		// older transcripts record paths relative to cwd
	}
	record.changed.sort((a, b) => b.at - a.at)
}

interface PendingTool { name: string, at: number, planFile: string }

/* A prompt submitted while Claude is mid-turn is queued, and the transcript records the enqueue plus whatever later drains it: "dequeue" when Claude consumes one, "popAll" when it consumes the lot, "remove" when it is withdrawn — missing those leaves a phantom pending count forever.
   Counting within the tail is safe: anything written after an enqueue is necessarily in the window too. Current versions stamp the queued text on the enqueue itself; the `last-prompt` record is only written when the prompt is *consumed*, so without `content` the preview would show the previous message as the pending one. */
function applyQueue(record: TranscriptRecord, entry: any, hadQueuedPrompt: boolean): boolean {
	if (entry.operation === "enqueue") {
		record.pendingMessages++
		record.pendingMessageAt = timestampOf(entry)
		if (typeof entry.content === "string" && sanitize(entry.content)) { record.lastPrompt = entry.content; return true }		// injected blocks such as task notifications sanitize to nothing and are not the user's message
		return hadQueuedPrompt
	}
	if (entry.operation === "popAll") record.pendingMessages = 0
	else record.pendingMessages = Math.max(0, record.pendingMessages - 1)
	return hadQueuedPrompt && record.pendingMessages > 0		// once the queue drains, the consumed prompt's own last-prompt record takes over again
}

/* Carry forward edits seen in earlier scans. Only the last `tailBytes` of a transcript are read, so a long run's early edits would otherwise scroll out of view; the union keeps the whole session's set, and the per-run filter trims it for display. */
function mergeChanged(record: TranscriptRecord, previous: ChangedFile[] | undefined): void {
	if (!previous?.length) return
	for (const old of previous) {
		const current = record.changed.find((file) => file.path === old.path)
		if (!current) { record.changed.push({ ...old }); continue }
		current.version = Math.min(current.version, old.version)		// earliest snapshot wins, so the diff reaches back to before the run
		current.at = Math.max(current.at, old.at)
	}
	record.changed.sort((a, b) => b.at - a.at)
	if (record.changed.length > MAX_TRACKED) record.changed.length = MAX_TRACKED
}

/* Claude's own edit tracker. trackingPath is absolute in current versions and relative in older ones, so both are handled. Keeps the lowest version per path: that is the earliest snapshot, and the diff's left side sits just below it. */
function applyDelta(record: TranscriptRecord, entry: any): void {
	const tracked = String(entry.trackingPath || "")
	if (!tracked) return		// some deltas carry no path
	const version = Number(entry.backup?.version || 0)
	if (!version) return
	const at = Date.parse(entry.backup?.backupTime || entry.timestamp || "") || 0
	const existing = record.changed.find((file) => file.path === tracked)		// resolved to absolute after the pass, once cwd is known
	if (!existing) { record.changed.push({ path: tracked, version, at }); return }
	existing.version = Math.min(existing.version, version)
	existing.at = Math.max(existing.at, at)
}

function applySystem(record: TranscriptRecord, entry: any): void {
	if (entry.subtype !== "api_error") return
	record.lastErrorAt = timestampOf(entry)
	record.errorMessage = clip(String(entry.error?.formatted || entry.error?.message || "API error"), 200)
}

function applyAssistant(record: TranscriptRecord, entry: any, pending: Map<string, PendingTool>): void {
	if (entry.isSidechain) return		// subagent chatter, not this conversation's state
	const at = timestampOf(entry)
	record.endTurn = entry.message?.stop_reason === "end_turn"
	if (at > record.lastAssistantAt) record.lastAssistantAt = at
	const model = String(entry.message?.model || "")
	if (model && !model.startsWith("<")) record.model = model		// "<synthetic>" is not a real model
	if (at > record.lastErrorAt) { record.errorMessage = ""; record.lastErrorAt = 0 }		// the model carried on after the error
	for (const block of blocksOf(entry)) {
		if (block?.type !== "tool_use" || typeof block.id !== "string") continue
		pending.set(block.id, { name: String(block.name || "tool"), at, planFile: String(block.input?.planFilePath || "") })		// ExitPlanMode names its own plan file
	}
}

function applyUser(record: TranscriptRecord, entry: any, pending: Map<string, PendingTool>): void {
	if (entry.isSidechain || entry.isMeta) return		// injected reminders are not the user speaking
	const at = timestampOf(entry)
	for (const block of blocksOf(entry)) {
		if (block?.type === "tool_result" && typeof block.tool_use_id === "string") pending.delete(block.tool_use_id)
		if (block?.type !== "text") continue
		/* Hitting stop writes a user record saying "[Request interrupted by user]" (or "… for tool use"). It is not the user speaking — counting it would read as a prompt awaiting a reply and pin the row on "Thinking" — and the interrupted tool_use never gets its result, so the turn is closed out here. */
		if (String(block.text || "").startsWith("[Request interrupted by user")) { record.interrupted = true; pending.clear(); continue }
		record.interrupted = false
		if (at > record.lastUserTurnAt) record.lastUserTurnAt = at
	}
}

/* Fall back to the conversation's opening prompt when no title record exists yet. */
function applyHeadTitle(record: TranscriptRecord, file: string): void {
	for (const line of readHead(file)) {
		if (line.length < 2) continue
		let entry: any
		try { entry = JSON.parse(line) } catch { continue }
		if (entry?.type === "custom-title" && entry.customTitle) { setHeadTitle(record, entry.customTitle, "custom"); return }
		if (entry?.type === "ai-title" && entry.aiTitle) { setHeadTitle(record, entry.aiTitle, "ai"); return }
		if (entry?.type !== "user" || entry.isSidechain || entry.isMeta) continue
		for (const block of blocksOf(entry)) {
			if (block?.type === "text" && String(block.text || "").trim()) { setHeadTitle(record, String(block.text), "head"); return }
		}
	}
}

function setHeadTitle(record: TranscriptRecord, text: string, source: TitleSource): void {
	record.title = clip(text, TITLE_MAX)
	record.titleSource = source
	if (!record.lastPrompt && source === "head") record.lastPrompt = clip(text, PROMPT_MAX)
}

// --- HELPERS ---

/* Content blocks of a message record, tolerating the plain-string form. */
function blocksOf(entry: any): any[] {
	const content = entry?.message?.content
	if (Array.isArray(content)) return content
	if (typeof content === "string") return [{ type: "text", text: content }]
	return []
}

function timestampOf(entry: any): number {
	const parsed = Date.parse(entry?.timestamp || "")
	return Number.isFinite(parsed) ? parsed : 0
}

function clip(text: string, max: number): string {
	const flat = sanitize(text)
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// --- TEXT CLEANUP ---

const NOISE = "system-reminder|ide_selection|local-command-stdout|local-command-stderr|command-message|command-args|command-contents|command-name|task-notification"
const NOISE_BLOCK = new RegExp(`<(${NOISE})>[\\s\\S]*?<\\/\\1>`, "g")
const NOISE_TAG = new RegExp(`<\\/?(${NOISE})>`, "g")
const COMMAND_NAME = /<command-name>\s*([^<]+?)\s*<\/command-name>/

/* Strip the machinery Claude wraps around slash commands and injected context, so titles and previews read like what the user actually typed. Only known wrapper tags are removed — a prompt that genuinely mentions <div> keeps it. */
export function sanitize(text: string): string {
	const raw = String(text || "")
	const command = raw.match(COMMAND_NAME)
	if (command) return command[1].trim()		// a slash-command turn is best titled by the command itself
	return raw.replace(NOISE_BLOCK, " ").replace(NOISE_TAG, " ").replace(/\s+/g, " ").trim()
}
