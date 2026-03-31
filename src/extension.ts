import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as diagnostics_channel from "diagnostics_channel";
import { execFileSync } from "child_process";

/**
 * Claude Usage Bar v0.3.1
 *
 * How it works:
 * Uses Node.js diagnostics_channel to passively observe ALL HTTP requests
 * in the extension-host process. When Claude Code calls /api/oauth/usage,
 * we read the response body — zero extra API calls, can't be bypassed by
 * axios/follow-redirects/etc.
 *
 * Also watches ~/.claude/usage-bar-data.json for statusLine data from
 * terminal Claude sessions.
 */

interface RateLimitInfo {
  fiveHour?: { utilization: number; resetsAt?: number };
  sevenDay?: { utilization: number; resetsAt?: number };
  sevenDaySonnet?: { utilization: number; resetsAt?: number };
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit?: number;
    usedCredits?: number;
    utilization?: number;
  };
}

const DATA_FILE = path.join(os.homedir(), ".claude", "usage-bar-data.json");

let rateLimitBarItem: vscode.StatusBarItem;
let fileWatcher: fs.FSWatcher | undefined;
let displayRefreshInterval: ReturnType<typeof setInterval> | undefined;
let pollInterval: ReturnType<typeof setTimeout> | undefined;
let cachedRateLimit: RateLimitInfo = {};
let lastGoodText: string | undefined;
let lastGoodTooltip: string | undefined;
let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
// Track requests to /api/oauth/usage so we can tap their responses
const pendingUsageRequests = new WeakSet<http.ClientRequest>();

// Stored references required for diagnostics_channel.unsubscribe to work.
// unsubscribe() matches by function identity — passing a new lambda is a no-op
// and leaves stale handlers accumulating across extension reloads.
let dcRequestHandler: ((msg: unknown) => void) | undefined;
let dcResponseHandler: ((msg: unknown) => void) | undefined;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Claude Usage Bar");
  context.subscriptions.push(outputChannel);

  log("Extension activating (v0.3.1 — diagnostics_channel intercept)");

  // Restore persisted state
  lastGoodText = context.globalState.get<string>("lastGoodText");
  lastGoodTooltip = context.globalState.get<string>("lastGoodTooltip");

  rateLimitBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    52
  );
  rateLimitBarItem.command = "claudeUsageBar.refreshRateLimit";
  context.subscriptions.push(rateLimitBarItem);

  // Show persisted state or waiting message
  if (lastGoodText) {
    rateLimitBarItem.text = lastGoodText;
    rateLimitBarItem.tooltip = lastGoodTooltip ?? "Click to refresh";
  } else {
    rateLimitBarItem.text = "$(pulse) Waiting for Claude...";
    rateLimitBarItem.tooltip =
      "Claude Usage Bar\n──────────────────────\nWaiting for usage data.\nSend a message in Claude to see usage.";
  }
  rateLimitBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsageBar.refresh", () => bootstrapFetch()),
    vscode.commands.registerCommand("claudeUsageBar.showDetails", () => bootstrapFetch()),
    vscode.commands.registerCommand("claudeUsageBar.refreshRateLimit", () => bootstrapFetch()),
    vscode.commands.registerCommand("claudeUsageBar.switchDisplayMode", () => {
      const config = vscode.workspace.getConfiguration("claudeUsageBar");
      const current = config.get<string>("displayMode", "session");
      const next = current === "session" ? "weekly" : current === "weekly" ? "both" : "session";
      config.update("displayMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Claude Usage Bar: showing ${next}`, 3000);
      updateDisplay();
    })
  );

  // 1. Bootstrap: one API call to get fresh data immediately
  bootstrapFetch();

  // 2. Subscribe to Node.js HTTP diagnostics to passively intercept usage calls
  installDiagnosticsIntercept();

  // 3. Background poll every 5 min for fresh data between diagnostics_channel events
  startBackgroundPoll();

  // 4. Watch statusLine data file (for terminal Claude sessions)
  startFileWatcher();

  // 5. Refresh countdown timers every 30s and reset expired limits to 0
  displayRefreshInterval = setInterval(() => {
    resetExpiredLimits();
    updateDisplay();
  }, 30_000);

  context.subscriptions.push({
    dispose: () => {
      uninstallDiagnosticsIntercept();
      if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = undefined;
      }
      if (displayRefreshInterval) clearInterval(displayRefreshInterval);
      if (pollInterval) clearTimeout(pollInterval);
    },
  });

  log("Ready — listening for Claude Code usage API responses via diagnostics_channel");
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

