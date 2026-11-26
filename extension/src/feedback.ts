export const FEEDBACK_GITHUB_OWNER = "jakehesson" as const;
export const FEEDBACK_GITHUB_REPO = "agent-studio" as const;
export const FEEDBACK_GITHUB_SLUG = "jakehesson/agent-studio" as const;
export const FEEDBACK_ISSUES_API_URL =
  "https://api.github.com/repos/jakehesson/agent-studio/issues" as const;
export const FEEDBACK_NEW_ISSUE_URL =
  "https://github.com/jakehesson/agent-studio/issues/new" as const;

export const FEEDBACK_MAX_TITLE_LENGTH = 200;
export const FEEDBACK_MAX_DESCRIPTION_LENGTH = 4000;
export const FEEDBACK_MAX_PREFILL_URL_LENGTH = 6000;
export const FEEDBACK_TRUNCATION_SUFFIX =
  "\n\n...[truncated; paste full details]";

export const FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS = [
  "appVersion",
  "ide",
  "model",
  "contextTokens",
  "contextWindow",
  "contextPercent",
  "agentCount",
  "eventCount",
  "embedMode",
  "osPlatform",
] as const;

export type FeedbackAllowedDiagnosticKey =
  (typeof FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS)[number];

export type FeedbackCategory = "bug" | "feature" | "telemetry" | "question";
export type FeedbackIde =
  | "antigravity"
  | "claude-code"
  | "copilot-vscode"
  | "mcp"
  | "unknown";

export interface FeedbackDiagnostics {
  appVersion?: string;
  ide?: FeedbackIde;
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  agentCount?: number;
  eventCount?: number;
  embedMode?: boolean;
  osPlatform?: string;
}

export interface SanitizedFeedbackPayload {
  category: FeedbackCategory;
  title: string;
  description: string;
  includeDiagnostics: boolean;
  diagnostics?: FeedbackDiagnostics;
}

export interface GitHubAuthSessionLike {
  accessToken: string;
  account?: { label?: string };
}

export interface VscodeAuthLike {
  getSession(
    providerId: "github",
    scopes: readonly string[],
    options: { silent?: boolean; createIfNone?: boolean },
  ): PromiseLike<GitHubAuthSessionLike | undefined>;
}

export type FeedbackFetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface FeedbackStatusMessage {
  type: "agentStudio:feedbackStatus";
  requestId: string;
  githubAuthAvailable: boolean;
  accountLabel?: string;
}

export type FeedbackSubmitResultMessage =
  | {
      type: "agentStudio:submitFeedbackResult";
      requestId: string;
      ok: true;
      mode: "created";
      issueUrl: string;
      issueNumber: number;
    }
  | {
      type: "agentStudio:submitFeedbackResult";
      requestId: string;
      ok: false;
      mode: "fallback";
      fallbackUrl: string;
      truncated: boolean;
      reason: string;
    };

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "category",
  "title",
  "description",
  "includeDiagnostics",
  "diagnostics",
]);

const FEEDBACK_CATEGORIES = new Set<string>([
  "bug",
  "feature",
  "telemetry",
  "question",
]);

const FEEDBACK_IDES = new Set<string>([
  "antigravity",
  "claude-code",
  "copilot-vscode",
  "mcp",
  "unknown",
]);

const CATEGORY_META: Record<
  FeedbackCategory,
  { label: string; prefix: string }
> = {
  bug: { label: "bug", prefix: "[Bug]" },
  feature: { label: "enhancement", prefix: "[Feature]" },
  telemetry: { label: "telemetry", prefix: "[Telemetry]" },
  question: { label: "question", prefix: "[Question]" },
};

const DIAGNOSTIC_LABELS: Record<FeedbackAllowedDiagnosticKey, string> = {
  appVersion: "App Version",
  ide: "IDE",
  model: "Model",
  contextTokens: "Context Tokens",
  contextWindow: "Context Window",
  contextPercent: "Context Percent",
  agentCount: "Agent Count",
  eventCount: "Event Count",
  embedMode: "Embed Mode",
  osPlatform: "OS Platform",
};

function cleanSingleLineString(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function cleanNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return Math.floor(raw);
}

function cleanPercent(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, raw));
}

