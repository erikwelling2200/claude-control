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

const canonicalCache = new Map<string, string>()

/* The identity of a folder, so two spellings of one directory compare equal. On Windows that is the whole
   problem: a session started from the terminal records C:\x, one started by the IDE records c:\x, and
   plain realpathSync hands back whatever case it was given. realpathSync.native asks the filesystem for
   the real name instead, which is the same string for every spelling. Cached because this runs per row on
   every rebuild, and it is a syscall. */
export function canonical(p: string): string {
	if (!p) return ""
	const hit = canonicalCache.get(p)
	if (hit) return hit
	let resolved = p
	try { resolved = fs.realpathSync.native(p) } catch {
		try { resolved = fs.realpathSync(p) } catch { /* path may be gone; compare the literal */ }
	}
	const result = resolved.normalize("NFC").replace(/[/\\]+$/, "")
	/* A path that does not exist yet resolves to itself — not something to remember, since it may appear. */
	if (resolved !== p) canonicalCache.set(p, result)
	return result
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
	const candidates = [findBundledExecutable(), ...executableNames("claude").map((name) => path.join(claudeRoot(), "local", name)), ...pathCandidates()]
	cachedExecutable = candidates.find((candidate) => candidate && isExecutableFile(candidate)) || ""
	return cachedExecutable
}

function pathCandidates(): string[] {
	return (process.env.PATH || "").split(path.delimiter).filter(Boolean).flatMap((dir) => executableNames("claude").map((name) => path.join(dir, name)))
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
			for (const name of executableNames("claude")) {
				const candidate = path.join(extRoot, entry, "resources", "native-binary", name)
				if (isExecutableFile(candidate)) { found.push(candidate); break }
			}
		}
	}
	found.sort()
	return found.length ? found[found.length - 1] : ""
}

function isExecutableFile(p: string): boolean {
	try {
		const stat = fs.statSync(p)		// statSync follows symlinks, so a dangling shim is rejected here
		if (!stat.isFile()) return false
		if (process.platform === "win32") return true		// NTFS carries no execute bit, so every file would be rejected
		return (stat.mode & 0o111) !== 0
	} catch { return false }
}

/* Windows launchers carry an extension; .exe first because execFile() cannot run a .cmd without a shell. */
function executableNames(base: string): string[] {
	return process.platform === "win32" ? [base + ".exe", base, base + ".cmd", base + ".bat"] : [base]
}