// ── Bootstrap Fetch (one call on activation) ─────────────────────

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const ANTHROPIC_BETA = "oauth-2025-04-20";

function readKeychainToken(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const username =
      process.env.USER || os.userInfo().username || "claude-user";
    // execFileSync bypasses the shell entirely — no interpolation of $() or backticks.
    // Using execSync with a template string would allow command injection if USER
    // contains shell metacharacters (e.g. set via a malicious .envrc).
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-a", username, "-w", "-s", KEYCHAIN_SERVICE],
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

function bootstrapFetch() {
  const token = readKeychainToken();
  if (!token) {
    log("Bootstrap: no keychain token found, skipping");
    return;
  }

  log("Bootstrap: fetching usage data...");

  const options: https.RequestOptions = {
    hostname: "api.anthropic.com",
    path: "/api/oauth/usage",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": ANTHROPIC_BETA,
    },
    timeout: 5000,
  };

  const req = https.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => { if (body.length < MAX_RESPONSE_BYTES) body += chunk; });
    res.on("end", () => {
      if (res.statusCode === 200) {
        log(`Bootstrap: got usage data`);
        processUsageResponse(body);
      } else {
        log(`Bootstrap: HTTP ${res.statusCode}, clearing stale cache`);
        clearStaleState();
      }
    });
  });
  req.on("error", (err) => {
    log(`Bootstrap: network error (${err.message}), using persisted state`);
  });
  req.on("timeout", () => {
    req.destroy();
    log("Bootstrap: timeout, using persisted state");
  });
  req.end();
}

function clearStaleState() {
  cachedRateLimit = {};
  lastGoodText = undefined;
  lastGoodTooltip = undefined;
  extensionContext.globalState.update("lastGoodText", undefined);
  extensionContext.globalState.update("lastGoodTooltip", undefined);
  rateLimitBarItem.text = "$(pulse) Waiting for Claude...";
  rateLimitBarItem.tooltip =
    "Claude Usage Bar\n──────────────────────\nWaiting for usage data.\nSend a message in Claude to see usage.";
  rateLimitBarItem.backgroundColor = undefined;
  rateLimitBarItem.color = undefined;
  rateLimitBarItem.show();
}

// ── Background Poll ──────────────────────────────────────────────

const POLL_MS = 5 * 60 * 1000; // 5 minutes
let backoffUntil = 0;

function startBackgroundPoll() {
  const scheduleNext = () => {
    // Add up to 1 min jitter to avoid sync with Claude Code's own polling
    const jitter = Math.floor(Math.random() * 60_000);
    pollInterval = setTimeout(() => {
      backgroundFetch();
      scheduleNext();
    }, POLL_MS + jitter);
  };
  scheduleNext();
}

function backgroundFetch() {
  // Skip if backing off from a 429
  if (Date.now() < backoffUntil) {
    log("Background poll: still in backoff, skipping");
    return;
  }

  const token = readKeychainToken();
  if (!token) return;

  log("Background poll: fetching usage data...");

  const options: https.RequestOptions = {
    hostname: "api.anthropic.com",
    path: "/api/oauth/usage",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": ANTHROPIC_BETA,
    },
    timeout: 5000,
  };

  const req = https.request(options, (res) => {
    let body = "";
    res.on("data", (chunk) => { if (body.length < MAX_RESPONSE_BYTES) body += chunk; });
    res.on("end", () => {
      if (res.statusCode === 200) {
        log("Background poll: got fresh data");
        processUsageResponse(body);
      } else if (res.statusCode === 429) {
        // parseInt returns NaN for date-string Retry-After values ("Wed, 01 Apr ..."),
        // and Date.now() + NaN = NaN makes the backoff condition never true. Fall back to 10 min.
        const retryAfterParsed = parseInt(res.headers["retry-after"] as string ?? "", 10);
        const retryAfter = Number.isFinite(retryAfterParsed) ? retryAfterParsed : 600;
        backoffUntil = Date.now() + (retryAfter + 30) * 1000;
        log(`Background poll: 429, backing off ${Math.ceil(retryAfter / 60)} min`);
      } else {
        log(`Background poll: HTTP ${res.statusCode}`);
      }
    });
  });
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.end();
}

