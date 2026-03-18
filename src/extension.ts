import * as vscode from "vscode";
import * as os from "os";
import * as https from "https";
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

    const { status, body } = await httpGet(creds.accessToken);

    if (status === 401) {
      rateLimitBarItem.text = "$(key) Token expired";
      rateLimitBarItem.tooltip = "Claude Code is refreshing your session — try again shortly";
      rateLimitBarItem.show();
      return;
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

function formatBar(utilPct: number): string {
  const barLength = 10;
  const filled = Math.round((utilPct / 100) * barLength);
  const empty = barLength - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function formatLimitText(label: string, limit: RateLimitEntry): string {
  const pct = Math.round(limit.utilization);
  const resetStr = limit.resetsAt ? formatTimeRemaining(limit.resetsAt) : "";
  let text = `${label} ${formatBar(pct)} ${pct}%`;
  if (resetStr) text += ` \u00b7 ${resetStr}`;
  return text;
}

function getMaxUtilization(limits: (RateLimitEntry | undefined)[]): number {
  return Math.max(0, ...limits.filter(Boolean).map(l => l!.utilization));
}

function updateRateLimitDisplay() {
  const displayMode: string = vscode.workspace.getConfiguration("claudeUsageBar").get("displayMode", "session");

  // Determine which limits to show in the bar text
  const showSession = displayMode === "session" || displayMode === "both";
  const showWeekly = displayMode === "weekly" || displayMode === "both";

  const sessionLimit = cachedRateLimit.fiveHour;
  const weeklyLimit = cachedRateLimit.sevenDay ?? cachedRateLimit.sevenDaySonnet;

  const hasSession = showSession && sessionLimit;
  const hasWeekly = showWeekly && weeklyLimit;

  if (!hasSession && !hasWeekly) {
    if (!lastFetchError) {
      rateLimitBarItem.text = "$(check) Usage OK";
      rateLimitBarItem.tooltip = "No active rate limits. Click to refresh.";
      rateLimitBarItem.show();
    }
    return;
  }

  // Build status bar text
  const parts: string[] = [];
  const limitsForColor: (RateLimitEntry | undefined)[] = [];

  if (hasSession) {
    parts.push(formatLimitText("S:", sessionLimit));
    limitsForColor.push(sessionLimit);
  }
  if (hasWeekly) {
    parts.push(formatLimitText("W:", weeklyLimit));
    limitsForColor.push(weeklyLimit);
  }

  const text = `$(pulse) ${parts.join("  ")}`;

  // Color based on highest utilization among displayed limits
  const maxUtil = getMaxUtilization(limitsForColor);
  if (maxUtil >= 90) {
    rateLimitBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (maxUtil >= 70) {
    rateLimitBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    rateLimitBarItem.backgroundColor = undefined;
  }

  // Tooltip always shows all available limits
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
