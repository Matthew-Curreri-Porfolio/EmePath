import * as vscode from "vscode";
import * as fs from "fs";
import { TextDecoder } from "util";

/*───────────────────────────────────────────────────────────────────────────*\
|  Globals / config                                                          |
\*───────────────────────────────────────────────────────────────────────────*/

let status: vscode.StatusBarItem;
let inlineEnabled = true;
let gatewayUrl = "http://127.0.0.1:3030";
let disposableProvider: vscode.Disposable | null = null;

const cfgKey = "codexz";
const out: vscode.OutputChannel = vscode.window.createOutputChannel("Codexz");

function log(event: string, data?: unknown) {
  const line =
    "[codexz] " +
    event +
    (data !== undefined ? " " + JSON.stringify(data) : "");
  console.log(line);
  out.appendLine(line);
}

/*───────────────────────────────────────────────────────────────────────────*\
|  Types                                                                      |
\*───────────────────────────────────────────────────────────────────────────*/

type WebviewToHostMessage =
  | { type: "scan" }
  | { type: "terminal" }
  | { type: "runShell"; code: string }
  | { type: string; [k: string]: unknown };

/*───────────────────────────────────────────────────────────────────────────*\
|  Health / completion                                                        |
\*───────────────────────────────────────────────────────────────────────────*/

async function health(): Promise<boolean> {
  try {
    const r = await fetch(`${gatewayUrl}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function complete(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<string> {
  const pre = doc.getText(
    new vscode.Range(new vscode.Position(Math.max(0, pos.line - 50), 0), pos)
  );
  const suf = doc.getText(
    new vscode.Range(
      pos,
      new vscode.Position(Math.min(doc.lineCount - 1, pos.line + 50), 1e6)
    )
  );
  const body = {
    language: doc.languageId,
    prefix: pre,
    suffix: suf,
    path: doc.uri.fsPath,
    cursor: { line: pos.line, ch: pos.character },
    budgetMs: 350
  };
  const r = await fetch(`${gatewayUrl}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`gateway ${r.status}`);
  return r.text();
}

/*───────────────────────────────────────────────────────────────────────────*\
|  Settings                                                                   |
\*───────────────────────────────────────────────────────────────────────────*/

function applyConfig(): void {
  const cfg = vscode.workspace.getConfiguration(cfgKey);

  const gw = cfg.get("gatewayUrl");
  if (typeof gw === "string" && gw.length > 0) gatewayUrl = gw;

  const ie = cfg.get("inlineEnabled");
  inlineEnabled = typeof ie === "boolean" ? ie : true;

  if (status) status.tooltip = `Gateway: ${gatewayUrl}`;
  log("config", { gatewayUrl, inlineEnabled });

  if (disposableProvider) {
    disposableProvider.dispose();
    disposableProvider = null;
  }

  if (inlineEnabled) {
    const provider: vscode.InlineCompletionItemProvider = {
      async provideInlineCompletionItems(
        doc,
        pos
      ): Promise<
        vscode.InlineCompletionList | vscode.InlineCompletionItem[] | undefined
      > {
        log("inline/provider_fired", {
          file: doc.uri.fsPath,
          line: pos.line,
          ch: pos.character
        });
        try {
          const text = await complete(doc, pos);
          if (!text) return;
          return { items: [{ insertText: text }] };
        } catch (e: any) {
          log("inline/error", { message: e?.message || String(e) });
          if (status) status.text = "Codexz: FAILED";
          return;
        }
      }
    };
    disposableProvider = vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**/*" },
      provider
    );
  }
}

/*───────────────────────────────────────────────────────────────────────────*\
|  Webview loader                                                             |
\*───────────────────────────────────────────────────────────────────────────*/

function nonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++)
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

async function renderWebviewHtml(
  ctx: vscode.ExtensionContext,
  webview: vscode.Webview
): Promise<string> {
  const n = nonce();
  const csp =
    `default-src 'none'; ` +
    `style-src 'unsafe-inline'; ` +
    `img-src https: data:; ` +
    `script-src 'nonce-${n}'; ` +
    `connect-src http: https:;`;

  const htmlUri = vscode.Uri.joinPath(ctx.extensionUri, "media", "chat.html");
  const fsPath = htmlUri.fsPath;

  try {
    const html = fs.readFileSync(fsPath, "utf8");
    log("webview/html_loaded_fs", { path: fsPath });
    return html
      .replace(/{{CSP}}/g, csp)
      .replace(/{{NONCE}}/g, n)
      .replace(/{{GATEWAY}}/g, gatewayUrl);
  } catch (e1: any) {
    try {
      const bytes = await vscode.workspace.fs.readFile(htmlUri);
      const html = new TextDecoder("utf-8").decode(bytes);
      log("webview/html_loaded_vscodefs", { path: fsPath });
      return html
        .replace(/{{CSP}}/g, csp)
        .replace(/{{NONCE}}/g, n)
        .replace(/{{GATEWAY}}/g, gatewayUrl);
    } catch (e2: any) {
      const msg1 = e1?.message || String(e1);
      const msg2 = e2?.message || String(e2);
      log("webview/html_failed", { fsPath, msg1, msg2 });

      return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Codexz Chat</title></head>
<body style="font-family:system-ui;padding:16px;color:#e6e6e6;background:#0f111a">
<h3>Codexz</h3>
<p>Missing or unreadable <code>media/chat.html</code>. Reload after creating it.</p>
<p><b>Resolved path</b>: <code>${fsPath}</code></p>
<p><b>fs.readFileSync</b>: ${msg1}</p>
<p><b>workspace.fs.readFile</b>: ${msg2}</p>
</body></html>`;
    }
  }
}

/*───────────────────────────────────────────────────────────────────────────*\
|  Webview panel & bridge                                                     |
\*───────────────────────────────────────────────────────────────────────────*/

function openChatPanel(ctx: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "codexzChat",
    "Codexz Chat",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")]
    }
  );

  renderWebviewHtml(ctx, panel.webview).then((html) => {
    panel.webview.html = html;
  });

  panel.onDidDispose(() => log("webview/dispose"));

  panel.webview.onDidReceiveMessage(async (raw: WebviewToHostMessage) => {
    const msg = raw ?? ({ type: "" } as WebviewToHostMessage);
    log("webview/msg_in", { type: msg.type });

    switch (msg.type) {
      case "scan": {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          panel.webview.postMessage({
            type: "scanResult",
            ok: false,
            error: "No workspace open"
          });
          break;
        }
        try {
          log("scan/start", { root });
          const r = await fetch(`${gatewayUrl}/scan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ root, maxFileSize: 262144 })
          });
          const data: any = await r.json().catch(() => ({} as any));
          log("scan/done", { ok: r.ok, count: data?.count, root: data?.root });
          panel.webview.postMessage({
            type: "scanResult",
            ok: r.ok,
            data,
            error: r.ok ? undefined : (data?.error || "scan failed")
          });
        } catch (e: any) {
          const err = e?.message || String(e);
          log("scan/error", { err });
          panel.webview.postMessage({
            type: "scanResult",
            ok: false,
            error: err
          });
        }
        break;
      }

      case "terminal": {
        log("terminal/open");
        ensureTerminal().show();
        break;
      }

      case "runShell": {
        const code = (msg as any).code;
        if (typeof code !== "string") {
          log("runShell/invalid", { reason: "code not string" });
          break;
        }

        const term = ensureTerminal();
        term.show();

        // Start in workspace root if available
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (cwd) {
          log("runShell/cd", { cwd });
          term.sendText(`cd ${JSON.stringify(cwd)} || pwd`, true);
        }

        // Normalize and run line-by-line for reliability
        const lines = code.replace(/\r/g, "").split("\n");
        log("runShell/dispatch", { lines: lines.length });
        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          if (!line) continue;
          term.sendText(line, true); // true = execute
        }
        break;
      }

      default: {
        log("webview/msg_unknown", { type: (msg as any)?.type });
        break;
      }
    }
  });
}

