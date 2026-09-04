// --- BOOTSTRAP ---

const vscode = acquireVsCodeApi()
const el = { search: byId("search"), clear: byId("clear"), count: byId("count"), chips: byId("chips"), hint: byId("hint"), list: byId("list"), empty: byId("empty"), usage: byId("usage") }
const nodes = new Map()		// entry key -> element, so rows survive re-renders and keep the spinner spinning
let data = { rows: [], workspaces: [], activeCwd: "", needsInputTotal: 0, preciseStatus: false, promptPreviewLines: 2, usage: { limits: [], fetchedAt: 0 } }
let ui = Object.assign({ query: "", chip: "all", hintDismissed: false, collapsed: {} }, vscode.getState() || {})		// collapsed is keyed by workspace folder, so a fold survives a reload
let openMenu = null

// --- ICONS: built from primitives so they stay legible at 14px ---

const ICONS = {
	hand: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
		<rect x="2.2" y="8" width="1.8" height="4.6" rx=".9" transform="rotate(-30 3.1 10.3)"/>
		<rect x="4.6" y="3.4" width="1.8" height="5.6" rx=".9"/>
		<rect x="6.8" y="2.2" width="1.8" height="6.8" rx=".9"/>
		<rect x="9" y="3" width="1.8" height="6" rx=".9"/>
		<rect x="11.2" y="4.6" width="1.8" height="4.4" rx=".9"/>
		<rect x="4.6" y="7.2" width="8.4" height="6.2" rx="2.6"/>
	</svg>`,
	check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.6l3.1 3.1L12.6 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	monitor: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 11.2v2.2M5.4 13.4h5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
}

el.search.value = ui.query
render()
vscode.postMessage({ type: "ready" })

// --- HOST MESSAGES ---

window.addEventListener("message", (event) => {
	const message = event.data
	if (message.type === "data") { data = message.data; render() }
	if (message.type === "focusSearch") { el.search.focus(); el.search.select() }
	if (message.type === "showWaiting") { ui.chip = "waiting"; save(); render() }
})

// --- INPUT ---

el.search.addEventListener("input", debounce(() => { ui.query = el.search.value; save(); render() }, 120))
el.clear.addEventListener("click", () => { el.search.value = ""; ui.query = ""; save(); render(); el.search.focus() })
el.usage.addEventListener("click", () => vscode.postMessage({ type: "refreshUsage" }))

document.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key === "f") { event.preventDefault(); el.search.focus(); el.search.select(); return }
	if (event.key !== "Escape") return
	if (openMenu) return closeMenu()
	if (!ui.query) return
	el.search.value = ""
	ui.query = ""
	save()
	render()
})

document.addEventListener("click", (event) => { if (openMenu && !openMenu.contains(event.target)) closeMenu() })

// --- RENDER ---

/* Rebuild the toolbar and reconcile the list against the current filters. */
function render() {
	el.clear.hidden = !ui.query
	const scoped = data.rows
	const visible = scoped.filter(matchesChip).filter(matchesQuery)
	renderChips(scoped)
	el.count.textContent = visible.length === scoped.length ? `${scoped.length}` : `${visible.length} of ${scoped.length}`
	renderHints(scoped)
	renderUsage()
	reconcile(entriesFor(visible))
	el.empty.hidden = visible.length > 0
	if (!visible.length) renderEmpty(scoped.length)
}

function matchesChip(row) {
	if (ui.chip === "waiting") return needsAttention(row.state)
	if (ui.chip === "busy") return row.state === "busy"
	return true
}

function matchesQuery(row) {
	if (!ui.query) return true
	const needle = ui.query.toLowerCase()
	return haystack(row).some((field) => field.toLowerCase().includes(needle))
}

function haystack(row) { return [row.title, row.lastPrompt, row.projectName, row.tool] }

function renderChips(scoped) {
	const waiting = scoped.filter((row) => needsAttention(row.state)).length
	const busy = scoped.filter((row) => row.state === "busy").length
	const chips = [
		{ id: "all", label: "All", warn: false },
		{ id: "waiting", label: waiting ? `Needs you ${waiting}` : "Needs you", warn: true },
		{ id: "busy", label: busy ? `Busy ${busy}` : "Busy", warn: false }
	]
	const markup = chips.map((chip) => `<button class="chip${chip.warn ? " warn" : ""}" role="tab" data-chip="${chip.id}" aria-selected="${ui.chip === chip.id}">${escape(chip.label)}</button>`).join("")
	if (el.chips.dataset.markup === markup) return
	el.chips.dataset.markup = markup
	el.chips.innerHTML = markup
	for (const button of el.chips.querySelectorAll(".chip")) {
		button.addEventListener("click", () => { ui.chip = button.dataset.chip; save(); render() })
	}
}

/* Attention must never be hidden by a filter, so say so when waiting conversations sit outside the current view. */
function renderHints(scoped) {
	const notices = []
	const elsewhere = data.needsInputTotal - scoped.filter((row) => needsAttention(row.state)).length
	if (elsewhere > 0) notices.push(`<div><a data-act="showAll">${elsewhere} conversation${elsewhere === 1 ? "" : "s"} waiting outside this filter — show all</a></div>`)
	if (!data.preciseStatus && !ui.hintDismissed) {
		notices.push(`<div><strong>Status is inferred.</strong> Without hooks, a slow command and a permission prompt look identical, so a stalled command reads as "Waiting?" rather than asking for you.<br><button data-act="precise">Enable precise status</button> <a data-act="dismiss">Not now</a></div>`)
	}
	el.hint.hidden = notices.length === 0
	const markup = notices.join("")
	if (el.hint.dataset.markup === markup) return
	el.hint.dataset.markup = markup
	el.hint.innerHTML = markup
	for (const node of el.hint.querySelectorAll("[data-act]")) {
		node.addEventListener("click", () => {
			if (node.dataset.act === "precise") return vscode.postMessage({ type: "enablePreciseStatus" })
			if (node.dataset.act === "dismiss") { ui.hintDismissed = true; save(); render(); return }
			ui.chip = "all"
			save()
			render()
		})
	}
}

const STALE_USAGE_MS = 900000
const SESSION_WINDOW_MS = 18000000
const WEEKLY_WINDOW_MS = 604800000

/* Claude's plan limits, pinned to the bottom. It only refreshes this cache when something asks it to, so the age is shown rather than implied. */
function renderUsage() {
	const usage = data.usage || { limits: [], fetchedAt: 0 }
	el.usage.hidden = usage.limits.length === 0
	if (el.usage.hidden) return
	const stale = !usage.fetchedAt || Date.now() - usage.fetchedAt > STALE_USAGE_MS
	/* Both bars carry the same tooltip: the two windows are read together (a 5-hour reading only means
	   something next to the weekly one), so hovering either bar should not hide the other. */
	const tooltip = usage.limits.map(barTooltip).join("\n")
	const rows = usage.limits.map((limit) => `<div class="bar${limit.active ? " active" : ""}" title="${escape(tooltip)}"><span class="lbl">${escape(limit.label)}</span><span class="track"><span class="pace" data-pct="${windowElapsed(limit)}"></span><span class="fill ${limit.severity}" data-pct="${limit.percent}"></span></span><span class="pct">${limit.percent}%</span></div>`)
	const asOf = usage.fetchedAt ? `as of ${age(Date.now() - usage.fetchedAt)} ago${stale ? " — click to refresh" : ""}` : "no reading yet — click to refresh"
	const markup = `${rows.join("")}<div class="asOf"><span>${escape(asOf)}</span><span class="resets">${escape(resetLabel(usage.limits))}</span></div>`
	setClass(el.usage, `usage${stale ? " stale" : ""}`)
	if (el.usage.dataset.markup === markup) return
	el.usage.dataset.markup = markup
	el.usage.innerHTML = markup
	/* Widths are applied through the CSSOM, not a style attribute: the webview CSP has no 'unsafe-inline',
	   so an inline style is dropped and the fill silently renders at its default width. */
	for (const zone of el.usage.querySelectorAll(".fill, .pace")) zone.style.width = `${zone.dataset.pct}%`
}

/* A percentage on its own does not say whether you are ahead or behind: 15% used is comfortable 40% into
   a window and alarming 5% into one. The middle zone marks how far through the window the reading sits, so
   the fill running short of it means spending below pace. */
function windowElapsed(limit) {
	if (!limit.resetsAt) return 0
	const span = limit.kind === "session" ? SESSION_WINDOW_MS : WEEKLY_WINDOW_MS
	return clampPercent(100 * (span - (limit.resetsAt - Date.now())) / span)
}

function clampPercent(value) {
	return Math.max(0, Math.min(100, Math.round(value)))
}

/* The reset that matters is the one currently constraining you, falling back to the longest-dated limit. */
function resetLabel(limits) {
	const pick = limits.find((limit) => limit.active && limit.resetsAt) || limits.filter((limit) => limit.resetsAt).sort((a, b) => b.resetsAt - a.resetsAt)[0]
	if (!pick) return ""
	return `Resets in ${until(pick.resetsAt - Date.now())}`
}

/* Two components, because one is too coarse for a reset you are pacing against: "2h" hides the
   difference between 1h31m and 2h29m. age() stays single-unit — it dates past activity, where that
   precision would only add noise. */
function until(ms) {
	const minutes = Math.max(0, Math.round(ms / 60000))
	if (minutes < 1) return "under a minute"
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
	const days = Math.floor(hours / 24)
	return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`
}