export function sanitizeFeedbackDiagnostics(raw: unknown): FeedbackDiagnostics {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const rec = raw as Record<string, unknown>;
  const out: FeedbackDiagnostics = {};

  if (Object.prototype.hasOwnProperty.call(rec, "appVersion")) {
    const v = cleanSingleLineString(rec.appVersion, 32);
    if (v !== undefined) out.appVersion = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "ide")) {
    if (typeof rec.ide === "string" && FEEDBACK_IDES.has(rec.ide)) {
      out.ide = rec.ide as FeedbackIde;
    }
  }
  if (Object.prototype.hasOwnProperty.call(rec, "model")) {
    const v = cleanSingleLineString(rec.model, 120);
    if (v !== undefined) out.model = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "contextTokens")) {
    const v = cleanNonNegativeInt(rec.contextTokens);
    if (v !== undefined) out.contextTokens = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "contextWindow")) {
    const v = cleanNonNegativeInt(rec.contextWindow);
    if (v !== undefined) out.contextWindow = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "contextPercent")) {
    const v = cleanPercent(rec.contextPercent);
    if (v !== undefined) out.contextPercent = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "agentCount")) {
    const v = cleanNonNegativeInt(rec.agentCount);
    if (v !== undefined) out.agentCount = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "eventCount")) {
    const v = cleanNonNegativeInt(rec.eventCount);
    if (v !== undefined) out.eventCount = v;
  }
  if (Object.prototype.hasOwnProperty.call(rec, "embedMode")) {
    if (typeof rec.embedMode === "boolean") {
      out.embedMode = rec.embedMode;
    }
  }
  if (Object.prototype.hasOwnProperty.call(rec, "osPlatform")) {
    const v = cleanSingleLineString(rec.osPlatform, 32);
    if (v !== undefined) out.osPlatform = v;
  }

  return out;
}

export function validateFeedbackPayload(
  raw: unknown,
): { ok: true; value: SanitizedFeedbackPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid feedback payload" };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, error: `Unexpected feedback field: ${key}` };
    }
  }

  if (typeof rec.category !== "string" || !FEEDBACK_CATEGORIES.has(rec.category)) {
    return { ok: false, error: "Invalid feedback category" };
  }
  if (typeof rec.title !== "string") {
    return { ok: false, error: "Title is required" };
  }
  const title = rec.title.trim();
  if (title.length < 1 || title.length > FEEDBACK_MAX_TITLE_LENGTH) {
    return {
      ok: false,
      error: `Title must be 1..${FEEDBACK_MAX_TITLE_LENGTH} characters`,
    };
  }
  if (typeof rec.description !== "string") {
    return { ok: false, error: "Description is required" };
  }
  const description = rec.description.trim();
  if (description.length < 1 || description.length > FEEDBACK_MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description must be 1..${FEEDBACK_MAX_DESCRIPTION_LENGTH} characters`,
    };
  }

  let includeDiagnostics = true;
  if (rec.includeDiagnostics !== undefined) {
    if (typeof rec.includeDiagnostics !== "boolean") {
      return { ok: false, error: "includeDiagnostics must be a boolean" };
    }
    includeDiagnostics = rec.includeDiagnostics;
  }

  let diagnostics: FeedbackDiagnostics | undefined;
  if (rec.diagnostics !== undefined && rec.diagnostics !== null) {
    if (typeof rec.diagnostics !== "object" || Array.isArray(rec.diagnostics)) {
      return { ok: false, error: "diagnostics must be an object" };
    }
    diagnostics = sanitizeFeedbackDiagnostics(rec.diagnostics);
  }

  return {
    ok: true,
    value: {
      category: rec.category as FeedbackCategory,
      title,
      description,
      includeDiagnostics,
      diagnostics,
    },
  };
}

export function formatFeedbackIssueTitle(
  category: FeedbackCategory,
  title: string,
): string {
  const { prefix } = CATEGORY_META[category];
  const trimmed = title.trim();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function formatFeedbackIssueBody(
  description: string,
  diagnostics?: FeedbackDiagnostics,
  includeDiagnostics = true,
): string {
  const cleanDescription = description.trim();
  const sections: string[] = [`### Description\n\n${cleanDescription}`];

  if (includeDiagnostics && diagnostics) {
    const sanitized = sanitizeFeedbackDiagnostics(diagnostics);
    const rows: string[] = [];
    for (const key of FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS) {
      const value = sanitized[key];
      if (value === undefined) continue;
      const formattedValue =
        key === "contextPercent" ? `${value}%` : String(value);
      rows.push(
        `| ${DIAGNOSTIC_LABELS[key]} | ${escapeMarkdownCell(formattedValue)} |`,
      );
    }
    if (rows.length > 0) {
      sections.push(
        `### Environment Diagnostics\n\n| Field | Value |\n| --- | --- |\n${rows.join("\n")}`,
      );
    }
  }

  return sections.join("\n\n");
}

function encodePrefillUrl(params: {
  title: string;
  body: string;
  label?: string;
}): string {
  const search = new URLSearchParams();
  search.set("title", params.title);
  search.set("body", params.body);
  if (params.label) {
    search.set("labels", params.label);
  }
  return `${FEEDBACK_NEW_ISSUE_URL}?${search.toString()}`;
}

