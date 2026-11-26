import type {
  FeedbackCategory,
  FeedbackDiagnostics,
  FeedbackSubmissionPayload,
  IdeSource,
} from "../types.js";

/** Compile-time locked target repository constants (zero client/config override). */
export const FEEDBACK_GITHUB_OWNER = "jakehesson";
export const FEEDBACK_GITHUB_REPO = "agent-studio";
export const FEEDBACK_ISSUES_API_URL =
  "https://api.github.com/repos/jakehesson/agent-studio/issues";
export const FEEDBACK_NEW_ISSUE_URL =
  "https://github.com/jakehesson/agent-studio/issues/new";
export const FEEDBACK_URL_MAX_LEN = 6000;
const TRUNCATION_NOTICE = "\n\n...[truncated; paste full details]";

export const FEEDBACK_CATEGORY_META: Record<
  FeedbackCategory,
  { label: string; githubLabel: string; prefix: string }
> = {
  bug: { label: "Bug", githubLabel: "bug", prefix: "[Bug]" },
  feature: { label: "Feature", githubLabel: "enhancement", prefix: "[Feature]" },
  telemetry: { label: "Telemetry", githubLabel: "telemetry", prefix: "[Telemetry]" },
  question: { label: "Question", githubLabel: "question", prefix: "[Question]" },
};

const VALID_IDES: ReadonlySet<IdeSource> = new Set<IdeSource>([
  "antigravity",
  "claude-code",
  "copilot-vscode",
  "mcp",
  "unknown",
]);

function clampString(val: unknown, maxLen: number): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function clampNonNegInt(val: unknown): number | undefined {
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) return undefined;
  return Math.round(val);
}

function clampPercent(val: unknown): number | undefined {
  if (typeof val !== "number" || !Number.isFinite(val)) return undefined;
  return Math.min(100, Math.max(0, Math.round(val * 10) / 10));
}

/**
 * Picks ONLY allowlisted diagnostic fields and enforces strict bounds.
 * Never includes workspace paths, filenames, session IDs, prompts, or secrets.
 */
export function sanitizeClientDiagnostics(
  raw?: FeedbackDiagnostics
): FeedbackDiagnostics {
  if (!raw || typeof raw !== "object") return {};
  const out: FeedbackDiagnostics = {};

  const appVersion = clampString(raw.appVersion, 32);
  if (appVersion) out.appVersion = appVersion;

  if (typeof raw.ide === "string" && VALID_IDES.has(raw.ide)) {
    out.ide = raw.ide;
  }

  const model = clampString(raw.model, 120);
  if (model) out.model = model;

  const contextTokens = clampNonNegInt(raw.contextTokens);
  if (contextTokens !== undefined) out.contextTokens = contextTokens;

  const contextWindow = clampNonNegInt(raw.contextWindow);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;

  const contextPercent = clampPercent(raw.contextPercent);
  if (contextPercent !== undefined) out.contextPercent = contextPercent;

  const agentCount = clampNonNegInt(raw.agentCount);
  if (agentCount !== undefined) out.agentCount = agentCount;

  const eventCount = clampNonNegInt(raw.eventCount);
  if (eventCount !== undefined) out.eventCount = eventCount;

  if (typeof raw.embedMode === "boolean") {
    out.embedMode = raw.embedMode;
  }

  const osPlatform = clampString(raw.osPlatform, 32);
  if (osPlatform) out.osPlatform = osPlatform;

  return out;
}

export function formatFeedbackTitle(
  category: FeedbackCategory,
  rawTitle: string
): string {
  const trimmed = rawTitle.trim().slice(0, 200);
  const meta = FEEDBACK_CATEGORY_META[category] ?? FEEDBACK_CATEGORY_META.bug;
  if (!trimmed) return meta.prefix;
  if (trimmed.toLowerCase().startsWith(meta.prefix.toLowerCase())) {
    return trimmed;
  }
  return `${meta.prefix} ${trimmed}`;
}

