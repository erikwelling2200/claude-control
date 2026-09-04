import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/* Iterating on this extension does NOT go through vsce: `npm run package` builds a .vsix for shipping, and installing one
   is just an unzip into ~/.vscode/extensions. So for a local edit we copy the build output over that unzipped folder
   directly, which turns a package-and-reinstall into a file copy. Only the files VS Code actually loads are copied —
   the manifest, the bundle and the webview assets. */

const repo = path.resolve(import.meta.dirname, "..")
const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"))
const target = installedDir(`${manifest.publisher}.${manifest.name}`)

/* The bundle is what an extension-host restart picks up; media/ is what a webview reload picks up. package.json comes
   along because a contributes/commands edit is otherwise invisible until the next real install. */
copyFile(path.join("dist", "extension.js"))
copyFile(path.join("dist", "extension.js.map"))
copyFile("package.json")
for (const asset of fs.readdirSync(path.join(repo, "media"))) copyFile(path.join("media", asset))

console.log(`deployed to ${target}`)
console.log("reload: media/* only → 'Developer: Reload Webviews'; src/* → 'Developer: Restart Extension Host'")

// --- HELPERS ---

/* VS Code stamps the version into the folder name, so the path moves on every version bump. Match on publisher.name and
   take the newest, rather than hardcoding a version that goes stale. */
function installedDir(id) {
	const root = path.join(os.homedir(), ".vscode", "extensions")
	const matches = fs.readdirSync(root).filter((name) => name.startsWith(`${id}-`) && fs.statSync(path.join(root, name)).isDirectory())
	if (matches.length === 0) throw new Error(`${id} is not installed under ${root} — install the .vsix once before deploying over it`)
	return path.join(root, matches.sort().at(-1))
}

/* An installed extension VS Code has never loaded has no folder to write into, and a silently skipped file would look
   like the edit did not take — so a missing source or destination is an error, not a warning. */
function copyFile(relative) {
	const from = path.join(repo, relative)
	const to = path.join(target, relative)
	if (!fs.existsSync(from)) throw new Error(`${relative} is missing from the repo — run 'npm run build' first`)
	fs.mkdirSync(path.dirname(to), { recursive: true })
	fs.copyFileSync(from, to)
}
