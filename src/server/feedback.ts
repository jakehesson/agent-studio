import { execFile as nodeExecFile } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

declare const __AGENT_STUDIO_VERSION__: string | undefined;

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
export const FEEDBACK_BODY_MAX_BYTES = 32 * 1024;
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

export const FeedbackCategorySchema = z.enum([
  "bug",
  "feature",
  "telemetry",
  "question",
]);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;

export const FeedbackIdeSchema = z.enum([
  "antigravity",
  "claude-code",
  "copilot-vscode",
  "mcp",
  "unknown",
]);
export type FeedbackIde = z.infer<typeof FeedbackIdeSchema>;

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

export const FeedbackSubmitPayloadSchema = z
  .object({
    category: FeedbackCategorySchema,
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(
        FEEDBACK_MAX_TITLE_LENGTH,
        `Title must be at most ${FEEDBACK_MAX_TITLE_LENGTH} characters`,
      ),
    description: z
      .string()
      .trim()
      .min(1, "Description is required")
      .max(
        FEEDBACK_MAX_DESCRIPTION_LENGTH,
        `Description must be at most ${FEEDBACK_MAX_DESCRIPTION_LENGTH} characters`,
      ),
    includeDiagnostics: z.boolean().optional().default(true),
    diagnostics: z
      .record(z.unknown())
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .strict();

export type FeedbackSubmitPayload = z.infer<typeof FeedbackSubmitPayloadSchema>;

export type FeedbackAuthMethod = "github-token" | "gh-cli" | "none";

export interface FeedbackStatusResponse {
  ok: true;
  repo: typeof FEEDBACK_GITHUB_SLUG;
  directAvailable: boolean;
  method: FeedbackAuthMethod;
  newIssueUrl: typeof FEEDBACK_NEW_ISSUE_URL;
  appVersion: string;
}

export type FeedbackSubmitResponse =
  | {
      ok: true;
      mode: "created";
      issueUrl: string;
      issueNumber: number;
    }
  | {
      ok: true;
      mode: "fallback";
      prefillUrl: string;
      truncated: boolean;
      reason: string;
    }
  | {
      ok: false;
      error: string;
    };

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface FeedbackServerDeps {
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileFn;
  fetch?: FetchFn;
  appVersion?: string;
  platform?: string;
}

const FEEDBACK_IDE_VALUES = new Set<string>(FeedbackIdeSchema.options);

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

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      {
        timeout: options.timeout ?? 10_000,
        windowsHide: options.windowsHide ?? true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errWithOutput = error as Error & {
            stdout?: string;
            stderr?: string;
          };
          errWithOutput.stdout = typeof stdout === "string" ? stdout : "";
          errWithOutput.stderr = typeof stderr === "string" ? stderr : "";
          reject(errWithOutput);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

export function getAgentStudioVersion(): string {
  if (
    typeof __AGENT_STUDIO_VERSION__ === "string" &&
    __AGENT_STUDIO_VERSION__.trim().length > 0
  ) {
    return __AGENT_STUDIO_VERSION__.trim();
  }
  const envVer = process.env.AGENT_STUDIO_VERSION?.trim();
  if (envVer) {
    return envVer;
  }
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of [
      "../../package.json",
      "../package.json",
      "../../../package.json",
    ]) {
      const candidate = path.resolve(thisDir, rel);
      if (!fsSync.existsSync(candidate)) continue;
      const parsed = JSON.parse(fsSync.readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        (parsed.name === "@jakehesson/agent-studio" ||
          parsed.name === "agent-studio" ||
          parsed.name === "agent-studio-vscode") &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version.trim();
      }
    }
  } catch {
    // Fall through to default version
  }
  return "0.11.1";
}

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

/**
 * Strictly allowlist diagnostics keys, enforce bounds, and strip any
 * unexpected keys or nested objects.
 */
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
    const rawIde = rec.ide;
    if (typeof rawIde === "string" && FEEDBACK_IDE_VALUES.has(rawIde)) {
      out.ide = rawIde as FeedbackIde;
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

export function getFeedbackCategoryMeta(category: FeedbackCategory): {
  label: string;
  prefix: string;
} {
  return CATEGORY_META[category];
}

export function formatFeedbackIssueTitle(
  category: FeedbackCategory,
  title: string,
): string {
  const { prefix } = getFeedbackCategoryMeta(category);
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

export async function resolveFeedbackStatus(
  deps?: FeedbackServerDeps,
): Promise<FeedbackStatusResponse> {
  const env = deps?.env ?? process.env;
  const execFile = deps?.execFile ?? defaultExecFile;
  const appVersion = deps?.appVersion ?? getAgentStudioVersion();

  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
  if (token.length > 0) {
    return {
      ok: true,
      repo: FEEDBACK_GITHUB_SLUG,
      directAvailable: true,
      method: "github-token",
      newIssueUrl: FEEDBACK_NEW_ISSUE_URL,
      appVersion,
    };
  }

  let ghAvailable = false;
  try {
    await execFile("gh", ["--version"], {
      timeout: 2000,
      windowsHide: true,
    });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }

  return {
    ok: true,
    repo: FEEDBACK_GITHUB_SLUG,
    directAvailable: ghAvailable,
    method: ghAvailable ? "gh-cli" : "none",
    newIssueUrl: FEEDBACK_NEW_ISSUE_URL,
    appVersion,
  };
}

async function createIssueViaRestApi(params: {
  fetchFn: FetchFn;
  token: string;
  title: string;
  body: string;
  label: string;
  appVersion: string;
}): Promise<
  | { ok: true; issueUrl: string; issueNumber: number }
  | { ok: false; reason: string }
> {
  const attempt = async (includeLabels: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const payload = includeLabels
        ? { title: params.title, body: params.body, labels: [params.label] }
        : { title: params.title, body: params.body };
      return await params.fetchFn(FEEDBACK_ISSUES_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${params.token}`,
          "Content-Type": "application/json",
          "User-Agent": `agent-studio/${params.appVersion}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(payload),
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
          : `${FEEDBACK_NEW_ISSUE_URL}`;
      const issueNumber =
        typeof json.number === "number" && Number.isFinite(json.number)
          ? json.number
          : parseIssueNumberFromUrl(issueUrl);
      return { ok: true, issueUrl, issueNumber };
    }
    return {
      ok: false,
      reason: `GitHub API returned HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `GitHub API request failed: ${sanitizeErrorReason(err, params.token)}`,
    };
  }
}

async function createIssueViaGhCli(params: {
  execFile: ExecFileFn;
  title: string;
  body: string;
  label: string;
  tokenToRedact?: string;
}): Promise<
  | { ok: true; issueUrl: string; issueNumber: number }
  | { ok: false; reason: string; enoent?: boolean }
> {
  const runCreate = (withLabel: boolean) => {
    const args = [
      "issue",
      "create",
      "--repo",
      FEEDBACK_GITHUB_SLUG,
      "--title",
      params.title,
      "--body",
      params.body,
      ...(withLabel ? ["--label", params.label] : []),
    ];
    return params.execFile("gh", args, {
      timeout: 10_000,
      windowsHide: true,
    });
  };

  const extractCreated = (stdout: string) => {
    const match = /https:\/\/github\.com\/jakehesson\/agent-studio\/issues\/(\d+)/.exec(
      stdout,
    );
    if (match) {
      return {
        issueUrl: match[0],
        issueNumber: Number.parseInt(match[1] ?? "0", 10),
      };
    }
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("https://github.com/"));
    return {
      issueUrl: line ?? `https://github.com/${FEEDBACK_GITHUB_SLUG}/issues`,
      issueNumber: line ? parseIssueNumberFromUrl(line) : 0,
    };
  };

  try {
    const res = await runCreate(true);
    return { ok: true, ...extractCreated(res.stdout) };
  } catch (err) {
    const errObj = err as { code?: unknown; stderr?: string; message?: string };
    if (errObj?.code === "ENOENT") {
      return {
        ok: false,
        enoent: true,
        reason: "gh CLI is not installed",
      };
    }
    const stderr = typeof errObj?.stderr === "string" ? errObj.stderr : "";
    const combined = `${stderr} ${errObj?.message ?? ""}`;
    if (/label/i.test(combined)) {
      try {
        const retryRes = await runCreate(false);
        return { ok: true, ...extractCreated(retryRes.stdout) };
      } catch (retryErr) {
        return {
          ok: false,
          reason: `gh CLI failed: ${sanitizeErrorReason(
            (retryErr as { stderr?: string })?.stderr || retryErr,
            params.tokenToRedact,
          )}`,
        };
      }
    }
    return {
      ok: false,
      reason: `gh CLI failed: ${sanitizeErrorReason(
        stderr || err,
        params.tokenToRedact,
      )}`,
    };
  }
}

export async function submitFeedbackGithubIssue(
  rawPayload: unknown,
  deps?: FeedbackServerDeps,
): Promise<{ status: number; body: FeedbackSubmitResponse }> {
  const parsed = FeedbackSubmitPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join("; "),
      },
    };
  }

  const input = parsed.data;
  const env = deps?.env ?? process.env;
  const execFile = deps?.execFile ?? defaultExecFile;
  const fetchFn: FetchFn =
    deps?.fetch ??
    ((url, init) => globalThis.fetch(url, init) as Promise<ReturnType<FetchFn> extends Promise<infer R> ? R : never>);
  const appVersion = deps?.appVersion ?? getAgentStudioVersion();
  const platform = deps?.platform ?? process.platform;

  const { label } = getFeedbackCategoryMeta(input.category);
  const issueTitle = formatFeedbackIssueTitle(input.category, input.title);
  const sanitizedDiagnostics = input.includeDiagnostics
    ? sanitizeFeedbackDiagnostics({
        ...(input.diagnostics ?? {}),
        appVersion: input.diagnostics?.appVersion ?? appVersion,
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

  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
  const failureReasons: string[] = [];

  if (token.length > 0) {
    const apiResult = await createIssueViaRestApi({
      fetchFn,
      token,
      title: issueTitle,
      body: issueBody,
      label,
      appVersion,
    });
    if (apiResult.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          mode: "created",
          issueUrl: apiResult.issueUrl,
          issueNumber: apiResult.issueNumber,
        },
      };
    }
    failureReasons.push(apiResult.reason);
  }

  const ghResult = await createIssueViaGhCli({
    execFile,
    title: issueTitle,
    body: issueBody,
    label,
    tokenToRedact: token || undefined,
  });
  if (ghResult.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        mode: "created",
        issueUrl: ghResult.issueUrl,
        issueNumber: ghResult.issueNumber,
      },
    };
  }

  if (!ghResult.enoent || failureReasons.length === 0) {
    failureReasons.push(
      ghResult.enoent && !token
        ? "No GITHUB_TOKEN/GH_TOKEN configured and gh CLI is not installed"
        : ghResult.reason,
    );
  }

  return {
    status: 200,
    body: {
      ok: true,
      mode: "fallback",
      prefillUrl: prefill.url,
      truncated: prefill.truncated,
      reason: failureReasons.join("; "),
    },
  };
}
