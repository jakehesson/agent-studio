import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import type * as ExtFeedbackModule from "../../extension/src/feedback.js";
import {
  FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS,
  FEEDBACK_GITHUB_OWNER,
  FEEDBACK_GITHUB_REPO,
  FEEDBACK_GITHUB_SLUG,
  FEEDBACK_ISSUES_API_URL,
  FEEDBACK_MAX_DESCRIPTION_LENGTH,
  FEEDBACK_MAX_PREFILL_URL_LENGTH,
  FEEDBACK_MAX_TITLE_LENGTH,
  FEEDBACK_NEW_ISSUE_URL,
  FeedbackCategorySchema,
  FeedbackIdeSchema,
  buildPrefillFeedbackIssueUrl,
  formatFeedbackIssueTitle,
  getFeedbackCategoryMeta,
  sanitizeFeedbackDiagnostics,
  type FeedbackCategory,
  type FeedbackDiagnostics,
} from "../../src/server/feedback.js";
import {
  inferContextWindow as coreInferContextWindow,
  type IdeSource,
} from "../../src/telemetry/types.js";

interface WebSnapshotContract {
  inferContextWindow(model?: string, ide?: IdeSource): number;
}

interface WebFeedbackUrlContract {
  FEEDBACK_GITHUB_OWNER: string;
  FEEDBACK_GITHUB_REPO: string;
  FEEDBACK_ISSUES_API_URL: string;
  FEEDBACK_NEW_ISSUE_URL: string;
  FEEDBACK_URL_MAX_LEN: number;
  FEEDBACK_CATEGORY_META: Record<
    FeedbackCategory,
    { label: string; githubLabel: string; prefix: string }
  >;
  sanitizeClientDiagnostics(raw?: FeedbackDiagnostics): FeedbackDiagnostics;
  formatFeedbackTitle(category: FeedbackCategory, rawTitle: string): string;
  isAllowedFeedbackNewIssueUrl(rawUrl: string): boolean;
  isAllowedFeedbackIssueUrl(rawUrl: string): boolean;
  buildPrefilledIssueUrl(payload: {
    category: FeedbackCategory;
    title: string;
    description: string;
    includeDiagnostics: boolean;
    diagnostics?: FeedbackDiagnostics;
  }): { url: string; truncated: boolean; fullMarkdown: string };
}

const REPO_ROOT = path.resolve(process.cwd());

function loadTranspiledTsModule<T>(
  relPath: string,
  stubRequire?: (specifier: string) => unknown,
): T {
  const absPath = path.join(REPO_ROOT, relPath);
  const source = fs.readFileSync(absPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Partial<T> };
  const requireStub =
    stubRequire ??
    ((specifier: string) => {
      throw new Error(`Unexpected runtime import "${specifier}" in ${relPath}`);
    });
  const fn = new Function("exports", "module", "require", outputText);
  fn(mod.exports, mod, requireStub);
  return mod.exports as T;
}

const webSnapshot = loadTranspiledTsModule<WebSnapshotContract>(
  "web/src/state/snapshot.ts",
  (specifier) => {
    if (specifier === "../utils.js") {
      return new Proxy(
        {},
        {
          get: () => () => undefined,
        },
      );
    }
    throw new Error(`Unexpected import ${specifier} in web/src/state/snapshot.ts`);
  },
);

const extFeedback = loadTranspiledTsModule<typeof ExtFeedbackModule>(
  "extension/src/feedback.ts",
);

const webFeedbackUrl = loadTranspiledTsModule<WebFeedbackUrlContract>(
  "web/src/utils/feedbackUrl.ts",
);

