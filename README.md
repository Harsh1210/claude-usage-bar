# Claude Usage Bar

Shows your **Claude Code rate limit usage** in the VS Code status bar — just like the terminal bar, but always visible while you code.

## Features

- **Live usage bar** — `████████░░ 82% · 1h 12m` in the status bar
- **Session (5hr) and weekly (7d) limits** tracked separately
- **Color alerts** — yellow at 70%, red at 90%
- **Reset countdown** — updates every 30 seconds
- **Zero token cost** — reads directly from Anthropic's usage API, no messages sent
- **Auto token refresh** — automatically refreshes expired OAuth tokens using the refresh token
- **Stale state fallback** — on errors (rate limits, network issues), shows the last known usage dimmed instead of losing your data

## Requirements

- [Claude Code](https://claude.ai/download) VS Code extension installed and signed in
- macOS (uses the macOS Keychain for auth — Windows/Linux support coming)

## How it works

Claude Code stores your OAuth credentials in the macOS Keychain. This extension reads those credentials and calls Anthropic's `/api/oauth/usage` endpoint — the same endpoint the Claude Code extension uses internally to show usage in its sidebar. No tokens are consumed.

## Status Bar

The status bar item shows the **highest active limit**:

| Display | Meaning |
|---------|---------|
| `████████░░ 82% · 1h 12m` | 82% used, resets in 1h 12m |
| `$(check) Usage OK` | Below all thresholds |
| Yellow background | 70%+ used |
| Red background | 90%+ used |
| Dimmed text + `$(eye-closed)` | Stale data — last known usage shown after an error |

**Hover** for a full breakdown of all limits (session, weekly, Sonnet, extra usage).
**Click** to manually refresh.

## Commands

| Command | Description |
|---------|-------------|
| `Claude Usage: Refresh Rate Limit` | Force refresh from API |

## Settings

No configuration needed — it works automatically once Claude Code is authenticated.

## Known Limitations

- macOS only (relies on `security` CLI for keychain access)
- Requires Claude AI login (not API key auth)

## Release Notes

### 0.2.0

- **Reverse-engineered from Claude Code CLI** — now matches the official implementation exactly
- Fixed `utilization` parsing: API returns 0-1 float, not 0-100 (was showing wrong percentages)
- Fixed `resets_at` parsing: API returns Unix epoch seconds, not ISO 8601 strings (reset times were wrong)
- Removed self-managed token refresh — Claude Code handles its own OAuth tokens; we just re-read the keychain (eliminates 429 errors from hitting the wrong refresh endpoint)
- Added retry with exponential backoff for 5xx errors (`[2s, 4s, 8s, 16s]`, matching CLI)
- Stale state fallback — on errors, shows last known usage dimmed instead of losing your data
- Persists last known state across reloads via VS Code globalState
- Backoff on 429 — stops polling for 10 min to avoid making it worse

### 0.1.0

Initial release.
