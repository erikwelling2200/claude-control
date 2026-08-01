import * as path from "path"
import * as vscode from "vscode"
import { readBridge, type BridgeInfo } from "./bridge"
import { backupsDir, findClaudeExecutable, projectName } from "./paths"
import { trustFolder, trustState } from "./trust"

export type RemoteState = "off" | "on" | "unavailable"

// --- CONTROLLER ---

const START_TIMEOUT_MS = 45000
const POLL_MS = 1500

/* Starts and stops Claude's Remote Control bridge for one directory at a time, and reports which state the title-bar icon should show. */
export class RemoteControl {
	private terminals = new Map<string, vscode.Terminal>()
	private unavailable = new Map<string, string>()
	private cwd = ""

	constructor(private readonly onChange: () => void) {}

	/* Which directory the toggle acts on — follows the panel's project filter. */
	setTarget(cwd: string): void {
		if (cwd === this.cwd) return
		this.cwd = cwd
		this.onChange()
	}

	target(): string { return this.cwd }

	state(): RemoteState {
		if (!this.cwd) return "off"
		if (readBridge(this.cwd).running) return "on"
		return this.unavailable.has(this.cwd) ? "unavailable" : "off"
	}

	reason(): string { return this.unavailable.get(this.cwd) || "" }

	info(): BridgeInfo { return readBridge(this.cwd) }

	/* Launch the bridge in a visible terminal: it is long-lived, prints the URL needed on the phone, may require an interactive login or trust prompt, and takes runtime keys. */
	async start(): Promise<void> {
		const cwd = this.cwd
		if (!cwd) return void vscode.window.showWarningMessage("Claude Control: pick a project in the panel first.")
		if (readBridge(cwd).running) return void vscode.window.showInformationMessage(`Remote Control is already serving ${projectName(cwd)}.`)
		const executable = findClaudeExecutable(vscode.workspace.getConfiguration("claudeMonitor").get<string>("claudePath", ""))
		if (!executable) return void vscode.window.showErrorMessage("Claude Control: could not find the claude executable. Set claudeMonitor.claudePath.")
		if (!(await this.ensureTrusted(cwd, executable))) return
		const confirmed = await vscode.window.showInformationMessage(
			`Expose ${projectName(cwd)} to claude.ai/code and the Claude mobile app?`,
			{ modal: true, detail: "Runs `claude remote-control` in a terminal for this folder. Sessions there become drivable from your phone. Needs a Claude subscription, and the folder must already be trusted." },
			"Enable"
		)
		if (confirmed !== "Enable") return
		this.unavailable.delete(cwd)
		const terminal = vscode.window.createTerminal({ name: `Remote Control · ${projectName(cwd)}`, cwd, iconPath: new vscode.ThemeIcon("broadcast") })
		this.terminals.set(cwd, terminal)
		terminal.show(true)
		terminal.sendText(`${shellQuote(executable)} remote-control --name ${shellQuote(projectName(cwd))}`)
		this.onChange()
		void this.awaitBridge(cwd, terminal)
	}

	/* Remote Control runs as a standalone `claude`, which needs the one-time workspace trust dialog. Sessions launched by the IDE never record that, so check before spending a terminal on a guaranteed failure. Trust is deliberately not written on the user's behalf — it is a security control, and accepting it takes one prompt. */
	private async ensureTrusted(cwd: string, executable: string): Promise<boolean> {
		const state = trustState(cwd)
		if (state === "trusted") return true
		if (state === "home") {
			this.unavailable.set(cwd, "This folder is your home directory, and Claude never saves trust for it. Remote Control has to be started from a project folder.")
			this.onChange()
			void vscode.window.showWarningMessage(`Remote Control cannot serve ${projectName(cwd)}: Claude never saves workspace trust for a home directory. Pick a project folder instead.`)
			return false
		}
		const choice = await vscode.window.showWarningMessage(
			`Claude has not been trusted in ${projectName(cwd)} yet.`,
			{ modal: true, detail: "Remote Control starts a standalone `claude`, which asks you to accept the workspace trust dialog once. Conversations opened through the IDE never trigger it, so it has not been accepted for this folder.\n\n\"Accept in Terminal\" opens `claude` there so you can accept the dialog yourself. \"Trust This Folder\" writes the same result straight to your Claude config — the alternative Claude's own error message suggests." },
			"Accept in Terminal", "Trust This Folder"
		)
		if (choice === "Accept in Terminal") {
			const terminal = vscode.window.createTerminal({ name: `Trust · ${projectName(cwd)}`, cwd })
			terminal.show(true)
			terminal.sendText(shellQuote(executable))
			return false		// the dialog is interactive; the user re-toggles once it is accepted
		}
		if (choice !== "Trust This Folder") return false
		const result = trustFolder(cwd, backupsDir())
		if (!result.ok) { void vscode.window.showErrorMessage(`Claude Control: ${result.error}`); return false }
		void vscode.window.showInformationMessage(`Trusted ${projectName(cwd)}${result.backup ? `. Previous config saved to ${path.basename(result.backup)}.` : "."}`)
		return true
	}

	/* The bridge writes its pointer once it is serving. No pointer inside the window means it refused — the terminal already shows why. */
	private async awaitBridge(cwd: string, terminal: vscode.Terminal): Promise<void> {
		const deadline = Date.now() + START_TIMEOUT_MS
		while (Date.now() < deadline) {
			await delay(POLL_MS)
			if (readBridge(cwd).running) return this.onChange()
			if (this.terminals.get(cwd) !== terminal) return		// superseded or stopped
			if (terminal.exitStatus) break
		}
		if (readBridge(cwd).running) return this.onChange()
		this.unavailable.set(cwd, "The bridge did not start. Its terminal shows the reason — commonly no subscription, an untrusted folder, or Remote Control not enabled for this account.")
		this.onChange()
		const choice = await vscode.window.showWarningMessage(`Remote Control did not start for ${projectName(cwd)}.`, "Show Terminal")
		if (choice === "Show Terminal") terminal.show(true)
	}

	/* Stop the server we started, or signal one started elsewhere. */
	async stop(): Promise<void> {
		const cwd = this.cwd
		const bridge = readBridge(cwd)
		if (!bridge.running) { this.onChange(); return }
		const confirmed = await vscode.window.showInformationMessage(
			`Stop Remote Control for ${projectName(cwd)}?`,
			{ modal: true, detail: "Sessions in this folder stop being reachable from claude.ai/code and the mobile app." },
			"Stop"
		)
		if (confirmed !== "Stop") return
		const terminal = this.terminals.get(cwd)
		if (terminal && !terminal.exitStatus) {
			terminal.sendText("\u0003", false)		// Ctrl+C lets the bridge clear its own pointer
			await delay(POLL_MS)
			if (!readBridge(cwd).running) { this.finish(cwd); return }
		}
		/* Only ever signal a bridge this window started. The pointer's pid can belong to a conversation's own claude process — the schema allows a "repl" bridge started by /remote-control — and interrupting that would kill the user's session. */
		if (bridge.pid && terminal) {
			try { process.kill(bridge.pid, "SIGINT") } catch { /* already gone */ }
			await delay(POLL_MS)
		}
		if (readBridge(cwd).running) vscode.window.showWarningMessage(`Remote Control for ${projectName(cwd)} is still running — it was started outside this window, so stop it in its own terminal.`)
		else this.finish(cwd)
	}

	private finish(cwd: string): void {
		const terminal = this.terminals.get(cwd)
		this.terminals.delete(cwd)
		if (terminal && !terminal.exitStatus) terminal.dispose()
		this.onChange()
	}

	/* Explain a dimmed icon. */
	async explain(): Promise<void> {
		const choice = await vscode.window.showWarningMessage(this.reason() || "Remote Control is unavailable here.", "Try Again")
		if (choice !== "Try Again") return
		this.unavailable.delete(this.cwd)
		this.onChange()
		await this.start()
	}

	dispose(): void {
		this.terminals.clear()		// terminals outlive the extension deliberately; the bridge should not die on a reload
	}
}

// --- HELPERS ---

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

function shellQuote(value: string): string { return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'` }
