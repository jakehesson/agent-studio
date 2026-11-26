import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";
import type {
  AgentChatResponse,
  PendingHumanPrompt,
  PendingQuestionItem,
  ReplyCapabilities,
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

interface WebApiExports {
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
  getPrimaryActionMeta(
    caps: ReplyCapabilities,
    blockingToolCall: boolean
  ): { label: string; showSecondaryCopy: boolean };
  computePromptStructureFingerprint(
    prompt: PendingHumanPrompt,
    caps: ReplyCapabilities
  ): string;
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

const webUtils = loadTranspiledTsModule<Record<string, unknown>>(
  "web/src/utils.ts"
);

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
});