describe("Cross-Package Contract Parity", () => {
  describe("inferContextWindow parity (src/telemetry/types.ts vs web/src/state/snapshot.ts)", () => {
    const IDES: Array<IdeSource | undefined> = [
      undefined,
      "antigravity",
      "claude-code",
      "copilot-vscode",
      "mcp",
      "unknown",
    ];

    const MODEL_MATRIX: Array<{ model: string; expectedByIde?: Record<string, number>; expected?: number }> = [
      // Unknown / empty models depend on IDE (Antigravity defaults to 1M, others 200k)
      {
        model: "",
        expectedByIde: {
          undefined: 200_000,
          antigravity: 1_000_000,
          "claude-code": 200_000,
          "copilot-vscode": 200_000,
          mcp: 200_000,
          unknown: 200_000,
        },
      },
      {
        model: "   ",
        expectedByIde: {
          undefined: 200_000,
          antigravity: 1_000_000,
          "claude-code": 200_000,
          "copilot-vscode": 200_000,
          mcp: 200_000,
          unknown: 200_000,
        },
      },
      {
        model: "unknown",
        expectedByIde: {
          undefined: 200_000,
          antigravity: 1_000_000,
          "claude-code": 200_000,
          "copilot-vscode": 200_000,
          mcp: 200_000,
          unknown: 200_000,
        },
      },
      {
        model: "UNKNOWN",
        expectedByIde: {
          undefined: 200_000,
          antigravity: 1_000_000,
          "claude-code": 200_000,
          "copilot-vscode": 200_000,
          mcp: 200_000,
          unknown: 200_000,
        },
      },
      // Explicit [1m] marker always yields 1M
      { model: "claude-opus-4-6[1m]", expected: 1_000_000 },
      { model: "Claude Sonnet 4.5 [1M]", expected: 1_000_000 },
      { model: "gpt-4o [1m]", expected: 1_000_000 },
      { model: "unknown [1m]", expected: 1_000_000 },
      // 1M models (Gemini, GPT-4.1)
      { model: "gemini-2.5-pro", expected: 1_000_000 },
      { model: "gemini-2.5-flash", expected: 1_000_000 },
      { model: "Gemini 3 Pro (High)", expected: 1_000_000 },
      { model: "google/gemini-2.5-flash-lite", expected: 1_000_000 },
      { model: "gpt-4.1", expected: 1_000_000 },
      { model: "gpt-4.1-mini", expected: 1_000_000 },
      { model: "GPT 4.1", expected: 1_000_000 },
      // 400k models (GPT-5, GPT-6)
      { model: "gpt-5", expected: 400_000 },
      { model: "gpt-5.1-codex", expected: 400_000 },
      { model: "GPT 5 mini", expected: 400_000 },
      { model: "gpt-6", expected: 400_000 },
      { model: "GPT 6 Preview", expected: 400_000 },
      // 128k models (GPT-4o, o1/o3/o4)
      { model: "gpt-4o", expected: 128_000 },
      { model: "gpt-4o-mini", expected: 128_000 },
      { model: "GPT 4o", expected: 128_000 },
      { model: "o1", expected: 128_000 },
      { model: "o1-preview", expected: 128_000 },
      { model: "o3", expected: 128_000 },
      { model: "o3-mini", expected: 128_000 },
      { model: "o4-mini", expected: 128_000 },
      { model: "openai/o3_high", expected: 128_000 },
      // 200k default models & boundary non-matches
      { model: "claude-opus-4-5", expected: 200_000 },
      { model: "claude-sonnet-4-5", expected: 200_000 },
      { model: "claude-haiku-4-5", expected: 200_000 },
      { model: "opus", expected: 200_000 },
      { model: "sonnet", expected: 200_000 },
      { model: "haiku", expected: 200_000 },
      { model: "gpt-4", expected: 200_000 },
      { model: "gpt-4-turbo", expected: 200_000 },
      { model: "o2", expected: 200_000 },
      { model: "o30", expected: 200_000 },
      { model: "foo1", expected: 200_000 },
      { model: "custom-model", expected: 200_000 },
    ];

    it("produces identical context windows across the full model x IDE matrix", () => {
      for (const entry of MODEL_MATRIX) {
        for (const ide of IDES) {
          const coreVal = coreInferContextWindow(entry.model, ide);
          const webVal = webSnapshot.inferContextWindow(entry.model, ide);
          const expected =
            entry.expected ?? entry.expectedByIde?.[String(ide)] ?? 200_000;
          assert.equal(
            coreVal,
            expected,
            `core inferContextWindow(${JSON.stringify(entry.model)}, ${String(ide)}) expected ${expected}, got ${coreVal}`,
          );
          assert.equal(
            webVal,
            coreVal,
            `web inferContextWindow(${JSON.stringify(entry.model)}, ${String(ide)}) drifted from core: web=${webVal}, core=${coreVal}`,
          );
        }
      }
    });
  });

  describe("Feedback contract parity (server, extension, and web)", () => {
    it("locks jakehesson/agent-studio repository constants identically across all 3 packages", () => {
      const expectedOwner = "jakehesson";
      const expectedRepo = "agent-studio";
      const expectedSlug = "jakehesson/agent-studio";
      const expectedApiUrl =
        "https://api.github.com/repos/jakehesson/agent-studio/issues";
      const expectedNewIssueUrl =
        "https://github.com/jakehesson/agent-studio/issues/new";

      assert.equal(FEEDBACK_GITHUB_OWNER, expectedOwner);
      assert.equal(extFeedback.FEEDBACK_GITHUB_OWNER, expectedOwner);
      assert.equal(webFeedbackUrl.FEEDBACK_GITHUB_OWNER, expectedOwner);

      assert.equal(FEEDBACK_GITHUB_REPO, expectedRepo);
      assert.equal(extFeedback.FEEDBACK_GITHUB_REPO, expectedRepo);
      assert.equal(webFeedbackUrl.FEEDBACK_GITHUB_REPO, expectedRepo);

      assert.equal(FEEDBACK_GITHUB_SLUG, expectedSlug);
      assert.equal(extFeedback.FEEDBACK_GITHUB_SLUG, expectedSlug);

      assert.equal(FEEDBACK_ISSUES_API_URL, expectedApiUrl);
      assert.equal(extFeedback.FEEDBACK_ISSUES_API_URL, expectedApiUrl);
      assert.equal(webFeedbackUrl.FEEDBACK_ISSUES_API_URL, expectedApiUrl);

      assert.equal(FEEDBACK_NEW_ISSUE_URL, expectedNewIssueUrl);
      assert.equal(extFeedback.FEEDBACK_NEW_ISSUE_URL, expectedNewIssueUrl);
      assert.equal(webFeedbackUrl.FEEDBACK_NEW_ISSUE_URL, expectedNewIssueUrl);

      assert.equal(FEEDBACK_MAX_PREFILL_URL_LENGTH, 6000);
      assert.equal(extFeedback.FEEDBACK_MAX_PREFILL_URL_LENGTH, 6000);
      assert.equal(webFeedbackUrl.FEEDBACK_URL_MAX_LEN, 6000);

      assert.equal(FEEDBACK_MAX_TITLE_LENGTH, extFeedback.FEEDBACK_MAX_TITLE_LENGTH);
      assert.equal(
        FEEDBACK_MAX_DESCRIPTION_LENGTH,
        extFeedback.FEEDBACK_MAX_DESCRIPTION_LENGTH,
      );
    });

    it("agrees on allowed categories, labels, and title prefixes across server, extension, and web", () => {
      const expectedCategories = ["bug", "feature", "telemetry", "question"] as const;
      assert.deepEqual([...FeedbackCategorySchema.options], [...expectedCategories]);
      assert.deepEqual(
        Object.keys(webFeedbackUrl.FEEDBACK_CATEGORY_META).sort(),
        [...expectedCategories].sort(),
      );

      for (const cat of expectedCategories) {
        const coreMeta = getFeedbackCategoryMeta(cat);
        const webMeta = webFeedbackUrl.FEEDBACK_CATEGORY_META[cat];
        assert.equal(webMeta.githubLabel, coreMeta.label);
        assert.equal(webMeta.prefix, coreMeta.prefix);

        const extValidated = extFeedback.validateFeedbackPayload({
          category: cat,
          title: "Sample issue",
          description: "Sample description",
        });
        assert.equal(extValidated.ok, true, `Extension rejected category ${cat}`);

        const coreTitle = formatFeedbackIssueTitle(cat, "Sample issue");
        const extTitle = extFeedback.formatFeedbackIssueTitle(cat, "Sample issue");
        const webTitle = webFeedbackUrl.formatFeedbackTitle(cat, "Sample issue");
        assert.equal(extTitle, coreTitle);
        assert.equal(webTitle, coreTitle);
      }

      // Disallowed categories must be rejected by both server Zod schema and extension validator
      for (const badCat of ["other", "security", "enhancement", ""]) {
        assert.equal(FeedbackCategorySchema.safeParse(badCat).success, false);
        assert.equal(
          extFeedback.validateFeedbackPayload({
            category: badCat,
            title: "Sample",
            description: "Desc",
          }).ok,
          false,
        );
      }
    });

    it("agrees on allowed diagnostic keys and IDE enum values across all 3 packages", () => {
      assert.deepEqual(
        [...FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS],
        [...extFeedback.FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS],
      );

      const sampleInput = {
        appVersion: "0.11.1",
        ide: "antigravity",
        model: "claude-opus-4-5",
        contextTokens: 12000,
        contextWindow: 200000,
        contextPercent: 6,
        agentCount: 4,
        eventCount: 25,
        embedMode: true,
        osPlatform: "win32",
        // Must be stripped by all 3:
        workspacePath: "/secret/workspace",
        sessionId: "secret-session",
        token: "ghp_secret",
      };

      const coreSanitized = sanitizeFeedbackDiagnostics(sampleInput);
      const extSanitized = extFeedback.sanitizeFeedbackDiagnostics(sampleInput);
      const webSanitized = webFeedbackUrl.sanitizeClientDiagnostics(
        sampleInput as unknown as Parameters<typeof webFeedbackUrl.sanitizeClientDiagnostics>[0],
      );

      assert.deepEqual(extSanitized, coreSanitized);
      assert.deepEqual(webSanitized, coreSanitized);

      for (const ide of FeedbackIdeSchema.options) {
        assert.equal(
          webFeedbackUrl.sanitizeClientDiagnostics({ ide }).ide,
          ide,
          `Web dropped valid IDE ${ide}`,
        );
      }
      assert.equal(
        webFeedbackUrl.sanitizeClientDiagnostics({ ide: "invalid-ide" as never }).ide,
        undefined,
      );
    });

    it("enforces identical allowed external URL patterns (/issues/new and /issues/<digits>)", () => {
      const urlCases: Array<{
        url: string;
        allowedIssue: boolean;
        allowedNewIssue: boolean;
      }> = [
        {
          url: "https://github.com/jakehesson/agent-studio/issues/new",
          allowedIssue: true,
          allowedNewIssue: true,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues/new?title=Bug&labels=bug",
          allowedIssue: true,
          allowedNewIssue: true,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues/1",
          allowedIssue: true,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues/4290",
          allowedIssue: true,
          allowedNewIssue: false,
        },
        // Disallowed URLs
        {
          url: "https://github.com/evil/agent-studio/issues/new",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/other-repo/issues/1",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "http://github.com/jakehesson/agent-studio/issues/new",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://user:pass@github.com/jakehesson/agent-studio/issues/new",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues/abc",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues/12/comments",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues/new/../settings",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/issues",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "https://github.com/jakehesson/agent-studio/pulls/12",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "javascript:alert(1)",
          allowedIssue: false,
          allowedNewIssue: false,
        },
        {
          url: "",
          allowedIssue: false,
          allowedNewIssue: false,
        },
      ];

      for (const tc of urlCases) {
        assert.equal(
          extFeedback.validateFeedbackExternalUrl(tc.url).ok,
          tc.allowedIssue,
          `Extension validateFeedbackExternalUrl(${JSON.stringify(tc.url)}) mismatch`,
        );
        assert.equal(
          webFeedbackUrl.isAllowedFeedbackIssueUrl(tc.url),
          tc.allowedIssue,
          `Web isAllowedFeedbackIssueUrl(${JSON.stringify(tc.url)}) mismatch`,
        );
        assert.equal(
          webFeedbackUrl.isAllowedFeedbackNewIssueUrl(tc.url),
          tc.allowedNewIssue,
          `Web isAllowedFeedbackNewIssueUrl(${JSON.stringify(tc.url)}) mismatch`,
        );
      }

      // Generated prefill URLs from all 3 modules must pass both guards and obey <= 6000 chars
      const longDesc = "x".repeat(3900);
      const serverPrefill = buildPrefillFeedbackIssueUrl({
        title: "[Telemetry] Context mismatch",
        body: longDesc,
        label: "telemetry",
      });
      const extPrefill = extFeedback.buildPrefillFeedbackIssueUrl({
        title: "[Telemetry] Context mismatch",
        body: longDesc,
        label: "telemetry",
      });
      const webPrefill = webFeedbackUrl.buildPrefilledIssueUrl({
        category: "telemetry",
        title: "Context mismatch",
        description: longDesc,
        includeDiagnostics: false,
      });

      for (const prefill of [serverPrefill, extPrefill, webPrefill]) {
        assert.ok(prefill.url.length <= 6000);
        assert.equal(extFeedback.validateFeedbackExternalUrl(prefill.url).ok, true);
        assert.equal(webFeedbackUrl.isAllowedFeedbackNewIssueUrl(prefill.url), true);
        assert.equal(webFeedbackUrl.isAllowedFeedbackIssueUrl(prefill.url), true);
      }
    });
  });
});
