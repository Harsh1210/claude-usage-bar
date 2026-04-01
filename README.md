# Claude Usage Bar

Shows your **Claude Code rate limit usage** in the VS Code status bar — always visible while you code.

## Features

- **Live usage bar** — `S: ████████░░ 92% · 1h 12m` in the status bar
- **Session (5h) and weekly (7d) limits** tracked separately
- **Display mode** — choose session, weekly, or both via settings
- **Color alerts** — yellow at 70%, red at 90%
- **Reset countdown** — updates every 30 seconds
- **Zero extra API calls** — passively reads Claude Code's own usage responses via Node.js `diagnostics_channel`
- **Bootstrap on reload** — one API call on activation for fresh data immediately
- **Persisted state** — last known usage survives VS Code restarts

## Requirements

- [Claude Code](https://claude.ai/download) VS Code extension installed and signed in
- macOS (uses the macOS Keychain for bootstrap auth — Windows/Linux support coming)

## How it works

Both Claude Code and this extension run in the same VS Code **extension-host Node.js process**. We use Node.js [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) to passively observe all HTTP traffic. When Claude Code calls its `/api/oauth/usage` endpoint, we read the response body — zero extra API calls.

On activation, a single bootstrap API call fetches fresh data immediately (using OAuth credentials from the macOS Keychain). After that, all updates come passively from intercepted responses.

For terminal Claude sessions, a `statusLine` script can write rate limit data to `~/.claude/usage-bar-data.json`, which the extension watches as a fallback.

## Status Bar

| Display | Meaning |
|---------|---------|
| `S: ████████░░ 82% · 1h 12m` | Session: 82% used, resets in 1h 12m |
| `W: ████░░░░░░ 40% · 2d 6h` | Weekly: 40% used |
| `$(check) Usage OK` | Below all thresholds |
| Yellow background | 70%+ used |
| Red background | 90%+ used |

**Hover** for a full breakdown of all limits (session, weekly, Sonnet, extra usage).
**Click** to refresh.

## Settings

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `claudeUsageBar.displayMode` | `session`, `weekly`, `both` | `session` | Which rate limit to show in the status bar |

## Commands

| Command | Description |
|---------|-------------|
| `Claude Usage: Refresh Rate Limit` | Refresh display |
| `Claude Usage: Switch Display Mode (Session / Weekly / Both)` | Cycle display mode without opening settings |

## Known Limitations

- macOS only (bootstrap uses `security` CLI for keychain access)
- Requires Claude AI login (not API key auth)
- Usage updates when Claude Code fetches usage data (on panel open/refresh), not on every message

## Release Notes

### 0.3.4

- **Persist display mode** — switching display mode via command palette now saves to settings, so it survives VS Code restarts

### 0.3.3

- **Days in weekly countdown** — reset timer shows `4d 6h` instead of `102h 38m`
- **Switch Display Mode command** — cycle session/weekly/both from `Cmd+Shift+P` without opening settings

### 0.3.2

- **Background poll** — fetches fresh data every 5 minutes with `Retry-After` backoff on 429
- **Click to refresh** — clicking the status bar immediately fetches fresh data
- **Auto-reset expired limits** — usage resets to 0% when the session timer expires
- **Security fixes** — hardened keychain access, response handling, and backoff logic
- Handles both 0–1 and 0–100 utilization scales and ISO/epoch `resets_at` timestamps

### 0.3.1

- **`diagnostics_channel` intercept** — passively reads Claude Code's own API responses, zero extra calls
- **Bootstrap fetch on activation** — fresh data immediately on reload
- **Format normalization** — handles both 0-1 and 0-100 utilization scales, ISO and epoch timestamps
- **Display mode setting** — choose session, weekly, or both
- Clears stale cache when bootstrap gets rate limited

### 0.2.0

- Reverse-engineered from Claude Code CLI — matched official implementation
- Fixed utilization/timestamp parsing
- Removed self-managed token refresh
- Added retry with exponential backoff for 5xx errors
- Stale state fallback and persisted state across reloads

### 0.1.0

Initial release.
