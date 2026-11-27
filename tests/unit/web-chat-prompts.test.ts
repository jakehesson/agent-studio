import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";
import type {
  AgentChatMessage,
  AgentChatResponse,
  PendingHumanPrompt,
  PendingQuestionItem,
  PromptStatus,
  ReplyCapabilities,
  ReplyToHostRequest,
  ReplyToHostResult,
  SessionSnapshot,
} from "../../web/src/types.js";

interface QuestionAnswerDraft {
  selected: string[];
  customOpen: boolean;
  customText: string;
}

interface PromptDraftState {
  activeIdx: number;
  answers: Record<number, QuestionAnswerDraft>;
}

interface WebSnapshotExports {
  normalizePendingHumanPrompt(raw: unknown): PendingHumanPrompt | null;
  normalizeServerSnapshot(raw: unknown): SessionSnapshot;
}

interface PromptResolutionResult {
  ok: boolean;
  conflict?: boolean;
  notFound?: boolean;
  status?: PromptStatus;
  prompt?: PendingHumanPrompt | null;
  error?: string;
}

interface WebApiExports {
  setMcpAppTransport(client: unknown): void;
  answerPendingPrompt(
    promptId: string,
    payload: {
      answerText: string;
      answers?: Record<string, string | string[]>;
      responder?: string;
    }
  ): Promise<PromptResolutionResult>;
  cancelPendingPrompt(
    promptId: string,
    reason?: string
  ): Promise<PromptResolutionResult>;
  normalizeAgentChatResponse(
    raw: unknown,
    fallbackParams: { session?: string; agent?: string; ide?: string }
  ): AgentChatResponse;
  fetchAgentChat(params: {
    session?: string;
    agent?: string;
    ide?: string;
    project?: string;
    workspace?: string;
    limit?: number;
    before?: string;
  }): Promise<AgentChatResponse>;
}

interface WebQuestionCardExports {
  getEffectiveQuestions(prompt: PendingHumanPrompt): PendingQuestionItem[];
  getQuestionAnswerText(
    q: PendingQuestionItem,
    draft: QuestionAnswerDraft | undefined
  ): string;
  isQuestionAnswered(
    q: PendingQuestionItem,
    draft: QuestionAnswerDraft | undefined
  ): boolean;
  resolveReadyCount(
    questions: PendingQuestionItem[],
    state: PromptDraftState
  ): number;
  formatPromptAnswerText(
    questions: PendingQuestionItem[],
    state: PromptDraftState
  ): string;
  buildStructuredAnswers(
    questions: PendingQuestionItem[],
    state: PromptDraftState
  ): Record<string, string | string[]>;
  clearPromptDraft(promptId: string): void;
  getPrimaryActionMeta(
    caps: ReplyCapabilities,
    blockingToolCall: boolean,
    directReply?: boolean
  ): { label: string; showSecondaryCopy: boolean };
  computePromptStructureFingerprint(
    prompt: PendingHumanPrompt,
    caps: ReplyCapabilities
  ): string;
  QuestionCard: new (
    container: unknown,
    opts: {
      prompt: PendingHumanPrompt;
      sessionId?: string;
      compact?: boolean;
      showHeader?: boolean;
      getCapabilities: () => ReplyCapabilities;
      onReply: (req: ReplyToHostRequest) => Promise<ReplyToHostResult>;
      onCancel?: (promptId: string, reason?: string) => Promise<ReplyToHostResult>;
      onOpenChat?: (agentId: string) => void;
    }
  ) => {
    update(opts: { prompt: PendingHumanPrompt }): void;
    dispose(): void;
  };
}

const REPO_ROOT = path.resolve(process.cwd());

function loadTranspiledTsModule<T>(
  relPath: string,
  resolveImport?: (specifier: string) => unknown
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
  const requireStub = (specifier: string) => {
    if (resolveImport) {
      return resolveImport(specifier);
    }
    throw new Error(`Unexpected runtime import "${specifier}" in ${relPath}`);
  };
  const fn = new Function("exports", "module", "require", outputText);
  fn(mod.exports, mod, requireStub);
  return mod.exports as T;
}

const webUtils = loadTranspiledTsModule<{
  classifyExternalTarget(toolName?: string): { id: string; label: string } | null;
  [key: string]: unknown;
}>("web/src/utils.ts");

const webSnapshot = loadTranspiledTsModule<WebSnapshotExports>(
  "web/src/state/snapshot.ts",
  (specifier) => {
    if (specifier === "../utils.js") return webUtils;
    throw new Error(`Unexpected import ${specifier} in web/src/state/snapshot.ts`);
  }
);

const webFeedbackUrl = loadTranspiledTsModule<Record<string, unknown>>(
  "web/src/utils/feedbackUrl.ts"
);

const webModelIndex = loadTranspiledTsModule<Record<string, unknown>>(
  "web/src/state/modelIndex.ts"
);

const webApi = loadTranspiledTsModule<WebApiExports>(
  "web/src/api.ts",
  (specifier) => {
    if (specifier === "./state/snapshot.js") return webSnapshot;
    if (specifier === "./state/modelIndex.js") return webModelIndex;
    if (specifier === "./utils.js") return webUtils;
    if (specifier === "./utils/feedbackUrl.js") return webFeedbackUrl;
    throw new Error(`Unexpected import ${specifier} in web/src/api.ts`);
  }
);

const webQuestionCard = loadTranspiledTsModule<WebQuestionCardExports>(
  "web/src/components/QuestionCard.ts",
  (specifier) => {
    if (specifier === "../utils.js") return webUtils;
    throw new Error(
      `Unexpected import ${specifier} in web/src/components/QuestionCard.ts`
    );
  }
);

