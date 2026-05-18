# pi Configuration

Personal configuration for [pi](https://github.com/earendil-works/pi-coding-agent) — the AI coding agent harness.

## What's Included

- **Settings** — `settings.json` (default model, theme, steering mode, etc.)
- **Models** — `models.json` (provider/model configuration)
- **Extensions** — Custom pi extensions (`extensions/`)
  - `azure-foundry/` — Azure AI Foundry provider
  - `exa.ts` — Exa web search integration
  - `firecrawl.ts` — Firecrawl scraping integration
  - `flow-title.ts` — Dynamic flow title generation
  - `llamacpp.ts` — llama.cpp provider
  - `searxng.ts` — SearXNG search integration
  - `gen-pi-logo.mjs` — Logo generation script
- **Disabled Extensions** — `extensions.disabled/`
- **Skills** — Custom agent skills (`skills/`)
  - `web-research/` — Web research skill
- **Themes** — Custom TUI themes (`themes/` & `themes.disabled/`)
  - `trans-pride.json`
  - `catppuccin-mocha.json`

## Installation

Copy the contents of `agent/` into your pi agent directory (usually `~/.pi/agent/`):

```bash
cp -r agent/* ~/.pi/agent/
```

> ⚠️ **Note:** This repo excludes sensitive files like `auth.json` and `azure-foundry.json`. You will need to re-enter API keys and credentials after installing.
