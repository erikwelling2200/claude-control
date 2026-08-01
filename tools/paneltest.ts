import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/* Isolate the hook spool: a live claude-monitor in the IDE reads the real directory, and two readers would race. */
process.env.CLAUDE_MONITOR_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-spool-"))

import { createHash } from "crypto"
import { readProcesses, readRegistry } from "../src/live"
import { claudeRoot, spoolDir } from "../src/paths"
import { scanOne } from "../src/scanner"
import { configFile, trustState } from "../src/trust"
import { readUsage } from "../src/usage"
import { Monitor, type MonitorConfig } from "../src/watcher"
import type { PanelData } from "../src/types"

// --- SETUP ---

const CONFIG: MonitorConfig = {
	tailBytes: 131072,
	staleToolSeconds: 90,
	preciseStatus: false,
	showClosed: true,
	pinNeedsInput: true,
	groupByProject: false,
	promptPreviewLines: 2,
	claudePath: ""
}

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-paneltest-"))
const storeFile = path.join(storeDir, "index.json")
const activeCwd = process.argv[2] || process.cwd()

let failures = 0
let warmMonitor2: Monitor | undefined

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? `  — ${detail}` : ""}`)
	if (!ok) failures++
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function isWaitingState(state: string | undefined): boolean { return state === "needs-input" || state === "needs-input?" }

/* Mirrors the extension's backup resolution so the test proves the sha256 derivation against real files on disk. Starts AT the reported version: a backup holds the content from before its change, so v1 is the file as the session found it — not a newly created file. */
function priorBackup(sessionId: string, file: string, version: number): string {
	for (let candidate = version; candidate >= 1 && candidate > version - 25; candidate--) {
		const hash = createHash("sha256").update(file).digest("hex").slice(0, 16)
		const backup = path.join(claudeRoot(), "file-history", sessionId, `${hash}@v${candidate}`)
		if (fs.existsSync(backup)) return backup
	}
	return ""
}

// --- RUN ---

async function main(): Promise<void> {
	let latest: PanelData | undefined
	let emissions = 0
	const announced: string[] = []
	const monitor = new Monitor(CONFIG, storeFile, activeCwd, (data) => { latest = data; emissions++ }, (row) => announced.push(row.sessionId))

	const started = performance.now()
	monitor.start()
	const firstPaintMs = performance.now() - started
	check("emits synchronously on start (first paint needs no scan)", emissions >= 1, `${emissions} emission(s) in ${firstPaintMs.toFixed(0)}ms`)

	await delay(4000)		// let the authoritative reconcile land
	if (!latest) { check("panel data produced", false); return finish(monitor) }

	console.log("")
	check("rows produced", latest.rows.length > 0, `${latest.rows.length} rows`)
	check("projects produced", latest.projects.length > 0, latest.projects.map((p) => `${p.name}(${p.count})`).join(" "))
	check("no two projects share a label", new Set(latest.projects.map((p) => p.name)).size === latest.projects.length)
	check("active cwd resolved", !!latest.activeCwd, latest.activeCwd)
	const activeHasSessions = latest.rows.some((row) => row.cwd === latest!.activeCwd)
	check("active cwd is offered as a project when it has sessions", !activeHasSessions || latest.projects.some((p) => p.cwd === latest!.activeCwd), activeHasSessions ? "" : "active folder has no sessions — host falls back to all projects")
	check("every row has a title", latest.rows.every((row) => !!row.title))
	check("every row has a project name", latest.rows.every((row) => !!row.projectName), latest.rows.filter((r) => !r.projectName).map((r) => r.sessionId).join(","))
	check("rows sorted newest first (within pin groups)", sortedWithinPins(latest.rows))
	check("live rows carry a pid", latest.rows.filter((row) => row.live).every((row) => row.pid > 0))
	check("closed rows are not live", latest.rows.filter((row) => row.state === "closed").every((row) => !row.live))

	const live = latest.rows.filter((row) => row.live)
	console.log(`\nlive rows ${live.length}:`)
	for (const row of live) console.log(`  ${row.state.padEnd(13)}${row.remoteActive ? "rc " : "   "}${row.planFile ? "plan " : "     "}${row.title.slice(0, 46)}`)

	// --- PLAN AWAITING FEEDBACK ---

	const withPlan = latest.rows.filter((row) => row.planFile)
	console.log(`\nrows offering a plan ${withPlan.length}`)
	check("every offered plan file exists on disk", withPlan.every((row) => fs.existsSync(row.planFile)), withPlan.map((row) => path.basename(row.planFile)).join(", "))
	check("plans are only offered while waiting on the user", withPlan.every((row) => row.state === "needs-input" || row.state === "needs-input?"), withPlan.map((row) => row.state).join(","))

	// --- REVIEWED STATE ---

	const finished = latest.rows.find((row) => row.state === "finished")
	if (!finished) console.log("\n(no finished conversation — skipping the reviewed check)")
	else {
		monitor.markSeen(finished.sessionId, Date.now())
		check("opening a finished conversation turns its tick grey", monitor.rowFor(finished.sessionId)?.state === "reviewed", monitor.rowFor(finished.sessionId)?.state)
		check("a reviewed conversation is not counted as waiting", !isWaitingState(monitor.rowFor(finished.sessionId)?.state))
	}

	// --- CHANGED FILES AND THEIR BACKUPS ---

	const withFiles = latest.rows.filter((row) => row.changed.length)
	console.log(`\nfinished runs offering file chips ${withFiles.length}`)
	check("chips only appear on finished runs", latest.rows.every((row) => !row.changed.length || row.state === "finished" || row.state === "reviewed"))
	check("every changed path is absolute", withFiles.every((row) => row.changed.every((file) => path.isAbsolute(file.path))))
	check("changed paths are unique per row", withFiles.every((row) => new Set(row.changed.map((f) => f.path)).size === row.changed.length))

	let resolvable = 0
	let total = 0
	for (const row of withFiles.slice(0, 4)) {
		console.log(`  ${row.title.slice(0, 34).padEnd(36)}${row.changed.length} file(s)`)
		for (const file of row.changed.slice(0, 6)) {
			total++
			const before = priorBackup(row.sessionId, file.path, file.version)
			if (before) resolvable++
			console.log(`    v${String(file.version).padEnd(3)}${(before ? "diff vs backup" : "new → empty").padEnd(16)}${path.basename(file.path)}`)
		}
	}
	if (total) console.log(`  ${resolvable}/${total} resolve to a real backup`)

	// --- REGRESSION: v1 IS A BACKUP, NOT A NEW FILE ---

	const cwd = "/home/cron/Z/Cron/CronDesign/Γ Projects/Games/DragonLands/DragonLands"
	const known = path.join(cwd, "src/entities/Player.js")
	if (fs.existsSync(known)) {
		const backup = priorBackup("785b4b1f-77f9-4e7a-844c-e490b4c6c514", known, 1)
		check("a long-lived file reported at v1 still resolves to a backup", !!backup, backup ? path.basename(backup) : "none — would wrongly read as new")
		if (backup) check("that backup differs from the file on disk", fs.readFileSync(backup).length !== fs.readFileSync(known).length)
	}

	// --- CHANGED FILES ACCUMULATE ACROSS SCANS ---

	const beforeCount = latest.rows.reduce((sum, row) => sum + row.changed.length, 0)
	warmMonitor2 = new Monitor(CONFIG, storeFile, activeCwd, () => {}, () => {})
	warmMonitor2.start()
	await delay(2500)
	const afterCount = warmMonitor2.build().rows.reduce((sum, row) => sum + row.changed.length, 0)
	check("a rescan never loses previously seen edits", afterCount >= beforeCount, `${beforeCount} → ${afterCount}`)
	warmMonitor2.dispose()

	// --- LIVENESS SOURCES AGREE ---

	const registry = readRegistry()
	const procs = readProcesses()
	console.log(`\nliveness: registry ${registry.size}, argv ${procs.size}, rows live ${live.length}`)
	for (const [id, session] of procs) console.log(`  argv  ${id.slice(0, 8)}  pid ${session.pid}  ${session.cwd.slice(-38)}`)
	check("argv scan recovers a full session id per resumed process", [...procs.keys()].every((id) => id.length > 8))
	check("every registry session is reported live", [...registry.keys()].every((id) => live.some((row) => row.sessionId === id)))
	check("every argv session is reported live", [...procs.keys()].every((id) => live.some((row) => row.sessionId === id)))

	// --- QUEUED MESSAGES ---

	const queued = latest.rows.filter((row) => row.pendingMessages > 0)
	console.log(`\nconversations with a pending message ${queued.length}`)
	for (const row of queued) console.log(`  ${row.pendingMessages} pending  ${row.state.padEnd(13)}${row.title.slice(0, 34)}`)
	check("pending counts are never negative", latest.rows.every((row) => row.pendingMessages >= 0))
	check("only live conversations report a queue", latest.rows.every((row) => row.pendingMessages === 0 || row.live))

	// --- PERMISSION MODE CONFIDENCE ---

	const withMode = latest.rows.filter((row) => row.permissionMode)
	const unsure = withMode.filter((row) => row.permissionModeStale)
	console.log(`\npermission modes ${withMode.length} known, ${unsure.length} predate their current turn`)
	for (const row of withMode.slice(0, 5)) console.log(`  ${row.permissionMode.padEnd(19)}${row.permissionModeStale ? "last known" : "current   "}  ${row.title.slice(0, 34)}`)
	check("a mode is never marked stale without a reading", latest.rows.every((row) => !row.permissionModeStale || !!row.permissionMode))

	// --- USAGE LIMITS ---

	const usage = latest.usage
	console.log(`\nusage limits ${usage.limits.length}, fetched ${usage.fetchedAt ? `${Math.round((Date.now() - usage.fetchedAt) / 60000)}m ago` : "never"}`)
	for (const limit of usage.limits) console.log(`  ${limit.label.padEnd(10)}${String(limit.percent).padStart(3)}%  ${limit.severity.padEnd(9)}${limit.active ? "limiting" : ""}`)
	if (usage.limits.length) {
		check("percentages are within 0-100", usage.limits.every((l) => l.percent >= 0 && l.percent <= 100))
		check("every limit has a label", usage.limits.every((l) => !!l.label))
		check("severity escalates with a full bar", usage.limits.every((l) => l.percent < 75 || l.severity !== "normal"))
		check("reset times are in the future", usage.limits.every((l) => !l.resetsAt || l.resetsAt > usage.fetchedAt))
		check("a repeat read is served from the mtime cache", readUsage() === readUsage())
	} else console.log("  (no cached usage — run /usage in a Claude session)")

	// --- WORKSPACE TRUST GATE ---

	console.log(`\nconfig file  ${configFile()}`)
	check("home directory reports as never-trustable", trustState(os.homedir()) === "home", trustState(os.homedir()))
	check("a nonexistent folder is not trusted", trustState("/nonexistent-folder-xyz") === "untrusted", trustState("/nonexistent-folder-xyz"))
	for (const project of latest.projects.slice(0, 6)) console.log(`  ${trustState(project.cwd).padEnd(10)}${project.name}`)

	// --- CACHE ROUND-TRIP ---

	monitor.dispose()
	check("cache written to disk", fs.existsSync(storeFile))
	const cached = JSON.parse(fs.readFileSync(storeFile, "utf8"))
	check("cache is schema-versioned", typeof cached.schema === "number")
	check("cache holds every record", cached.records.length === latest.rows.length, `${cached.records.length} cached vs ${latest.rows.length} rows`)

	let warm: PanelData | undefined
	const warmMonitor = new Monitor(CONFIG, storeFile, activeCwd, (data) => { if (!warm) warm = data }, () => {})
	const warmStart = performance.now()
	warmMonitor.start()
	const warmMs = performance.now() - warmStart
	check("warm start paints the same rows from cache", warm?.rows.length === latest.rows.length, `${warmMs.toFixed(0)}ms, ${warm?.rows.length} rows`)

	// --- HOOK SIGNAL DRIVES needs-input ON A REAL LIVE SESSION ---

	if (!live.length) console.log("\n(no live sessions — skipping the hook-signal check)")
	else {
		const target = live.find((row) => row.state === "finished") || live[0]		// an idle session cannot race its transcript ahead of the injected signal
		fs.mkdirSync(spoolDir(), { recursive: true })
		const spooled = path.join(spoolDir(), `paneltest-${Date.now()}.json`)
		fs.writeFileSync(spooled, JSON.stringify({ session_id: target.sessionId, hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: target.cwd }))
		await delay(1200)
		warmMonitor.refresh()
		await delay(2500)
		const row = warm && warmMonitor.rowFor(target.sessionId)
		check("a PermissionRequest signal flips a live row to needs-input", row?.state === "needs-input", `${target.title.slice(0, 40)} → ${row?.state}`)
		check("the label names the tool actually pending in the transcript", !!row?.tool.startsWith("Needs input"), row?.tool)		// the transcript is the source of truth, not the hook payload's tool_name
		check("spool file retained inside the grace window so other windows can read it", fs.existsSync(spooled))

		const stale = path.join(spoolDir(), `paneltest-stale-${Date.now()}.json`)
		fs.writeFileSync(stale, JSON.stringify({ session_id: target.sessionId, hook_event_name: "Stop" }))
		const backdated = new Date(Date.now() - 120000)
		fs.utimesSync(stale, backdated, backdated)
		warmMonitor.refresh()
		await delay(2500)
		check("spool file past the grace window is cleaned up", !fs.existsSync(stale))
	}

	// --- SYNTHETIC TRANSCRIPTS: QUEUED TEXT AND INTERRUPTS ---

	console.log("\nsynthetic transcripts")
	const line = (entry: object) => `${JSON.stringify(entry)}\n`
	const synth = (name: string, lines: string[]) => {
		const file = path.join(storeDir, `${name}.jsonl`)
		fs.writeFileSync(file, lines.join(""))
		return scanOne(file, { tailBytes: 131072 })
	}

	const queuedRec = synth("11111111-aaaa-bbbb-cccc-000000000001", [
		line({ type: "user", message: { role: "user", content: [{ type: "text", text: "first prompt" }] }, timestamp: "2026-07-30T10:00:00.000Z", cwd: "/tmp/p" }),
		line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-30T10:00:10.000Z", content: "the queued message" }),
		line({ type: "last-prompt", lastPrompt: "first prompt" })		// re-appended with the consumed prompt, exactly as Claude writes it
	])
	check("enqueue content becomes the pending preview", queuedRec?.lastPrompt === "the queued message", queuedRec?.lastPrompt)
	check("the enqueue is counted", queuedRec?.pendingMessages === 1)

	const drainedRec = synth("11111111-aaaa-bbbb-cccc-000000000002", [
		line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-30T10:00:10.000Z", content: "the queued message" }),
		line({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-30T10:00:11.000Z" }),
		line({ type: "last-prompt", lastPrompt: "the queued message" })
	])
	check("a drained queue hands last-prompt back its authority", drainedRec?.pendingMessages === 0 && drainedRec?.lastPrompt === "the queued message")

	const notifiedRec = synth("11111111-aaaa-bbbb-cccc-000000000003", [
		line({ type: "last-prompt", lastPrompt: "real prompt" }),
		line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-30T10:00:10.000Z", content: "<task-notification>machinery</task-notification>" })
	])
	check("an injected task notification is not shown as the pending message", notifiedRec?.lastPrompt === "real prompt", notifiedRec?.lastPrompt)

	const interruptedRec = synth("11111111-aaaa-bbbb-cccc-000000000004", [
		line({ type: "user", message: { role: "user", content: [{ type: "text", text: "do the thing" }] }, timestamp: "2026-07-30T10:00:00.000Z", cwd: "/tmp/p" }),
		line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], stop_reason: "tool_use" }, timestamp: "2026-07-30T10:00:05.000Z" }),
		line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] }, timestamp: "2026-07-30T10:00:20.000Z" })
	])
	check("an interrupt marks the record interrupted", interruptedRec?.interrupted === true)
	check("an interrupt closes out the orphaned tool_use", interruptedRec?.pendingTool === "")
	check("an interrupt does not read as the user speaking", (interruptedRec?.lastUserTurnAt || 0) < (interruptedRec?.lastAssistantAt || 0))

	const resumedRec = synth("11111111-aaaa-bbbb-cccc-000000000005", [
		line({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, timestamp: "2026-07-30T10:00:20.000Z", cwd: "/tmp/p" }),
		line({ type: "user", message: { role: "user", content: [{ type: "text", text: "carry on then" }] }, timestamp: "2026-07-30T10:01:00.000Z" })
	])
	check("a later prompt clears the interrupt", resumedRec?.interrupted === false && (resumedRec?.lastUserTurnAt || 0) > 0)

	finish(warmMonitor)
}

/* Sorting is by recency, but waiting rows are pinned above the rest. */
function sortedWithinPins(rows: PanelData["rows"]): boolean {
	const waiting = rows.filter((row) => row.state === "needs-input" || row.state === "needs-input?")
	const rest = rows.filter((row) => !(row.state === "needs-input" || row.state === "needs-input?"))
	const descending = (list: PanelData["rows"]) => list.every((row, i) => i === 0 || list[i - 1].lastActivity >= row.lastActivity)
	return rows.slice(0, waiting.length).every((row) => row.state.startsWith("needs-input")) && descending(waiting) && descending(rest)
}

function finish(monitor: Monitor): void {
	monitor.dispose()
	fs.rmSync(storeDir, { recursive: true, force: true })
	console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`)
	process.exit(failures === 0 ? 0 : 1)
}

void main()
