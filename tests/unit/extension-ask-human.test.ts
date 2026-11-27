import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import type * as AskHumanModule from "../../extension/src/askHumanTool.js";

const REPO_ROOT = path.resolve(process.cwd());
const EXT_ROOT = path.join(REPO_ROOT, "extension");

function createVscodeMock() {
  class MockLanguageModelTextPart {
    public readonly value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  class MockLanguageModelToolResult {
    public readonly content: unknown[];
    constructor(content: unknown[]) {
      this.content = content;
    }
  }

  class MockDisposable {
    private readonly fn: () => void;
    public disposed = false;
    constructor(fn: () => void) {
      this.fn = fn;
    }
    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.fn();
    }
  }

  return {
    LanguageModelTextPart: MockLanguageModelTextPart,
    LanguageModelToolResult: MockLanguageModelToolResult,
    Disposable: MockDisposable,
  };
}

function loadAskHumanModule(
  vscodeMock: ReturnType<typeof createVscodeMock> = createVscodeMock(),
): typeof AskHumanModule {
  const srcPath = path.join(EXT_ROOT, "src", "askHumanTool.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const localRequire = createRequire(srcPath);
  const customRequire = (id: string) => {
    if (id === "vscode") return vscodeMock;
    return localRequire(id);
  };
  const mod = { exports: {} as Partial<typeof AskHumanModule> };
  const fn = new Function("exports", "module", "require", outputText);
  fn(mod.exports, mod, customRequire);
  return mod.exports as typeof AskHumanModule;
}

function createMockCancellationToken() {
  let cancelled = false;
  let listenerDisposeCount = 0;
  let activeListeners = 0;
  const listeners = new Set<() => void>();

  const token = {
    get isCancellationRequested(): boolean {
      return cancelled;
    },
    onCancellationRequested(cb: () => void) {
      listeners.add(cb);
      activeListeners += 1;
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(cb);
          listenerDisposeCount += 1;
          activeListeners -= 1;
        },
      };
    },
  };

  return {
    token: token as unknown as import("vscode").CancellationToken,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const cb of [...listeners]) {
        cb();
      }
    },
    getStats() {
      return { listenerDisposeCount, activeListeners };
    },
  };
}

function createMockTransport(overrides?: {
  online?: boolean;
  localBaseUrl?: string;
  ide?: "antigravity" | "copilot-vscode";
  workspaceRoot?: string;
  projectId?: string;
  ensureError?: Error;
}) {
  let ensureCalls = 0;
  const localBaseUrl = overrides?.localBaseUrl ?? "http://127.0.0.1:8767";
  const transport: AskHumanModule.AskHumanServerTransport = {
    async ensureRunning() {
      ensureCalls += 1;
      if (overrides?.ensureError) throw overrides.ensureError;
      return {
        online: overrides?.online ?? true,
        localBaseUrl,
      };
    },
    getLocalBaseUrl() {
      return localBaseUrl;
    },
    detectHostIde() {
      return overrides?.ide ?? "copilot-vscode";
    },
    getPrimaryWorkspaceRoot() {
      return overrides && "workspaceRoot" in overrides
        ? overrides.workspaceRoot
        : "d:/Work/DemoProject";
    },
    detectWorkspaceProjectId() {
      return overrides && "projectId" in overrides
        ? overrides.projectId
        : "demo-project";
    },
  };
  return {
    transport,
    getEnsureCalls: () => ensureCalls,
  };
}

