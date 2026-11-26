import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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
  FEEDBACK_TRUNCATION_SUFFIX,
  buildPrefillFeedbackIssueUrl,
  createStudioServer,
  formatFeedbackIssueBody,
  formatFeedbackIssueTitle,
  sanitizeFeedbackDiagnostics,
  type FeedbackServerDeps,
} from "../../src/server/index.js";

function loadExtensionFeedbackModule(): typeof ExtFeedbackModule {
  const srcPath = path.join(process.cwd(), "extension", "src", "feedback.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} as Partial<typeof ExtFeedbackModule> };
  const fn = new Function("exports", "module", outputText);
  fn(mod.exports, mod);
  return mod.exports as typeof ExtFeedbackModule;
}

describe("In-App GitHub Feedback (S1-57)", () => {
  it("locks target repository constants strictly to jakehesson/agent-studio", () => {
    assert.equal(FEEDBACK_GITHUB_OWNER, "jakehesson");
    assert.equal(FEEDBACK_GITHUB_REPO, "agent-studio");
    assert.equal(FEEDBACK_GITHUB_SLUG, "jakehesson/agent-studio");
    assert.equal(
      FEEDBACK_ISSUES_API_URL,
      "https://api.github.com/repos/jakehesson/agent-studio/issues",
    );
    assert.equal(
      FEEDBACK_NEW_ISSUE_URL,
      "https://github.com/jakehesson/agent-studio/issues/new",
    );

    const extMod = loadExtensionFeedbackModule();
    assert.equal(extMod.FEEDBACK_GITHUB_OWNER, "jakehesson");
    assert.equal(extMod.FEEDBACK_GITHUB_REPO, "agent-studio");
    assert.equal(
      extMod.FEEDBACK_ISSUES_API_URL,
      "https://api.github.com/repos/jakehesson/agent-studio/issues",
    );
    assert.equal(
      extMod.FEEDBACK_NEW_ISSUE_URL,
      "https://github.com/jakehesson/agent-studio/issues/new",
    );
  });

  it("strictly allowlists sanitizeFeedbackDiagnostics keys and strips forbidden/nested fields", () => {
    const sanitized = sanitizeFeedbackDiagnostics({
      appVersion: "  0.11.1\n\nextra  ",
      ide: "antigravity",
      model: "claude-opus-4-5",
      contextTokens: 12345.9,
      contextWindow: 200000,
      contextPercent: 142,
      agentCount: 3.4,
      eventCount: -5,
      embedMode: true,
      osPlatform: "win32",
      // Forbidden & unexpected keys:
      workspacePath: "C:/secret/project",
      filePath: "/etc/passwd",
      sessionId: "sess-1234",
      prompt: "user prompt text",
      toolOutput: "secret output",
      token: "ghp_secret123",
      secret: "top-secret",
      owner: "attacker",
      repo: "evil",
      nested: { a: 1 },
    });

    assert.deepEqual(Object.keys(sanitized).sort(), [
      "agentCount",
      "appVersion",
      "contextPercent",
      "contextTokens",
      "contextWindow",
      "embedMode",
      "ide",
      "model",
      "osPlatform",
    ]);
    for (const key of Object.keys(sanitized)) {
      assert.ok(
        (FEEDBACK_ALLOWED_DIAGNOSTIC_KEYS as readonly string[]).includes(key),
        `Unexpected diagnostic key survived: ${key}`,
      );
    }
    assert.equal(sanitized.appVersion, "0.11.1 extra");
    assert.equal(sanitized.ide, "antigravity");
    assert.equal(sanitized.contextTokens, 12345);
    assert.equal(sanitized.contextPercent, 100);
    assert.equal(sanitized.agentCount, 3);
    assert.equal(sanitized.eventCount, undefined);
    assert.equal(sanitized.embedMode, true);

    // Invalid types & over-long strings are bounded/dropped
    const bounded = sanitizeFeedbackDiagnostics({
      appVersion: "v".repeat(100),
      ide: "evil-ide",
      model: "m".repeat(300),
      contextPercent: -10,
      embedMode: "yes",
      osPlatform: { nested: true },
    });
    assert.equal(bounded.appVersion?.length, 32);
    assert.equal(bounded.ide, undefined);
    assert.equal(bounded.model?.length, 120);
    assert.equal(bounded.contextPercent, 0);
    assert.equal(bounded.embedMode, undefined);
    assert.equal(bounded.osPlatform, undefined);
  });

  it("formats issue titles, Markdown diagnostic tables, and truncates prefill URLs to <= 6000 chars", () => {
    assert.equal(
      formatFeedbackIssueTitle("bug", "Crash on open"),
      "[Bug] Crash on open",
    );
    assert.equal(
      formatFeedbackIssueTitle("feature", "Dark mode toggle"),
      "[Feature] Dark mode toggle",
    );
    assert.equal(
      formatFeedbackIssueTitle("telemetry", "Missing subagent edge"),
      "[Telemetry] Missing subagent edge",
    );
    assert.equal(
      formatFeedbackIssueTitle("question", "How does SSE work?"),
      "[Question] How does SSE work?",
    );

    const bodyWithDiag = formatFeedbackIssueBody(
      "Timeline scrub fails",
      { ide: "copilot-vscode", agentCount: 2, embedMode: true },
      true,
    );
    assert.match(bodyWithDiag, /^### Description\n\nTimeline scrub fails/);
    assert.match(bodyWithDiag, /### Environment Diagnostics/);
    assert.match(bodyWithDiag, /\| IDE \| copilot-vscode \|/);
    assert.match(bodyWithDiag, /\| Agent Count \| 2 \|/);
    assert.ok(!bodyWithDiag.includes("Model"));

    const bodyWithoutDiag = formatFeedbackIssueBody(
      "Timeline scrub fails",
      { ide: "copilot-vscode", agentCount: 2 },
      false,
    );
    assert.ok(!bodyWithoutDiag.includes("Environment Diagnostics"));

    const shortPrefill = buildPrefillFeedbackIssueUrl({
      title: "[Bug] Short issue",
      body: "Short body",
      label: "bug",
    });
    assert.equal(shortPrefill.truncated, false);
    assert.ok(shortPrefill.url.startsWith(FEEDBACK_NEW_ISSUE_URL));

    const longBody = "A".repeat(7000) + "\n\nLine with spaces & symbols %$#@!";
    const prefill = buildPrefillFeedbackIssueUrl({
      title: "[Bug] Very long issue",
      body: longBody,
      label: "bug",
    });
    assert.equal(prefill.truncated, true);
    assert.ok(prefill.url.startsWith(FEEDBACK_NEW_ISSUE_URL));
    assert.ok(
      prefill.url.length <= FEEDBACK_MAX_PREFILL_URL_LENGTH,
      `Expected URL <= 6000 chars, got ${prefill.url.length}`,
    );
    const parsed = new URL(prefill.url);
    assert.ok(
      (parsed.searchParams.get("body") ?? "").endsWith(
        FEEDBACK_TRUNCATION_SUFFIX,
      ),
    );
  });

  describe("HTTP server feedback routes", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "av-feedback-test-"),
      );
    });

    afterEach(async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    async function startServer(feedbackDeps: FeedbackServerDeps) {
      const srv = createStudioServer({
        brainDir: path.join(tmpDir, "brain"),
        claudeDir: path.join(tmpDir, "claude"),
        vscodeDir: path.join(tmpDir, "vscode"),
        webDir: path.join(tmpDir, "web"),
        includeGlobalTelemetryFile: false,
        feedbackDeps,
      });
      const { port } = await srv.listen(0, "127.0.0.1");
      return { srv, base: `http://127.0.0.1:${port}` };
    }

    it("GET /api/feedback/status detects github-token, gh-cli, and none", async () => {
      // 1. github-token
      const s1 = await startServer({
        env: { GITHUB_TOKEN: "ghp_mocktoken" },
        appVersion: "0.11.1",
      });
      try {
        const res = await fetch(`${s1.base}/api/feedback/status`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(data, {
          ok: true,
          repo: "jakehesson/agent-studio",
          directAvailable: true,
          method: "github-token",
          newIssueUrl: FEEDBACK_NEW_ISSUE_URL,
          appVersion: "0.11.1",
        });
      } finally {
        await s1.srv.close();
      }

      // 2. gh-cli (only calls gh --version)
      const ghCalls: Array<{ file: string; args: readonly string[] }> = [];
      const s2 = await startServer({
        env: {},
        appVersion: "0.11.1",
        execFile: async (file, args) => {
          ghCalls.push({ file, args });
          return { stdout: "gh version 2.60.0", stderr: "" };
        },
      });
      try {
        const res = await fetch(`${s2.base}/api/feedback/status`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as Record<string, unknown>;
        assert.equal(data.method, "gh-cli");
        assert.equal(data.directAvailable, true);
        assert.equal(ghCalls.length, 1);
        assert.equal(ghCalls[0]?.file, "gh");
        assert.deepEqual(ghCalls[0]?.args, ["--version"]);
      } finally {
        await s2.srv.close();
      }

      // 3. none
      const s3 = await startServer({
        env: {},
        appVersion: "0.11.1",
        execFile: async () => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        },
      });
      try {
        const res = await fetch(`${s3.base}/api/feedback/status`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as Record<string, unknown>;
        assert.equal(data.method, "none");
        assert.equal(data.directAvailable, false);
      } finally {
        await s3.srv.close();
      }
    });

    it("POST /api/feedback/github-issue enforces validation, length caps, 32KB limit, and rejects target overrides", async () => {
      const { srv, base } = await startServer({
        env: {},
        execFile: async () => {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        },
      });
      try {
        // Rejects target-override keys via strict Zod schema
        for (const extra of [
          { owner: "attacker" },
          { repo: "other-repo" },
          { endpoint: "https://evil.example/issues" },
          { apiUrl: "https://evil.example/api" },
          { gh: "--hostname evil" },
        ]) {
          const r = await fetch(`${base}/api/feedback/github-issue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              category: "bug",
              title: "Valid title",
              description: "Valid description",
              ...extra,
            }),
          });
          assert.equal(r.status, 400);
        }

        // Rejects empty/over-length title & description
        const rEmpty = await fetch(`${base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "bug",
            title: "   ",
            description: "Valid description",
          }),
        });
        assert.equal(rEmpty.status, 400);

        const rLongTitle = await fetch(`${base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "bug",
            title: "T".repeat(FEEDBACK_MAX_TITLE_LENGTH + 1),
            description: "Valid description",
          }),
        });
        assert.equal(rLongTitle.status, 400);

        const rLongDesc = await fetch(`${base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "bug",
            title: "Valid title",
            description: "D".repeat(FEEDBACK_MAX_DESCRIPTION_LENGTH + 1),
          }),
        });
        assert.equal(rLongDesc.status, 400);

        // Rejects > 32 KB body
        const rTooBig = await fetch(`${base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "bug",
            title: "Big",
            description: "X".repeat(33 * 1024),
          }),
        });
        assert.equal(rTooBig.status, 413);

        // Keeps existing POST /api/feedback (Mockups) untouched
        const rMockup = await fetch(`${base}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(rMockup.status, 400);
        const mockupErr = (await rMockup.json()) as { error: string };
        assert.equal(mockupErr.error, "id and note are required");
      } finally {
        await srv.close();
      }
    });

    it("POST /api/feedback/github-issue submits directly via GITHUB_TOKEN and strips forbidden diagnostics", async () => {
      const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
      const { srv, base } = await startServer({
        env: { GITHUB_TOKEN: "ghp_super_secret_token_value" },
        appVersion: "0.11.1",
        platform: "win32",
        fetch: async (url, init) => {
          fetchCalls.push({ url, init });
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: "https://github.com/jakehesson/agent-studio/issues/99",
              number: 99,
            }),
            text: async () => "",
          };
        },
      });
      try {
        const res = await fetch(`${base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "feature",
            title: "Add export button",
            description: "Export timeline to JSON",
            includeDiagnostics: true,
            diagnostics: {
              ide: "antigravity",
              agentCount: 4,
              workspacePath: "D:/Secret/PrivateRepo",
              prompt: "do not leak me",
              token: "should-strip",
            },
          }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(body, {
          ok: true,
          mode: "created",
          issueUrl: "https://github.com/jakehesson/agent-studio/issues/99",
          issueNumber: 99,
        });

        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0]?.url, FEEDBACK_ISSUES_API_URL);
        assert.equal(fetchCalls[0]?.init?.method, "POST");
        const sentBody = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
          title: string;
          body: string;
          labels: string[];
        };
        assert.equal(sentBody.title, "[Feature] Add export button");
        assert.deepEqual(sentBody.labels, ["enhancement"]);
        assert.match(sentBody.body, /\| IDE \| antigravity \|/);
        assert.match(sentBody.body, /\| OS Platform \| win32 \|/);
        assert.ok(!sentBody.body.includes("D:/Secret/PrivateRepo"));
        assert.ok(!sentBody.body.includes("do not leak me"));
        assert.ok(!sentBody.body.includes("should-strip"));
      } finally {
        await srv.close();
      }
    });

    it("POST /api/feedback/github-issue uses gh CLI execFile args (with label retry) and falls back without leaking tokens", async () => {
      const ghInvocations: Array<{
        file: string;
        args: readonly string[];
        options: { timeout?: number; windowsHide?: boolean };
      }> = [];
      let callCount = 0;

      const sGh = await startServer({
        env: {},
        execFile: async (file, args, options) => {
          ghInvocations.push({ file, args, options });
          callCount += 1;
          if (callCount === 1) {
            throw Object.assign(new Error("label error"), {
              stderr: "could not add label: 'question' not found",
            });
          }
          return {
            stdout: "https://github.com/jakehesson/agent-studio/issues/105\n",
            stderr: "",
          };
        },
      });
      try {
        const res = await fetch(`${sGh.base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "question",
            title: "How to sync?",
            description: "Need help with sync",
            includeDiagnostics: false,
          }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(body, {
          ok: true,
          mode: "created",
          issueUrl: "https://github.com/jakehesson/agent-studio/issues/105",
          issueNumber: 105,
        });
        assert.equal(ghInvocations.length, 2);
        assert.equal(ghInvocations[0]?.file, "gh");
        assert.deepEqual(ghInvocations[0]?.args.slice(0, 4), [
          "issue",
          "create",
          "--repo",
          "jakehesson/agent-studio",
        ]);
        assert.ok(ghInvocations[0]?.args.includes("--label"));
        assert.ok(!ghInvocations[1]?.args.includes("--label"));
        assert.equal(ghInvocations[0]?.options.windowsHide, true);
      } finally {
        await sGh.srv.close();
      }

      // Fallback when token fails + gh unavailable, ensuring token is redacted
      const secretToken = "ghp_TOPSECRET_NEVER_EXPOSE_987654";
      const sFallback = await startServer({
        env: { GITHUB_TOKEN: secretToken },
        fetch: async () => {
          throw new Error(`network failure with ${secretToken}`);
        },
        execFile: async () => {
          throw Object.assign(new Error("gh missing"), { code: "ENOENT" });
        },
      });
      try {
        const res = await fetch(`${sFallback.base}/api/feedback/github-issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category: "bug",
            title: "Offline bug",
            description: "Submitting offline",
          }),
        });
        assert.equal(res.status, 200);
        const rawText = await res.text();
        assert.ok(
          !rawText.includes(secretToken),
          "Secret token leaked into HTTP response!",
        );
        const body = JSON.parse(rawText) as {
          ok: boolean;
          mode: string;
          prefillUrl: string;
          reason: string;
        };
        assert.equal(body.ok, true);
        assert.equal(body.mode, "fallback");
        assert.ok(body.prefillUrl.startsWith(FEEDBACK_NEW_ISSUE_URL));
        assert.match(body.reason, /\[redacted\]/);
      } finally {
        await sFallback.srv.close();
      }
    });
  });

  describe("Extension feedback module (extension/src/feedback.ts)", () => {
    it("strictly validates openExternal URLs to https://github.com/jakehesson/agent-studio/issues/new", () => {
      const extMod = loadExtensionFeedbackModule();

      const okBase = extMod.validateFeedbackExternalUrl(
        "https://github.com/jakehesson/agent-studio/issues/new",
      );
      assert.equal(okBase.ok, true);

      const okQuery = extMod.validateFeedbackExternalUrl(
        "https://github.com/jakehesson/agent-studio/issues/new?title=%5BBug%5D+Test&body=Hello&labels=bug",
      );
      assert.equal(okQuery.ok, true);

      const okCreatedIssue = extMod.validateFeedbackExternalUrl(
        "https://github.com/jakehesson/agent-studio/issues/123",
      );
      assert.equal(okCreatedIssue.ok, true);

      const disallowed = [
        "",
        "http://github.com/jakehesson/agent-studio/issues/new",
        "https://github.com/other/agent-studio/issues/new",
        "https://github.com/jakehesson/other-repo/issues/new",
        "https://github.com/jakehesson/other-repo/issues/123",
        "https://github.com/jakehesson/agent-studio/issues",
        "https://github.com/jakehesson/agent-studio/issues/",
        "https://github.com/jakehesson/agent-studio/issues/abc",
        "https://github.com/jakehesson/agent-studio/issues/123/comments",
        "https://github.com/jakehesson/agent-studio/issues/newEvil",
        "https://github.com/jakehesson/agent-studio/issues/new/../123",
        "https://github.com/jakehesson/agent-studio/issues/new/../../other/repo/issues/new",
        "https://user:pass@github.com/jakehesson/agent-studio/issues/new",
        "https://evil.example/?next=https://github.com/jakehesson/agent-studio/issues/new",
        "javascript:alert(1)",
      ];
      for (const bad of disallowed) {
        const res = extMod.validateFeedbackExternalUrl(bad);
        assert.equal(res.ok, false, `Expected URL to be rejected: ${bad}`);
      }
    });

    it("handles status check, direct creation, fallback, and token redaction in extension host", async () => {
      const extMod = loadExtensionFeedbackModule();

      const statusAnon = await extMod.handleFeedbackStatusRequest("req-1", {
        getSession: async () => undefined,
      });
      assert.deepEqual(statusAnon, {
        type: "agentStudio:feedbackStatus",
        requestId: "req-1",
        githubAuthAvailable: false,
      });

      const statusAuthed = await extMod.handleFeedbackStatusRequest("req-2", {
        getSession: async () => ({
          accessToken: "gho_secret_oauth",
          account: { label: "jakehesson" },
        }),
      });
      assert.deepEqual(statusAuthed, {
        type: "agentStudio:feedbackStatus",
        requestId: "req-2",
        githubAuthAvailable: true,
        accountLabel: "jakehesson",
      });

      // Rejects target override in payload
      const rejectedOverride = await extMod.handleSubmitFeedback(
        "req-3",
        {
          category: "bug",
          title: "Bad",
          description: "Bad",
          repo: "evil/repo",
        },
        { auth: { getSession: async () => ({ accessToken: "tok" }) } },
      );
      assert.equal(rejectedOverride.ok, false);
      assert.equal(rejectedOverride.mode, "fallback");

      // Direct creation via GitHub auth session (including telemetry category)
      const fetched: Array<{ url: string; body: string }> = [];
      const created = await extMod.handleSubmitFeedback(
        "req-4",
        {
          category: "telemetry",
          title: "Missing edge",
          description: "Subagent edge missing in timeline",
          diagnostics: {
            ide: "copilot-vscode",
            embedMode: true,
            workspacePath: "/Users/secret/repo",
          },
        },
        {
          auth: {
            getSession: async () => ({ accessToken: "gho_secret_oauth" }),
          },
          platform: "darwin",
          fetch: async (url, init) => {
            fetched.push({ url, body: String(init?.body ?? "") });
            return {
              ok: true,
              status: 201,
              json: async () => ({
                html_url:
                  "https://github.com/jakehesson/agent-studio/issues/202",
                number: 202,
              }),
              text: async () => "",
            };
          },
        },
      );
      assert.equal(fetched[0]?.url, FEEDBACK_ISSUES_API_URL);
      const extSent = JSON.parse(fetched[0]?.body ?? "{}") as {
        title: string;
        labels: string[];
      };
      assert.equal(extSent.title, "[Telemetry] Missing edge");
      assert.deepEqual(extSent.labels, ["telemetry"]);
      assert.deepEqual(created, {
        type: "agentStudio:submitFeedbackResult",
        requestId: "req-4",
        ok: true,
        mode: "created",
        issueUrl: "https://github.com/jakehesson/agent-studio/issues/202",
        issueNumber: 202,
      });

      // Fallback redacts accessToken if fetch throws with it
      const secretSessionToken = "gho_DO_NOT_LEAK_TOKEN";
      const fallback = await extMod.handleSubmitFeedback(
        "req-5",
        {
          category: "feature",
          title: "Add shortcut",
          description: "Keyboard shortcut",
        },
        {
          auth: {
            getSession: async () => ({ accessToken: secretSessionToken }),
          },
          fetch: async () => {
            throw new Error(`boom ${secretSessionToken}`);
          },
        },
      );
      assert.equal(fallback.ok, false);
      assert.equal(fallback.mode, "fallback");
      if (!fallback.ok) {
        assert.ok(fallback.fallbackUrl.startsWith(FEEDBACK_NEW_ISSUE_URL));
        assert.ok(!fallback.reason.includes(secretSessionToken));
        assert.match(fallback.reason, /\[redacted\]/);
      }
    });

    it("webviewProvider.ts enforces iframe expectedOrigin checks and feedback bridge messages", () => {
      const providerSrc = fs.readFileSync(
        path.join(process.cwd(), "extension", "src", "webviewProvider.ts"),
        "utf8",
      );
      assert.match(providerSrc, /event\.source !== frame\.contentWindow/);
      assert.match(providerSrc, /event\.origin !== expectedOrigin/);
      assert.match(providerSrc, /frame\.contentWindow\.postMessage\(data,\s*expectedOrigin\)/);
      assert.match(providerSrc, /agentStudio:feedbackStatusRequest/);
      assert.match(providerSrc, /agentStudio:submitFeedback/);
      assert.match(providerSrc, /agentStudio:openFeedbackUrl/);
    });
  });
});
