import { execFile } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { findClaudeExecutable, sessionsDir } from "./paths"
import type { LiveSession } from "./types"

// --- PROCESS LIVENESS ---

/* Field 22 of /proc/<pid>/stat (starttime). The comm field can contain spaces and parens, so slice after the last ')'. */
export function readProcStart(pid: number): string {
	let stat: string
	try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8") } catch { return "" }
	const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)
	return tail[19] || ""		// fields 3..N land at index 0, so starttime (22) is index 19
}

/* True when the pid is running AND is the same process that registered — guards against pid reuse. This mirrors Claude's own check. */
export function isAlive(pid: number, procStart: string): boolean {
	if (!pid || pid < 1) return false
	if (process.platform !== "linux") {
		try { process.kill(pid, 0); return true } catch { return false }
	}
	if (!fs.existsSync(`/proc/${pid}`)) return false
	if (!procStart) return true		// nothing to compare against; presence is all we have
	return readProcStart(pid) === procStart
}

// --- FAST PATH: THE ON-DISK REGISTRY ---

/* Read ~/.claude/sessions/*.json and keep only entries whose process is genuinely still alive. */
export function readRegistry(): Map<string, LiveSession> {
	const out = new Map<string, LiveSession>()
	let files: string[]
	try { files = fs.readdirSync(sessionsDir()) } catch { return out }
	for (const file of files) {
		if (!file.endsWith(".json")) continue
		let raw: any
		try { raw = JSON.parse(fs.readFileSync(path.join(sessionsDir(), file), "utf8")) } catch { continue }
		if (!raw || typeof raw.sessionId !== "string" || typeof raw.pid !== "number") continue
		if (!isAlive(raw.pid, String(raw.procStart || ""))) continue		// stale file from a crashed process
		const session: LiveSession = {
			pid: raw.pid,
			sessionId: raw.sessionId,
			cwd: String(raw.cwd || ""),
			startedAt: Number(raw.startedAt || 0),
			name: String(raw.name || ""),
			kind: String(raw.kind || ""),
			procStart: String(raw.procStart || "")
		}
		const existing = out.get(session.sessionId)
		if (!existing || session.startedAt > existing.startedAt) out.set(session.sessionId, session)		// same session can be served by several pids
	}
	return out
}

// --- INDEPENDENT PATH: THE PROCESS TABLE ---

/* Read session ids straight out of the running processes' argv. This depends on none of Claude's bookkeeping, so it still sees a session whose registry file was never written or was cleaned up — the case that makes a resumed conversation look closed. Costs ~6ms for a full /proc walk. */
export function readProcesses(): Map<string, LiveSession> {
	const out = new Map<string, LiveSession>()
	if (process.platform !== "linux") return out
	let entries: string[]
	try { entries = fs.readdirSync("/proc") } catch { return out }
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue
		let raw: string
		try { raw = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8") } catch { continue }		// process exited mid-walk
		if (!raw.includes("claude")) continue
		const argv = raw.split("\0")
		if (!argv.some((arg) => arg === "claude" || arg.endsWith("/claude"))) continue		// skip anything merely mentioning claude in a path
		const sessionId = sessionIdFromArgv(argv)
		if (!sessionId) continue		// a fresh session carries no id in argv; the registry covers those
		const pid = Number(entry)
		out.set(sessionId, { pid, sessionId, cwd: cwdOf(pid), startedAt: 0, name: "", kind: "interactive", procStart: readProcStart(pid) })
	}
	return out
}

function sessionIdFromArgv(argv: string[]): string {
	for (let i = 0; i < argv.length; i++) {
		const inline = /^--(?:resume|session-id)=(.+)$/.exec(argv[i])
		if (inline) return inline[1]
		if ((argv[i] === "--resume" || argv[i] === "--session-id") && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1]
	}
	return ""
}

function cwdOf(pid: number): string {
	try { return fs.readlinkSync(`/proc/${pid}/cwd`) } catch { return "" }
}

// --- AUTHORITATIVE PATH: THE SUPPORTED CLI ---

/* `claude agents --json` is documented for scripting and does its own liveness filtering. Costs ~0.7s, so callers use it periodically, not per tick. */
export function readAgents(claudePath: string, cwd: string): Promise<Map<string, LiveSession> | undefined> {
	const executable = findClaudeExecutable(claudePath)
	if (!executable) return Promise.resolve(undefined)
	return new Promise((resolve) => {
		execFile(executable, ["agents", "--json"], { cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			if (err && !stdout) return resolve(undefined)
			let parsed: any
			try { parsed = JSON.parse(stdout) } catch { return resolve(undefined) }
			if (!Array.isArray(parsed)) return resolve(undefined)
			const out = new Map<string, LiveSession>()
			for (const raw of parsed) {
				if (!raw || typeof raw.sessionId !== "string") continue
				const session: LiveSession = {
					pid: Number(raw.pid || 0),
					sessionId: raw.sessionId,
					cwd: String(raw.cwd || ""),
					startedAt: Number(raw.startedAt || 0),
					name: String(raw.name || ""),
					kind: String(raw.kind || ""),
					procStart: ""
				}
				const existing = out.get(session.sessionId)
				if (!existing || session.startedAt > existing.startedAt) out.set(session.sessionId, session)
			}
			resolve(out)
		})
	})
}
