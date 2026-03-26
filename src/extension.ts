import * as vscode from "vscode";
import * as os from "os";
import * as https from "https";
import { execSync } from "child_process";

interface RateLimitEntry {
  utilization: number; // 0-1 from API, converted to 0-100 for display
  resetsAt?: number;   // Unix epoch SECONDS
}

interface RateLimitInfo {
  fiveHour?: RateLimitEntry;
  sevenDay?: RateLimitEntry;
  sevenDaySonnet?: RateLimitEntry;
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit?: number;
    usedCredits?: number;
    utilization?: number;
  };
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const ANTHROPIC_BETA = "oauth-2025-04-20";

let rateLimitBarItem: vscode.StatusBarItem;
let rateLimitPollInterval: ReturnType<typeof setInterval> | undefined;
let resetCountdownInterval: ReturnType<typeof setInterval> | undefined;
let cachedRateLimit: RateLimitInfo = {};
let isFetchingRateLimit = false;
let lastFetchError: string | undefined;
let lastGoodText: string | undefined;
let lastGoodTooltip: string | undefined;
let backoffUntil = 0;
let isStale = false;
let extensionContext: vscode.ExtensionContext;
const BACKOFF_MS = 10 * 60 * 1000;
const SERVER_RETRY_DELAYS = [2000, 4000, 8000, 16000]; // match CLI backoff

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // Restore last known good state from persistent storage
  lastGoodText = context.globalState.get<string>("lastGoodText");
  lastGoodTooltip = context.globalState.get<string>("lastGoodTooltip");

  rateLimitBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    52
  );
  rateLimitBarItem.command = "claudeUsageBar.refreshRateLimit";
  rateLimitBarItem.tooltip = "Click to refresh";
  context.subscriptions.push(rateLimitBarItem);

  // Show persisted state immediately (or 0% baseline) while we fetch
  if (!lastGoodText) {
    lastGoodText = "$(pulse) \u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%";
    lastGoodTooltip = "Claude Rate Limit\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nNo data yet";
  }
  rateLimitBarItem.text = `${lastGoodText} $(eye-closed)`;
  rateLimitBarItem.tooltip = `${lastGoodTooltip}\n\n\u26A0 Stale \u2014 refreshing...`;
  rateLimitBarItem.color = new vscode.ThemeColor("disabledForeground");
  rateLimitBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsageBar.refresh", () => fetchRateLimit(true)),
    vscode.commands.registerCommand("claudeUsageBar.showDetails", () => fetchRateLimit(true)),
    vscode.commands.registerCommand("claudeUsageBar.refreshRateLimit", () => fetchRateLimit(true))
  );

  fetchRateLimit();
  rateLimitPollInterval = setInterval(() => fetchRateLimit(), 5 * 60 * 1000);
  resetCountdownInterval = setInterval(() => updateRateLimitDisplay(), 30_000);

  context.subscriptions.push({
    dispose: () => {
      if (rateLimitPollInterval) clearInterval(rateLimitPollInterval);
      if (resetCountdownInterval) clearInterval(resetCountdownInterval);
    },
  });
}

// ── Keychain ─────────────────────────────────────────────────────

function readKeychain(): { accessToken: string; refreshToken: string; clientId?: string; scopes?: string[] } | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const username = process.env.USER || os.userInfo().username || "claude-user";
    const raw = execSync(
      `security find-generic-password -a "${username}" -w -s "${KEYCHAIN_SERVICE}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        clientId: oauth.clientId,
        scopes: oauth.scopes,
      };
    }
  } catch { /* ignore */ }
  return undefined;
}

// ── HTTP helpers ─────────────────────────────────────────────────

function httpGet(token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": ANTHROPIC_BETA,
      },
      timeout: 5000, // match CLI: 5s timeout
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

/** Retry with exponential backoff for 5xx errors, matching CLI behavior */
async function httpGetWithRetry(token: string): Promise<{ status: number; body: string }> {
  let lastResult = await httpGet(token);
  if (lastResult.status < 500) return lastResult;

  for (const delay of SERVER_RETRY_DELAYS) {
    console.log(`[claude-usage-bar] Server error ${lastResult.status}, retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    lastResult = await httpGet(token);
    if (lastResult.status < 500) return lastResult;
  }
  return lastResult;
}