// ── Reset Expired Limits ─────────────────────────────────────────

function resetExpiredLimits() {
  const now = Date.now() / 1000;
  if (cachedRateLimit.fiveHour?.resetsAt && now >= cachedRateLimit.fiveHour.resetsAt) {
    log("Session limit expired — resetting to 0%");
    cachedRateLimit.fiveHour = { utilization: 0, resetsAt: undefined };
  }
  if (cachedRateLimit.sevenDay?.resetsAt && now >= cachedRateLimit.sevenDay.resetsAt) {
    log("Weekly limit expired — resetting to 0%");
    cachedRateLimit.sevenDay = { utilization: 0, resetsAt: undefined };
  }
  if (cachedRateLimit.sevenDaySonnet?.resetsAt && now >= cachedRateLimit.sevenDaySonnet.resetsAt) {
    log("Sonnet weekly limit expired — resetting to 0%");
    cachedRateLimit.sevenDaySonnet = { utilization: 0, resetsAt: undefined };
  }
}

// ── Diagnostics Channel Intercept ────────────────────────────────
// Node.js fires 'http.client.request.start' for EVERY outbound HTTP request,
// regardless of which library initiated it (axios, follow-redirects, fetch, etc.)

function installDiagnosticsIntercept() {
  // Guard: do not register duplicate handlers on extension reload
  if (dcRequestHandler || dcResponseHandler) {
    uninstallDiagnosticsIntercept();
  }

  try {
    // 'http.client.request.start' fires when a request is sent
    // The message contains { request: http.ClientRequest }
    dcRequestHandler = (message: unknown) => {
      try {
        const msg = message as { request: http.ClientRequest };
        const req = msg.request;
        if (!req) return;

        // Check if this request is to the usage endpoint
        const reqPath = (req as any).path as string | undefined;
        const reqHost = (req as any).getHeader?.("host") as string | undefined;

        // Require an explicit anthropic.com host — the original code also accepted
        // undefined host, which would match any request whose headers weren't set
        // yet, including requests from unrelated extensions.
        const isUsageCall =
          reqPath?.includes("/api/oauth/usage") &&
          reqHost?.includes("anthropic.com");

        if (isUsageCall) {
          log(`Detected usage API request: ${reqPath}`);
          pendingUsageRequests.add(req);
        }
      } catch {
        // Never break other extensions
      }
    };

    // 'http.client.response.finish' fires when a response is fully received
    // The message contains { request, response }
    dcResponseHandler = (message: unknown) => {
      try {
        const msg = message as {
          request: http.ClientRequest;
          response: http.IncomingMessage;
        };
        if (!pendingUsageRequests.has(msg.request)) return;
        pendingUsageRequests.delete(msg.request);

        const res = msg.response;
        log(`Usage API response: ${res.statusCode}`);

        if (res.statusCode === 200) {
          tapResponseBody(res);
        }
      } catch {
        // Never break other extensions
      }
    };

    diagnostics_channel.subscribe("http.client.request.start", dcRequestHandler);
    diagnostics_channel.subscribe("http.client.response.finish", dcResponseHandler);

    log("diagnostics_channel subscriptions installed");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to install diagnostics_channel: ${msg}`);
    log("Falling back to file watcher only");
  }
}

function uninstallDiagnosticsIntercept() {
  try {
    if (dcRequestHandler) {
      diagnostics_channel.unsubscribe("http.client.request.start", dcRequestHandler);
      dcRequestHandler = undefined;
    }
    if (dcResponseHandler) {
      diagnostics_channel.unsubscribe("http.client.response.finish", dcResponseHandler);
      dcResponseHandler = undefined;
    }
  } catch {
    // ignore cleanup errors
  }
}

// Guard against an unexpectedly large response body (CDN error, MITM) consuming
// unbounded memory. The real usage response is ~200 bytes.
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB hard cap

function tapResponseBody(res: http.IncomingMessage) {
  let body = "";
  const origOn = res.on.bind(res);

  res.on = function (
    event: string,
    listener: (...args: any[]) => void
  ): http.IncomingMessage {
    if (event === "data") {
      const wrapped = (chunk: Buffer | string) => {
        if (body.length < MAX_RESPONSE_BYTES) {
          body += chunk.toString();
        }
        listener(chunk);
      };
      return origOn.call(res, event, wrapped) as http.IncomingMessage;
    }
    if (event === "end") {
      const wrapped = (...args: unknown[]) => {
        try {
          if (body) processUsageResponse(body);
        } catch {
          // never break Claude Code
        }
        listener(...args);
      };
      return origOn.call(res, event, wrapped) as http.IncomingMessage;
    }
    return origOn.call(res, event, listener) as http.IncomingMessage;
  };
}

/** Parse resets_at which can be epoch seconds (number) or ISO string */
function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
}

/** Normalize utilization — API may return 0-1 or 0-100 */
function normalizeUtilization(value: number): number {
  return value > 1 ? value / 100 : value;
}

function processUsageResponse(body: string) {
  try {
    const parsed = JSON.parse(body);
    log(`Intercepted usage data: ${body.slice(0, 200)}`);

    cachedRateLimit = {};

    if (parsed.five_hour?.utilization != null) {
      cachedRateLimit.fiveHour = {
        utilization: normalizeUtilization(parsed.five_hour.utilization),
        resetsAt: parseResetsAt(parsed.five_hour.resets_at),
      };
    }
    if (parsed.seven_day?.utilization != null) {
      cachedRateLimit.sevenDay = {
        utilization: normalizeUtilization(parsed.seven_day.utilization),
        resetsAt: parseResetsAt(parsed.seven_day.resets_at),
      };
    }
    if (parsed.seven_day_sonnet?.utilization != null) {
      cachedRateLimit.sevenDaySonnet = {
        utilization: normalizeUtilization(parsed.seven_day_sonnet.utilization),
        resetsAt: parseResetsAt(parsed.seven_day_sonnet.resets_at),
      };
    }
    if (parsed.extra_usage) {
      cachedRateLimit.extraUsage = {
        isEnabled: parsed.extra_usage.is_enabled,
        monthlyLimit: parsed.extra_usage.monthly_limit,
        usedCredits: parsed.extra_usage.used_credits,
        utilization: parsed.extra_usage.utilization != null
          ? normalizeUtilization(parsed.extra_usage.utilization)
          : undefined,
      };
    }

    updateDisplay();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error parsing intercepted response: ${msg}`);
  }
}

