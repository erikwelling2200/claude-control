import * as fs from "fs"
import * as path from "path"
import { backupsDir, settingsFile, spoolDir } from "./paths"

// --- WHAT WE REGISTER ---

/* Six of these fire at most once per turn. PreToolUse fires per tool call and is hooked anyway — its payload carries the live permission_mode, which the transcript records nowhere mid-run, so it is the only way a mid-run Shift+Tab shows up before the turn ends. The spooled `cat` is far too cheap to slow a tool call, and PostToolUse would add nothing it does not already give us. */
export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Elicitation", "Notification", "Stop", "SessionEnd"] as const

/* The hook does no parsing: it spools raw stdin for the extension to read. One file per event avoids interleaved appends, and `cat` cannot meaningfully slow or fail a turn. */
export function hookCommand(): string {
	const dir = quote(spoolDir())
	return `mkdir -p ${dir} && cat > ${dir}/$$-$(date +%s)-$RANDOM.json`		// dir is quoted, the filename is not, so $$ and $RANDOM still expand
}

/* Our entries are identified by the spool path inside the command, so uninstall never has to guess and no non-standard keys are added to the hook object. */
function isOurs(entry: any): boolean {
	if (!entry || !Array.isArray(entry.hooks)) return false
	return entry.hooks.some((hook: any) => typeof hook?.command === "string" && hook.command.includes(spoolDir()))
}

export interface HookResult {
	ok: boolean
	backup: string
	error: string
}

// --- INSTALL / UNINSTALL ---

/* True when every event we need is already registered. */
export function hooksInstalled(): boolean {
	const settings = readSettings()
	if (!settings.ok) return false
	const hooks = settings.value?.hooks
	if (!hooks) return false
	return HOOK_EVENTS.every((event) => Array.isArray(hooks[event]) && hooks[event].some(isOurs))
}

/* True when some of our entries exist but not all — an install from a version with fewer events. The user consented to that install, so topping it up needs no new prompt. */
export function hooksOutdated(): boolean {
	const settings = readSettings()
	if (!settings.ok) return false
	const hooks = settings.value?.hooks
	if (!hooks) return false
	const present = HOOK_EVENTS.filter((event) => Array.isArray(hooks[event]) && hooks[event].some(isOurs)).length
	return present > 0 && present < HOOK_EVENTS.length
}

/* Add our entries, leaving every other setting and any pre-existing hooks untouched. */
export function installHooks(): HookResult {
	const settings = readSettings()
	if (!settings.ok) return { ok: false, backup: "", error: settings.error }
	const value = settings.value || {}
	const backup = backupSettings()
	if (!value.hooks || typeof value.hooks !== "object") value.hooks = {}
	for (const event of HOOK_EVENTS) {
		if (!Array.isArray(value.hooks[event])) value.hooks[event] = []
		value.hooks[event] = value.hooks[event].filter((entry: any) => !isOurs(entry))		// replace ours so a changed command path cannot double up
		value.hooks[event].push({ hooks: [{ type: "command", command: hookCommand() }] })
	}
	try { fs.mkdirSync(spoolDir(), { recursive: true }) } catch { /* created again at activation */ }
	const written = writeSettings(value)
	return { ok: written === "", backup, error: written }
}

/* Remove exactly our entries and any containers they leave empty. */
export function uninstallHooks(): HookResult {
	const settings = readSettings()
	if (!settings.ok) return { ok: false, backup: "", error: settings.error }
	const value = settings.value
	if (!value?.hooks) return { ok: true, backup: "", error: "" }
	const backup = backupSettings()
	for (const event of Object.keys(value.hooks)) {
		if (!Array.isArray(value.hooks[event])) continue
		value.hooks[event] = value.hooks[event].filter((entry: any) => !isOurs(entry))
		if (value.hooks[event].length === 0) delete value.hooks[event]
	}
	if (Object.keys(value.hooks).length === 0) delete value.hooks
	const written = writeSettings(value)
	return { ok: written === "", backup, error: written }
}

// --- SETTINGS FILE IO ---

interface ReadResult { ok: boolean, value: any, error: string }

/* A missing file is fine. Malformed JSON is not — we refuse rather than risk clobbering hand-written settings. */
function readSettings(): ReadResult {
	const file = settingsFile()
	if (!fs.existsSync(file)) return { ok: true, value: {}, error: "" }
	let text: string
	try { text = fs.readFileSync(file, "utf8") } catch (err) { return { ok: false, value: undefined, error: `Could not read ${file}: ${String(err)}` } }
	if (!text.trim()) return { ok: true, value: {}, error: "" }
	try { return { ok: true, value: JSON.parse(text), error: "" } }
	catch { return { ok: false, value: undefined, error: `${file} is not valid JSON — fix it by hand and try again.` } }
}

/* Temp file plus rename, so an interrupted write can never leave settings truncated. Returns "" on success. */
function writeSettings(value: any): string {
	const file = settingsFile()
	const temp = `${file}.claude-monitor.tmp`
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
		fs.renameSync(temp, file)
		return ""
	} catch (err) {
		try { fs.unlinkSync(temp) } catch { /* nothing to clean */ }
		return `Could not write ${file}: ${String(err)}`
	}
}

/* Copy the current settings into Claude's own backups directory before changing them. */
function backupSettings(): string {
	const source = settingsFile()
	if (!fs.existsSync(source)) return ""
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	const target = path.join(backupsDir(), `settings.json.claude-monitor-${stamp}`)
	try {
		fs.mkdirSync(backupsDir(), { recursive: true })
		fs.copyFileSync(source, target)
		return target
	} catch { return "" }
}

/* Single-quote for POSIX shells, which is what the hook runner uses on this platform. */
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }
