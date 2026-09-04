import * as path from "path"
import * as vscode from "vscode"
import { readTabSessions, titleMatches, type TabSession } from "./panelstate"

// --- CHAT TABS IN THIS WINDOW ---

/* Three things are easy to confuse and are kept apart across this extension:

     a process       one running claude.exe          LiveSession, from live.ts
     a chat tab      one webview in *this* window    this file
     a conversation  one transcript on disk          TranscriptRecord, from scanner.ts

   They come apart in both directions. Closing a chat tab leaves the process running — the Claude
   extension keeps it so Ctrl+Shift+T can restore the tab — and killing a process leaves the tab sitting
   there showing an error. This file owns the middle row of that table and nothing else: which
   conversations this window currently has a tab for, and which ones it used to.

   Only this window's tabs are visible to it, so what it reports is never the whole truth: a conversation
   with no tab here may well have one in another window. Every window publishes what it finds through
   tabshare.ts, which is where the answers are combined. */

export const CHAT_VIEW_TYPE = "claudeVSCodePanel"		// tab viewTypes arrive prefixed, so this is matched as a substring

export function isChatTab(tab: vscode.Tab): boolean {
	return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CHAT_VIEW_TYPE)
}

export function chatTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isChatTab)
}

/* VS Code flushes the editor layout to its database on its own schedule, so a tab that just opened may
   not be in there yet. Re-read a few times over the following minute rather than once. */
const SNAPSHOT_DELAYS_MS = [1000, 5000, 20000, 60000]

export class ChatTabs {
	private sessions: TabSession[] = []		// the tab-to-conversation mapping as last read from disk
	private timer: NodeJS.Timeout | undefined
	private readonly dbFile: string

	/* `storageUri` is this extension's folder inside workspaceStorage/<hash>/, whose parent holds the
	   window's state.vscdb — the one file that says which conversation each chat tab is showing. */
	constructor(storageUri: vscode.Uri, private readonly onChange: (tabbed: Set<string>) => void, private readonly log?: vscode.OutputChannel) {
		this.dbFile = path.join(path.dirname(storageUri.fsPath), "state.vscdb")
	}

	start(subscriptions: vscode.Disposable[]): void {
		this.log?.appendLine(`chat tabs read from ${this.dbFile}`)
		this.refresh()
		/* Restored tabs are the reason this runs on a timer from the start and not only on tab events. The
		   extension activates on startup finished, which can be before VS Code has put the previous
		   session's tabs back: the first read then honestly finds none, and without a re-read this window
		   would tell the others it holds nothing for as long as it stays open. */
		this.schedule()
		subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((event) => {
			for (const tab of event.closed) {
				if (!isChatTab(tab)) continue
				this.reportClosed(tab)
			}
			if (event.opened.some(isChatTab) || event.closed.some(isChatTab)) this.schedule()
		}))
		/* Coming back to a window is a good moment to make sure what it has published is still true, and
		   it costs one read of a file that is only touched when the layout changes. */
		subscriptions.push(vscode.window.onDidChangeWindowState((state) => { if (state.focused) this.refresh() }))
		subscriptions.push({ dispose: () => { if (this.timer) clearTimeout(this.timer) } })
	}

	/* A tab closing is reported straight away rather than at the next snapshot: the mapping still names
	   the closed tab at that moment, and one entry more than there are tabs is exactly what `attached`
	   needs to work out which conversation lost its window. */
	private reportClosed(tab: vscode.Tab): void {
		const gone = this.sessions.find((session) => session.title === tab.label && session.group === tab.group.viewColumn) || this.sessions.find((session) => session.title === tab.label)
		this.log?.appendLine(gone ? `chat tab "${tab.label}" closed — ${gone.sessionId} has no window here any more` : `a chat tab closed ("${tab.label}") but no conversation is on record for it`)
		this.onChange(this.attached())
	}

	private schedule(step = 0): void {
		if (this.timer) clearTimeout(this.timer)
		if (step >= SNAPSHOT_DELAYS_MS.length) return
		this.timer = setTimeout(() => { this.refresh(); this.schedule(step + 1) }, SNAPSHOT_DELAYS_MS[step])
	}

	private refresh(): void {
		const tabs = chatTabs()
		const fresh = readTabSessions(this.dbFile, tabs.map((tab) => tab.label))
		if (!fresh.length && tabs.length) return void this.log?.appendLine(`${tabs.length} chat tab(s) open but the workspace database names none of them yet`)
		if (describe(fresh) !== describe(this.sessions)) this.log?.appendLine(`chat tabs on record: ${describe(fresh) || "none"} (open: ${tabs.map((tab) => `"${tab.label}"`).join(", ") || "none"})`)
		this.sessions = fresh
		const attached = this.attached()
		this.log?.appendLine(`publishing ${attached.size} chat tab(s): ${[...attached].map((sessionId) => sessionId.slice(0, 8)).join(", ") || "none"}`)
		this.onChange(attached)
	}

	/* Which of the mapped conversations still have a tab. Rebuilt from the mapping on every snapshot
	   rather than tracked through close events, so a mapping that was already stale when a tab closed
	   corrects itself on the next read instead of leaving a row that nothing will ever put right.

	   A record naming exactly as many chat tabs as the window has open is describing those tabs, whatever
	   its titles say — the stored title lags behind a conversation being re-summarised, and matching on it
	   would then declare a perfectly visible tab gone. Only when the counts disagree, which is what a
	   just-closed tab looks like, do the titles have to settle which entry lost its tab. */
	private attached(): Set<string> {
		const tabs = chatTabs()
		if (this.sessions.length === tabs.length) return new Set(this.sessions.map((session) => session.sessionId))
		const matched = this.sessions.filter((session) => tabs.some((tab) => holds(tab, session)))
		/* Claiming every mapped conversation is the safer wrong answer than claiming none: an extra entry
		   leaves a row listed that should have gone, while an empty one tells the other windows this one
		   shows nothing, and every hand-over to it stops working. */
		if (!matched.length && tabs.length) this.log?.appendLine(`${tabs.length} chat tab(s) open but none matched the mapping; assuming all ${this.sessions.length} are still shown`)
		return new Set((matched.length || !tabs.length ? matched : this.sessions).map((session) => session.sessionId))
	}
}

/* The view column is only compared when the record kept one: a record split across pages can lose the
   field, and a title that matches is already strong evidence on its own. */
function holds(tab: vscode.Tab, session: TabSession): boolean {
	if (!titleMatches(session.title, tab.label)) return false
	return !session.group || session.group === tab.group.viewColumn
}

function describe(sessions: TabSession[]): string {
	return sessions.map((session) => `"${session.title}"[${session.group}]=${session.sessionId.slice(0, 8)}`).join(", ")
}