// ── File Watcher (statusLine fallback for terminal sessions) ─────

function startFileWatcher() {
  try {
    const dir = path.dirname(DATA_FILE);
    const basename = path.basename(DATA_FILE);
    if (!fs.existsSync(dir)) return;

    fileWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename === basename) {
        readDataFile();
      }
    });
    fileWatcher.on("error", () => {
      /* rely on intercept */
    });
  } catch {
    /* optional fallback */
  }

  // Also read once on startup in case file already exists
  readDataFile();
}

function readDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;

    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    // Strict type check before arithmetic: a truthy non-number (e.g. the string "now")
    // produces NaN, which makes the age check always false and bypasses the 6-hour limit.
    if (typeof parsed.timestamp !== "number") return;
    const age = Date.now() / 1000 - parsed.timestamp;
    if (age > 6 * 3600) return; // too old

    // statusLine format uses used_percentage (0-100), convert to 0-1
    if (parsed.rate_limits?.five_hour) {
      cachedRateLimit.fiveHour = {
        utilization: parsed.rate_limits.five_hour.used_percentage / 100,
        resetsAt: parsed.rate_limits.five_hour.resets_at,
      };
    }
    if (parsed.rate_limits?.seven_day) {
      cachedRateLimit.sevenDay = {
        utilization: parsed.rate_limits.seven_day.used_percentage / 100,
        resetsAt: parsed.rate_limits.seven_day.resets_at,
      };
    }

    log(`Read statusLine file data (age: ${Math.floor(age)}s)`);
    updateDisplay();
  } catch {
    /* optional */
  }
}

// ── Display ──────────────────────────────────────────────────────

