import * as fs from "fs"
import { isAlive } from "./live"
import { BRIDGE_POINTER_TTL_MS, bridgePointerFile } from "./paths"

// --- BRIDGE STATE ---

/* Shape written by `claude remote-control`, taken from the binary's own schema. pid and procStart are optional. */
interface BridgePointer {
	sessionId?: string
	environmentId?: string
	source?: string
	pid?: number
	procStart?: string
}

export interface BridgeInfo {
	running: boolean
	environmentId: string
	sessionId: string		// which conversation owns the bridge — "repl" bridges name the session that ran /remote-control
	source: string		// "repl" (started inside a conversation) or "standalone" (a directory-scoped server)
	pid: number
	ageMs: number
}

const EMPTY: BridgeInfo = { running: false, environmentId: "", sessionId: "", source: "", pid: 0, ageMs: 0 }

/* Read the bridge pointer for a directory. Claude treats the file's own mtime as the freshness signal with a 4h TTL, so we do the same. Kept free of vscode imports so the panel can report per-row remote state. */
export function readBridge(cwd: string): BridgeInfo {
	if (!cwd) return EMPTY
	const file = bridgePointerFile(cwd)
	let pointer: BridgePointer
	let ageMs = 0
	try {
		ageMs = Math.max(0, Date.now() - fs.statSync(file).mtimeMs)
		pointer = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch { return EMPTY }
	if (ageMs > BRIDGE_POINTER_TTL_MS) return EMPTY		// Claude itself clears pointers older than this
	if (!pointer || typeof pointer.environmentId !== "string") return EMPTY
	if (pointer.pid && !isAlive(pointer.pid, String(pointer.procStart || ""))) return EMPTY		// pointer outlived its server
	return {
		running: true,
		environmentId: pointer.environmentId,
		sessionId: String(pointer.sessionId || ""),
		source: String(pointer.source || ""),
		pid: Number(pointer.pid || 0),
		ageMs
	}
}

/* Every folder with a live bridge, mapped to the conversation that owns it. Lets a row light up only when the bridge is actually its own. */
export function bridgesByCwd(cwds: Iterable<string>): Map<string, BridgeInfo> {
	const out = new Map<string, BridgeInfo>()
	for (const cwd of cwds) {
		if (out.has(cwd)) continue
		const bridge = readBridge(cwd)
		if (bridge.running) out.set(cwd, bridge)
	}
	return out
}
