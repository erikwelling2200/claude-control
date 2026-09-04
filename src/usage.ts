import * as fs from "fs"
import * as path from "path"
import { claudeRoot } from "./paths"
import { configFile } from "./trust"
import type { UsageLimit, UsageSnapshot } from "./types"

// --- USAGE LIMITS ---

/* Claude caches its own limit utilisation in ~/.claude.json under cachedUsageUtilization. The `limits` array is already normalised into the three bars the panel wants — session, weekly (all models) and the weekly model-scoped cap — so the legacy five_hour/seven_day keys are ignored. */

const EMPTY: UsageSnapshot = { limits: [], fetchedAt: 0 }

let cache: UsageSnapshot = EMPTY
let cachedMtime = -1

let scriptCache: UsageSnapshot = EMPTY
let scriptCachedMtime = -1

/* Two sources. The CLI writes cachedUsageUtilization into ~/.claude.json, but only from an interactive
   session — a headless `claude -p /usage` never moves it, so that source can be hours old. The
   session-usage skill fetches /api/oauth/usage itself and lands the body in ~/.claude/usage-cache.json.
   Whichever was fetched last is the current reading. */
export function readUsage(): UsageSnapshot {
	const fromConfig = readConfigUsage()
	const fromScript = readScriptUsage()
	return fromScript.fetchedAt > fromConfig.fetchedAt ? fromScript : fromConfig
}

/* Re-parse only when the config file has actually changed: it is ~40 KB and this is called on every tick. */
function readConfigUsage(): UsageSnapshot {
	const file = configFile()
	let mtimeMs: number
	try { mtimeMs = fs.statSync(file).mtimeMs } catch { return EMPTY }
	if (mtimeMs === cachedMtime) return cache
	cachedMtime = mtimeMs
	cache = parseUsage(file)
	return cache
}

/* Where the session-usage skill parks its own reading of /api/oauth/usage. */
function usageCacheFile(): string {
	return path.join(claudeRoot(), "usage-cache.json")
}

function readScriptUsage(): UsageSnapshot {
	const file = usageCacheFile()
	let mtimeMs: number
	try { mtimeMs = fs.statSync(file).mtimeMs } catch { return EMPTY }
	if (mtimeMs === scriptCachedMtime) return scriptCache
	scriptCachedMtime = mtimeMs
	scriptCache = parseUsageCache(file)
	return scriptCache
}

/* Only the windows worth a bar. The endpoint also returns internal codenames whose meaning is not
   stable enough to label, and nulls for every window the plan does not have. */
const USAGE_WINDOWS: { key: string, kind: string, label: string, always?: boolean }[] = [
	{ key: "five_hour", kind: "session", label: "Session", always: true },
	{ key: "seven_day", kind: "weekly_all", label: "Week", always: true },
	{ key: "seven_day_opus", kind: "weekly_opus", label: "Opus" },
	{ key: "seven_day_sonnet", kind: "weekly_sonnet", label: "Sonnet" }
]

/* The endpoint keys each window by name; the config file stores an array of limits. Same numbers, so
   this converts into the shape the panel already renders. */
function parseUsageCache(file: string): UsageSnapshot {
	let entry: any
	try { entry = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return EMPTY }
	const body = entry?.body
	if (!body) return EMPTY
	const limits: UsageLimit[] = []
	for (const window of USAGE_WINDOWS) {
		const raw = body[window.key]
		const percent = Number(raw?.utilization)
		if (!Number.isFinite(percent)) continue
		const rounded = Math.max(0, Math.min(100, Math.round(percent)))
		if (!window.always && rounded === 0) continue		// a plan without this cap reads as a flat zero
		limits.push({
			kind: window.kind,
			label: window.label,
			percent: rounded,
			severity: severityFor({}, rounded),
			resetsAt: Date.parse(raw?.resets_at || "") || 0,
			active: rounded > 0
		})
	}
	if (!limits.length) return EMPTY
	return { limits, fetchedAt: Number(entry?.fetchedAt || 0) }
}

function parseUsage(file: string): UsageSnapshot {
	let config: any
	try { config = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return EMPTY }
	const cached = config?.cachedUsageUtilization
	const raw = cached?.utilization?.limits
	if (!Array.isArray(raw)) return EMPTY
	const limits: UsageLimit[] = []
	for (const entry of raw) {
		const percent = Number(entry?.percent)
		if (!Number.isFinite(percent)) continue
		limits.push({
			kind: String(entry.kind || ""),
			label: labelFor(entry),
			percent: Math.max(0, Math.min(100, Math.round(percent))),
			severity: severityFor(entry, percent),
			resetsAt: Date.parse(entry?.resets_at || "") || 0,
			active: !!entry?.is_active
		})
	}
	return { limits, fetchedAt: Number(cached?.fetchedAtMs || 0) }
}

/* A scoped weekly limit names its model, which is the only way to tell the Opus cap from the Fable one. */
function labelFor(entry: any): string {
	const model = entry?.scope?.model?.display_name
	if (model) return String(model)
	if (entry?.kind === "session") return "Session"
	if (entry?.kind === "weekly_all") return "Week"
	return String(entry?.group || entry?.kind || "Limit")
}

/* Trust Claude's own severity, but never report "normal" for a bar that is visibly nearly full. */
function severityFor(entry: any, percent: number): UsageLimit["severity"] {
	const given = String(entry?.severity || "")
	if (given === "critical" || percent >= 90) return "critical"
	if (given === "warning" || percent >= 75) return "warning"
	return "normal"
}