/*───────────────────────────────────────────────────────────────────────────*\
|  Terminal                                                                   |
\*───────────────────────────────────────────────────────────────────────────*/

let codexzTerminal: vscode.Terminal | null = null;

function ensureTerminal(): vscode.Terminal {
  if (codexzTerminal && !codexzTerminal.exitStatus) return codexzTerminal;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  codexzTerminal = vscode.window.createTerminal({ name: "Codexz", cwd });
  codexzTerminal.processId?.then((pid) => log("terminal/new", { pid, cwd }));
  return codexzTerminal;
}

/*───────────────────────────────────────────────────────────────────────────*\
|  Activate / Deactivate                                                       |
\*───────────────────────────────────────────────────────────────────────────*/

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  out.show(true);
  log("activate");

  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1000
  );
  status.text = "Codexz: …";
  status.command = "codexz.openChat";
  status.show();
  ctx.subscriptions.push(status);

  applyConfig();
  status.text = (await health()) ? "Codexz: Connected" : "Codexz: FAILED";

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(cfgKey)) applyConfig();
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codexz.ping", async () => {
      status.text = "Codexz: …";
      status.text = (await health()) ? "Codexz: Connected" : "Codexz: FAILED";
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codexz.test", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        vscode.window.showWarningMessage("Open a file.");
        return;
      }
      try {
        const outText = await complete(ed.document, ed.selection.active);
        vscode.window.showInformationMessage(
          `Completion: ${outText.slice(0, 120)}…`
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(
          `Completion failed: ${e?.message || e}`
        );
      }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codexz.toggleInline", async () => {
      const cfg = vscode.workspace.getConfiguration(cfgKey);
      await cfg.update(
        "inlineEnabled",
        !inlineEnabled,
        vscode.ConfigurationTarget.Global
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("codexz.openChat", () =>
      openChatPanel(ctx)
    )
  );

  log("ready");
}

export function deactivate(): void {
  log("deactivate");
}
