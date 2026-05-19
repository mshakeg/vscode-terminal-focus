# terminal-focus

Tiny VS Code extension that lets external programs focus a specific integrated terminal by shell PID, even when the user is currently in a different VS Code window.

Built as the companion to the shared notification-hook library [`mshakeg/notify-hook`](https://github.com/mshakeg/notify-hook), which drives both [Claude Code](https://github.com/mshakeg/claude-dotfiles) and Codex CLI dotfiles: clicking a desktop notification jumps directly to the terminal pane that fired it, rather than only the workspace window.

## How it works

- On activation, the extension registers its window in a shared on-disk registry at `~/Library/Application Support/code-terminal-focus/windows.json`. Each entry: `{ windowKey, workspace, title, pids, updatedAt }`. The `pids` array is refreshed on every `onDidOpenTerminal` / `onDidCloseTerminal`.
- The extension registers a URI handler for `vscode://mshakeg.terminal-focus/focus?pid=<N>&w=<windowKey>`. On invoke it:
  - if `w` is present and doesn't match this window's `windowKey`, returns silently (so only the targeted window acts even if macOS routes the URI to the wrong host);
  - otherwise iterates `vscode.window.terminals`, awaits each `processId`, and calls `terminal.show()` on the matching one.

`notify.sh` does the lookup → window-raise → URI-dispatch dance:

```
$ jq lookup PID 49268 in windows.json
  → windowKey: 25ed526f-..., workspace: /Users/me/dev/dotfiles
$ code /Users/me/dev/dotfiles            # bring that VS Code window to the front
$ open 'vscode://mshakeg.terminal-focus/focus?pid=49268&w=25ed526f-...'
```

Why `code <path>` and not `code -r <path>`: the `-r` flag means "reuse the LAST ACTIVE window, force-open path there", which can replace the workspace of whichever window happened to be frontmost. Plain `code <path>` finds an existing window matching the workspace and focuses it.

## Build & install

```bash
npm install
npm run package        # typechecks, bundles via esbuild, emits .vsix
code --install-extension terminal-focus-*.vsix
```

Reload existing VS Code windows after first install (Cmd+Shift+P → "Developer: Reload Window") so the registry-writing activation logic runs.

For iteration: open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Manual test

```bash
# 1. find a shell PID from the registry
jq -r '.windows[].pids[]' ~/Library/Application\ Support/code-terminal-focus/windows.json

# 2. dispatch the focus URI
open 'vscode://mshakeg.terminal-focus/focus?pid=<PID>'
```

If you have multiple VS Code windows, also pass `&w=<windowKey>` so only the matching window's extension acts.

## Limitations

- macOS only (uses macOS-specific `Application Support` registry path).
- Multi-window dispatch relies on `code <path>` bringing the target VS Code window to the foreground before the URI is dispatched, because macOS routes a `vscode://` URI to whichever VS Code window is topmost at the moment of receipt. If `code` can't connect to the running VS Code instance (e.g. PATH issues, no VS Code app installed at the expected location), the URI may land on the wrong window — though the `windowKey` gate ensures it's at worst a silent no-op rather than focusing the wrong terminal.
