# Pi config

Personal, portable configuration for [Pi](https://github.com/earendil-works/pi-mono), including extensions, skills, themes, model definitions, settings, and keybindings.

## Interface

- `trans-pride` theme and gradient startup title
- Rounded, fully closed chat input
- Compact custom footer with context usage, cost, and token speed
- [`@wierdbytes/pi-facelift`](https://pi.dev/packages/@wierdbytes/pi-facelift) for built-in tool rendering and syntax-highlighted diffs
- Closed, rounded Facelift-compatible frames for custom tools, including workflows, subagents, background terminals, file search, Firecrawl, Ask User, and Trope CUA
- Matching interactive workflow and subagent dashboards, with closed panels and accent-colored keyboard focus
- Facelift's `Working…` timer and duplicate TPS display are disabled; TPS remains in the custom footer

## Restore

Clone the repository, review the files, then copy `agent/` into `~/.pi/agent/`.

```bash
cp -R agent/. ~/.pi/agent/
```

Apply the platform filter from the installed copy:

```bash
node ~/.pi/agent/scripts/configure-platform.mjs
```

On Linux, this removes the Trope CUA extension entirely. On Windows and macOS it remains available, but the native `trope-cua` command must be installed separately. The extension also has a runtime platform guard, so it never registers on Linux even if the filter is skipped.

Start Pi once so packages declared in `agent/settings.json` are installed. Then apply the portable closed-frame patch:

```bash
node ~/.pi/agent/scripts/patch-facelift.mjs
```

Run the patch again after Facelift package updates.

For Facelift syntax highlighting and to suppress its duplicate working metrics, configure the environment before starting Pi.

Linux and macOS (`~/.profile`, `~/.zprofile`, or the relevant shell profile):

```bash
export FACELIFT_THEME=catppuccin-mocha
export FACELIFT_SHOW_WORKING_TIME=0
```

Windows PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("FACELIFT_THEME", "catppuccin-mocha", "User")
[Environment]::SetEnvironmentVariable("FACELIFT_SHOW_WORKING_TIME", "0", "User")
```

The Facelift config in `agent/wierd-facelift/config.json` also keeps its working timer disabled. Run `/reload` after changing extensions or applying the frame patch.

## Package updates

Update Pi and installed packages with:

```bash
pi update --all
```

Third-party package updates can replace local changes inside `~/.pi/agent/npm/`. Run `node ~/.pi/agent/scripts/patch-facelift.mjs` after updating.

## Platform support

- Linux: all UI, workflow, subagent, search, Firecrawl, and background-terminal features; no Trope CUA installation or tool registration
- macOS: the same features, plus Trope CUA when its native command is installed
- Windows: the same features, plus Trope CUA when its native command is installed
- Background terminals use `sh -c` on Linux/macOS and PowerShell 7 on Windows

## Never committed

- `.env`, `auth.json`, provider credentials, and trust decisions
- sessions and workflow run artifacts
- dependencies, binaries, caches, and backups