export function buildPrefillFeedbackIssueUrl(params: {
  title: string;
  body: string;
  label?: string;
}): { url: string; truncated: boolean } {
  const fullUrl = encodePrefillUrl(params);
  if (fullUrl.length <= FEEDBACK_MAX_PREFILL_URL_LENGTH) {
    return { url: fullUrl, truncated: false };
  }

  let low = 0;
  let high = params.body.length;
  let bestUrl = encodePrefillUrl({
    title: params.title,
    body: FEEDBACK_TRUNCATION_SUFFIX.trimStart(),
    label: params.label,
  });

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidateBody =
      params.body.slice(0, mid) + FEEDBACK_TRUNCATION_SUFFIX;
    const candidateUrl = encodePrefillUrl({
      title: params.title,
      body: candidateBody,
      label: params.label,
    });
    if (candidateUrl.length <= FEEDBACK_MAX_PREFILL_URL_LENGTH) {
      bestUrl = candidateUrl;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestUrl.length > FEEDBACK_MAX_PREFILL_URL_LENGTH) {
    bestUrl = encodePrefillUrl({
      title: params.title,
      body: "",
      label: params.label,
    }).slice(0, FEEDBACK_MAX_PREFILL_URL_LENGTH);
  }

  return { url: bestUrl, truncated: true };
}

const FEEDBACK_ISSUES_WEB_PREFIX =
  `https://github.com/${FEEDBACK_GITHUB_SLUG}/issues/` as const;
const CREATED_ISSUE_PATH_RE = /^\/jakehesson\/agent-studio\/issues\/\d+$/;

/**
 * Strict URL guard for `agentStudio:openFeedbackUrl` before calling
 * `vscode.env.openExternal`. Only allows:
 * - `https://github.com/jakehesson/agent-studio/issues/new` (optional query params)
 * - `https://github.com/jakehesson/agent-studio/issues/<number>`
 */
