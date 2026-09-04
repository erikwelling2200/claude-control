// --- STATE ---

/* "needs-input?" is the heuristic guess used only when hooks are not installed. "waiting" means the turn is over but a background task will wake the session, so it is not done. "finished" means done but not yet looked at; "reviewed" means the user has since opened it. "killed" means the conversation has no process any more, whatever its tab still shows. */
export type SessionState = "busy" | "needs-input" | "needs-input?" | "waiting" | "finished" | "reviewed" | "killed" | "error"

export type TitleSource = "custom" | "ai" | "head" | "registry" | "id"

// --- TRANSCRIPT ---

/* Everything derived from one transcript file, cacheable against (size, mtimeMs). */
export interface TranscriptRecord {
	sessionId: string
	file: string
	slug: string
	size: number
	mtimeMs: number
	title: string
	titleSource: TitleSource
	lastPrompt: string
	cwd: string
	projectName: string
	gitBranch: string
	version: string
	permissionMode: string		// default | acceptEdits | bypassPermissions | plan | …
	permissionModeAt: number		// when that reading was taken; the transcript records it only rarely
	model: string		// full id as the API reported it, e.g. claude-opus-5
	lastActivity: number		// file mtime — what the user perceives as recency, so it drives sorting
	lastRecordAt: number		// newest in-transcript timestamp — used for hook freshness and staleness
	lastAssistantAt: number
	pendingTool: string
	pendingToolAt: number
	pendingTasks: number		// background tasks launched but not yet reported back — the session will be woken, so an ended turn is not the end
	planFile: string		// set when the pending tool is ExitPlanMode, from its own planFilePath input
	lastErrorAt: number
	errorMessage: string
	endTurn: boolean
	interrupted: boolean		// the user hit stop and nothing has happened since, so the run is over even though no end_turn was written
	lastUserTurnAt: number
	pendingMessages: number		// submitted but not yet consumed by Claude, from queue-operation records
	pendingMessageAt: number
	changed: ChangedFile[]		// every tracked edit in the tail, filtered to the latest run when built into a row
}

// --- CHANGED FILES ---

/* One file Claude's own edit tracker recorded during the latest run. `version` is the earliest snapshot seen in that run, so the diff's left side is the backup just below it. */
export interface ChangedFile {
	path: string
	version: number
	at: number
}

// --- USAGE LIMITS ---

export interface UsageLimit {
	kind: string
	label: string
	percent: number
	severity: "normal" | "warning" | "critical"
	resetsAt: number
	active: boolean		// the limit currently doing the constraining
}

export interface UsageSnapshot {
	limits: UsageLimit[]
	fetchedAt: number		// Claude only refreshes this on demand, so the panel shows how old it is
}

// --- LIVE PROCESSES ---

export interface LiveSession {
	pid: number
	sessionId: string
	cwd: string
	startedAt: number
	name: string
	kind: string
	procStart: string
}

// --- HOOK SIGNALS ---

export type HookState = "busy" | "needs-input" | "finished" | "closed"

export interface HookSignal {
	state: HookState
	at: number
	event: string
	tool: string
	permissionMode: string		// hook payloads carry the live mode, which the transcript only records at prompt submission
}

// --- VIEW MODEL ---

/* One row as the webview consumes it. */
export interface SessionRow {
	sessionId: string
	title: string
	lastPrompt: string
	cwd: string
	projectName: string
	gitBranch: string
	state: SessionState
	tool: string
	lastActivity: number
	live: boolean
	pid: number
	file: string
	errorMessage: string
	remoteActive: boolean		// a Remote Control bridge is serving this conversation's folder
	planFile: string		// a plan awaiting your feedback, opened alongside the conversation
	permissionMode: string
	permissionModeStale: boolean		// the reading predates the current turn, so the mode may have changed since
	pendingMessages: number
	modelLabel: string		// bare family for the gutter, e.g. OPUS
	changed: ChangedFile[]		// shown as chips once the run has finished
}

export interface ProjectOption {
	cwd: string
	name: string
	count: number
}

export interface PanelData {
	rows: SessionRow[]
	workspaces: ProjectOption[]		// one per folder with conversations, labels already disambiguated, for the list's group headers
	activeCwd: string		// the folder this window has open, whose group the list puts first
	needsInputTotal: number
	preciseStatus: boolean
	promptPreviewLines: number
	usage: UsageSnapshot
}
