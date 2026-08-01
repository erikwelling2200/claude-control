import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { canonical } from "./paths"

// --- WORKSPACE TRUST ---

/* Claude records per-folder trust as projects[<dir>].hasTrustDialogAccepted in its config file. Sessions launched by the IDE extension never write it, so a standalone `claude remote-control` in the same folder can still be refused.
   By default this lives beside the config directory as ~/.claude.json, but when CLAUDE_CONFIG_DIR is set it moves inside it — and must NOT fall back to the home copy, or a redirected config (a test sandbox, for instance) would read and write the real user file. */
export function configFile(): string {
	if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
	return path.join(os.homedir(), ".claude.json")
}

export type TrustState = "trusted" | "untrusted" | "home"

/* Home directories are a special case: the binary states trust is never saved for them, so Remote Control can never be started there. */
export function trustState(cwd: string): TrustState {
	if (!cwd) return "untrusted"
	if (canonical(cwd) === canonical(os.homedir())) return "home"
	let config: any
	try { config = JSON.parse(fs.readFileSync(configFile(), "utf8")) } catch { return "untrusted" }
	const projects = config?.projects
	if (!projects || typeof projects !== "object") return "untrusted"
	const trusted = new Set<string>()
	for (const [dir, entry] of Object.entries<any>(projects)) {
		if (entry?.hasTrustDialogAccepted) trusted.add(canonical(dir))
	}
	for (const dir of ancestors(cwd)) {
		if (trusted.has(dir)) return "trusted"		// Claude climbs parents too, so trusting a repo root covers its subdirectories
	}
	return "untrusted"
}

/* The directory and every parent above it, canonicalised. */
function ancestors(cwd: string): string[] {
	const chain: string[] = []
	let current = canonical(cwd)
	while (current && !chain.includes(current)) {
		chain.push(current)
		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}
	return chain
}

// --- GRANTING TRUST ---

export interface TrustResult { ok: boolean, backup: string, error: string }

/* Claude's own error message offers this as the alternative to the interactive dialog: set projects[dir].hasTrustDialogAccepted. Only ever called on an explicit request for one named folder, and the rest of the config is preserved byte-for-byte apart from that key. */
export function trustFolder(cwd: string, backupsTo: string): TrustResult {
	const file = configFile()
	let config: any
	let text = ""
	try { text = fs.readFileSync(file, "utf8") } catch (err) { return { ok: false, backup: "", error: `Could not read ${file}: ${String(err)}` } }
	try { config = JSON.parse(text) } catch { return { ok: false, backup: "", error: `${file} is not valid JSON — fix it by hand and try again.` } }
	const backup = writeBackup(file, text, backupsTo)
	if (!config.projects || typeof config.projects !== "object") config.projects = {}
	for (const key of new Set([cwd, canonical(cwd)])) {		// the binary keys on its own cwd, which may or may not be the symlink-resolved form
		if (!config.projects[key] || typeof config.projects[key] !== "object") config.projects[key] = {}
		config.projects[key].hasTrustDialogAccepted = true
	}
	const temp = `${file}.claude-monitor.tmp`
	try {
		fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`)
		fs.renameSync(temp, file)
		return { ok: true, backup, error: "" }
	} catch (err) {
		try { fs.unlinkSync(temp) } catch { /* nothing to clean */ }
		return { ok: false, backup, error: `Could not write ${file}: ${String(err)}` }
	}
}

function writeBackup(file: string, text: string, backupsTo: string): string {
	const target = path.join(backupsTo, `claude.json.claude-monitor-${new Date().toISOString().replace(/[:.]/g, "-")}`)
	try {
		fs.mkdirSync(backupsTo, { recursive: true })
		fs.writeFileSync(target, text)
		return target
	} catch { return "" }
}
