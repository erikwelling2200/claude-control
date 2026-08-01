// --- BOOTSTRAP ---

const vscode = acquireVsCodeApi()
const el = { search: byId("search"), clear: byId("clear"), project: byId("project"), count: byId("count"), chips: byId("chips"), hint: byId("hint"), list: byId("list"), empty: byId("empty"), usage: byId("usage") }
const nodes = new Map()		// entry key -> element, so rows survive re-renders and keep the spinner spinning
let data = { rows: [], projects: [], activeCwd: "", selectedCwd: "", needsInputTotal: 0, preciseStatus: false, promptPreviewLines: 2, groupByProject: false, showClosed: true, usage: { limits: [], fetchedAt: 0 } }
let ui = Object.assign({ query: "", chip: "all", hintDismissed: false }, vscode.getState() || {})
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
	monitor: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 11.2v2.2M5.4 13.4h5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
	shield: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7l5 1.8v4.1c0 3.1-2.1 5.3-5 6.6-2.9-1.3-5-3.5-5-6.6V3.5z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
	shieldCheck: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7l5 1.8v4.1c0 3.1-2.1 5.3-5 6.6-2.9-1.3-5-3.5-5-6.6V3.5z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.7 7.9l1.7 1.7 3-3.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	shieldOff: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.7l5 1.8v4.1c0 3.1-2.1 5.3-5 6.6-2.9-1.3-5-3.5-5-6.6V3.5z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.1 12.4L11.9 3.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
	plan: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="2.6" width="9.6" height="11" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.7 6h4.6M5.7 8.6h4.6M5.7 11.2h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`
}

/* Permission modes, with Claude Code's own labels and icons (see modeicons.js). bypassPermissions is tinted red — it is the one mode where Claude never stops to ask. */
const PERMISSIONS = {
	default: { label: "Manual — asks before each edit", danger: false },
	acceptEdits: { label: "Edit automatically", danger: false },
	plan: { label: "Plan — explores, then proposes", danger: false },
	auto: { label: "Auto — pauses only for risky actions", danger: false },
	bypassPermissions: { label: "Bypass permissions — never asks", danger: true },
	dontAsk: { label: "Does not ask", danger: true }
}

el.search.value = ui.query
render()
vscode.postMessage({ type: "ready" })

// --- HOST MESSAGES ---

window.addEventListener("message", (event) => {
	const message = event.data
	if (message.type === "data") { data = message.data; render() }
	if (message.type === "focusSearch") { el.search.focus(); el.search.select() }
	if (message.type === "showWaiting") { ui.chip = "waiting"; save(); vscode.postMessage({ type: "selectProject", cwd: "" }); render() }
})

// --- INPUT ---

el.search.addEventListener("input", debounce(() => { ui.query = el.search.value; save(); render() }, 120))
el.clear.addEventListener("click", () => { el.search.value = ""; ui.query = ""; save(); render(); el.search.focus() })
el.project.addEventListener("change", () => vscode.postMessage({ type: "selectProject", cwd: el.project.value }))
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
	renderProjects()
	const scoped = data.rows.filter(inScope)
	const visible = scoped.filter(matchesChip).filter(matchesQuery)
	renderChips(scoped)
	el.count.textContent = visible.length === scoped.length ? `${scoped.length}` : `${visible.length} of ${scoped.length}`
	renderHints(scoped)
	renderUsage()
	reconcile(entriesFor(visible))
	el.empty.hidden = visible.length > 0
	if (!visible.length) renderEmpty(scoped.length)
}

function inScope(row) {
	if (!data.showClosed && row.state === "closed") return false
	return !data.selectedCwd || row.cwd === data.selectedCwd
}

function matchesChip(row) {
	if (ui.chip === "waiting") return isWaiting(row.state)
	if (ui.chip === "busy") return row.state === "busy"
	return true
}

function matchesQuery(row) {
	if (!ui.query) return true
	const needle = ui.query.toLowerCase()
	return haystack(row).some((field) => field.toLowerCase().includes(needle))
}

function haystack(row) { return [row.title, row.lastPrompt, row.projectName, row.gitBranch, row.tool] }

const NAME_MAX = 15

/* The project name only earns its place when the row is somewhere other than the folder you are already in. */
function showProjectName(row) {
	if (data.selectedCwd || data.groupByProject) return false
	return row.cwd !== data.activeCwd
}

/* Project dropdown, active project preselected by the host. */
function renderProjects() {
	const options = [`<option value="">All projects (${data.rows.length})</option>`]
	for (const project of data.projects) options.push(`<option value="${escape(project.cwd)}">${escape(project.name)} (${project.count})</option>`)
	const markup = options.join("")
	if (el.project.dataset.markup !== markup) { el.project.innerHTML = markup; el.project.dataset.markup = markup }
	el.project.value = data.projects.some((project) => project.cwd === data.selectedCwd) ? data.selectedCwd : ""
}

function renderChips(scoped) {
	const waiting = scoped.filter((row) => isWaiting(row.state)).length
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
	const elsewhere = data.needsInputTotal - scoped.filter((row) => isWaiting(row.state)).length
	if (elsewhere > 0) notices.push(`<div><a data-act="showAll">${elsewhere} conversation${elsewhere === 1 ? "" : "s"} waiting outside this filter — show all</a></div>`)
	if (!data.preciseStatus && !ui.hintDismissed) {
		notices.push(`<div><strong>Status is inferred.</strong> Without hooks, a slow command and a permission prompt look identical, so uncertain rows show a faded hand.<br><button data-act="precise">Enable precise status</button> <a data-act="dismiss">Not now</a></div>`)
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
			vscode.postMessage({ type: "selectProject", cwd: "" })
		})
	}
}

const STALE_USAGE_MS = 900000

/* Claude's plan limits, pinned to the bottom. It only refreshes this cache when something asks it to, so the age is shown rather than implied. */
function renderUsage() {
	const usage = data.usage || { limits: [], fetchedAt: 0 }
	el.usage.hidden = usage.limits.length === 0
	if (el.usage.hidden) return
	const stale = !usage.fetchedAt || Date.now() - usage.fetchedAt > STALE_USAGE_MS
	const rows = usage.limits.map((limit) => `<div class="bar${limit.active ? " active" : ""}" title="${escape(barTooltip(limit))}"><span class="lbl">${escape(limit.label)}</span><span class="track"><span class="fill ${limit.severity}" data-pct="${limit.percent}"></span></span><span class="pct">${limit.percent}%</span></div>`)
	const asOf = usage.fetchedAt ? `as of ${age(Date.now() - usage.fetchedAt)} ago${stale ? " — click to refresh" : ""}` : "no reading yet — click to refresh"
	const markup = `${rows.join("")}<div class="asOf"><span>${escape(asOf)}</span><span class="resets">${escape(resetLabel(usage.limits))}</span></div>`
	setClass(el.usage, `usage${stale ? " stale" : ""}`)
	if (el.usage.dataset.markup === markup) return
	el.usage.dataset.markup = markup
	el.usage.innerHTML = markup
	/* Widths are applied through the CSSOM, not a style attribute: the webview CSP has no 'unsafe-inline',
	   so an inline style is dropped and the fill silently renders at its default width. */
	for (const fill of el.usage.querySelectorAll(".fill")) fill.style.width = `${fill.dataset.pct}%`
}

/* The reset that matters is the one currently constraining you, falling back to the longest-dated limit. */
function resetLabel(limits) {
	const pick = limits.find((limit) => limit.active && limit.resetsAt) || limits.filter((limit) => limit.resetsAt).sort((a, b) => b.resetsAt - a.resetsAt)[0]
	if (!pick) return ""
	const when = new Date(Math.round(pick.resetsAt / 60000) * 60000)		// Claude reports 01:59:59, which reads as 2am
	const hours = when.getHours()
	const suffix = hours < 12 ? "am" : "pm"
	const hour12 = hours % 12 === 0 ? 12 : hours % 12
	const minutes = when.getMinutes()
	const clock = `${hour12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}${suffix}`
	return `Resets ${clock} ${dayLabel(when)}`
}

function dayLabel(when) {
	const midnight = new Date()
	midnight.setHours(0, 0, 0, 0)
	const days = Math.floor((when - midnight) / 86400000)
	if (days <= 0) return "today"
	if (days === 1) return "tomorrow"
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][when.getDay()]
}

function barTooltip(limit) {
	const reset = limit.resetsAt ? ` · resets in ${age(limit.resetsAt - Date.now())}` : ""
	return `${limit.label}: ${limit.percent}% used${limit.active ? " (currently limiting)" : ""}${reset}`
}

function renderEmpty(scopedCount) {
	const reason = scopedCount === 0 ? "No conversations for this project yet." : "Nothing matches the current search and filter."
	el.empty.innerHTML = `${escape(reason)}<br><button type="button">Reset filters</button>`
	el.empty.querySelector("button").addEventListener("click", () => {
		ui.query = ""
		ui.chip = "all"
		el.search.value = ""
		save()
		vscode.postMessage({ type: "selectProject", cwd: "" })
		render()
	})
}

// --- LIST RECONCILE ---

/* Flat rows, or group headers interleaved when grouping is on. Keys let reconcile move nodes instead of rebuilding them. */
function entriesFor(rows) {
	if (!data.groupByProject) return rows.map((row) => ({ key: `r:${row.sessionId}`, kind: "row", row }))
	const entries = []
	let current = null
	for (const row of rows) {
		if (row.cwd !== current) { current = row.cwd; entries.push({ key: `g:${current}`, kind: "group", label: row.projectName || "(unknown)" }) }
		entries.push({ key: `r:${row.sessionId}`, kind: "row", row })
	}
	return entries
}

/* Update in place and re-append in order. Touching only what changed keeps the spinner from restarting on every tick. */
function reconcile(entries) {
	const seen = new Set()
	for (const entry of entries) {
		seen.add(entry.key)
		let node = nodes.get(entry.key)
		if (!node) { node = entry.kind === "group" ? makeGroup() : makeRow(); nodes.set(entry.key, node) }
		if (entry.kind === "group") { if (node.textContent !== entry.label) node.textContent = entry.label }
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
	const node = document.createElement("div")
	node.className = "groupHead"
	return node
}

function makeRow() {
	const node = document.createElement("div")
	node.className = "row"
	node.setAttribute("role", "listitem")
	node.tabIndex = 0
	node.innerHTML = `<div class="gutter"><span class="icon"></span><span class="time"></span><span class="model"></span><span class="perm"></span><button class="remote" type="button" tabindex="-1">${ICONS.monitor}</button></div><div class="body"><div class="title"></div><div class="activity"></div><div class="prompt"></div><div class="meta"></div><div class="files"></div></div><button class="kebab" type="button" tabindex="-1" aria-label="More actions">&#8942;</button>`
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
	const meta = metaFor(row)
	node.querySelector(".meta").hidden = !meta
	setHtml(node, "meta", meta)
	const remote = node.querySelector(".remote")
	remote.hidden = !row.remoteActive		// purely an indicator now — connecting happens from the row menu
	setClass(remote, `remote${row.remoteActive ? " on" : ""}`)
	remote.title = row.remoteActive ? "Remote Control is active — this conversation is reachable from the Claude mobile app" : ""
	remote.setAttribute("aria-pressed", String(!!row.remoteActive))
	setPermission(node, row.state === "closed" ? "" : row.permissionMode, row.permissionModeStale)		// a closed conversation's mode is noise, and an empty slot would leave a gap
	setText(node, "model", row.modelLabel)
	node.querySelector(".model").title = row.modelLabel ? `Model: ${row.modelLabel}` : ""
	setFiles(node, row)
}