function escapeTableCell(val: string): string {
  return val.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function formatFeedbackMarkdown(payload: {
  description: string;
  includeDiagnostics: boolean;
  diagnostics?: FeedbackDiagnostics;
}): string {
  const desc = payload.description.trim().slice(0, 4000);
  const parts: string[] = ["### Description", "", desc || "_No description provided._"];

  if (payload.includeDiagnostics && payload.diagnostics) {
    const d = sanitizeClientDiagnostics(payload.diagnostics);
    const rows: Array<[string, string]> = [];
    if (d.appVersion !== undefined) rows.push(["App Version", d.appVersion]);
    if (d.ide !== undefined) rows.push(["Host IDE", d.ide]);
    if (d.embedMode !== undefined) {
      rows.push(["Surface Mode", d.embedMode ? "IDE Extension (embed=1)" : "Studio"]);
    }
    if (d.model !== undefined) rows.push(["Active Model", d.model]);
    if (d.contextTokens !== undefined || d.contextWindow !== undefined || d.contextPercent !== undefined) {
      const tokStr = d.contextTokens !== undefined ? String(d.contextTokens) : "—";
      const winStr = d.contextWindow !== undefined ? String(d.contextWindow) : "—";
      const pctStr = d.contextPercent !== undefined ? `${d.contextPercent}%` : "—";
      rows.push(["Context / Tokens", `${tokStr} / ${winStr} (${pctStr})`]);
    }
    if (d.agentCount !== undefined) rows.push(["Agent Count", String(d.agentCount)]);
    if (d.eventCount !== undefined) rows.push(["Event Count", String(d.eventCount)]);
    if (d.osPlatform !== undefined) rows.push(["OS Platform", d.osPlatform]);

    if (rows.length > 0) {
      parts.push(
        "",
        "### Environment Diagnostics",
        "",
        "| Field | Value |",
        "| --- | --- |",
        ...rows.map(([k, v]) => `| ${escapeTableCell(k)} | ${escapeTableCell(v)} |`)
      );
    }
  }

  return parts.join("\n");
}

/**
 * Verifies a URL is strictly targeting jakehesson/agent-studio's new-issue endpoint.
 */
export function isAllowedFeedbackNewIssueUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    return (
      rawUrl.startsWith(FEEDBACK_NEW_ISSUE_URL) &&
      parsed.origin === "https://github.com" &&
      parsed.pathname === "/jakehesson/agent-studio/issues/new"
    );
  } catch {
    return false;
  }
}

/**
 * Verifies a URL strictly points to an issue or new-issue page on jakehesson/agent-studio.
 */
export function isAllowedFeedbackIssueUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return false;
    return (
      parsed.origin === "https://github.com" &&
      (parsed.pathname === "/jakehesson/agent-studio/issues/new" ||
        /^\/jakehesson\/agent-studio\/issues\/\d+$/.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}

function buildIssueSearchUrl(title: string, body: string, labels: string): string {
  const sp = new URLSearchParams();
  sp.set("title", title);
  sp.set("body", body);
  sp.set("labels", labels);
  return `${FEEDBACK_NEW_ISSUE_URL}?${sp.toString()}`;
}

/**
 * Builds a pre-filled GitHub new-issue URL locked to jakehesson/agent-studio.
 * Enforces a hard <= 6000-char cap by truncating `body` with a clear suffix.
 */
export function buildPrefilledIssueUrl(payload: FeedbackSubmissionPayload): {
  url: string;
  truncated: boolean;
  fullMarkdown: string;
} {
  const meta = FEEDBACK_CATEGORY_META[payload.category] ?? FEEDBACK_CATEGORY_META.bug;
  const title = formatFeedbackTitle(payload.category, payload.title);
  const fullMarkdown = formatFeedbackMarkdown({
    description: payload.description,
    includeDiagnostics: payload.includeDiagnostics,
    diagnostics: payload.diagnostics,
  });

  const fullUrl = buildIssueSearchUrl(title, fullMarkdown, meta.githubLabel);
  if (fullUrl.length <= FEEDBACK_URL_MAX_LEN) {
    return { url: fullUrl, truncated: false, fullMarkdown };
  }

  // Binary search the maximum prefix of `fullMarkdown` that fits within 6000 chars
  let lo = 0;
  let hi = fullMarkdown.length;
  let bestUrl = buildIssueSearchUrl(title, TRUNCATION_NOTICE.trimStart(), meta.githubLabel);

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidateBody =
      mid > 0 ? `${fullMarkdown.slice(0, mid).trimEnd()}${TRUNCATION_NOTICE}` : TRUNCATION_NOTICE.trimStart();
    const candidateUrl = buildIssueSearchUrl(title, candidateBody, meta.githubLabel);
    if (candidateUrl.length <= FEEDBACK_URL_MAX_LEN) {
      bestUrl = candidateUrl;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestUrl.length > FEEDBACK_URL_MAX_LEN) {
    bestUrl = buildIssueSearchUrl(title.slice(0, 120), TRUNCATION_NOTICE.trimStart(), meta.githubLabel).slice(
      0,
      FEEDBACK_URL_MAX_LEN
    );
  }

  return { url: bestUrl, truncated: true, fullMarkdown };
}