// ── Fetch Usage ──────────────────────────────────────────────────

async function fetchRateLimit(manual = false) {
  if (isFetchingRateLimit) return;

  // Skip if backing off (unless user clicked manually)
  if (!manual && Date.now() < backoffUntil) return;

  isFetchingRateLimit = true;

  // Only show spinner on first load — otherwise keep current display
  if (!lastGoodText) {
    rateLimitBarItem.text = "$(sync~spin) Checking...";
    rateLimitBarItem.show();
  }

  try {
    const creds = readKeychain();
    if (!creds) {
      showStaleOrFallback("$(key) No auth token", "Could not read OAuth token from keychain");
      return;
    }

    // Always re-read token from keychain — Claude Code handles its own refresh.
    // We never refresh tokens ourselves to avoid corrupting Claude Code's state.
    const { status, body } = await httpGetWithRetry(creds.accessToken);

    if (status === 401) {
      showStaleOrFallback("$(key) Token expired", "Token expired \u2014 Claude Code will refresh it automatically. Try again shortly.");
      return;
    }

    if (status === 429) {
      backoffUntil = Date.now() + BACKOFF_MS;
      lastFetchError = "429";
      showStaleOrFallback("$(clock) Rate limited", "API rate limited \u2014 will retry in 10 min");
      return;
    }

    if (status === 200) {
      const parsed = JSON.parse(body);
      console.log("[claude-usage-bar] Raw API response:", JSON.stringify(parsed, null, 2));
      cachedRateLimit = {};

      // API returns utilization as 0-1 float, resets_at as Unix epoch seconds
      if (parsed.five_hour?.utilization != null) {
        cachedRateLimit.fiveHour = {
          utilization: parsed.five_hour.utilization,
          resetsAt: parsed.five_hour.resets_at,
        };
      }
      if (parsed.seven_day?.utilization != null) {
        cachedRateLimit.sevenDay = {
          utilization: parsed.seven_day.utilization,
          resetsAt: parsed.seven_day.resets_at,
        };
      }
      if (parsed.seven_day_sonnet?.utilization != null) {
        cachedRateLimit.sevenDaySonnet = {
          utilization: parsed.seven_day_sonnet.utilization,
          resetsAt: parsed.seven_day_sonnet.resets_at,
        };
      }
      if (parsed.extra_usage) {
        cachedRateLimit.extraUsage = {
          isEnabled: parsed.extra_usage.is_enabled,
          monthlyLimit: parsed.extra_usage.monthly_limit,
          usedCredits: parsed.extra_usage.used_credits,
          utilization: parsed.extra_usage.utilization,
        };
      }
      lastFetchError = undefined;
      backoffUntil = 0;
      isStale = false;
      updateRateLimitDisplay();
    } else {
      lastFetchError = `HTTP ${status}`;
      showStaleOrFallback(`$(warning) Error ${status}`, body.slice(0, 200));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lastFetchError = msg;
    showStaleOrFallback("$(warning) Network error", msg);
  } finally {
    isFetchingRateLimit = false;
  }
}

function showStaleOrFallback(fallbackText: string, errorDetail: string) {
  isStale = true;
  if (lastGoodText) {
    rateLimitBarItem.text = `${lastGoodText} $(eye-closed)`;
    rateLimitBarItem.tooltip = `${lastGoodTooltip}\n\n\u26A0 Stale \u2014 ${errorDetail}\nClick to retry`;
    rateLimitBarItem.backgroundColor = undefined;
    rateLimitBarItem.color = new vscode.ThemeColor("disabledForeground");
  } else {
    rateLimitBarItem.text = fallbackText;
    rateLimitBarItem.tooltip = errorDetail;
    rateLimitBarItem.color = undefined;
  }
  rateLimitBarItem.show();
}

// ── Display ──────────────────────────────────────────────────────

/** Format Unix epoch seconds to human-readable remaining time */
function formatTimeRemaining(epochSeconds: number): string {
  const diff = Math.floor(epochSeconds - Date.now() / 1000);
  if (diff <= 0) return "soon";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function updateRateLimitDisplay() {
  // Don't overwrite stale/error display — wait for a successful fetch
  if (isStale) return;

  const limit = cachedRateLimit.fiveHour ?? cachedRateLimit.sevenDay ?? cachedRateLimit.sevenDaySonnet;

  if (!limit) {
    if (!lastFetchError) {
      rateLimitBarItem.text = "$(check) Usage OK";
      rateLimitBarItem.tooltip = "No active rate limits. Click to refresh.";
      rateLimitBarItem.backgroundColor = undefined;
      rateLimitBarItem.color = undefined;
      rateLimitBarItem.show();
    }
    return;
  }

  // utilization is 0-1 from API — multiply by 100 for display (matching CLI)
  const utilPct = Math.floor(limit.utilization * 100);
  const resetStr = limit.resetsAt ? formatTimeRemaining(limit.resetsAt) : undefined;

  const barLength = 10;
  const filled = Math.round((utilPct / 100) * barLength);
  const empty = barLength - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

  let text = `$(pulse) ${bar} ${utilPct}%`;
  if (resetStr) text += ` \u00b7 ${resetStr}`;

  if (utilPct >= 90) {
    rateLimitBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (utilPct >= 70) {
    rateLimitBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    rateLimitBarItem.backgroundColor = undefined;
  }

  const lines = ["Claude Rate Limit", "\u2500".repeat(22)];

  if (cachedRateLimit.fiveHour) {
    const pct = Math.floor(cachedRateLimit.fiveHour.utilization * 100);
    const rst = cachedRateLimit.fiveHour.resetsAt ? formatTimeRemaining(cachedRateLimit.fiveHour.resetsAt) : "?";
    lines.push(`Session (5hr):  ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.sevenDay) {
    const pct = Math.floor(cachedRateLimit.sevenDay.utilization * 100);
    const rst = cachedRateLimit.sevenDay.resetsAt ? formatTimeRemaining(cachedRateLimit.sevenDay.resetsAt) : "?";
    lines.push(`Weekly (7d):    ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.sevenDaySonnet) {
    const pct = Math.floor(cachedRateLimit.sevenDaySonnet.utilization * 100);
    const rst = cachedRateLimit.sevenDaySonnet.resetsAt ? formatTimeRemaining(cachedRateLimit.sevenDaySonnet.resetsAt) : "?";
    lines.push(`Sonnet (7d):    ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.extraUsage) {
    const eu = cachedRateLimit.extraUsage;
    if (eu.usedCredits != null && eu.monthlyLimit != null) {
      lines.push(`Extra usage:    $${eu.usedCredits.toFixed(0)}/$${eu.monthlyLimit} (${Math.floor((eu.utilization ?? 0) * 100)}%)`);
    }
  }

  lines.push("", "Click to refresh");

  rateLimitBarItem.color = undefined;
  rateLimitBarItem.text = text;
  rateLimitBarItem.tooltip = lines.join("\n");
  rateLimitBarItem.show();

  // Cache for stale display on errors — persist across reloads
  lastGoodText = text;
  lastGoodTooltip = lines.join("\n");
  extensionContext.globalState.update("lastGoodText", lastGoodText);
  extensionContext.globalState.update("lastGoodTooltip", lastGoodTooltip);
}

export function deactivate() {
  if (rateLimitPollInterval) clearInterval(rateLimitPollInterval);
  if (resetCountdownInterval) clearInterval(resetCountdownInterval);
}