function barTooltip(limit) {
	const reset = limit.resetsAt ? ` · resets in ${until(limit.resetsAt - Date.now())}` : ""
	const elapsed = limit.resetsAt ? ` · ${windowElapsed(limit)}% of the window elapsed` : ""
	return `${limit.label}: ${limit.percent}% used${limit.active ? " (currently limiting)" : ""}${elapsed}${reset}`
}

function renderEmpty(scopedCount) {
	const reason = scopedCount === 0 ? "No conversations yet." : "Nothing matches the current search and filter."
	el.empty.innerHTML = `${escape(reason)}<br><button type="button">Reset filters</button>`
	el.empty.querySelector("button").addEventListener("click", () => {
		ui.query = ""
		ui.chip = "all"
		el.search.value = ""
		save()
		render()
	})
}

// --- LIST RECONCILE ---

/* One foldable header per workspace, its rows beneath it. The folder this window has open comes first —
   it is the one you are working in — and the rest follow in order of most recent activity, which is the
   order the rows already arrive in. Keys let reconcile move nodes instead of rebuilding them. */
function entriesFor(rows) {
	const groups = new Map()
	for (const row of rows) {
		if (!groups.has(row.cwd)) groups.set(row.cwd, [])
		groups.get(row.cwd).push(row)
	}
	const order = [...groups.keys()]
	const home = order.indexOf(data.activeCwd)
	if (home > 0) order.unshift(order.splice(home, 1)[0])
	const entries = []
	for (const cwd of order) {
		const inGroup = groups.get(cwd)
		const collapsed = !!ui.collapsed[cwd]
		entries.push({ key: `g:${cwd}`, kind: "group", cwd, label: workspaceLabel(cwd, inGroup[0]), count: inGroup.length, collapsed, home: cwd === data.activeCwd })
		if (collapsed) continue
		for (const row of inGroup) entries.push({ key: `r:${row.sessionId}`, kind: "row", row })
	}
	return entries
}

