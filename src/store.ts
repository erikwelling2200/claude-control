import * as fs from "fs"
import * as path from "path"
import type { TranscriptRecord } from "./types"

// --- SCHEMA ---

/* Bump when TranscriptRecord changes shape so old caches self-invalidate instead of half-loading. */
const SCHEMA = 5
const SAVE_DEBOUNCE_MS = 2000

interface CacheFile {
	schema: number
	records: TranscriptRecord[]
}

// --- STORE ---

/* Scan results persisted between sessions so the panel can paint before touching a transcript. */
export class Store {
	private records = new Map<string, TranscriptRecord>()
	private timer: NodeJS.Timeout | undefined
	private dirty = false

	constructor(private readonly file: string) {}

	/* Read the cache from disk. Any problem simply yields an empty cache. */
	load(): void {
		let parsed: CacheFile
		try { parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) } catch { return }
		if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.records)) return
		for (const record of parsed.records) {
			if (record?.file && record.sessionId) this.records.set(record.file, record)
		}
	}

	cache(): Map<string, TranscriptRecord> { return this.records }

	all(): TranscriptRecord[] { return [...this.records.values()] }

	/* Swap in a fresh scan, dropping entries whose transcript has gone. */
	replace(records: TranscriptRecord[]): void {
		this.records = new Map(records.map((record) => [record.file, record]))
		this.markDirty()
	}

	put(record: TranscriptRecord): void {
		this.records.set(record.file, record)
		this.markDirty()
	}

	remove(file: string): void {
		if (this.records.delete(file)) this.markDirty()
	}

	private markDirty(): void {
		this.dirty = true
		if (this.timer) return
		this.timer = setTimeout(() => { this.timer = undefined; this.saveNow() }, SAVE_DEBOUNCE_MS)
	}

	/* Write the cache via a temp file + rename so a crash cannot leave a half-written index. */
	saveNow(): void {
		if (!this.dirty) return
		this.dirty = false
		const payload: CacheFile = { schema: SCHEMA, records: this.all() }
		const temp = `${this.file}.tmp`
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true })
			fs.writeFileSync(temp, JSON.stringify(payload))
			fs.renameSync(temp, this.file)
		} catch { /* cache is an optimisation; losing a write is survivable */ }
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		this.saveNow()
	}
}
