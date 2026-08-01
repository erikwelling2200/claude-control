import * as fs from "fs"
import { configFile } from "./trust"
import type { UsageLimit, UsageSnapshot } from "./types"

// --- USAGE LIMITS ---

/* Claude caches its own limit utilisation in ~/.claude.json under cachedUsageUtilization. The `limits` array is already normalised into the three bars the panel wants — session, weekly (all models) and the weekly model-scoped cap — so the legacy five_hour/seven_day keys are ignored. */

const EMPTY: UsageSnapshot = { limits: [], fetchedAt: 0 }

let cache: UsageSnapshot = EMPTY
let cachedMtime = -1

/* Re-parse only when the config file has actually changed: it is ~40 KB and this is called on every tick. */
export function readUsage(): UsageSnapshot {
	const file = configFile()
	let mtimeMs: number
	try { mtimeMs = fs.statSync(file).mtimeMs } catch { return EMPTY }
	if (mtimeMs === cachedMtime) return cache
	cachedMtime = mtimeMs
	cache = parseUsage(file)
	return cache
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