export function validateFeedbackExternalUrl(
  rawUrl: unknown,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof rawUrl !== "string" || !rawUrl) {
    return { ok: false, reason: "Missing feedback URL" };
  }
  if (!rawUrl.startsWith(FEEDBACK_ISSUES_WEB_PREFIX)) {
    return {
      ok: false,
      reason: `Feedback URL must start with ${FEEDBACK_ISSUES_WEB_PREFIX}`,
    };
  }
  const rawBeforeQuery = rawUrl.split(/[?#]/)[0] ?? "";
  if (/\/\.\.(?:\/|$)/.test(rawBeforeQuery)) {
    return { ok: false, reason: "Path traversal segments are disallowed" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid feedback URL" };
  }
  if (parsed.protocol !== "https:" || parsed.origin !== "https://github.com") {
    return {
      ok: false,
      reason: `Disallowed feedback URL origin: ${parsed.origin}`,
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Credentials in feedback URL are disallowed" };
  }
  const isNewIssue =
    parsed.pathname === `/${FEEDBACK_GITHUB_SLUG}/issues/new`;
  const isCreatedIssue = CREATED_ISSUE_PATH_RE.test(parsed.pathname);
  if (!isNewIssue && !isCreatedIssue) {
    return {
      ok: false,
      reason: `Disallowed feedback URL pathname: ${parsed.pathname}`,
    };
  }
  return { ok: true, url: parsed.toString() };
}

function sanitizeErrorReason(raw: unknown, tokenToRedact?: string): string {
  let msg = raw instanceof Error ? raw.message : String(raw ?? "");
  if (tokenToRedact) {
    msg = msg.split(tokenToRedact).join("[redacted]");
  }
  msg = msg
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return msg.slice(0, 240) || "Unknown error";
}

function parseIssueNumberFromUrl(url: string): number {
  const match = /\/issues\/(\d+)(?:$|[?#])/.exec(url);
  if (!match) return 0;
  const num = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(num) ? num : 0;
}

export async function handleFeedbackStatusRequest(
  requestId: unknown,
  auth?: VscodeAuthLike | null,
): Promise<FeedbackStatusMessage> {
  const cleanRequestId = typeof requestId === "string" ? requestId : "";
  if (!auth || typeof auth.getSession !== "function") {
    return {
      type: "agentStudio:feedbackStatus",
      requestId: cleanRequestId,
      githubAuthAvailable: false,
    };
  }
  try {
    const session = await auth.getSession("github", ["public_repo"], {
      silent: true,
    });
    const available = Boolean(session?.accessToken);
    const label = session?.account?.label;
    return {
      type: "agentStudio:feedbackStatus",
      requestId: cleanRequestId,
      githubAuthAvailable: available,
      ...(available && label ? { accountLabel: label } : {}),
    };
  } catch {
    return {
      type: "agentStudio:feedbackStatus",
      requestId: cleanRequestId,
      githubAuthAvailable: false,
    };
  }
}

export async function handleSubmitFeedback(
  requestId: unknown,
  rawPayload: unknown,
  deps?: {
    auth?: VscodeAuthLike | null;
    fetch?: FeedbackFetchFn;
    appVersion?: string;
    platform?: string;
  },
): Promise<FeedbackSubmitResultMessage> {
  const cleanRequestId = typeof requestId === "string" ? requestId : "";
  const validated = validateFeedbackPayload(rawPayload);
  if (!validated.ok) {
    return {
      type: "agentStudio:submitFeedbackResult",
      requestId: cleanRequestId,
      ok: false,
      mode: "fallback",
      fallbackUrl: FEEDBACK_NEW_ISSUE_URL,
      truncated: false,
      reason: validated.error,
    };
  }

  const input = validated.value;
  const { label } = CATEGORY_META[input.category];
  const issueTitle = formatFeedbackIssueTitle(input.category, input.title);
  const platform = deps?.platform ?? process.platform;
  const sanitizedDiagnostics = input.includeDiagnostics
    ? sanitizeFeedbackDiagnostics({
        ...(input.diagnostics ?? {}),
        osPlatform: platform,
      })
    : undefined;
  const issueBody = formatFeedbackIssueBody(
    input.description,
    sanitizedDiagnostics,
    input.includeDiagnostics,
  );
  const prefill = buildPrefillFeedbackIssueUrl({
    title: issueTitle,
    body: issueBody,
    label,
  });

  const auth = deps?.auth;
  if (!auth || typeof auth.getSession !== "function") {
    return {
      type: "agentStudio:submitFeedbackResult",
      requestId: cleanRequestId,
      ok: false,
      mode: "fallback",
      fallbackUrl: prefill.url,
      truncated: prefill.truncated,
      reason: "GitHub authentication provider is unavailable in this host",
    };
  }

  let session: GitHubAuthSessionLike | undefined;
  try {
    session = await auth.getSession("github", ["public_repo"], {
      createIfNone: true,
    });
  } catch (err) {
    return {
      type: "agentStudio:submitFeedbackResult",
      requestId: cleanRequestId,
      ok: false,
      mode: "fallback",
      fallbackUrl: prefill.url,
      truncated: prefill.truncated,
      reason: `GitHub sign-in failed: ${sanitizeErrorReason(err)}`,
    };
  }

  const token = session?.accessToken?.trim();
  if (!token) {
    return {
      type: "agentStudio:submitFeedbackResult",
      requestId: cleanRequestId,
      ok: false,
      mode: "fallback",
      fallbackUrl: prefill.url,
      truncated: prefill.truncated,
      reason: "GitHub authentication was cancelled or unavailable",
    };
  }

  const fetchFn: FeedbackFetchFn =
    deps?.fetch ??
    ((url, init) =>
      globalThis.fetch(url, init) as Promise<
        ReturnType<FeedbackFetchFn> extends Promise<infer R> ? R : never
      >);
  const appVersion = deps?.appVersion ?? "0.11.1";

  const attempt = async (includeLabels: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const bodyPayload = includeLabels
        ? { title: issueTitle, body: issueBody, labels: [label] }
        : { title: issueTitle, body: issueBody };
      return await fetchFn(FEEDBACK_ISSUES_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": `agent-studio-vscode/${appVersion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await attempt(true);
    if (res.status === 422) {
      res = await attempt(false);
    }
    if (res.status === 201) {
      const json = (await res.json()) as {
        html_url?: unknown;
        number?: unknown;
      };
      const issueUrl =
        typeof json.html_url === "string" && json.html_url.trim()
          ? json.html_url.trim()
          : FEEDBACK_NEW_ISSUE_URL;
      const issueNumber =
        typeof json.number === "number" && Number.isFinite(json.number)
          ? json.number
          : parseIssueNumberFromUrl(issueUrl);
      return {
        type: "agentStudio:submitFeedbackResult",
        requestId: cleanRequestId,
        ok: true,
        mode: "created",
        issueUrl,
        issueNumber,
      };
    }
    return {
      type: "agentStudio:submitFeedbackResult",
      requestId: cleanRequestId,
      ok: false,
      mode: "fallback",
      fallbackUrl: prefill.url,
      truncated: prefill.truncated,
      reason: `GitHub API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      type: "agentStudio:submitFeedbackResult",
      requestId: cleanRequestId,
      ok: false,
      mode: "fallback",
      fallbackUrl: prefill.url,
      truncated: prefill.truncated,
      reason: `GitHub API request failed: ${sanitizeErrorReason(err, token)}`,
    };
  }
}