function createMockOutput() {
  const lines: string[] = [];
  return {
    output: {
      appendLine(line: string) {
        lines.push(line);
      },
    },
    lines,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractResultText(result: { content: unknown[] } | null | undefined): string {
  assert.ok(result && Array.isArray(result.content), "Expected LanguageModelToolResult with content array");
  const first = result.content[0] as { value?: string } | undefined;
  assert.ok(first && typeof first.value === "string", "Expected LanguageModelTextPart with string value");
  return first.value;
}

describe("Extension ask_human language model tool (S1-77)", () => {
  it("contributes agent_studio_ask_human in extension/package.json with matching inputSchema", () => {
    const pkgPath = path.join(EXT_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      contributes?: {
        languageModelTools?: Array<{
          name?: string;
          toolReferenceName?: string;
          canBeReferencedInPrompt?: boolean;
          displayName?: string;
          modelDescription?: string;
          inputSchema?: {
            type?: string;
            required?: string[];
            properties?: Record<string, unknown>;
          };
        }>;
      };
    };

    const tools = pkg.contributes?.languageModelTools;
    assert.ok(Array.isArray(tools), "Expected contributes.languageModelTools array");
    const entry = tools.find((t) => t.name === "agent_studio_ask_human");
    assert.ok(entry, "Expected agent_studio_ask_human tool contribution");
    assert.equal(entry.toolReferenceName, "agent_studio_ask_human");
    assert.equal(entry.canBeReferencedInPrompt, true);
    assert.ok(entry.displayName && entry.displayName.length > 0);
    assert.ok(entry.modelDescription && entry.modelDescription.length > 20);

    const schema = entry.inputSchema;
    assert.ok(schema && schema.type === "object");
    assert.deepEqual(schema.required, ["questions"]);
    const props = schema.properties ?? {};
    for (const field of [
      "title",
      "summary",
      "kind",
      "questions",
      "agentId",
      "agentLabel",
      "sessionId",
      "timeoutSeconds",
    ]) {
      assert.ok(field in props, `Missing top-level inputSchema property: ${field}`);
    }

    const questionsProp = props.questions as {
      type?: string;
      minItems?: number;
      maxItems?: number;
      items?: {
        required?: string[];
        properties?: Record<string, unknown>;
      };
    };
    assert.equal(questionsProp.type, "array");
    assert.equal(questionsProp.minItems, 1);
    assert.equal(questionsProp.maxItems, 10);
    assert.deepEqual(questionsProp.items?.required, ["question", "type", "options"]);
    const qProps = questionsProp.items?.properties ?? {};
    for (const qField of [
      "header",
      "question",
      "type",
      "options",
      "allowCustomInput",
      "defaultValue",
    ]) {
      assert.ok(qField in qProps, `Missing question property: ${qField}`);
    }
  });

  it("wires registerAskHumanTool into extension/src/extension.ts activate()", () => {
    const extSrc = fs.readFileSync(path.join(EXT_ROOT, "src", "extension.ts"), "utf8");
    assert.ok(
      extSrc.includes('from "./askHumanTool"'),
      "extension.ts must import from ./askHumanTool",
    );
    assert.ok(
      extSrc.includes("registerAskHumanTool(manager, output, lmApi)"),
      "extension.ts must register askHumanTool with manager, output, lmApi",
    );
    assert.ok(
      extSrc.includes("context.subscriptions.push(askHumanDisposable)"),
      "extension.ts must push askHumanDisposable to context.subscriptions",
    );
  });

  it("safely no-ops on Antigravity or older hosts when vscode.lm.registerTool is absent or throws", () => {
    const vscodeMock = createVscodeMock();
    const mod = loadAskHumanModule(vscodeMock);
    const { transport } = createMockTransport({ ide: "antigravity" });
    const { output, lines } = createMockOutput();

    // 1. Undefined lmApi (Antigravity)
    const d1 = mod.registerAskHumanTool(transport, output, undefined);
    assert.equal(typeof d1.dispose, "function");
    d1.dispose();
    assert.ok(lines.some((l) => l.includes("does not expose vscode.lm.registerTool")));

    // 2. Empty lmApi object without registerTool
    const d2 = mod.registerAskHumanTool(transport, output, {});
    assert.equal(typeof d2.dispose, "function");
    d2.dispose();

    // 3. Throwing registerTool
    const d3 = mod.registerAskHumanTool(transport, output, {
      registerTool() {
        throw new Error("proposed API unavailable");
      },
    });
    assert.equal(typeof d3.dispose, "function");
    assert.ok(lines.some((l) => l.includes("proposed API unavailable")));

    // 4. Supported registerTool registers agent_studio_ask_human
    const registered: Array<{ name: string; tool: unknown }> = [];
    let innerDisposed = false;
    const d4 = mod.registerAskHumanTool(transport, output, {
      registerTool(name, tool) {
        registered.push({ name, tool });
        return new vscodeMock.Disposable(() => {
          innerDisposed = true;
        }) as unknown as import("vscode").Disposable;
      },
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.name, "agent_studio_ask_human");
    d4.dispose();
    assert.equal(innerDisposed, true);
  });

  it("prepareInvocation sets invocationMessage and omits confirmationMessages", () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport();
    const { output } = createMockOutput();
    const handler = mod.createAskHumanToolHandler(transport, output);
    const { token } = createMockCancellationToken();

    assert.ok(handler.prepareInvocation);
    const prepNoTitle = handler.prepareInvocation(
      {
        input: {
          questions: [{ question: "Proceed?", type: "single_select", options: [{ label: "Yes" }] }],
        },
      },
      token,
    ) as { invocationMessage?: unknown; confirmationMessages?: unknown };
    assert.equal(typeof prepNoTitle.invocationMessage, "string");
    assert.ok(String(prepNoTitle.invocationMessage).includes("Agent Studio Messages"));
    assert.equal("confirmationMessages" in prepNoTitle, false);

    const prepWithTitle = handler.prepareInvocation(
      {
        input: {
          title: "Pick database",
          questions: [{ question: "DB?", type: "single_select", options: [{ label: "Postgres" }] }],
        },
      },
      token,
    ) as { invocationMessage?: unknown; confirmationMessages?: unknown };
    assert.ok(String(prepWithTitle.invocationMessage).includes("Pick database"));
    assert.equal("confirmationMessages" in prepWithTitle, false);
  });

  it("posts POST /api/prompts and long-polls GET /api/prompts/:id?waitMs=20000 until answered", async () => {
    const vscodeMock = createVscodeMock();
    const mod = loadAskHumanModule(vscodeMock);
    const { transport } = createMockTransport({
      ide: "copilot-vscode",
      workspaceRoot: "d:/Work/AgentVisualizer",
      projectId: "agent-studio",
    });
    const { output } = createMockOutput();
    const { token, getStats } = createMockCancellationToken();

    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let pollStep = 0;

    const handler = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        calls.push({ url, method, body });

        if (method === "POST" && url === "http://127.0.0.1:8767/api/prompts") {
          return jsonResponse(201, {
            ok: true,
            prompt: { id: "prompt-123", status: "pending" },
          });
        }

        if (
          method === "GET" &&
          url === "http://127.0.0.1:8767/api/prompts/prompt-123?waitMs=20000"
        ) {
          pollStep += 1;
          if (pollStep === 1) {
            return jsonResponse(200, {
              ok: true,
              prompt: { id: "prompt-123", status: "pending" },
            });
          }
          return jsonResponse(200, {
            ok: true,
            prompt: {
              id: "prompt-123",
              status: "answered",
              answerText: "Use PostgreSQL with Prisma",
              answers: { q1: "PostgreSQL" },
            },
          });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const result = await handler.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          title: "Database choice",
          summary: "Select primary persistence engine",
          sessionId: "sess-abc",
          agentId: "architect",
          agentLabel: "Architect",
          timeoutSeconds: 120,
          questions: [
            {
              id: "q1",
              header: "Storage",
              question: "Which database should we use?",
              type: "single_select",
              options: [
                { label: "PostgreSQL", recommended: true },
                { label: "SQLite" },
              ],
              allowCustomInput: true,
            },
          ],
        },
      },
      token,
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      promptSource: "studio-vscode-lm",
      toolName: "agent_studio_ask_human",
      ide: "copilot-vscode",
      workspacePath: "d:/Work/AgentVisualizer",
      projectId: "agent-studio",
      sessionId: "sess-abc",
      title: "Database choice",
      summary: "Select primary persistence engine",
      questions: [
        {
          id: "q1",
          header: "Storage",
          question: "Which database should we use?",
          type: "single_select",
          options: [
            { label: "PostgreSQL", recommended: true },
            { label: "SQLite" },
          ],
          allowCustomInput: true,
        },
      ],
      agentId: "architect",
      agentLabel: "Architect",
      timeoutMs: 120_000,
    });

    const text = extractResultText(result);
    assert.ok(text.includes("Use PostgreSQL with Prisma"));
    assert.ok(text.includes('"status": "answered"'));
    assert.ok(text.includes('"promptId": "prompt-123"'));
    assert.ok(text.includes('"q1": "PostgreSQL"'));
    assert.equal(getStats().activeListeners, 0, "Expected cancellation listener disposed");
    assert.ok(getStats().listenerDisposeCount >= 2);
  });

  it("returns native fallback guidance when Agent Studio server is offline", async () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport({ online: false });
    const { output } = createMockOutput();
    const { token } = createMockCancellationToken();

    let fetchCalled = false;
    const handler = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not be called");
      },
    });

    const result = await handler.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Continue?", type: "text", options: [] }],
        },
      },
      token,
    );

    assert.equal(fetchCalled, false);
    const text = extractResultText(result);
    assert.ok(text.includes("vscode_askQuestions"));
    assert.ok(text.includes('"status":"offline"'));
  });

  it("aborts in-flight poll, posts /cancel, and disposes listener when CancellationToken cancels", async () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport();
    const { output } = createMockOutput();
    const ctrl = createMockCancellationToken();

    let pollAborted = false;
    const cancelPosts: Array<{ url: string; body: unknown }> = [];

    const handler = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (method === "POST" && url.endsWith("/api/prompts")) {
          return jsonResponse(201, {
            ok: true,
            prompt: { id: "prompt-cancel-1", status: "pending" },
          });
        }

        if (method === "GET" && url.includes("/api/prompts/prompt-cancel-1")) {
          return await new Promise<Response>((_resolve, reject) => {
            const sig = init?.signal;
            if (sig?.aborted) {
              pollAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            sig?.addEventListener(
              "abort",
              () => {
                pollAborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
            // Trigger cancellation as soon as poll is in flight
            queueMicrotask(() => ctrl.cancel());
          });
        }

        if (method === "POST" && url.endsWith("/api/prompts/prompt-cancel-1/cancel")) {
          cancelPosts.push({
            url,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          });
          return jsonResponse(200, { ok: true });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const result = await handler.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Confirm deploy?", type: "single_select", options: [{ label: "Yes" }] }],
        },
      },
      ctrl.token,
    );

    assert.equal(pollAborted, true);
    assert.equal(cancelPosts.length, 1);
    assert.equal(
      cancelPosts[0]?.url,
      "http://127.0.0.1:8767/api/prompts/prompt-cancel-1/cancel",
    );
    assert.deepEqual(cancelPosts[0]?.body, { reason: "Cancelled by IDE/user" });
    assert.equal(ctrl.getStats().activeListeners, 0);

    const text = extractResultText(result);
    assert.ok(text.includes('"status":"canceled"'));
    assert.ok(text.includes('"promptId":"prompt-cancel-1"'));
  });

  it("handles pre-canceled token, HTTP 429, expired, canceled, and 404 responses cleanly", async () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport();
    const { output } = createMockOutput();

    // 1. Pre-canceled token
    const preCtrl = createMockCancellationToken();
    preCtrl.cancel();
    let fetchCalls = 0;
    const preHandler = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(500, {});
      },
    });
    const preRes = await preHandler.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      preCtrl.token,
    );
    assert.equal(fetchCalls, 0);
    assert.ok(extractResultText(preRes).includes('"status":"canceled"'));

    // 2. HTTP 429 on POST /api/prompts
    const c429 = createMockCancellationToken();
    const h429 = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async () =>
        jsonResponse(429, { error: "Too many active pending prompts (max 64)" }),
    });
    const r429 = await h429.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      c429.token,
    );
    const t429 = extractResultText(r429);
    assert.ok(t429.includes('"httpStatus":429'));
    assert.ok(t429.includes("Too many active pending prompts"));
    assert.ok(t429.includes("vscode_askQuestions"));

    // 3. Poll returns expired
    const cExp = createMockCancellationToken();
    const hExp = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async (input, init) => {
        if (init?.method === "POST") {
          return jsonResponse(201, { ok: true, prompt: { id: "p-exp", status: "pending" } });
        }
        assert.ok(String(input).includes("/api/prompts/p-exp"));
        return jsonResponse(200, { ok: true, prompt: { id: "p-exp", status: "expired" } });
      },
    });
    const rExp = await hExp.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      cExp.token,
    );
    assert.ok(extractResultText(rExp).includes('"status":"expired"'));

    // 4. Poll returns canceled with reason
    const cCan = createMockCancellationToken();
    const hCan = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") {
          return jsonResponse(201, { ok: true, prompt: { id: "p-can", status: "pending" } });
        }
        return jsonResponse(200, {
          ok: true,
          prompt: {
            id: "p-can",
            status: "canceled",
            cancelReason: "Dismissed by user in Studio",
          },
        });
      },
    });
    const rCan = await hCan.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      cCan.token,
    );
    const tCan = extractResultText(rCan);
    assert.ok(tCan.includes('"status":"canceled"'));
    assert.ok(tCan.includes("Dismissed by user in Studio"));

    // 5. Poll returns 404
    const c404 = createMockCancellationToken();
    const h404 = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") {
          return jsonResponse(201, { ok: true, prompt: { id: "p-404", status: "pending" } });
        }
        return jsonResponse(404, { error: "Prompt not found" });
      },
    });
    const r404 = await h404.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      c404.token,
    );
    assert.ok(extractResultText(r404).includes('"status":"expired"'));
  });

  it("rejects invalid inputs without contacting server or network", async () => {
    const mod = loadAskHumanModule();
    const { transport, getEnsureCalls } = createMockTransport();
    const { output } = createMockOutput();
    const { token } = createMockCancellationToken();

    let fetchCalls = 0;
    const handler = mod.createAskHumanToolHandler(transport, output, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(200, {});
      },
    });

    const badInputs: unknown[] = [
      null,
      {},
      { questions: [] },
      {
        questions: Array.from({ length: 11 }, (_, idx) => ({
          question: `Q${idx}`,
          type: "text",
          options: [],
        })),
      },
      { questions: [{ question: " ", type: "text", options: [] }] },
      { questions: [{ question: "Q", type: "invalid_type", options: [] }] },
      { questions: [{ question: "Q", type: "single_select", options: [{ label: "" }] }] },
      { questions: [{ question: "Q", type: "text", options: [] }], timeoutSeconds: Number.NaN },
    ];

    for (const bad of badInputs) {
      const res = await handler.invoke(
        {
          toolInvocationToken: undefined,
          input: bad as AskHumanModule.AskHumanToolInput,
        },
        token,
      );
      const text = extractResultText(res);
      assert.ok(text.includes('"status":"invalid_input"'), `Expected invalid_input for ${JSON.stringify(bad)}`);
    }

    assert.equal(getEnsureCalls(), 0);
    assert.equal(fetchCalls, 0);
  });

  it("recovers from transient poll failures (HTTP 500 and network errors) and resets error count on pending", async () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport();
    const { output } = createMockOutput();
    const { token, getStats } = createMockCancellationToken();

    const sleepCalls: number[] = [];
    let pollAttempt = 0;

    const handler = mod.createAskHumanToolHandler(transport, output, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (method === "POST" && url.endsWith("/api/prompts")) {
          return jsonResponse(201, {
            ok: true,
            prompt: { id: "p-transient", status: "pending" },
          });
        }

        if (method === "GET" && url.includes("/api/prompts/p-transient")) {
          pollAttempt += 1;
          if (pollAttempt === 1) {
            return jsonResponse(500, { error: "Temporary server glitch" });
          }
          if (pollAttempt === 2) {
            throw new Error("ECONNRESET");
          }
          if (pollAttempt === 3) {
            // Successful pending response should reset consecutive error counter
            return jsonResponse(200, {
              ok: true,
              prompt: { id: "p-transient", status: "pending" },
            });
          }
          if (pollAttempt === 4) {
            return jsonResponse(503, { error: "Service busy" });
          }
          if (pollAttempt === 5) {
            throw new Error("ETIMEDOUT");
          }
          return jsonResponse(200, {
            ok: true,
            prompt: {
              id: "p-transient",
              status: "answered",
              answerText: "Proceed with rollout",
              answers: { confirm: "Proceed" },
            },
          });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const res = await handler.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Deploy?", type: "single_select", options: [{ label: "Proceed" }] }],
        },
      },
      token,
    );

    assert.equal(pollAttempt, 6);
    assert.deepEqual(sleepCalls, [250, 250, 250, 250]);
    const text = extractResultText(res);
    assert.ok(text.includes('"status": "answered"'));
    assert.ok(text.includes('"promptId": "p-transient"'));
    assert.ok(text.includes("Proceed with rollout"));
    assert.equal(getStats().activeListeners, 0);
  });

  it("aborts after MAX_CONSECUTIVE_POLL_ERRORS (3) and advises native vscode_askQuestions", async () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport();
    const { output } = createMockOutput();

    // 1. 3 consecutive HTTP 500 poll responses
    const cHttp = createMockCancellationToken();
    const httpSleepCalls: number[] = [];
    const httpCancelPosts: string[] = [];
    let httpPollCount = 0;

    const hHttp = mod.createAskHumanToolHandler(transport, output, {
      sleep: async (ms) => {
        httpSleepCalls.push(ms);
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith("/api/prompts")) {
          return jsonResponse(201, {
            ok: true,
            prompt: { id: "p-err-http", status: "pending" },
          });
        }
        if (method === "GET" && url.includes("/api/prompts/p-err-http")) {
          httpPollCount += 1;
          return jsonResponse(500, { error: "Internal Server Error" });
        }
        if (method === "POST" && url.endsWith("/cancel")) {
          httpCancelPosts.push(url);
          return jsonResponse(200, { ok: true });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const rHttp = await hHttp.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      cHttp.token,
    );

    assert.equal(httpPollCount, 3);
    assert.deepEqual(httpSleepCalls, [250, 250]);
    assert.equal(httpCancelPosts.length, 0);
    assert.equal(cHttp.getStats().activeListeners, 0);

    const tHttp = extractResultText(rHttp);
    assert.ok(tHttp.includes('"status":"error"'));
    assert.ok(tHttp.includes('"promptId":"p-err-http"'));
    assert.ok(tHttp.includes('"httpStatus":500'));
    assert.ok(tHttp.includes("Internal Server Error"));
    assert.ok(tHttp.includes('"fallbackTool":"vscode_askQuestions"'));
    assert.ok(tHttp.includes("vscode_askQuestions"));

    // 2. 3 consecutive thrown network errors
    const cNet = createMockCancellationToken();
    const netSleepCalls: number[] = [];
    let netPollCount = 0;

    const hNet = mod.createAskHumanToolHandler(transport, output, {
      sleep: async (ms) => {
        netSleepCalls.push(ms);
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith("/api/prompts")) {
          return jsonResponse(201, {
            ok: true,
            prompt: { id: "p-err-net", status: "pending" },
          });
        }
        if (method === "GET" && url.includes("/api/prompts/p-err-net")) {
          netPollCount += 1;
          throw new Error("connect ECONNREFUSED 127.0.0.1:8767");
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const rNet = await hNet.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          questions: [{ question: "Q?", type: "text", options: [] }],
        },
      },
      cNet.token,
    );

    assert.equal(netPollCount, 3);
    assert.deepEqual(netSleepCalls, [250, 250]);
    assert.equal(cNet.getStats().activeListeners, 0);

    const tNet = extractResultText(rNet);
    assert.ok(tNet.includes('"status":"error"'));
    assert.ok(tNet.includes('"promptId":"p-err-net"'));
    assert.ok(tNet.includes("connect ECONNREFUSED"));
    assert.ok(tNet.includes('"fallbackTool":"vscode_askQuestions"'));
    assert.ok(tNet.includes("vscode_askQuestions"));
  });

  it("posts POST /api/prompts/:id/cancel and returns expired fallback guidance on local deadline timeout", async () => {
    const mod = loadAskHumanModule();
    const { transport } = createMockTransport();
    const { output } = createMockOutput();
    const ctrl = createMockCancellationToken();

    let currentTime = 1_000_000;
    const pollUrls: string[] = [];
    const cancelPosts: Array<{ url: string; body: unknown }> = [];

    const handler = mod.createAskHumanToolHandler(transport, output, {
      now: () => currentTime,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (method === "POST" && url.endsWith("/api/prompts")) {
          return jsonResponse(201, {
            ok: true,
            prompt: { id: "p-deadline", status: "pending" },
          });
        }

        if (method === "GET" && url.includes("/api/prompts/p-deadline")) {
          pollUrls.push(url);
          // timeoutSeconds=5 -> timeoutMs=5000 -> deadlineMs = 1_000_000 + 5_000 + 5_000 = 1_010_000
          currentTime += 10_001;
          return jsonResponse(200, {
            ok: true,
            prompt: { id: "p-deadline", status: "pending" },
          });
        }

        if (method === "POST" && url.endsWith("/api/prompts/p-deadline/cancel")) {
          cancelPosts.push({
            url,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          });
          return jsonResponse(200, { ok: true });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    });

    const res = await handler.invoke(
      {
        toolInvocationToken: undefined,
        input: {
          timeoutSeconds: 5,
          questions: [{ question: "Approve?", type: "single_select", options: [{ label: "Yes" }] }],
        },
      },
      ctrl.token,
    );

    assert.equal(pollUrls.length, 1);
    assert.equal(pollUrls[0], "http://127.0.0.1:8767/api/prompts/p-deadline?waitMs=10000");
    assert.equal(cancelPosts.length, 1);
    assert.equal(
      cancelPosts[0]?.url,
      "http://127.0.0.1:8767/api/prompts/p-deadline/cancel",
    );
    assert.deepEqual(cancelPosts[0]?.body, {
      reason: "Timed out waiting for human response",
    });
    assert.equal(ctrl.getStats().activeListeners, 0);

    const text = extractResultText(res);
    assert.ok(text.includes('"status":"expired"'));
    assert.ok(text.includes('"promptId":"p-deadline"'));
    assert.ok(text.includes("Timed out waiting for human response."));
    assert.ok(text.includes('"fallbackTool":"vscode_askQuestions"'));
    assert.ok(text.includes("vscode_askQuestions"));
  });
});