function formatTimeRemaining(epochSeconds: number): string {
  const diff = Math.floor(epochSeconds - Date.now() / 1000);
  if (diff <= 0) return "soon";
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

function formatLimitText(
  label: string,
  utilization: number,
  resetsAt?: number
): string {
  const pct = Math.floor(utilization * 100);
  const resetStr = resetsAt ? formatTimeRemaining(resetsAt) : "";
  let text = `${label} ${formatBar(pct)} ${pct}%`;
  if (resetStr) text += ` \u00b7 ${resetStr}`;
  return text;
}

function updateDisplay() {
  const displayMode: string = vscode.workspace
    .getConfiguration("claudeUsageBar")
    .get("displayMode", "session");
  const showSession = displayMode === "session" || displayMode === "both";
  const showWeekly = displayMode === "weekly" || displayMode === "both";

  const sessionLimit = cachedRateLimit.fiveHour;
  const weeklyLimit =
    cachedRateLimit.sevenDay ?? cachedRateLimit.sevenDaySonnet;

  const hasSession = showSession && sessionLimit;
  const hasWeekly = showWeekly && weeklyLimit;

  if (!hasSession && !hasWeekly) {
    if (lastGoodText) return;
    rateLimitBarItem.text = "$(check) Usage OK";
    rateLimitBarItem.tooltip = "No active rate limits.\nClick to refresh.";
    rateLimitBarItem.backgroundColor = undefined;
    rateLimitBarItem.color = undefined;
    rateLimitBarItem.show();
    return;
  }

  const parts: string[] = [];
  const pcts: number[] = [];

  if (hasSession) {
    parts.push(
      formatLimitText("S:", sessionLimit.utilization, sessionLimit.resetsAt)
    );
    pcts.push(Math.floor(sessionLimit.utilization * 100));
  }
  if (hasWeekly) {
    parts.push(
      formatLimitText("W:", weeklyLimit.utilization, weeklyLimit.resetsAt)
    );
    pcts.push(Math.floor(weeklyLimit.utilization * 100));
  }

  const text = `$(pulse) ${parts.join("  ")}`;

  const maxPct = Math.max(...pcts);
  if (maxPct >= 90) {
    rateLimitBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (maxPct >= 70) {
    rateLimitBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    rateLimitBarItem.backgroundColor = undefined;
  }
  rateLimitBarItem.color = undefined;

  // Tooltip
  const lines = ["Claude Rate Limit", "\u2500".repeat(22)];

  if (cachedRateLimit.fiveHour) {
    const pct = Math.floor(cachedRateLimit.fiveHour.utilization * 100);
    const rst = cachedRateLimit.fiveHour.resetsAt
      ? formatTimeRemaining(cachedRateLimit.fiveHour.resetsAt)
      : "?";
    lines.push(`Session (5hr):  ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.sevenDay) {
    const pct = Math.floor(cachedRateLimit.sevenDay.utilization * 100);
    const rst = cachedRateLimit.sevenDay.resetsAt
      ? formatTimeRemaining(cachedRateLimit.sevenDay.resetsAt)
      : "?";
    lines.push(`Weekly (7d):    ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.sevenDaySonnet) {
    const pct = Math.floor(cachedRateLimit.sevenDaySonnet.utilization * 100);
    const rst = cachedRateLimit.sevenDaySonnet.resetsAt
      ? formatTimeRemaining(cachedRateLimit.sevenDaySonnet.resetsAt)
      : "?";
    lines.push(`Sonnet (7d):    ${pct}%  \u00b7  resets ${rst}`);
  }
  if (cachedRateLimit.extraUsage) {
    const eu = cachedRateLimit.extraUsage;
    if (eu.usedCredits != null && eu.monthlyLimit != null) {
      lines.push(
        `Extra usage:    $${eu.usedCredits.toFixed(0)}/$${eu.monthlyLimit} (${Math.floor((eu.utilization ?? 0) * 100)}%)`
      );
    }
  }

  lines.push("", "Updates automatically with Claude API responses");

  rateLimitBarItem.text = text;
  rateLimitBarItem.tooltip = lines.join("\n");
  rateLimitBarItem.show();

  lastGoodText = text;
  lastGoodTooltip = lines.join("\n");
  extensionContext.globalState.update("lastGoodText", lastGoodText);
  extensionContext.globalState.update("lastGoodTooltip", lastGoodTooltip);
}

export function deactivate() {
  uninstallDiagnosticsIntercept();
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = undefined;
  }
  if (displayRefreshInterval) clearInterval(displayRefreshInterval);
}
