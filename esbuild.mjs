import { build, context } from "esbuild"

// --- CONFIG ---

const watch = process.argv.includes("--watch")
const probe = process.argv.includes("--probe")

const extension = {
	entryPoints: ["src/extension.ts"],
	outfile: "dist/extension.js",
	bundle: true,
	platform: "node",
	target: "node20",
	format: "cjs",
	external: ["vscode"],
	sourcemap: true,
	logLevel: "info"
}

const probeBuild = {
	entryPoints: ["tools/probe.ts"],
	outfile: "dist/probe.mjs",
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	logLevel: "info"
}

// --- RUN ---

if (probe) await build(probeBuild)
else if (watch) {
	const ctx = await context(extension)
	await ctx.watch()
	console.log("watching…")
} else await build(extension)
