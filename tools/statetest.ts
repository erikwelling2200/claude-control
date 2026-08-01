import { resolveState } from "../src/status"
import type { HookSignal, LiveSession, TranscriptRecord } from "../src/types"

// --- FIXTURES ---

const NOW = 1785230000000
const LIVE: LiveSession = { pid: 1234, sessionId: "s1", cwd: "/tmp/p", startedAt: NOW - 60000, name: "p-1", kind: "interactive", procStart: "1" }

function record(over: Partial<TranscriptRecord> = {}): TranscriptRecord {
	return {
		sessionId: "s1", file: "/tmp/p/s1.jsonl", slug: "-tmp-p", size: 10, mtimeMs: NOW - 1000,
		title: "t", titleSource: "ai", lastPrompt: "", cwd: "/tmp/p", projectName: "p", gitBranch: "", version: "",
		permissionMode: "default", permissionModeAt: NOW - 2000, model: "claude-opus-5", changed: [],
		lastActivity: NOW - 1000, lastRecordAt: NOW - 1000, lastAssistantAt: NOW - 1000,
		pendingTool: "", pendingToolAt: 0, planFile: "", pendingMessages: 0, pendingMessageAt: 0, lastErrorAt: 0, errorMessage: "", endTurn: false, interrupted: false, lastUserTurnAt: 0,
		...over
	}
}

function signal(over: Partial<HookSignal> = {}): HookSignal {
	return { state: "needs-input", at: NOW, event: "PermissionRequest", tool: "Bash", permissionMode: "default", ...over }
}

let failures = 0

function expect(label: string, actual: string, wanted: string): void {
	const ok = actual === wanted
	console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `  — got ${actual}, wanted ${wanted}`}`)
	if (!ok) failures++
}

function state(over: Partial<Parameters<typeof resolveState>[0]> = {}): string {
	return resolveState({ record: record(), live: LIVE, signal: undefined, preciseStatus: false, staleToolSeconds: 90, now: NOW, ...over })
}

// --- CASES ---

console.log("liveness")
expect("no live process is closed", state({ live: undefined }), "closed")
expect("no live process beats a fresh busy signal", state({ live: undefined, signal: signal({ state: "busy" }) }), "closed")

console.log("\nhook signals")
expect("fresh needs-input wins", state({ signal: signal() }), "needs-input")
expect("fresh needs-input overrides a finished transcript", state({ record: record({ endTurn: true }), signal: signal() }), "needs-input")
expect("fresh Stop is finished", state({ signal: signal({ state: "finished", event: "Stop" }) }), "finished")
expect("fresh SessionEnd is closed", state({ signal: signal({ state: "closed", event: "SessionEnd" }) }), "closed")
expect("stale needs-input is ignored", state({ record: record({ lastRecordAt: NOW, endTurn: true }), signal: signal({ at: NOW - 30000 }) }), "finished")
expect("signal within the 2s tolerance still counts", state({ record: record({ lastRecordAt: NOW + 1500, endTurn: true }), signal: signal({ at: NOW }) }), "needs-input")

console.log("\ntranscript only")
expect("pending tool is busy", state({ record: record({ pendingTool: "Bash", pendingToolAt: NOW - 5000 }) }), "busy")
expect("end_turn is finished", state({ record: record({ endTurn: true }) }), "finished")
expect("user spoke last means a reply is coming", state({ record: record({ lastUserTurnAt: NOW - 500, lastAssistantAt: NOW - 5000, endTurn: true }) }), "busy")
expect("mid-turn assistant with no pending tool is busy", state({ record: record({ endTurn: false }) }), "busy")

console.log("\nerrors")
expect("unresolved api error", state({ record: record({ errorMessage: "Connection error", lastErrorAt: NOW - 2000 }) }), "error")
expect("a fresh needs-input outranks an error", state({ record: record({ errorMessage: "Connection error" }), signal: signal() }), "needs-input")

console.log("\nstalled tool heuristic")
const stalled = record({ pendingTool: "Bash", pendingToolAt: NOW - 200000, lastRecordAt: NOW - 200000 })
expect("stalled tool without hooks is uncertain", state({ record: stalled }), "needs-input?")
expect("stalled tool stays busy inside the window", state({ record: record({ pendingTool: "Bash", pendingToolAt: NOW - 5000, lastRecordAt: NOW - 5000 }) }), "busy")
expect("with hooks and a signal, no guessing", state({ record: stalled, preciseStatus: true, signal: signal({ state: "busy", at: NOW }) }), "busy")
expect("with hooks but no signal for this session, still guess", state({ record: stalled, preciseStatus: true }), "needs-input?")

console.log("\ninterrupted runs")
expect("an interrupted run is finished, not thinking", state({ record: record({ interrupted: true, endTurn: false }) }), "finished")
expect("interrupt beats a stale busy signal", state({ record: record({ interrupted: true, lastRecordAt: NOW }), signal: signal({ state: "busy", at: NOW - 30000 }) }), "finished")
expect("a fresh needs-input still outranks an interrupt", state({ record: record({ interrupted: true }), signal: signal() }), "needs-input")

console.log("\ntools that always ask")
expect("a pending ExitPlanMode is immediately needs-input", state({ record: record({ pendingTool: "ExitPlanMode", pendingToolAt: NOW - 2000, lastRecordAt: NOW - 2000 }) }), "needs-input")
expect("a pending AskUserQuestion is immediately needs-input", state({ record: record({ pendingTool: "AskUserQuestion", pendingToolAt: NOW - 500, lastRecordAt: NOW - 500 }) }), "needs-input")
expect("Bash still has to age before it is doubted", state({ record: record({ pendingTool: "Bash", pendingToolAt: NOW - 2000, lastRecordAt: NOW - 2000 }) }), "busy")

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