/* The host disambiguates folders that share a basename, so prefer its label over the row's own. */
function workspaceLabel(cwd, row) {
	const workspace = data.workspaces.find((candidate) => candidate.cwd === cwd)
	return workspace ? workspace.name : (row.projectName || cwd || "(unknown)")
}

/* Update in place and re-append in order. Touching only what changed keeps the spinner from restarting on every tick. */
function reconcile(entries) {
	const seen = new Set()
	for (const entry of entries) {
		seen.add(entry.key)
		let node = nodes.get(entry.key)
		if (!node) { node = entry.kind === "group" ? makeGroup() : makeRow(); nodes.set(entry.key, node) }
		if (entry.kind === "group") updateGroup(node, entry)
		else updateRow(node, entry.row)
		el.list.appendChild(node)		// appendChild moves an existing node without recreating it
	}
	for (const [key, node] of nodes) {
		if (seen.has(key)) continue
		node.remove()
		nodes.delete(key)
	}
}

function makeGroup() {
	const node = document.createElement("button")
	node.className = "groupHead"
	node.type = "button"
	node.innerHTML = `<span class="caret" aria-hidden="true">&#9656;</span><span class="gname"></span><span class="gcount"></span>`
	node.addEventListener("click", () => {
		const cwd = node.dataset.cwd
		if (ui.collapsed[cwd]) delete ui.collapsed[cwd]
		else ui.collapsed[cwd] = true
		save()
		render()
	})
	return node
}

function updateGroup(node, entry) {
	node.dataset.cwd = entry.cwd
	setClass(node, `groupHead${entry.collapsed ? " collapsed" : ""}${entry.home ? " home" : ""}`)
	node.setAttribute("aria-expanded", String(!entry.collapsed))
	setText(node, "gname", entry.label)
	setText(node, "gcount", String(entry.count))
	node.title = entry.cwd
}

