import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// --- SANDBOX ---

/* Run the whole hook lifecycle against a throwaway CLAUDE_CONFIG_DIR so the real settings are never touched. Set before anything reads it — claudeRoot() resolves the env var lazily on each call, so static imports below are safe. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-hooktest-"))
process.env.CLAUDE_CONFIG_DIR = sandbox

/* eslint-disable import/first */
import { HOOK_EVENTS, hookCommand, hooksInstalled, hooksOutdated, installHooks, uninstallHooks } from "../src/hooks"
import { settingsFile, spoolDir } from "../src/paths"
import { HookSignals } from "../src/status"
import { configFile, trustFolder, trustState } from "../src/trust"

const ORIGINAL = `{
  "model": "opus[1m]",
  "effortLevel": "xhigh",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo pre-existing-user-hook"
          }
        ]
      }
    ]
  }
}
`

let failures = 0

function check(label: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? `  — ${detail}` : ""}`)
	if (!ok) failures++
}

async function main(): Promise<void> {
	fs.writeFileSync(settingsFile(), ORIGINAL)
	console.log(`sandbox ${sandbox}\n`)

	// --- INSTALL ---

	check("not installed initially", !hooksInstalled())
	const install = installHooks()
	check("install reports ok", install.ok, install.error)
	check("backup was written", !!install.backup && fs.existsSync(install.backup))
	check("backup matches the original bytes", fs.readFileSync(install.backup, "utf8") === ORIGINAL)
	check("hooksInstalled now true", hooksInstalled())

	/* Entries of ours under one event, identified the same way uninstall identifies them. */
	const ours = (entries: any[]) => (entries || []).filter((entry) => entry?.hooks?.some((hook: any) => String(hook?.command || "").includes(spoolDir())))

	const after = JSON.parse(fs.readFileSync(settingsFile(), "utf8"))
	check("model preserved", after.model === "opus[1m]")
	check("effortLevel preserved", after.effortLevel === "xhigh")
	check("pre-existing PreToolUse hook preserved", JSON.stringify(after.hooks.PreToolUse?.[0]?.hooks?.[0]?.command) === `"echo pre-existing-user-hook"`)
	check(`exactly ${HOOK_EVENTS.length} events registered`, HOOK_EVENTS.every((event) => ours(after.hooks[event]).length === 1), Object.keys(after.hooks).join(","))
	check("ours merged next to the user's PreToolUse entry", after.hooks.PreToolUse.length === 2)

	// --- IDEMPOTENCE ---

	installHooks()
	const twice = JSON.parse(fs.readFileSync(settingsFile(), "utf8"))
	check("second install does not duplicate entries", HOOK_EVENTS.every((event) => ours(twice.hooks[event]).length === 1))

	// --- THE COMMAND ACTUALLY WORKS ---

	fs.rmSync(spoolDir(), { recursive: true, force: true })
	const payload = JSON.stringify({ session_id: "test-session-1", hook_event_name: "PermissionRequest", tool_name: "Bash", cwd: sandbox })
	execFileSync("bash", ["-c", hookCommand()], { input: payload })
	const spooled = fs.readdirSync(spoolDir())
	check("hook command spooled one file", spooled.length === 1, spooled.join(","))
	check("spooled payload round-trips", spooled.length === 1 && fs.readFileSync(path.join(spoolDir(), spooled[0]), "utf8") === payload)

	const signals = new HookSignals()
	const touched = signals.drain()
	check("drain reported the session", touched.has("test-session-1"))
	check("signal maps to needs-input", signals.get("test-session-1")?.state === "needs-input")
	check("spool file kept during the grace window (another window may still need it)", fs.readdirSync(spoolDir()).length === 1)
	check("re-draining does not re-report an already-read file", signals.drain().size === 0)

	const backdated = new Date(Date.now() - 120000)
	fs.utimesSync(path.join(spoolDir(), spooled[0]), backdated, backdated)
	signals.drain()
	check("spool file removed once past the grace window", fs.readdirSync(spoolDir()).length === 0)

	// --- PRETOOLUSE CARRIES THE LIVE PERMISSION MODE ---

	execFileSync("bash", ["-c", hookCommand()], { input: JSON.stringify({ session_id: "test-session-2", hook_event_name: "PreToolUse", tool_name: "Edit", permission_mode: "acceptEdits" }) })
	signals.drain()
	check("PreToolUse maps to busy", signals.get("test-session-2")?.state === "busy")
	check("PreToolUse carries permission_mode", signals.get("test-session-2")?.permissionMode === "acceptEdits")

	// --- AN OLDER INSTALL IS DETECTED AS OUTDATED ---

	check("full install is not outdated", !hooksOutdated())
	const trimmed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"))
	delete trimmed.hooks[HOOK_EVENTS[HOOK_EVENTS.length - 1]]		// simulate an install made before this event existed
	fs.writeFileSync(settingsFile(), JSON.stringify(trimmed, null, 2))
	check("missing event reads as outdated, not uninstalled", hooksOutdated() && !hooksInstalled())
	installHooks()
	check("reinstall tops the missing event up", hooksInstalled() && !hooksOutdated())

	// --- THE COMMAND SURVIVES A PATH WITH SPACES ---

	check("spool path is quoted in the command", hookCommand().includes(`'${spoolDir()}'`))
	check("filename substitutions stay unquoted", /\$\$-\$\(date \+%s\)-\$RANDOM\.json$/.test(hookCommand()))

	// --- UNINSTALL ---

	const uninstall = uninstallHooks()
	check("uninstall reports ok", uninstall.ok, uninstall.error)
	check("hooksInstalled now false", !hooksInstalled())
	const restored = fs.readFileSync(settingsFile(), "utf8")
	check("settings restored byte-identical to the original", restored === ORIGINAL, restored === ORIGINAL ? "" : `\n--- got ---\n${restored}`)

	// --- REFUSES TO CLOBBER BROKEN JSON ---

	fs.writeFileSync(settingsFile(), "{ this is not json")
	const refused = installHooks()
	check("install refuses malformed settings", !refused.ok, refused.error)
	check("malformed settings left untouched", fs.readFileSync(settingsFile(), "utf8") === "{ this is not json")

	// --- WORKSPACE TRUST ---

	const CONFIG = `{
  "userID": "keep-me",
  "firstStartTime": "2026-01-01T00:00:00.000Z",
  "projects": {
    "/some/other/place": {
      "hasTrustDialogAccepted": true,
      "allowedTools": ["Bash"]
    }
  }
}
`
	/* Refuse to run if the config path ever escapes the sandbox — this test writes deliberately broken JSON, and must never aim that at a real file. */
	if (!configFile().startsWith(sandbox)) {
		console.log(`FAIL  config path escaped the sandbox: ${configFile()}`)
		process.exit(1)
	}
	fs.writeFileSync(configFile(), CONFIG)
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-repo-"))
	const nested = path.join(repo, "packages", "api")
	fs.mkdirSync(nested, { recursive: true })

	console.log("")
	check("an untrusted folder reads as untrusted", trustState(repo) === "untrusted", trustState(repo))
	const trust = trustFolder(repo, path.join(sandbox, "backups"))
	check("trustFolder reports ok", trust.ok, trust.error)
	check("config backed up before writing", !!trust.backup && fs.readFileSync(trust.backup, "utf8") === CONFIG)
	check("folder now reads as trusted", trustState(repo) === "trusted", trustState(repo))
	check("a subdirectory inherits trust from its parent", trustState(nested) === "trusted", trustState(nested))

	const written = JSON.parse(fs.readFileSync(configFile(), "utf8"))
	check("unrelated top-level keys preserved", written.userID === "keep-me" && !!written.firstStartTime)
	check("unrelated project entries preserved", written.projects["/some/other/place"]?.hasTrustDialogAccepted === true && Array.isArray(written.projects["/some/other/place"].allowedTools))
	check("only the trust flag was added to our entry", JSON.stringify(Object.keys(written.projects[repo] || {})) === `["hasTrustDialogAccepted"]`, JSON.stringify(written.projects[repo]))

	fs.writeFileSync(configFile(), "{ broken")
	const refusedTrust = trustFolder(repo, path.join(sandbox, "backups"))
	check("trustFolder refuses malformed config", !refusedTrust.ok, refusedTrust.error)
	check("malformed config left untouched", fs.readFileSync(configFile(), "utf8") === "{ broken")
	fs.rmSync(repo, { recursive: true, force: true })

	console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`)
	fs.rmSync(sandbox, { recursive: true, force: true })
	process.exit(failures === 0 ? 0 : 1)
}

void main()
