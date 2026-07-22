# Pi config

Personal, portable configuration for [Pi](https://github.com/earendil-works/pi-mono), including extensions, skills, themes, model definitions, settings, and keybindings.

## Interface

- `trans-pride` theme and gradient startup title
- Rounded, fully closed chat input
- Compact custom footer with context usage, cost, and token speed
- [`@wierdbytes/pi-facelift`](https://pi.dev/packages/@wierdbytes/pi-facelift) for built-in tool rendering and syntax-highlighted diffs
- Closed, rounded Facelift-compatible frames for custom tools, including workflows, subagents, background terminals, file search, Firecrawl, Ask User, and Trope CUA
- Facelift's `Working…` timer and duplicate TPS display are disabled in `agent/wierd-facelift/config.json`; TPS remains in the custom footer

## Restore

Clone the repository, review the files, then copy `agent/` into `~/.pi/agent/`.

```bash
cp -R agent/. ~/.pi/agent/
```

Start Pi once so packages declared in `agent/settings.json` are installed, then run `/reload` after changing extensions.

## Package updates

Update Pi and installed packages with:

```bash
pi update --all
```

Third-party package updates can replace local changes inside `~/.pi/agent/npm/`. Review the Facelift frame behavior after updating.

## Never committed

- `.env`, `auth.json`, provider credentials, and trust decisions
- sessions and workflow run artifacts
- dependencies, binaries, caches, and backups