interface WebAgentChatPaneExports {
  shouldRouteChatToHostTab(opts: {
    embedMode: boolean;
    mcpAppMode?: boolean;
    hasParent: boolean;
  }): boolean;
  buildOpenChatTabPayload(opts: {
    sessionId: string;
    agentId: string;
    agentLabel?: string;
    ide?: string;
    focusQuestion?: boolean;
  }): {
    type: "agentStudio:openChatTab";
    sessionId: string;
    agentId: string;
    agentLabel: string;
    ide: string;
    focusQuestion: boolean;
  };
  parseChatViewRouteParams(search: string): {
    view: string;
    isChatView: boolean;
    session: string;
    agent: string;
    focusQuestion: boolean;
    embed: boolean;
    ide: string;
    workspace: string;
    project: string;
  };
  filterChatMessages(
    messages: AgentChatMessage[],
    query: string
  ): AgentChatMessage[];
  decodeFileUriToPath(uri: string): string;
  buildOpenFileMessage(opts: {
    uri: string;
    startLine?: number;
    endLine?: number;
  }): {
    type: "agentStudio.openFile";
    uri: string;
    startLine?: number;
    endLine?: number;
  };
  shouldAcceptChatSnapshot(opts: {
    pinnedSessionId: string;
    snapshotSessionId?: string | null;
  }): boolean;
  isChatFetchCurrent(opts: {
    seq: number;
    currentSeq: number;
    active: boolean;
  }): boolean;
}

const webMarkdown = loadTranspiledTsModule<Record<string, unknown>>(
  "web/src/utils/markdown.ts",
  (specifier) => {
    if (specifier === "../utils.js") return webUtils;
    throw new Error(`Unexpected import ${specifier} in web/src/utils/markdown.ts`);
  }
);

const webAgentChatPane = loadTranspiledTsModule<WebAgentChatPaneExports>(
  "web/src/components/AgentChatPane.ts",
  (specifier) => {
    if (specifier === "../api.js") return webApi;
    if (specifier === "../utils.js") return webUtils;
    if (specifier === "../utils/markdown.js") return webMarkdown;
    if (specifier === "./QuestionCard.js") return webQuestionCard;
    throw new Error(
      `Unexpected import ${specifier} in web/src/components/AgentChatPane.ts`
    );
  }
);

