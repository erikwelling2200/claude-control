import * as os from "os"
import * as path from "path"
import { readAgents, readRegistry } from "../src/live"
import { claudeRoot, findClaudeExecutable, projectsDir } from "../src/paths"
import { activityLabel, HookSignals, resolveState } from "../src/status"
import { listTranscripts, scanAll } from "../src/watcher"
import type { TranscriptRecord } from "../src/types"

// --- CONFIG ---

const TAIL_BYTES = 131072
const STALE_TOOL_SECONDS = 90

// --- REPORT ---

/* Exercise the real data layer against the live ~/.claude and print what the panel would show. */
async function main(): Promise<void> {
	console.log(`root        ${claudeRoot()}`)
	console.log(`projects    ${projectsDir()}`)
	console.log(`executable  ${findClaudeExecutable("") || "(not found)"}`)
	console.log(`transcripts ${listTranscripts().length}`)

	const coldStart = performance.now()
	const cold = scanAll(TAIL_BYTES)
	const coldMs = performance.now() - coldStart

	const cache = new Map<string, TranscriptRecord>(cold.records.map((record) => [record.file, record]))
	const warmStart = performance.now()
	const warm = scanAll(TAIL_BYTES, cache)
	const warmMs = performance.now() - warmStart

	const registryStart = performance.now()
	const registry = readRegistry()
	const registryMs = performance.now() - registryStart

	const agentsStart = performance.now()
	const agents = await readAgents("", os.homedir())
	const agentsMs = performance.now() - agentsStart

	console.log("")
	console.log(`cold scan   ${coldMs.toFixed(0)}ms   (${cold.scanned} read, ${cold.reused} reused)`)
	console.log(`warm scan   ${warmMs.toFixed(0)}ms   (${warm.scanned} read, ${warm.reused} reused)`)
	console.log(`registry    ${registryMs.toFixed(0)}ms   (${registry.size} live)`)
	console.log(`agents CLI  ${agentsMs.toFixed(0)}ms   (${agents ? `${agents.size} live` : "unavailable"})`)

	// --- LIVENESS AGREEMENT ---

	if (agents) {
		const onlyRegistry = [...registry.keys()].filter((id) => !agents.has(id))
		const onlyAgents = [...agents.keys()].filter((id) => !registry.has(id))
		console.log(`agreement   ${onlyRegistry.length === 0 && onlyAgents.length === 0 ? "exact" : "DIFFERS"}`)
		for (const id of onlyRegistry) console.log(`  registry-only ${id}`)
		for (const id of onlyAgents) console.log(`  agents-only   ${id}`)
	}

	// --- ROWS ---

	const signals = new HookSignals()
	signals.drain()
	console.log(`\nhook signals ${signals.size}\n`)

	const now = Date.now()
	const rows = cold.records.map((record) => {
		const state = resolveState({
			record,
			live: registry.get(record.sessionId),
			signal: signals.get(record.sessionId),
			preciseStatus: false,
			staleToolSeconds: STALE_TOOL_SECONDS,
			now
		})
		return { record, state, label: activityLabel(state, record) }
	}).sort((a, b) => b.record.lastActivity - a.record.lastActivity)

	console.log(pad("STATE", 13) + pad("AGE", 8) + pad("PROJECT", 20) + pad("SRC", 5) + "TITLE")
	console.log("-".repeat(110))
	for (const row of rows) {
		console.log(
			pad(row.state, 13) +
			pad(age(now - row.record.lastActivity), 8) +
			pad(row.record.projectName || "(unknown)", 20) +
			pad(row.record.titleSource, 5) +
			row.record.title
		)
		if (row.record.lastPrompt) console.log(`${" ".repeat(46)}${dim(clip(row.record.lastPrompt, 60))}`)
	}

	// --- TALLY ---

	const tally = new Map<string, number>()
	for (const row of rows) tally.set(row.state, (tally.get(row.state) || 0) + 1)
	console.log("")
	for (const [state, count] of [...tally].sort()) console.log(`${pad(state, 14)}${count}`)

	const missing = rows.filter((row) => !row.record.cwd)
	if (missing.length) console.log(`\nWARNING ${missing.length} transcript(s) yielded no cwd: ${missing.map((row) => path.basename(row.record.file)).join(", ")}`)
}

// --- FORMAT ---

function pad(text: string, width: number): string { return text.length >= width ? `${text.slice(0, width - 1)} ` : text + " ".repeat(width - text.length) }

function clip(text: string, max: number): string { return text.length > max ? `${text.slice(0, max - 1)}…` : text }

function dim(text: string): string { return `[2m${text}[0m` }

function age(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
	return `${Math.round(seconds / 86400)}d`
}

void main()