/* Permission mode icon. Rewritten only when the mode or its confidence changes.
   Claude records the mode only on the odd user record — 10 times in a 1500-record session — and never when you toggle it mid-run, so a reading can easily predate the current turn. Those are shown faded and say so, rather than asserting a mode that may have changed. */
function setPermission(node, mode, stale) {
	const key = `${mode}|${stale ? "stale" : "fresh"}`
	if (node.dataset.permMode === key) return
	node.dataset.permMode = key
	const perm = node.querySelector(".perm")
	const spec = PERMISSIONS[mode]
	const art = (window.MODE_ICONS || {})[mode] || (mode === "dontAsk" ? (window.MODE_ICONS || {}).bypassPermissions : "")
	perm.innerHTML = art || ""
	perm.className = `perm${spec?.danger ? " danger" : ""}${stale ? " unsure" : ""}`
	perm.hidden = !art
	perm.title = art ? `${spec ? spec.label : mode}${stale ? " — last known; Claude does not record mid-run changes, so enable precise status for a live reading" : ""}` : ""
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
	if (state === "needs-input?") { icon.className = "icon hand uncertain"; icon.innerHTML = ICONS.hand; return }
	if (state === "finished") { icon.className = "icon check"; icon.innerHTML = ICONS.check; return }
	if (state === "reviewed") { icon.className = "icon check seen"; icon.innerHTML = ICONS.check; return }
	icon.className = state === "error" ? "icon bullet error" : "icon bullet"
	icon.innerHTML = ""
}

function rowTint(state) {
	if (isWaiting(state)) return "tintAttention"
	if (state === "finished") return "tintDone"
	if (state === "closed") return "dim"
	return ""
}

/* Returns markup, not text: the project name is bold while the branch stays plain. */
function metaFor(row) {
	const parts = []
	if (showProjectName(row) && row.projectName) parts.push(`<span class="proj">${escape(row.projectName)}</span>`)
	if (row.gitBranch) parts.push(escape(row.gitBranch))
	return parts.join(" · ")
}

function activityClass(state) {
	if (state === "busy") return "working"
	if (isWaiting(state)) return "attention"
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
	menu.innerHTML = `<button data-act="open" type="button">Open conversation</button><button data-act="remoteInSession" type="button">${remoteOn ? "Manage Remote Control" : "Remote control this conversation"}</button><button data-act="reveal" type="button">Reveal transcript</button><button data-act="copyId" type="button">Copy session ID</button><button data-act="openFolder" type="button">Open folder in new window</button>`
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

function isWaiting(state) { return state === "needs-input" || state === "needs-input?" }

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
