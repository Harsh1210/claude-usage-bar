<div align="center">

<img src="icon.png" alt="Claude Usage Bar" width="96" height="96">

# Claude Usage Bar

**Your Claude Code rate-limit usage, always visible in the VS Code status bar.**

Live session + weekly progress · color alerts at 70% / 90% · reset countdowns · zero extra API calls.

[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/HarshAgarwal1012.claude-usage-bar?label=marketplace&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=HarshAgarwal1012.claude-usage-bar)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/HarshAgarwal1012.claude-usage-bar)](https://marketplace.visualstudio.com/items?itemName=HarshAgarwal1012.claude-usage-bar)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

---

## Why

If you're on a Claude Code subscription, you're rate-limited on both a **5-hour session window** and a **weekly cap**. Claude's own panel surfaces this — but only when you open it. The moment you're heads-down coding in VS Code, you have no idea whether you're at 20% of your session or 95% and about to get cut off mid-refactor.

**Claude Usage Bar** puts your real-time usage in the VS Code status bar so you can glance at it like any other dev metric. And it does it **without making a single extra API call** — it passively intercepts Claude Code's own usage responses via Node.js `diagnostics_channel`.

---

## Table of Contents

- [Features](#features)
- [Status Bar Display](#status-bar-display)
- [How It Works](#how-it-works)
- [Install](#install)
- [Requirements](#requirements)
- [Settings](#settings)
- [Commands](#commands)
- [Known Limitations](#known-limitations)
- [Release Notes](#release-notes)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Live usage bar** — `S: ████████░░ 82% · 1h 12m` in the status bar, always visible
- **Session (5h) and weekly (7d) limits** tracked separately, with per-limit hover breakdown
- **Display mode** — show session, weekly, or both via settings or a one-keystroke toggle
- **Color alerts** — status bar turns yellow at 70% and red at 90%, so you can't miss it
- **Progress bar or circles** — choose Unicode block characters or filled circles (`●●●○○`)
- **Reset countdown** — ticks every 30 seconds; shows `2d 6h` for long weekly windows
- **Zero extra API calls** — passively reads Claude Code's own `/api/oauth/usage` responses via Node.js `diagnostics_channel`
- **Bootstrap on reload** — one API call on activation (via macOS Keychain OAuth) for instant fresh data
- **Background poll** — fetches fresh data every 5 minutes with proper `Retry-After` backoff on 429s
- **Persisted state** — last known usage survives VS Code restarts, so you never see a blank bar at startup
- **Click to refresh** — click the status bar to force an immediate fetch
- **Auto-reset on expiry** — usage resets to 0% the moment the session timer hits zero
- **Terminal fallback** — for terminal-based Claude sessions, a `statusLine` script writes to `~/.claude/usage-bar-data.json`, which the extension watches as a fallback source

---

## Status Bar Display

| Display | Meaning |
|---|---|
| `S: ████████░░ 82% · 1h 12m` | Session: 82% used, resets in 1h 12m |
| `S: ●●●●○○○○○○ 40% · 2h 45m` | Same thing, with circles (via `showProgressBar=false`) |
| `W: ████░░░░░░ 40% · 2d 6h` | Weekly: 40% used, resets in 2d 6h |
| `$(check) Usage OK` | Below all thresholds |
| **Yellow background** | ≥ 70% used |
| **Red background** | ≥ 90% used |

**Hover** the status bar for a full breakdown of all limits (session, weekly, Sonnet-specific, extra usage).
**Click** to force an immediate refresh.

---

## How It Works

Claude Code (the VS Code extension) and Claude Usage Bar both run inside the same **VS Code extension-host Node.js process**. That means this extension can use Node's built-in [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) to observe HTTP traffic that Claude Code itself makes to Anthropic.

When Claude Code calls `/api/oauth/usage` as part of its own UI rendering, the extension reads the response body passively — **zero extra network calls, zero extra auth**.

On activation, a single bootstrap call fetches fresh data immediately using OAuth credentials from the macOS Keychain. After that, every update flows in via passive interception.

```
┌──────────────────────────────────────────┐
│  VS Code Extension Host (Node.js)        │
│                                          │
│  ┌──────────────┐     ┌───────────────┐  │
│  │ Claude Code  │────▶│  diagnostics_ │  │
│  │  extension   │     │    channel    │  │
│  └──────────────┘     └───────┬───────┘  │
│         │                     │          │
│         ▼                     ▼          │
│   /api/oauth/usage     Claude Usage Bar  │
│   (Anthropic API)        reads payload   │
└──────────────────────────────────────────┘
                                │
                                ▼
                        Status bar update
```

For terminal-based Claude sessions, a `statusLine` script writes rate-limit data to `~/.claude/usage-bar-data.json`; the extension watches that file as a secondary source so you still see accurate usage even when you're not using the VS Code panel.

---

## Install

### From the VS Code Marketplace (recommended)

Search for **Claude Usage Bar** in the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`) and click **Install**, or:

```bash
code --install-extension HarshAgarwal1012.claude-usage-bar
```

### From a `.vsix` file

Download the latest `.vsix` from [Releases](https://github.com/Harsh1210/claude-usage-bar/releases), then:

```bash
code --install-extension claude-usage-bar-0.3.5.vsix
```

---

## Requirements

- **Claude Code** VS Code extension — [install from Anthropic](https://claude.ai/download) and sign in (OAuth, not API key)
- **macOS** — bootstrap fetch uses the macOS Keychain via the `security` CLI
  - _Windows / Linux support is tracked in [issues](https://github.com/Harsh1210/claude-usage-bar/issues)._

---

## Settings

All settings live under `claudeUsageBar.*` in VS Code settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `claudeUsageBar.displayMode` | `session` \| `weekly` \| `both` | `session` | Which rate limit(s) to show in the status bar |
| `claudeUsageBar.showProgressBar` | `boolean` | `true` | Use Unicode block progress bar; set `false` for circles |

---

## Commands

Access via Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Claude Usage: Refresh Rate Limit` | Force an immediate fetch and redraw the status bar |
| `Claude Usage: Switch Display Mode (Session / Weekly / Both)` | Cycle display mode without opening settings (persists to settings) |

---

## Known Limitations

- **macOS only** — bootstrap depends on the `security` CLI for OAuth keychain access
- **Claude AI login required** — API-key auth for Claude Code is not supported (the usage endpoint is OAuth-scoped)
- Usage refreshes **when Claude Code itself fetches usage data** (on panel open or explicit refresh) — not after every prompt you send. Click the status bar for an immediate refresh if you need fresher numbers.

---

## Release Notes

### 0.3.5
- Package hygiene — exclude `.agents/` and `.kiro/` from the published `.vsix`

### 0.3.4
- **Persist display mode** — switching display mode via the Command Palette now saves to settings, so it survives VS Code restarts

### 0.3.3
- **Days in weekly countdown** — reset timer shows `4d 6h` instead of `102h 38m`
- **Switch Display Mode command** — cycle session/weekly/both from `Cmd+Shift+P` without opening settings

### 0.3.2
- **Background poll** — fetches fresh data every 5 minutes with `Retry-After` backoff on 429s
- **Click to refresh** — clicking the status bar immediately fetches fresh data
- **Auto-reset expired limits** — usage resets to 0% when the session timer expires
- **Security fixes** — hardened keychain access, response handling, and backoff logic
- Handles both 0–1 and 0–100 utilization scales, and ISO / epoch `resets_at` timestamps

### 0.3.1
- **`diagnostics_channel` intercept** — passively reads Claude Code's own API responses, zero extra calls
- **Bootstrap fetch on activation** — fresh data immediately on reload
- **Format normalization** — handles both 0–1 and 0–100 utilization scales, ISO and epoch timestamps
- **Display mode setting** — choose session, weekly, or both
- Clears stale cache when bootstrap gets rate-limited

### 0.2.0
- Reverse-engineered from Claude Code CLI — matched the official implementation
- Fixed utilization / timestamp parsing
- Removed self-managed token refresh (Claude Code handles it)
- Added retry with exponential backoff for 5xx errors
- Stale state fallback and persisted state across reloads

### 0.1.0
- Initial release

---

## Contributing

```bash
git clone https://github.com/Harsh1210/claude-usage-bar
cd claude-usage-bar
npm install
npm run compile
```

**Development (watch mode):**
```bash
npm run watch
# Press F5 in VS Code to launch an Extension Development Host
```

**Package a `.vsix`:**
```bash
npx @vscode/vsce package
```

Issues and PRs welcome — see the [issue tracker](https://github.com/Harsh1210/claude-usage-bar/issues).

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

**Keywords:** vscode extension · claude code · anthropic · rate limit · status bar · usage tracking · session limit · weekly limit · diagnostics_channel · typescript · ai developer tools

</div>