describe("Web Studio S1-66 Chat & Prompt Frontend Helpers", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  describe("normalizePendingHumanPrompt & normalizeServerSnapshot", () => {
    it("synthesizes a single_select question from legacy options[] when questions[] is absent", () => {
      const prompt = webSnapshot.normalizePendingHumanPrompt({
        id: "p-legacy",
        agentId: "root",
        agentLabel: "Coordinator",
        kind: "question",
        title: "Choose deployment target",
        options: [
          { label: "Staging", recommended: true },
          { label: "Production" },
        ],
      });

      assert.ok(prompt);
      assert.equal(prompt.id, "p-legacy");
      assert.equal(prompt.blockingToolCall, false);
      assert.equal(prompt.questions.length, 1);
      assert.equal(prompt.questions[0]?.type, "single_select");
      assert.deepEqual(prompt.questions[0]?.options, [
        { label: "Staging", recommended: true },
        { label: "Production", recommended: false },
      ]);
    });

    it("links pendingPrompts onto matching AgentNodeSnapshot.pendingPrompt and preserves null", () => {
      const snap = webSnapshot.normalizeServerSnapshot({
        sessionId: "sess-1",
        ide: "antigravity",
        status: "WAITING",
        pendingPrompts: [
          {
            id: "q-1",
            agentId: "agent-a",
            agentLabel: "Frontend",
            kind: "question",
            title: "Pick layout",
            blockingToolCall: true,
            questions: [
              {
                question: "Which layout?",
                type: "single_select",
                options: [{ label: "Drawer", recommended: true }],
              },
            ],
          },
        ],
        agents: [
          { id: "agent-a", label: "Frontend", ide: "antigravity", status: "WAITING" },
          {
            id: "agent-b",
            label: "Backend",
            ide: "antigravity",
            status: "WORKING",
            pendingPrompt: null,
          },
        ],
        edges: [],
        events: [],
      });

      assert.equal(snap.pendingPrompts?.length, 1);
      assert.equal(snap.agents[0]?.pendingPrompt?.id, "q-1");
      assert.equal(snap.agents[0]?.pendingPrompt?.blockingToolCall, true);
      assert.equal(snap.agents[1]?.pendingPrompt, null);
    });
  });

  describe("normalizeAgentChatResponse & fetchAgentChat", () => {
    it("normalizes /api/chat payload, roles, tools, and pendingPrompt", () => {
      const res = webApi.normalizeAgentChatResponse(
        {
          ok: true,
          sessionId: "sess-2",
          agentId: "root",
          agentLabel: "Coordinator",
          ide: "claude-code",
          totalMessages: 12,
          hasMore: true,
          nextCursor: "cursor-10",
          pendingPrompt: {
            id: "pq-1",
            agentId: "root",
            agentLabel: "Coordinator",
            kind: "approval",
            title: "Run migration?",
            blockingToolCall: true,
            questions: [],
          },
          messages: [
            {
              id: "m1",
              ts: "2026-11-26T10:00:00Z",
              epoch: 100,
              role: "assistant",
              text: "Working on it",
              thinking: "Plan first",
              tools: [
                {
                  toolName: "read_file",
                  summary: "Read schema.ts",
                  status: "ok",
                },
              ],
            },
            {
              id: "m2",
              ts: "2026-11-26T10:00:05Z",
              epoch: 105,
              role: "subagent",
              text: "Spawned frontend-engineer",
              subagentId: "fe-1",
              subagentLabel: "Frontend Engineer",
            },
          ],
        },
        { session: "sess-2", agent: "root" }
      );

      assert.equal(res.ok, true);
      assert.equal(res.hasMore, true);
      assert.equal(res.nextCursor, "cursor-10");
      assert.equal(res.totalMessages, 12);
      assert.equal(res.messages.length, 2);
      assert.equal(res.messages[0]?.tools?.[0]?.status, "ok");
      assert.equal(res.messages[1]?.subagentId, "fe-1");
      assert.equal(res.pendingPrompt?.kind, "approval");
      assert.equal(res.pendingPrompt?.blockingToolCall, true);
    });

    it("passes scoped query parameters to GET /api/chat", async () => {
      let requestedUrl = "";
      globalThis.fetch = (async (input: string | URL | Request) => {
        requestedUrl = typeof input === "string" ? input : String(input);
        return new Response(
          JSON.stringify({
            ok: true,
            sessionId: "s-9",
            agentId: "ag-1",
            agentLabel: "Agent 1",
            ide: "antigravity",
            messages: [],
            totalMessages: 0,
            hasMore: false,
            pendingPrompt: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      await webApi.fetchAgentChat({
        session: "s-9",
        agent: "ag-1",
        ide: "antigravity",
        project: "proj-x",
        workspace: "/work/repo",
        limit: 40,
        before: "cur-2",
      });

      const parsed = new URL(requestedUrl, "http://127.0.0.1:4242");
      assert.equal(parsed.pathname, "/api/chat");
      assert.equal(parsed.searchParams.get("session"), "s-9");
      assert.equal(parsed.searchParams.get("agent"), "ag-1");
      assert.equal(parsed.searchParams.get("ide"), "antigravity");
      assert.equal(parsed.searchParams.get("project"), "proj-x");
      assert.equal(parsed.searchParams.get("workspace"), "/work/repo");
      assert.equal(parsed.searchParams.get("limit"), "40");
      assert.equal(parsed.searchParams.get("before"), "cur-2");
    });
  });

  describe("QuestionCard pure formatting, multi-select gating & runtime action labels", () => {
    it("formats single and multi-question answers and gates multi_select customText on customOpen", () => {
      const questions: PendingQuestionItem[] = [
        {
          header: "Transport",
          question: "Which transport should we use?",
          type: "single_select",
          options: [{ label: "SSE" }, { label: "WebSocket" }],
        },
        {
          header: "Checks",
          question: "Which checks should run?",
          type: "multi_select",
          options: [{ label: "Typecheck" }, { label: "Unit" }],
        },
      ];

      const draft = {
        activeIdx: 0,
        answers: {
          0: { selected: ["SSE"], customOpen: false, customText: "ignored" },
          1: {
            selected: ["Typecheck", "Unit"],
            customOpen: false,
            customText: "hidden note",
          },
        },
      };

      assert.equal(webQuestionCard.resolveReadyCount(questions, draft), 2);
      assert.equal(
        webQuestionCard.formatPromptAnswerText(questions, draft),
        "1. Which transport should we use?: SSE\n2. Which checks should run?: Typecheck, Unit"
      );

      draft.answers[1]!.customOpen = true;
      assert.equal(
        webQuestionCard.formatPromptAnswerText(questions, draft),
        "1. Which transport should we use?: SSE\n2. Which checks should run?: Typecheck, Unit, hidden note"
      );
    });

    it("returns runtime-honest primary button labels and secondary Copy visibility", () => {
      const mcpSend: ReplyCapabilities = {
        canSendMessage: true,
        isMcpApp: true,
        isEmbed: false,
      };
      const mcpNoSend: ReplyCapabilities = {
        canSendMessage: false,
        isMcpApp: true,
        isEmbed: false,
      };
      const embedCaps: ReplyCapabilities = {
        canSendMessage: false,
        isMcpApp: false,
        isEmbed: true,
      };
      const standaloneCaps: ReplyCapabilities = {
        canSendMessage: false,
        isMcpApp: false,
        isEmbed: false,
      };

      assert.deepEqual(webQuestionCard.getPrimaryActionMeta(mcpSend, false), {
        label: "Send Answer to Chat",
        showSecondaryCopy: true,
      });
      assert.deepEqual(webQuestionCard.getPrimaryActionMeta(mcpSend, true), {
        label: "Copy Answer",
        showSecondaryCopy: false,
      });
      assert.deepEqual(webQuestionCard.getPrimaryActionMeta(mcpNoSend, false), {
        label: "Copy Answer",
        showSecondaryCopy: false,
      });
      assert.deepEqual(webQuestionCard.getPrimaryActionMeta(embedCaps, false), {
        label: "Prefill IDE Chat",
        showSecondaryCopy: true,
      });
      assert.deepEqual(webQuestionCard.getPrimaryActionMeta(embedCaps, true), {
        label: "Copy & Focus IDE",
        showSecondaryCopy: false,
      });
      assert.deepEqual(webQuestionCard.getPrimaryActionMeta(standaloneCaps, false), {
        label: "Copy Answer",
        showSecondaryCopy: false,
      });
    });

    it("keeps structure fingerprint stable across metadata-only SSE updates", () => {
      const caps: ReplyCapabilities = {
        canSendMessage: false,
        isMcpApp: false,
        isEmbed: true,
      };
      const base: PendingHumanPrompt = {
        id: "p-1",
        agentId: "root",
        agentLabel: "Coordinator",
        kind: "question",
        title: "Old title",
        summary: "Old summary",
        blockingToolCall: false,
        questions: [
          {
            question: "Proceed?",
            type: "single_select",
            options: [{ label: "Yes" }],
          },
        ],
      };
      const metaUpdated: PendingHumanPrompt = {
        ...base,
        agentLabel: "Coordinator (active)",
        title: "New title",
        summary: "New summary",
      };

      assert.equal(
        webQuestionCard.computePromptStructureFingerprint(base, caps),
        webQuestionCard.computePromptStructureFingerprint(metaUpdated, caps)
      );
    });
  });

  describe("AgentChatPane pure routing, URL parsing, and filtering helpers (S1-75)", () => {
    it("routes Chat clicks to host IDE tab only in embedMode outside MCP App with parent", () => {
      assert.equal(
        webAgentChatPane.shouldRouteChatToHostTab({
          embedMode: true,
          mcpAppMode: false,
          hasParent: true,
        }),
        true
      );
      assert.equal(
        webAgentChatPane.shouldRouteChatToHostTab({
          embedMode: true,
          mcpAppMode: true,
          hasParent: true,
        }),
        false
      );
      assert.equal(
        webAgentChatPane.shouldRouteChatToHostTab({
          embedMode: false,
          mcpAppMode: false,
          hasParent: true,
        }),
        false
      );
      assert.equal(
        webAgentChatPane.shouldRouteChatToHostTab({
          embedMode: true,
          mcpAppMode: false,
          hasParent: false,
        }),
        false
      );
    });

    it("builds normalized agentStudio:openChatTab payload", () => {
      assert.deepEqual(
        webAgentChatPane.buildOpenChatTabPayload({
          sessionId: " sess-42 ",
          agentId: " fe-1 ",
          agentLabel: " Frontend Engineer ",
          ide: "copilot-vscode",
          focusQuestion: true,
        }),
        {
          type: "agentStudio:openChatTab",
          sessionId: "sess-42",
          agentId: "fe-1",
          agentLabel: "Frontend Engineer",
          ide: "copilot-vscode",
          focusQuestion: true,
        }
      );

      assert.deepEqual(
        webAgentChatPane.buildOpenChatTabPayload({
          sessionId: "s-1",
          agentId: "root",
        }),
        {
          type: "agentStudio:openChatTab",
          sessionId: "s-1",
          agentId: "root",
          agentLabel: "root",
          ide: "unknown",
          focusQuestion: false,
        }
      );
    });

    it("parses view=chat route parameters cleanly", () => {
      const parsed = webAgentChatPane.parseChatViewRouteParams(
        "?view=chat&session=s-7&agent=ag-fe&focusQuestion=1&embed=1&ide=antigravity&workspace=%2Fd%2Frepo&project=agent-studio"
      );
      assert.deepEqual(parsed, {
        view: "chat",
        isChatView: true,
        session: "s-7",
        agent: "ag-fe",
        focusQuestion: true,
        embed: true,
        ide: "antigravity",
        workspace: "/d/repo",
        project: "agent-studio",
      });

      const studioRoute = webAgentChatPane.parseChatViewRouteParams("view=studio&session=s-1");
      assert.equal(studioRoute.isChatView, false);
      assert.equal(studioRoute.focusQuestion, false);
      assert.equal(studioRoute.embed, false);
    });

    it("filters conversation turns across text, thinking, subagent, and tool payloads", () => {
      const msgs: AgentChatMessage[] = [
        {
          id: "m1",
          ts: "2026-11-26T10:00:00Z",
          epoch: 1,
          agentId: "root",
          role: "user",
          text: "Implement the side tab chat view",
        },
        {
          id: "m2",
          ts: "2026-11-26T10:00:02Z",
          epoch: 2,
          agentId: "root",
          role: "assistant",
          text: "Inspecting layout styles",
          thinking: "Need container queries for narrow panes",
          tools: [
            {
              toolName: "read_file",
              summary: "Read studio.css",
              inputPreview: "web/src/styles/studio.css",
              output: "container-type: inline-size",
              status: "ok",
            },
          ],
        },
        {
          id: "m3",
          ts: "2026-11-26T10:00:04Z",
          epoch: 3,
          agentId: "root",
          role: "subagent",
          text: "Delegating backend checks",
          subagentId: "be-1",
          subagentLabel: "Backend Engineer",
        },
      ];

      assert.equal(webAgentChatPane.filterChatMessages(msgs, "").length, 3);
      assert.deepEqual(
        webAgentChatPane.filterChatMessages(msgs, "SIDE TAB").map((m) => m.id),
        ["m1"]
      );
      assert.deepEqual(
        webAgentChatPane.filterChatMessages(msgs, "container queries").map((m) => m.id),
        ["m2"]
      );
      assert.deepEqual(
        webAgentChatPane.filterChatMessages(msgs, "studio.css").map((m) => m.id),
        ["m2"]
      );
      assert.deepEqual(
        webAgentChatPane.filterChatMessages(msgs, "backend engineer").map((m) => m.id),
        ["m3"]
      );
      assert.equal(webAgentChatPane.filterChatMessages(msgs, "nonexistent").length, 0);
    });

    it("decodes file URIs cleanly and builds agentStudio.openFile host messages", () => {
      assert.equal(
        webAgentChatPane.decodeFileUriToPath("file:///D:/Work/Repo/web/src/app.ts"),
        "D:/Work/Repo/web/src/app.ts"
      );
      assert.equal(
        webAgentChatPane.decodeFileUriToPath("file:///workspace/my%20file.ts"),
        "/workspace/my file.ts"
      );
      assert.equal(
        webAgentChatPane.decodeFileUriToPath("file://fileserver/share/doc.md"),
        "//fileserver/share/doc.md"
      );
      assert.equal(
        webAgentChatPane.decodeFileUriToPath("src/plain.ts"),
        "src/plain.ts"
      );

      assert.deepEqual(
        webAgentChatPane.buildOpenFileMessage({
          uri: "file:///D:/Work/Repo/src/app.ts",
          startLine: 12,
          endLine: 25,
        }),
        {
          type: "agentStudio.openFile",
          uri: "file:///D:/Work/Repo/src/app.ts",
          startLine: 12,
          endLine: 25,
        }
      );

      assert.deepEqual(
        webAgentChatPane.buildOpenFileMessage({
          uri: "file:///workspace/README.md",
          startLine: Number.NaN,
        }),
        {
          type: "agentStudio.openFile",
          uri: "file:///workspace/README.md",
        }
      );
    });

    it("enforces stale openSeq guard and pinned SSE session mismatch predicate", () => {
      assert.equal(
        webAgentChatPane.isChatFetchCurrent({ seq: 3, currentSeq: 3, active: true }),
        true
      );
      assert.equal(
        webAgentChatPane.isChatFetchCurrent({ seq: 2, currentSeq: 3, active: true }),
        false
      );
      assert.equal(
        webAgentChatPane.isChatFetchCurrent({ seq: 3, currentSeq: 3, active: false }),
        false
      );

      assert.equal(
        webAgentChatPane.shouldAcceptChatSnapshot({
          pinnedSessionId: "sess-1",
          snapshotSessionId: "sess-1",
        }),
        true
      );
      assert.equal(
        webAgentChatPane.shouldAcceptChatSnapshot({
          pinnedSessionId: "sess-1",
          snapshotSessionId: "sess-2",
        }),
        false
      );
      assert.equal(
        webAgentChatPane.shouldAcceptChatSnapshot({
          pinnedSessionId: "",
          snapshotSessionId: "sess-1",
        }),
        false
      );
      assert.equal(
        webAgentChatPane.shouldAcceptChatSnapshot({
          pinnedSessionId: "sess-1",
          snapshotSessionId: null,
        }),
        false
      );
    });
  });

  describe("Direct Human Answering Frontend Helpers (S1-77)", () => {
    it("returns Send Answer without resting Copy when directReply is true across all runtimes", () => {
      const capsList: ReplyCapabilities[] = [
        { canSendMessage: true, isMcpApp: true, isEmbed: false },
        { canSendMessage: false, isMcpApp: true, isEmbed: false },
        { canSendMessage: false, isMcpApp: false, isEmbed: true },
        { canSendMessage: false, isMcpApp: false, isEmbed: false },
      ];
      for (const caps of capsList) {
        assert.deepEqual(webQuestionCard.getPrimaryActionMeta(caps, false, true), {
          label: "Send Answer",
          showSecondaryCopy: false,
        });
        assert.deepEqual(webQuestionCard.getPrimaryActionMeta(caps, true, true), {
          label: "Send Answer",
          showSecondaryCopy: false,
        });
      }
    });

    it("builds structured answers map for single_select, multi_select, and text questions", () => {
      const questions: PendingQuestionItem[] = [
        {
          id: "q-transport",
          question: "Which transport?",
          type: "single_select",
          options: [{ label: "SSE" }, { label: "Polling" }],
        },
        {
          id: "q-checks",
          question: "Which checks?",
          type: "multi_select",
          options: [{ label: "Typecheck" }, { label: "Unit" }],
        },
        {
          header: "Notes",
          question: "Any extra notes?",
          type: "text",
          options: [],
        },
      ];
      const draft: PromptDraftState = {
        activeIdx: 0,
        answers: {
          0: { selected: ["SSE"], customOpen: false, customText: "ignored" },
          1: { selected: ["Typecheck"], customOpen: true, customText: "Lint" },
          2: { selected: [], customOpen: true, customText: "Ship it" },
        },
      };

      assert.deepEqual(webQuestionCard.buildStructuredAnswers(questions, draft), {
        "q-transport": "SSE",
        "q-checks": ["Typecheck", "Lint"],
        Notes: "Ship it",
      });

      draft.answers[1]!.customOpen = false;
      assert.deepEqual(webQuestionCard.buildStructuredAnswers(questions, draft), {
        "q-transport": "SSE",
        "q-checks": ["Typecheck"],
        Notes: "Ship it",
      });
    });

    it("includes directReply and status in computePromptStructureFingerprint and preserves S1-77 fields in normalizePendingHumanPrompt", () => {
      const caps: ReplyCapabilities = {
        canSendMessage: false,
        isMcpApp: false,
        isEmbed: true,
      };
      const base = webSnapshot.normalizePendingHumanPrompt({
        id: "p-direct-1",
        agentId: "fe-1",
        agentLabel: "Frontend",
        kind: "question",
        title: "Approve layout?",
        blockingToolCall: false,
        directReply: true,
        promptSource: "studio-mcp",
        status: "pending",
        expiresAt: "2026-11-27T04:00:00Z",
        sessionId: "sess-77",
        workspacePath: "d:/Work/Repo",
        ide: "antigravity",
        questions: [
          {
            id: "q1",
            question: "Proceed?",
            type: "single_select",
            options: [{ label: "Yes" }],
          },
        ],
      });
      assert.ok(base);
      assert.equal(base.directReply, true);
      assert.equal(base.promptSource, "studio-mcp");
      assert.equal(base.status, "pending");
      assert.equal(base.expiresAt, "2026-11-27T04:00:00Z");
      assert.equal(base.sessionId, "sess-77");
      assert.equal(base.workspacePath, "d:/Work/Repo");
      assert.equal(base.ide, "antigravity");

      const nonDirect: PendingHumanPrompt = { ...base, directReply: false };
      const answered: PendingHumanPrompt = { ...base, status: "answered" };
      assert.notEqual(
        webQuestionCard.computePromptStructureFingerprint(base, caps),
        webQuestionCard.computePromptStructureFingerprint(nonDirect, caps)
      );
      assert.notEqual(
        webQuestionCard.computePromptStructureFingerprint(base, caps),
        webQuestionCard.computePromptStructureFingerprint(answered, caps)
      );
    });

    it("classifies ask_human tool variants as ext:human", () => {
      for (const tool of [
        "ask_human",
        "agent_studio_ask_human",
        "mcp__agent-studio__ask_human",
        "agent-studio/ask_human",
      ]) {
        assert.deepEqual(webUtils.classifyExternalTarget(tool), {
          id: "ext:human",
          label: "User",
        });
      }
    });

    it("submits direct answers and cancellations over HTTP and handles 409/error recovery", async () => {
      webApi.setMcpAppTransport(null);
      const calls: Array<{ url: string; method?: string; body?: string }> = [];

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (url.endsWith("/answer") && url.includes("p-ok")) {
          return new Response(
            JSON.stringify({ ok: true, status: "answered" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/answer") && url.includes("p-conflict")) {
          return new Response(
            JSON.stringify({ ok: false, status: "answered", error: "Already resolved" }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/cancel") && url.includes("p-cancel")) {
          return new Response(
            JSON.stringify({ ok: true, status: "canceled" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ ok: false, error: "Server busy" }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch;

      const okRes = await webApi.answerPendingPrompt("p-ok", {
        answerText: "SSE",
        answers: { q1: "SSE" },
      });
      assert.equal(okRes.ok, true);
      assert.equal(okRes.status, "answered");
      assert.equal(calls[0]?.url, "/api/prompts/p-ok/answer");
      assert.equal(calls[0]?.method, "POST");
      assert.deepEqual(JSON.parse(calls[0]!.body!), {
        promptId: "p-ok",
        answerText: "SSE",
        answers: { q1: "SSE" },
      });

      const conflictRes = await webApi.answerPendingPrompt("p-conflict", {
        answerText: "SSE",
      });
      assert.equal(conflictRes.ok, false);
      assert.equal(conflictRes.conflict, true);
      assert.equal(conflictRes.status, "answered");
      assert.equal(conflictRes.error, "Already resolved");

      const errRes = await webApi.answerPendingPrompt("p-err", {
        answerText: "SSE",
      });
      assert.equal(errRes.ok, false);
      assert.equal(errRes.conflict, undefined);
      assert.equal(errRes.error, "Server busy");

      const cancelRes = await webApi.cancelPendingPrompt("p-cancel", "User dismissed");
      assert.equal(cancelRes.ok, true);
      assert.equal(cancelRes.status, "canceled");
      assert.equal(calls[3]?.url, "/api/prompts/p-cancel/cancel");
      assert.deepEqual(JSON.parse(calls[3]!.body!), {
        promptId: "p-cancel",
        reason: "User dismissed",
      });
    });

    it("routes answerPendingPrompt and cancelPendingPrompt via MCP App tools when active", async () => {
      const mcpCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
      webApi.setMcpAppTransport({
        async callServerTool(params: {
          name: string;
          arguments?: Record<string, unknown>;
        }) {
          mcpCalls.push(params);
          if (params.name === "app_answer_prompt") {
            return {
              isError: false,
              structuredContent: { ok: true, status: "answered" },
            };
          }
          return {
            isError: true,
            structuredContent: {
              ok: false,
              conflict: true,
              status: "answered",
              error: "Already resolved",
            },
          };
        },
      });

      try {
        const ans = await webApi.answerPendingPrompt("p-mcp", {
          answerText: "Yes",
          answers: { q1: "Yes" },
        });
        assert.equal(ans.ok, true);
        assert.equal(ans.status, "answered");
        assert.equal(mcpCalls[0]?.name, "app_answer_prompt");

        const cancelConflict = await webApi.cancelPendingPrompt("p-mcp");
        assert.equal(cancelConflict.ok, false);
        assert.equal(cancelConflict.conflict, true);
        assert.equal(cancelConflict.error, "Already resolved");
        assert.equal(mcpCalls[1]?.name, "app_cancel_prompt");
      } finally {
        webApi.setMcpAppTransport(null);
      }
    });

    it("exercises QuestionCard 2-step cancel flow and error recovery with Retry + Copy Answer", async () => {
      const globalBag = globalThis as unknown as {
        window?: unknown;
        document?: unknown;
      };
      const origWindow = globalBag.window;
      const origDocument = globalBag.document;

      class FakeEl {
        public tagName = "DIV";
        public dataset: Record<string, string> = {};
        public disabled = false;
        public hidden = false;
        public value = "";
        public checked = false;
        public textContent = "";
        public className = "";
        public title = "";
        public classList = {
          toggle: () => false,
          contains: (c: string) => this.className.split(/\s+/).includes(c),
        };
        private attrs = new Map<string, string>();
        private listeners = new Map<string, Array<(ev: unknown) => void>>();
        public setAttribute(k: string, v: string) {
          this.attrs.set(k, v);
        }
        public getAttribute(k: string) {
          return this.attrs.get(k) ?? null;
        }
        public removeAttribute(k: string) {
          this.attrs.delete(k);
        }
        public hasAttribute(k: string) {
          return this.attrs.has(k);
        }
        public addEventListener(type: string, fn: (ev: unknown) => void) {
          const list = this.listeners.get(type) ?? [];
          list.push(fn);
          this.listeners.set(type, list);
        }
        public async dispatch(type: string, ev: Record<string, unknown> = {}) {
          const list = this.listeners.get(type) ?? [];
          for (const fn of list) {
            await fn({ preventDefault: () => undefined, stopPropagation: () => undefined, ...ev });
          }
        }
        public focus() {}
        public querySelector() {
          return null;
        }
        public querySelectorAll() {
          return [];
        }
      }

      const createFakeContainer = () => {
        let html = "";
        let els = new Map<string, FakeEl>();
        const rebuildEls = (nextHtml: string) => {
          html = nextHtml;
          els = new Map<string, FakeEl>();
          const add = (sel: string, tag = "BUTTON") => {
            const el = new FakeEl();
            el.tagName = tag;
            if (sel === "[data-qc-custom-input]") el.value = "";
            els.set(sel, el);
          };
          add("[data-qc-form]", "FORM");
          add(".qc-primary-btn");
          add("[data-qc-cancel]");
          add("[data-qc-cancel-confirm]", "DIV");
          add("[data-qc-cancel-keep]");
          add("[data-qc-cancel-confirm-yes]");
          add("[data-qc-retry]");
          add("[data-qc-error-copy]");
          add(".qc-status", "DIV");
          add("[data-qc-status-msg]", "SPAN");
          add("[data-qc-error-actions]", "DIV");
          add("[data-qc-ready]", "SPAN");
          add("[data-qc-custom-input]", "TEXTAREA");
        };
        return {
          get innerHTML() {
            return html;
          },
          set innerHTML(v: string) {
            rebuildEls(v);
          },
          contains: () => false,
          querySelector: (sel: string) => els.get(sel) ?? null,
          querySelectorAll: () => [],
          getEl: (sel: string) => els.get(sel) ?? null,
        };
      };

      (globalThis as unknown as Record<string, unknown>).window = {
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
      };
      (globalThis as unknown as Record<string, unknown>).document = {
        activeElement: null,
        contains: () => true,
      };

      try {
        const container = createFakeContainer();
        let replyCalls = 0;
        let cancelCalls = 0;
        const prompt: PendingHumanPrompt = {
          id: "qc-direct-1",
          agentId: "fe-1",
          agentLabel: "Frontend",
          kind: "question",
          title: "Pick color",
          blockingToolCall: false,
          directReply: true,
          questions: [
            {
              id: "color",
              question: "Color?",
              type: "text",
              options: [],
              defaultValue: "Cyan",
            },
          ],
        };

        const card = new webQuestionCard.QuestionCard(container, {
          prompt,
          getCapabilities: () => ({ canSendMessage: false, isMcpApp: false, isEmbed: true }),
          onReply: async () => {
            replyCalls += 1;
            if (replyCalls === 1) {
              return { ok: false, mode: "error", message: "Network offline" };
            }
            return { ok: true, mode: "answered", message: "Answer sent." };
          },
          onCancel: async () => {
            cancelCalls += 1;
            return { ok: true, mode: "canceled", message: "Canceled — agent unblocked" };
          },
        });

        // Resting direct-reply card: Send Answer + Cancel, no Copy button, no blocking note
        assert.ok(container.innerHTML.includes("Send Answer"));
        assert.ok(container.innerHTML.includes("Direct Reply"));
        assert.ok(container.innerHTML.includes("qc-cancel-btn"));
        assert.ok(!container.innerHTML.includes("data-qc-copy"));
        assert.ok(!container.innerHTML.includes("qc-blocking-note"));

        // Step 1 of 2-step cancel: clicking Cancel opens inline confirm, Keep closes it without calling onCancel
        await container.getEl("[data-qc-cancel]")!.dispatch("click");
        assert.equal(cancelCalls, 0);
        assert.ok(container.innerHTML.includes("Cancel prompt?"));
        await container.getEl("[data-qc-cancel-keep]")!.dispatch("click");
        assert.equal(cancelCalls, 0);

        // Submit failure shows Retry + Copy Answer without losing draft; Retry succeeds
        await container.getEl("[data-qc-form]")!.dispatch("submit");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(replyCalls, 1);
        assert.ok(container.innerHTML.includes("Network offline"));
        assert.ok(container.innerHTML.includes("data-qc-retry"));
        assert.ok(container.innerHTML.includes("data-qc-error-copy"));

        await container.getEl("[data-qc-retry]")!.dispatch("click");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(replyCalls, 2);
        assert.ok(container.innerHTML.includes("Sent to Frontend ✓"));

        // Separate card: Confirming 2-step cancel invokes onCancel and locks card
        const cancelContainer = createFakeContainer();
        const cancelCard = new webQuestionCard.QuestionCard(cancelContainer, {
          prompt: { ...prompt, id: "qc-direct-2" },
          getCapabilities: () => ({ canSendMessage: false, isMcpApp: false, isEmbed: false }),
          onReply: async () => ({ ok: true, mode: "answered", message: "ok" }),
          onCancel: async () => {
            cancelCalls += 1;
            return { ok: true, mode: "canceled", message: "Canceled — agent unblocked" };
          },
        });
        await cancelContainer.getEl("[data-qc-cancel]")!.dispatch("click");
        await cancelContainer.getEl("[data-qc-cancel-confirm-yes]")!.dispatch("click");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(cancelCalls, 1);
        assert.ok(cancelContainer.innerHTML.includes("Canceled — agent unblocked"));

        card.dispose();
        cancelCard.dispose();
        webQuestionCard.clearPromptDraft("qc-direct-1");
        webQuestionCard.clearPromptDraft("qc-direct-2");
      } finally {
        (globalThis as unknown as Record<string, unknown>).window = origWindow;
        (globalThis as unknown as Record<string, unknown>).document = origDocument;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// S1-77 fix-pass: QuestionCard lock / conflict / remote-resolution / XSS tests
// ---------------------------------------------------------------------------

interface FakeDomDoc {
  activeElement: unknown;
  contains: () => boolean;
}

function installFakeQcDom(): {
  doc: FakeDomDoc;
  createContainer: () => {
    innerHTML: string;
    contains: () => boolean;
    querySelector: (sel: string) => unknown;
    querySelectorAll: () => unknown[];
    getEl: (sel: string) => {
      dispatch: (type: string, ev?: Record<string, unknown>) => Promise<void>;
    } | null;
  };
  restore: () => void;
} {
  const bag = globalThis as unknown as Record<string, unknown>;
  const origWindow = bag.window;
  const origDocument = bag.document;
  const doc: FakeDomDoc = { activeElement: null, contains: () => true };

  class FakeEl {
    public tagName = "DIV";
    public dataset: Record<string, string> = {};
    public disabled = false;
    public hidden = false;
    public value = "";
    public checked = false;
    public textContent = "";
    public className = "";
    public title = "";
    public classList = {
      toggle: () => false,
      contains: (c: string) => this.className.split(/\s+/).includes(c),
    };
    private attrs = new Map<string, string>();
    private listeners = new Map<string, Array<(ev: unknown) => void>>();
    public setAttribute(k: string, v: string) {
      this.attrs.set(k, v);
    }
    public getAttribute(k: string) {
      return this.attrs.get(k) ?? null;
    }
    public removeAttribute(k: string) {
      this.attrs.delete(k);
    }
    public hasAttribute(k: string) {
      return this.attrs.has(k);
    }
    public addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    public async dispatch(type: string, ev: Record<string, unknown> = {}) {
      const list = this.listeners.get(type) ?? [];
      for (const fn of list) {
        await fn({ preventDefault: () => undefined, stopPropagation: () => undefined, ...ev });
      }
    }
    public focus() {
      doc.activeElement = this;
    }
    public querySelector() {
      return null;
    }
    public querySelectorAll() {
      return [];
    }
  }

  const selectors: Array<[string, string]> = [
    ["[data-qc-form]", "FORM"],
    [".qc-primary-btn", "BUTTON"],
    ["[data-qc-cancel]", "BUTTON"],
    ["[data-qc-cancel-confirm]", "DIV"],
    ["[data-qc-cancel-keep]", "BUTTON"],
    ["[data-qc-cancel-confirm-yes]", "BUTTON"],
    ["[data-qc-retry]", "BUTTON"],
    ["[data-qc-error-copy]", "BUTTON"],
    [".qc-status", "DIV"],
    ["[data-qc-status-msg]", "SPAN"],
    ["[data-qc-error-actions]", "DIV"],
    ["[data-qc-ready]", "SPAN"],
    ["[data-qc-custom-input]", "TEXTAREA"],
  ];

  const createContainer = () => {
    let html = "";
    let els = new Map<string, FakeEl>();
    const rebuild = (next: string) => {
      html = next;
      els = new Map<string, FakeEl>();
      for (const [sel, tag] of selectors) {
        // Only expose elements whose marker is actually present in the rendered markup.
        const marker = sel.replace(/^\[|\]$/g, "").replace(/^\./, "");
        if (!next.includes(marker)) continue;
        const el = new FakeEl();
        el.tagName = tag;
        els.set(sel, el);
      }
    };
    return {
      get innerHTML() {
        return html;
      },
      set innerHTML(v: string) {
        rebuild(v);
      },
      contains: () => false,
      querySelector: (sel: string) => els.get(sel) ?? null,
      querySelectorAll: () => [] as unknown[],
      getEl: (sel: string) => els.get(sel) ?? null,
    };
  };

  bag.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  bag.document = doc;

  return {
    doc,
    createContainer,
    restore: () => {
      bag.window = origWindow;
      bag.document = origDocument;
    },
  };
}

function makeQcPrompt(id: string, extra: Partial<PendingHumanPrompt> = {}): PendingHumanPrompt {
  return {
    id,
    agentId: "fe-1",
    agentLabel: "Frontend",
    kind: "question",
    title: "Pick color",
    blockingToolCall: false,
    directReply: true,
    questions: [
      {
        id: "color",
        question: "Color?",
        type: "text",
        options: [],
        defaultValue: "Cyan",
      },
    ],
    ...extra,
  };
}

const qcCaps = () => ({ canSendMessage: false, isMcpApp: false, isEmbed: true });
const qcTick = () => new Promise((r) => setTimeout(r, 10));

describe("Web Studio S1-77 QuestionCard lock & safety", () => {
  it("locks against double-submit while a reply is in flight", async () => {
    const dom = installFakeQcDom();
    try {
      const container = dom.createContainer();
      let replyCalls = 0;
      let release: (v: ReplyToHostResult) => void = () => undefined;
      const card = new webQuestionCard.QuestionCard(container, {
        prompt: makeQcPrompt("qc-dbl-1"),
        getCapabilities: qcCaps,
        onReply: () => {
          replyCalls += 1;
          return new Promise<ReplyToHostResult>((r) => {
            release = r;
          });
        },
      });

      void container.getEl("[data-qc-form]")!.dispatch("submit");
      await qcTick();
      // Second submit (re-rendered form) and primary click while sending must be ignored
      await container.getEl("[data-qc-form]")?.dispatch("submit");
      await container.getEl(".qc-primary-btn")?.dispatch("click");
      await qcTick();
      assert.equal(replyCalls, 1);

      release({ ok: true, mode: "answered", message: "ok" });
      await qcTick();
      assert.ok(container.innerHTML.includes("is-resolved"));
      await container.getEl("[data-qc-form]")?.dispatch("submit");
      await qcTick();
      assert.equal(replyCalls, 1);
      card.dispose();
    } finally {
      webQuestionCard.clearPromptDraft("qc-dbl-1");
      dom.restore();
    }
  });

  it("locks the card on 409 conflict and focuses Copy Answer", async () => {
    const dom = installFakeQcDom();
    try {
      const container = dom.createContainer();
      let replyCalls = 0;
      const card = new webQuestionCard.QuestionCard(container, {
        prompt: makeQcPrompt("qc-409-1"),
        getCapabilities: qcCaps,
        onReply: async () => {
          replyCalls += 1;
          return {
            ok: false,
            mode: "error",
            conflict: true,
            status: "answered",
            message: "Already answered elsewhere",
          };
        },
      });

      await container.getEl("[data-qc-form]")!.dispatch("submit");
      await qcTick();
      assert.equal(replyCalls, 1);
      assert.ok(container.innerHTML.includes("Already answered elsewhere"));
      assert.ok(container.innerHTML.includes("is-resolved"));
      assert.ok(!container.innerHTML.includes("data-qc-retry"));
      const copyBtn = container.getEl("[data-qc-error-copy]");
      assert.ok(copyBtn, "Copy Answer button should be rendered after 409");
      assert.equal(dom.doc.activeElement, copyBtn);

      await container.getEl("[data-qc-form]")?.dispatch("submit");
      await qcTick();
      assert.equal(replyCalls, 1);
      card.dispose();
    } finally {
      webQuestionCard.clearPromptDraft("qc-409-1");
      dom.restore();
    }
  });

  it("re-renders a mounted card into the locked state on remote pending -> expired", async () => {
    const dom = installFakeQcDom();
    try {
      const container = dom.createContainer();
      let replyCalls = 0;
      const prompt = makeQcPrompt("qc-remote-1", { status: "pending" });
      const card = new webQuestionCard.QuestionCard(container, {
        prompt,
        getCapabilities: qcCaps,
        onReply: async () => {
          replyCalls += 1;
          return { ok: true, mode: "answered", message: "ok" };
        },
      });
      assert.ok(!container.innerHTML.includes("is-resolved"));

      card.update({ prompt: { ...prompt, status: "expired" } });
      assert.ok(container.innerHTML.includes("is-resolved"));
      const lockedHtml = container.innerHTML;

      // Subsequent updates keep the card frozen
      card.update({ prompt: { ...prompt, status: "expired", title: "Changed title" } });
      assert.equal(container.innerHTML, lockedHtml);

      await container.getEl("[data-qc-form]")?.dispatch("submit");
      await qcTick();
      assert.equal(replyCalls, 0);
      card.dispose();
    } finally {
      webQuestionCard.clearPromptDraft("qc-remote-1");
      dom.restore();
    }
  });

  it("escapes HTML in title, summary, question, and option labels", () => {
    const dom = installFakeQcDom();
    try {
      const container = dom.createContainer();
      const card = new webQuestionCard.QuestionCard(container, {
        prompt: makeQcPrompt("qc-xss-1", {
          title: "<img src=x onerror=alert(1)>",
          summary: "<script>alert(2)</script>",
          directReply: false,
          questions: [
            {
              id: "pick",
              question: "\"><svg onload=alert(3)>",
              type: "single_select",
              options: [
                { id: "a", label: "<b onmouseover=alert(4)>bold</b>" },
                { id: "b", label: "Safe" },
              ],
            },
          ],
        }),
        getCapabilities: qcCaps,
        onReply: async () => ({ ok: true, mode: "answered", message: "ok" }),
      });
      const html = container.innerHTML;
      assert.ok(!html.includes("<img"), "title must be escaped");
      assert.ok(!html.includes("<script"), "summary must be escaped");
      assert.ok(!html.includes("<svg"), "question must be escaped");
      assert.ok(!html.includes("<b "), "option label must be escaped");
      assert.ok(!html.includes("\"><svg"), "attribute context must be escaped");
      assert.ok(html.includes("&lt;"), "escaped entities should be present");
      card.dispose();
    } finally {
      webQuestionCard.clearPromptDraft("qc-xss-1");
      dom.restore();
    }
  });
});
