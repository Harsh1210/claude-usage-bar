import * as vscode from "vscode";
import * as os from "os";
import * as https from "https";
import * as http from "http";
import { execSync } from "child_process";

interface RateLimitEntry {
  utilization: number; // 0-100
  resetsAt?: string;   // ISO 8601 string
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
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

let rateLimitBarItem: vscode.StatusBarItem;
let rateLimitPollInterval: ReturnType<typeof setInterval> | undefined;
let resetCountdownInterval: ReturnType<typeof setInterval> | undefined;
let cachedRateLimit: RateLimitInfo = {};
let isFetchingRateLimit = false;
let lastFetchError: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  rateLimitBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    52
  );
  rateLimitBarItem.command = "claudeUsageBar.refreshRateLimit";
  rateLimitBarItem.tooltip = "Click to refresh";
  context.subscriptions.push(rateLimitBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsageBar.refresh", () => fetchRateLimit()),
    vscode.commands.registerCommand("claudeUsageBar.showDetails", () => fetchRateLimit()),
    vscode.commands.registerCommand("claudeUsageBar.refreshRateLimit", () => fetchRateLimit())
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

function readKeychain(): { accessToken: string; refreshToken: string } | undefined {
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
      return { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken };
    }
  } catch { /* ignore */ }
  return undefined;
}

// ── Token Refresh ────────────────────────────────────────────────

function refreshToken(refreshTok: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTok,
      client_id: CLIENT_ID,
    }).toString();

    const url = new URL(TOKEN_URL);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(`No access_token in response: ${data}`));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Fetch Usage ──────────────────────────────────────────────────

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
      timeout: 10000,
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

async function fetchRateLimit() {
  if (isFetchingRateLimit) return;
  isFetchingRateLimit = true;

  rateLimitBarItem.text = "$(sync~spin) Checking...";
  rateLimitBarItem.show();

  try {
    const creds = readKeychain();
    if (!creds) {
      rateLimitBarItem.text = "$(key) No auth token";
      rateLimitBarItem.tooltip = "Could not read OAuth token from keychain";
      rateLimitBarItem.show();
      return;
    }

    // Try with current token, refresh if 401/429
    let { status, body } = await httpGet(creds.accessToken);

    if (status === 401 || status === 429) {
      try {
        const newToken = await refreshToken(creds.refreshToken);
        const retry = await httpGet(newToken);
        status = retry.status;
        body = retry.body;
      } catch {
        // refresh failed, use original response
      }
    }

    if (status === 200) {
      const parsed = JSON.parse(body);
      cachedRateLimit = {};

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
      updateRateLimitDisplay();
    } else {
      lastFetchError = `HTTP ${status}`;
      rateLimitBarItem.text = `$(warning) Error ${status}`;
      rateLimitBarItem.tooltip = body.slice(0, 200);
      rateLimitBarItem.show();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lastFetchError = msg;
    rateLimitBarItem.text = "$(warning) Network error";
    rateLimitBarItem.tooltip = msg;
    rateLimitBarItem.show();
  } finally {
    isFetchingRateLimit = false;
  }
}

// ── Display ──────────────────────────────────────────────────────

function formatTimeRemaining(isoString: string): string {
  const resetMs = new Date(isoString).getTime();
  const diff = Math.floor((resetMs - Date.now()) / 1000);
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function updateRateLimitDisplay() {
  // Show highest utilization limit first
  const limit = cachedRateLimit.fiveHour ?? cachedRateLimit.sevenDay ?? cachedRateLimit.sevenDaySonnet;

  if (!limit) {
    if (!lastFetchError) {
      rateLimitBarItem.text = "$(check) Usage OK";
      rateLimitBarItem.tooltip = "No active rate limits. Click to refresh.";
      rateLimitBarItem.show();
    }
    return;
  }

  const utilPct = Math.round(limit.utilization);
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
    const pct = Math.round(cachedRateLimit.fiveHour.utilization);
    const rst = cachedRateLimit.fiveHour.resetsAt ? formatTimeRemaining(cachedRateLimit.fiveHour.resetsAt) : "?";
    lines.push(`Session (5hr):  ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.sevenDay) {
    const pct = Math.round(cachedRateLimit.sevenDay.utilization);
    const rst = cachedRateLimit.sevenDay.resetsAt ? formatTimeRemaining(cachedRateLimit.sevenDay.resetsAt) : "?";
    lines.push(`Weekly (7d):    ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.sevenDaySonnet) {
    const pct = Math.round(cachedRateLimit.sevenDaySonnet.utilization);
    const rst = cachedRateLimit.sevenDaySonnet.resetsAt ? formatTimeRemaining(cachedRateLimit.sevenDaySonnet.resetsAt) : "?";
    lines.push(`Sonnet (7d):    ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.extraUsage) {
    const eu = cachedRateLimit.extraUsage;
    if (eu.usedCredits != null && eu.monthlyLimit != null) {
      lines.push(`Extra usage:    $${eu.usedCredits.toFixed(0)}/$${eu.monthlyLimit} (${Math.round(eu.utilization ?? 0)}%)`);
    }
  }

  lines.push("", "Click to refresh");

  rateLimitBarItem.text = text;
  rateLimitBarItem.tooltip = lines.join("\n");
  rateLimitBarItem.show();
}

export function deactivate() {
  if (rateLimitPollInterval) clearInterval(rateLimitPollInterval);
  if (resetCountdownInterval) clearInterval(resetCountdownInterval);
}