function makeRow() {
	const node = document.createElement("div")
	node.className = "row"
	node.setAttribute("role", "listitem")
	node.tabIndex = 0
	node.innerHTML = `<div class="gutter"><span class="icon"></span><span class="time"></span><span class="model"></span><button class="remote" type="button" tabindex="-1">${ICONS.monitor}</button></div><div class="body"><div class="title"></div><div class="activity"></div><div class="prompt"></div><div class="files"></div></div><button class="kebab" type="button" tabindex="-1" aria-label="More actions">&#8942;</button>`
	node.addEventListener("click", (event) => {
		if (event.target.closest(".kebab") || event.target.closest(".menu") || event.target.closest(".remote")) return
		vscode.postMessage({ type: "open", sessionId: node.dataset.sessionId })
	})
	node.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return
		event.preventDefault()
		vscode.postMessage({ type: "open", sessionId: node.dataset.sessionId })
	})
	node.querySelector(".kebab").addEventListener("click", (event) => { event.stopPropagation(); toggleMenu(node) })
	node.querySelector(".remote").addEventListener("click", (event) => {
		event.stopPropagation()
		vscode.postMessage({ type: "remoteInSession", sessionId: node.dataset.sessionId })		// sends /remote-control into this very conversation
	})
	node.querySelector(".files").addEventListener("click", (event) => {
		const chip = event.target.closest(".chipFile")
		if (!chip) return
		event.stopPropagation()
		vscode.postMessage({ type: "diffFile", sessionId: node.dataset.sessionId, file: chip.dataset.file, version: Number(chip.dataset.version) })
	})
	return node
}

function updateRow(node, row) {
	node.dataset.sessionId = row.sessionId
	node.dataset.cwd = row.cwd
	node.dataset.lastActivity = String(row.lastActivity)
	node.dataset.live = row.live ? "1" : ""		// the row menu offers to kill a process only when there is one
	setClass(node, `row ${rowTint(row.state)}`.trim())
	setIcon(node, row.state)
	setText(node, "time", age(Date.now() - row.lastActivity))
	setHtml(node, "title", highlight(row.title))
	node.querySelector(".title").title = row.title
	setClass(node.querySelector(".activity"), `activity ${activityClass(row.state)}`)		// the real status always stays visible
	setText(node, "activity", row.tool)
	/* A queued message is already what last-prompt holds, since Claude writes that record as it enqueues — so one pending message just marks up the existing preview. Several can only be counted, because the records carry no text. */
	const prompt = node.querySelector(".prompt")
	const many = row.pendingMessages > 1
	prompt.hidden = (!row.lastPrompt && !many) || data.promptPreviewLines < 1
	prompt.style.webkitLineClamp = String(data.promptPreviewLines)
	if (many) setHtml(node, "prompt", `${row.pendingMessages} messages pending…`)
	else setHtml(node, "prompt", `${row.pendingMessages === 1 ? `<span class="pend">[pending]</span> ` : ""}${highlight(row.lastPrompt)}`)
	prompt.title = many ? `${row.pendingMessages} messages queued and not yet processed` : `${row.pendingMessages === 1 ? "[pending] " : ""}${row.lastPrompt}`
	const remote = node.querySelector(".remote")
	remote.hidden = !row.remoteActive		// purely an indicator now — connecting happens from the row menu
	setClass(remote, `remote${row.remoteActive ? " on" : ""}`)
	remote.title = row.remoteActive ? "Remote Control is active — this conversation is reachable from the Claude mobile app" : ""
	remote.setAttribute("aria-pressed", String(!!row.remoteActive))
	setText(node, "model", row.modelLabel)
	node.querySelector(".model").title = row.modelLabel ? `Model: ${row.modelLabel}` : ""
	setFiles(node, row)
}

/* Chips for the files the finished run touched. Rebuilt only when the set changes, so hovering stays stable. */
function setFiles(node, row) {
	const files = row.changed || []
	const signature = files.map((file) => `${file.path}@${file.version}`).join("|")
	const container = node.querySelector(".files")
	container.hidden = files.length === 0
	if (node.dataset.filesSig === signature) return
	node.dataset.filesSig = signature
	const label = files.length ? `<span class="filesLabel">EDITS:</span>` : ""
	container.innerHTML = `${label}${files.map((file) => `<button class="chipFile" type="button" data-file="${escape(file.path)}" data-version="${file.version}" title="${escape(file.path)}">${escape(shortName(file.path))}</button>`).join("")}`
}

function baseName(file) { return String(file).split(/[/\\]/).pop() || file }

/* Trim a long filename but keep the extension, so `my_very_long_file_name.js` reads as `my_very_long_...js`. */
function shortName(file) {
	const name = baseName(file)
	if (name.length <= NAME_MAX) return name
	const dot = name.lastIndexOf(".")
	const ext = dot > 0 ? name.slice(dot + 1) : ""
	return `${name.slice(0, Math.max(4, NAME_MAX - ext.length))}...${ext}`
}

