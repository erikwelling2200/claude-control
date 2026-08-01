import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// --- CLAUDE LOCATIONS ---

/* Root of Claude Code's config, honouring CLAUDE_CONFIG_DIR. */
export function claudeRoot(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
}

export function projectsDir(): string { return path.join(claudeRoot(), "projects") }
export function sessionsDir(): string { return path.join(claudeRoot(), "sessions") }
export function backupsDir(): string { return path.join(claudeRoot(), "backups") }
export function settingsFile(): string { return path.join(claudeRoot(), "settings.json") }

/* Where hook invocations spool their raw stdin for the extension to drain. Overridable so tests do not race a live extension reading the real directory. */
export function spoolDir(): string {
	return process.env.CLAUDE_MONITOR_SPOOL_DIR || path.join(claudeRoot(), "claude-monitor", "events")
}

/* Claude writes its remote-control bridge state here, with a 4h TTL. */
export function bridgePointerFile(cwd: string): string {
	return path.join(projectsDir(), slugify(cwd), "bridge-pointer.json")
}

export const BRIDGE_POINTER_TTL_MS = 14400000

// --- PATH IDENTITY ---

/* Claude's project-directory slug: every non-alphanumeric byte becomes a dash. Forward direction only — it is lossy and never reversed. */
export function slugify(dir: string): string {
	return dir.replace(/[^a-zA-Z0-9]/g, "-")
}

/* Canonical form for comparing two paths that may differ by symlink or unicode composition. */
export function canonical(p: string): string {
	if (!p) return ""
	let resolved = p
	try { resolved = fs.realpathSync(p) } catch { /* path may be gone; compare the literal */ }
	return resolved.normalize("NFC").replace(/[/\\]+$/, "")
}

export function samePath(a: string, b: string): boolean { return canonical(a) === canonical(b) }

/* Display name for a project directory. */
export function projectName(cwd: string): string {
	return path.basename(cwd) || cwd
}

// --- CLAUDE EXECUTABLE ---

let cachedExecutable: string | undefined

/* Locate the claude binary. The IDE-bundled copy is preferred because it is the exact build already running these sessions; a `claude` shim on PATH is commonly stale or broken (claude doctor reports as much). */
export function findClaudeExecutable(override?: string): string {
	if (override && isExecutableFile(override)) return override
	if (cachedExecutable !== undefined) return cachedExecutable
	const candidates = [findBundledExecutable(), path.join(claudeRoot(), "local", "claude"), ...pathCandidates()]
	cachedExecutable = candidates.find((candidate) => candidate && isExecutableFile(candidate)) || ""
	return cachedExecutable
}

function pathCandidates(): string[] {
	return (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "claude"))
}

/* Newest native-binary copy shipped inside an installed Claude Code IDE extension. */
function findBundledExecutable(): string {
	const home = os.homedir()
	const roots = [".antigravity-ide", ".vscode", ".vscode-server", ".vscode-insiders", ".cursor", ".windsurf"]
	const found: string[] = []
	for (const root of roots) {
		const extRoot = path.join(home, root, "extensions")
		let entries: string[]
		try { entries = fs.readdirSync(extRoot) } catch { continue }
		for (const entry of entries) {
			if (!entry.startsWith("anthropic.claude-code-")) continue
			const candidate = path.join(extRoot, entry, "resources", "native-binary", "claude")
			if (isExecutableFile(candidate)) found.push(candidate)
		}
	}
	found.sort()
	return found.length ? found[found.length - 1] : ""
}

function isExecutableFile(p: string): boolean {
	try {
		const stat = fs.statSync(p)		// statSync follows symlinks, so a dangling shim is rejected here
		return stat.isFile() && (stat.mode & 0o111) !== 0
	} catch { return false }
}
