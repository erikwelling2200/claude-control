import * as vscode from "vscode"
import type { PanelData } from "./types"

// --- VIEW PROVIDER ---

export interface ViewHandlers {
	open: (sessionId: string) => void
	toggleRemote: (cwd: string) => void
	remoteInSession: (sessionId: string) => void
	diffFile: (sessionId: string, file: string, version: number) => void
	refreshUsage: () => void
	reveal: (sessionId: string) => void
	copyId: (sessionId: string) => void
	kill: (sessionId: string) => void
	openFolder: (cwd: string) => void
	enablePreciseStatus: () => void
}

/* Hosts the conversation list. Everything is inlined from disk with a nonce so the strict CSP holds. */
export class SessionsView implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined
	private latest: PanelData | undefined

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly handlers: ViewHandlers,
		private readonly onVisibility: (visible: boolean) => void
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] }
		view.webview.html = this.html(view.webview)
		view.webview.onDidReceiveMessage((message) => this.receive(message))
		view.onDidChangeVisibility(() => this.onVisibility(view.visible))
		this.onVisibility(view.visible)
		if (this.latest) this.post(this.latest)
	}

	private receive(message: any): void {
		switch (message?.type) {
			case "ready": if (this.latest) this.post(this.latest); break
			case "open": this.handlers.open(String(message.sessionId || "")); break
			case "toggleRemote": this.handlers.toggleRemote(String(message.cwd || "")); break
			case "remoteInSession": this.handlers.remoteInSession(String(message.sessionId || "")); break
			case "diffFile": this.handlers.diffFile(String(message.sessionId || ""), String(message.file || ""), Number(message.version || 0)); break
			case "reveal": this.handlers.reveal(String(message.sessionId || "")); break
			case "copyId": this.handlers.copyId(String(message.sessionId || "")); break
			case "kill": this.handlers.kill(String(message.sessionId || "")); break
			case "openFolder": this.handlers.openFolder(String(message.cwd || "")); break
			case "refreshUsage": this.handlers.refreshUsage(); break
			case "enablePreciseStatus": this.handlers.enablePreciseStatus(); break
		}
	}

	/* Push new data, and mirror the waiting count into the view title so it is visible even when the list is filtered. */
	post(data: PanelData): void {
		this.latest = data
		if (!this.view) return
		this.view.webview.postMessage({ type: "data", data })
		this.view.description = data.needsInputTotal ? `${data.needsInputTotal} waiting` : ""
	}

	focusSearch(): void { this.view?.webview.postMessage({ type: "focusSearch" }) }

	/* Show everything, narrowed to conversations waiting on input. */
	showWaiting(): void {
		this.view?.show?.(true)
		this.view?.webview.postMessage({ type: "showWaiting" })
	}

	private html(webview: vscode.Webview): string {
		const nonce = makeNonce()
		const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.css"))
		const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "panel.js"))
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${css}" rel="stylesheet">
	<title>Claude Control</title>
</head>
<body>
	<div class="toolbar">
		<div class="searchWrap">
			<span class="searchIcon" aria-hidden="true">&#9906;</span>
			<input id="search" type="search" placeholder="Search title, prompt, project…" autocomplete="off" spellcheck="false" aria-label="Search conversations">
			<button id="clear" class="clear" type="button" title="Clear search" aria-label="Clear search" hidden>&#10005;</button>
		</div>
		<div class="row2">
			<span id="count" class="count"></span>
		</div>
		<div id="chips" class="chips" role="tablist"></div>
	</div>
	<div id="hint" class="hint" hidden></div>
	<div id="scroll" class="scroll">
		<div id="list" class="list" role="list"></div>
		<div id="empty" class="empty" hidden></div>
	</div>
	<button id="usage" class="usage" type="button" hidden></button>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`
	}
}

// --- HELPERS ---

function makeNonce(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	let nonce = ""
	for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)]
	return nonce
}
