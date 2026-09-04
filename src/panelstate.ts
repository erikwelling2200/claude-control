import * as fs from "fs"

// --- WHICH CONVERSATION A CHAT TAB HOLDS ---

/* Nothing in the tab API says which conversation a chat tab is showing: TabInputWebview carries a
   viewType and nothing else. VS Code's own workspace database does, though. It persists the editor
   layout under memento/workbench.parts.editor, and every Claude tab is stored there as a webview input
   whose serialised state is {"isFullEditor":…,"sessionID":"…"} — the exact mapping, per window.

   Reading it means treating a SQLite file as text, which is crude but has no dependency and needs no
   write access. Three things follow from that, and each one cost a debugging round:

     - a value is not stored next to its key, so the layout is found by its own first field rather than
       by the memento key it belongs to
     - a large value is split across pages, so it cannot be JSON.parse-d as a whole; the fields of one
       chat tab are read where they sit instead, and a tab whose record straddles a page boundary is then
       the only thing lost rather than the whole window
     - freed pages keep superseded copies of the record, so the file holds several layouts at once and
       `pick` scores each against the tabs the window actually has open */

export interface TabSession {
	title: string		// the tab's label, which is the conversation summary
	sessionId: string
	group: number		// view column, so two tabs with the same title still tell apart
}

const LAYOUT_ANCHOR = `{"editorpart.state"`		// the stored layout's own first field
const PANEL_MARK = "claudeVSCodePanel"
const SESSION_FIELD = `"sessionID":"`
const TITLE_FIELD = `"title":"`
const GROUP_FIELD = `"group":`

/* Every chat tab the workspace database currently describes. `labels` is what the window really has
   open; the layout that matches it best wins, since a stale copy describes tabs that are long gone. */
export function readTabSessions(dbFile: string, labels: string[]): TabSession[] {
	let raw: string
	try { raw = fs.readFileSync(dbFile, "utf8") } catch { return [] }
	const candidates = layouts(raw).map(scanLayout).filter((sessions) => sessions.length)
	return pick(candidates, labels)
}

/* The file's copies of the layout, each running from its own first field to where the next one starts. */
function layouts(raw: string): string[] {
	const out: string[] = []
	for (let at = raw.indexOf(LAYOUT_ANCHOR); at >= 0;) {
		const next = raw.indexOf(LAYOUT_ANCHOR, at + LAYOUT_ANCHOR.length)
		out.push(next < 0 ? raw.slice(at) : raw.slice(at, next))
		at = next
	}
	return out
}

/* The chat tabs one copy of the layout describes. Backslashes are dropped first: a webview's own state is
   JSON inside JSON inside JSON, and flattening the escaping means every field can be read under the same
   plain name whatever depth it sits at. It costs nothing but a backslash inside a tab title, which is
   only a label. */
function scanLayout(layout: string): TabSession[] {
	const flat = layout.split("\\").join("")
	const out: TabSession[] = []
	const seen = new Set<string>()
	for (let at = flat.indexOf(PANEL_MARK); at >= 0; at = flat.indexOf(PANEL_MARK, at + 1)) {
		const next = flat.indexOf(PANEL_MARK, at + 1)
		const entry = next < 0 ? flat.slice(at) : flat.slice(at, next)		// one tab's record, never bleeding into the next
		const sessionId = textAfter(entry, SESSION_FIELD)
		if (!sessionId || seen.has(sessionId)) continue		// the mark appears twice per tab, as the viewType and as the providedId
		seen.add(sessionId)
		out.push({ title: textAfter(entry, TITLE_FIELD), sessionId, group: Number(digitsAfter(entry, GROUP_FIELD)) || 0 })
	}
	return out
}

function textAfter(entry: string, field: string): string {
	const at = entry.indexOf(field)
	if (at < 0) return ""
	const from = at + field.length
	const end = entry.indexOf(`"`, from)
	return end < 0 ? "" : entry.slice(from, end)
}

function digitsAfter(entry: string, field: string): string {
	const at = entry.indexOf(field)
	if (at < 0) return ""
	return /^\d+/.exec(entry.slice(at + field.length))?.[0] || ""
}

/* Whether a stored title names a tab. VS Code writes the title as it is *displayed*, so a long one is
   already cut short with an ellipsis ("Erik Welling milestone b…") while the tab's own label is the whole
   summary. Comparing the two as equals matches nothing at all, which reads as "this window has no chat
   tabs" — so the stored title is treated as the prefix it is. */
export function titleMatches(stored: string, label: string): boolean {
	if (stored === label) return true
	const shown = stored.replace(/(…|\.\.\.)$/, "")
	if (shown === stored) return false		// nothing was cut off, so a prefix match would let "hi" claim the tab named "hi2"
	return shown.length > 0 && label.startsWith(shown)
}

/* The layout whose chat tabs line up with the open ones. A tab it lists that is not open counts against
   it, which is what separates the current layout from a stale copy still describing a tab that has since
   been closed — the two match the open tabs equally well, and only the extra entry tells them apart. */
function pick(candidates: TabSession[][], labels: string[]): TabSession[] {
	let best: TabSession[] = []
	let bestScore = -Infinity
	for (const candidate of candidates) {
		const matches = candidate.filter((session) => labels.some((label) => titleMatches(session.title, label))).length
		const score = matches - (candidate.length - matches)
		if (score > bestScore || (score === bestScore && candidate.length > best.length)) { best = candidate; bestScore = score }
	}
	return best
}
