import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { RegistryEntry, registryPath, removeEntry, upsertEntry } from './registry';

// Lets external programs focus a specific integrated terminal in a specific
// VS Code window by shell PID. Each window's extension instance maintains
// its entry in a shared on-disk registry, and a windowKey-gated URI handler
// (`vscode://mshakeg.terminal-focus/focus?pid=<N>&w=<windowKey>`) calls
// terminal.show() on the matching terminal.

// Generated fresh per extension-host activation. Using vscode.env.sessionId
// would be tempting (it's "per session") but the docs don't guarantee
// per-window uniqueness — if VS Code's session semantics ever change to be
// per-app rather than per-window, two windows would publish the same key
// and clobber each other's registry entries. randomUUID() sidesteps that.
const windowKey = randomUUID();

function workspacePath(): string {
  // For multi-root workspaces, prefer the .code-workspace file's path so
  // `code <workspace>` reopens the existing multi-root window rather than
  // opening the first folder as its own single-root window.
  return vscode.workspace.workspaceFile?.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? '';
}

function bestEffortTitle(): string {
  const name = vscode.workspace.workspaceFolders?.[0]?.name ?? 'Untitled';
  return `${name} — Visual Studio Code`;
}

async function snapshotPids(): Promise<number[]> {
  const pids: number[] = [];
  for (const term of vscode.window.terminals) {
    try {
      const pid = await term.processId;
      if (typeof pid === 'number' && pid > 0) {
        pids.push(pid);
      }
    } catch {
      // ignore
    }
  }
  return pids;
}

async function publish(): Promise<void> {
  const entry: RegistryEntry = {
    windowKey,
    workspace: workspacePath(),
    title: bestEffortTitle(),
    pids: await snapshotPids(),
    updatedAt: 0,
  };
  try {
    await upsertEntry(entry);
  } catch (err) {
    console.error('[terminal-focus] failed to publish registry entry:', err);
  }
}

async function unpublish(): Promise<void> {
  try {
    await removeEntry(windowKey);
  } catch (err) {
    console.error('[terminal-focus] failed to remove registry entry:', err);
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        if (uri.path !== '/focus') {
          return;
        }
        const params = new URLSearchParams(uri.query);

        // windowKey gate: when set, only the matching window acts. Lets the
        // caller (notify.sh) target a specific window even if macOS routes
        // the URI to a different VS Code window's extension host first.
        // Backward compatible: omit `w` and the handler falls back to
        // matching by PID across whichever window receives the URI.
        const wantedWindow = params.get('w');
        if (wantedWindow && wantedWindow !== windowKey) {
          return;
        }

        const pidParam = params.get('pid');
        const targetPid = pidParam !== null ? Number(pidParam) : NaN;
        if (!Number.isFinite(targetPid) || targetPid <= 0) {
          return;
        }
        for (const term of vscode.window.terminals) {
          let pid: number | undefined;
          try {
            pid = await term.processId;
          } catch {
            continue;
          }
          if (pid === targetPid) {
            term.show();
            return;
          }
        }
      },
    }),
  );

  // Refresh the registry on terminal lifecycle changes. processId is a
  // Promise that resolves after the shell PTY is up, so onDidOpenTerminal
  // can fire slightly before the PID is available — snapshotPids() awaits
  // each Promise, so the next refresh picks it up.
  ctx.subscriptions.push(vscode.window.onDidOpenTerminal(() => { void publish(); }));
  ctx.subscriptions.push(vscode.window.onDidCloseTerminal(() => { void publish(); }));

  // Initial snapshot. Defer slightly so terminals that already exist when
  // the extension activates have a chance to report their PIDs.
  void publish();
  setTimeout(() => { void publish(); }, 1500);

  // Best-effort cleanup on window close. VS Code calls deactivate when the
  // window closes; stale entries also age out after 24h on the next publish.
  ctx.subscriptions.push({ dispose: () => { void unpublish(); } });
}

export async function deactivate(): Promise<void> {
  await unpublish();
}

export { registryPath };