/* Only rewrite the icon when the state actually changes, otherwise the spinner restarts mid-rotation. */
function setIcon(node, state) {
	if (node.dataset.iconState === state) return
	node.dataset.iconState = state
	const icon = node.querySelector(".icon")
	if (state === "busy") { icon.className = "icon working"; icon.innerHTML = ""; return }
	if (state === "needs-input") { icon.className = "icon hand"; icon.innerHTML = ICONS.hand; return }
	/* The hand is reserved for a conversation that is genuinely asking you something. A session held up by its own tool — a long command, an armed task — gets the busy ring held still instead: work is out, but nothing is running here. */
	if (state === "waiting" || state === "needs-input?") { icon.className = "icon working armed"; icon.innerHTML = ""; return }
	if (state === "finished") { icon.className = "icon check"; icon.innerHTML = ICONS.check; return }
	if (state === "reviewed") { icon.className = "icon check seen"; icon.innerHTML = ICONS.check; return }
	icon.className = state === "error" ? "icon bullet error" : "icon bullet"
	icon.innerHTML = ""
}

function rowTint(state) {
	if (state === "needs-input") return "tintAttention"		// only a confirmed ask earns the attention tint; a guess does not
	if (state === "finished") return "tintDone"
	if (state === "killed") return "dim"
	return ""
}

function activityClass(state) {
	if (state === "busy") return "working"
	if (state === "waiting" || state === "needs-input?") return "waiting"
	if (state === "needs-input") return "attention"
	if (state === "finished") return "done"
	if (state === "error") return "error"
	return "muted"
}

// --- ROW MENU ---

function toggleMenu(row) {
	if (openMenu && openMenu.dataset.sessionId === row.dataset.sessionId) return closeMenu()
	closeMenu()
	const menu = document.createElement("div")
	menu.className = "menu"
	menu.dataset.sessionId = row.dataset.sessionId
	/* Always the in-session route: this exposes *this conversation* by sending it /remote-control. The title-bar tower is the separate folder-wide server. */
	const remoteOn = row.querySelector(".remote").classList.contains("on")
	const end = row.dataset.live ? "Kill process and close tab" : "Close tab"
	menu.innerHTML = `<button data-act="open" type="button">Open conversation</button><button data-act="remoteInSession" type="button">${remoteOn ? "Manage Remote Control" : "Remote control this conversation"}</button><button data-act="reveal" type="button">Reveal transcript</button><button data-act="copyId" type="button">Copy session ID</button><button data-act="openFolder" type="button">Open folder in new window</button><button data-act="kill" class="danger" type="button">${end}</button>`
	for (const button of menu.querySelectorAll("button")) {
		button.addEventListener("click", (event) => {
			event.stopPropagation()
			const act = button.dataset.act
			if (act === "openFolder") vscode.postMessage({ type: act, cwd: row.dataset.cwd })
			else vscode.postMessage({ type: act, sessionId: row.dataset.sessionId })
			closeMenu()
		})
	}
	row.appendChild(menu)
	menu.style.top = `${row.querySelector(".kebab").offsetTop + 18}px`
	openMenu = menu
}

function closeMenu() {
	if (openMenu) openMenu.remove()
	openMenu = null
}

// --- TIME ---

/* One timer refreshes every visible age label, rather than a full re-render. */
setInterval(() => {
	const now = Date.now()
	for (const node of nodes.values()) {
		if (!node.dataset.lastActivity) continue
		setText(node, "time", age(now - Number(node.dataset.lastActivity)))
	}
}, 10000)

function age(ms) {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
	return `${Math.round(seconds / 86400)}d`
}

// --- HELPERS ---

function needsAttention(state) { return state === "needs-input" || state === "needs-input?" }

function byId(id) { return document.getElementById(id) }

function save() { vscode.setState(ui) }

function setText(node, selector, value) {
	const target = node.querySelector(`.${selector}`)
	if (target && target.textContent !== value) target.textContent = value
}

function setHtml(node, selector, value) {
	const target = node.querySelector(`.${selector}`)
	if (target && target.innerHTML !== value) target.innerHTML = value
}

function setClass(node, value) { if (node && node.className !== value) node.className = value }

function escape(text) { return String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }

/* Escape first, then wrap matches — so a prompt containing markup can never inject anything. */
function highlight(text) {
	const safe = escape(text)
	if (!ui.query) return safe
	const needle = escape(ui.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	if (!needle) return safe
	return safe.replace(new RegExp(needle, "gi"), (match) => `<span class="hit">${match}</span>`)
}

function debounce(fn, ms) {
	let timer
	return (...args) => {
		clearTimeout(timer)
		timer = setTimeout(() => fn(...args), ms)
	}
}
