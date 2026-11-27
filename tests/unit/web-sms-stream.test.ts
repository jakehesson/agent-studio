import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import type {
  AgentNodeSnapshot,
  NormalizedEvent,
  PendingQuestionItem,
} from "../../web/src/types.js";

interface BehindThoughtStep {
  kind: "thought";
  epoch: number;
  ts: string;
  timeLabel: string;
  text: string;
  event: NormalizedEvent;
  durationLabel?: string;
}

interface BehindToolStep {
  kind: "tool";
  epoch: number;
  ts: string;
  timeLabel: string;
  toolName: string;
  summary: string;
  status: "running" | "ok" | "error" | "denied";
  durationSec?: number;
  durationLabel?: string;
  inputPreview?: string;
  outputPreview?: string;
  event: NormalizedEvent;
  endEvent?: NormalizedEvent;
}

type BehindStep = BehindThoughtStep | BehindToolStep;

interface BehindSummary {
  thoughtCount: number;
  toolCount: number;
  durationLabel?: string;
}

interface SmsMessageItem {
  kind: "message";
  event: NormalizedEvent;
  dir: "inbound" | "outbound";
  fromLabel: string;
  roleBadge: string;
  routeLabel: string;
  timeLabel: string;
  text: string;
  fullMarkdownText: string;
  isHumanAnswer?: boolean;
  replyToEntryId?: string;
  replyToQuote?: string;
  replyToActorLabel?: string;
  questions?: PendingQuestionItem[];
  chosenAnswerText?: string;
  behindSteps: BehindStep[];
  behindSummary: BehindSummary;
}

interface SmsToolBurstItem {
  kind: "tool_burst";
  groupKey: string;
  agentId: string;
  agentLabel: string;
}

type SmsStreamEntry = SmsMessageItem | SmsToolBurstItem;

type ThreadSelection =
  | {
      key: "all";
      kind: "all";
      label: string;
      route: string;
    }
  | {
      key: string;
      kind: "cluster";
      clusterId: string;
      agentIds: string[];
      runId?: string;
      label: string;
      route: string;
    };

interface ExtractSmsStreamOptions {
  events: NormalizedEvent[];
  agents: AgentNodeSnapshot[];
  thread: ThreadSelection;
  labelMap?: Map<string, string>;
  showRawTools?: boolean;
}

interface SmsStreamResult {
  entries: SmsStreamEntry[];
  hiddenBurstCount: number;
  hiddenToolCount: number;
  hiddenBackgroundAgents: string[];
}

interface TopologyGroupingExports {
  resolveCommEndpoints(
    ev: NormalizedEvent,
    rootId: string | undefined,
    agentParentMap: Map<string, string | undefined>
  ): { fromId: string; toId: string } | null;
  extractSmsStream(
    opts: ExtractSmsStreamOptions,
    options?: { showRawTools?: boolean }
  ): SmsStreamEntry[];
  extractSmsStreamWithMeta(
    opts: ExtractSmsStreamOptions,
    options?: { showRawTools?: boolean }
  ): SmsStreamResult;
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

const topologyGrouping = loadTranspiledTsModule<TopologyGroupingExports>(
  "web/src/state/topologyGrouping.ts",
  (specifier) => {
    if (specifier === "../utils.js") return webUtils;
    throw new Error(`Unexpected import ${specifier} in web/src/state/topologyGrouping.ts`);
  }
);

const ALL_THREAD: ThreadSelection = {
  key: "all",
  kind: "all",
  label: "All Session Messages",
  route: "All Session Messages",
};

function makeAgents(): AgentNodeSnapshot[] {
  return [
    {
      id: "root",
      label: "Coordinator",
      ide: "antigravity",
      status: "WORKING",
      toolCalls: 3,
      messagesSent: 1,
      messagesReceived: 2,
    },
    {
      id: "a2-morgoth",
      label: "A2 - Morgoth",
      parentAgentId: "root",
      ide: "antigravity",
      status: "DONE",
      role: "Subagent",
      toolCalls: 2,
      messagesSent: 1,
      messagesReceived: 1,
    },
    {
      id: "a3-questioner",
      label: "A3 - Questioner",
      parentAgentId: "root",
      ide: "antigravity",
      status: "DONE",
      role: "Subagent",
      toolCalls: 1,
      messagesSent: 2,
      messagesReceived: 1,
    },
    {
      id: "a4-waiter",
      label: "A4 - Waiter",
      parentAgentId: "root",
      ide: "antigravity",
      status: "WORKING",
      role: "Subagent",
      toolCalls: 1,
      messagesSent: 0,
      messagesReceived: 0,
    },
  ];
}

describe("Web SMS Stream & Behind-Response Correlation", () => {
  it("routes isHumanAnswer user_input to a subagent from ext:human -> subagent regardless of parentAgentId", () => {
    const parentMap = new Map<string, string | undefined>([
      ["root", undefined],
      ["a3-questioner", "root"],
    ]);

    const answerEv: NormalizedEvent = {
      id: "ev-human-ans",
      ts: "2026-11-26T18:55:29.000Z",
      epoch: 1795719329,
      ide: "antigravity",
      sessionId: "sess-1",
      agentId: "a3-questioner",
      parentAgentId: "root",
      kind: "user_input",
      summary: "Sharp philosophical debate",
      payload: { isHumanAnswer: true, questionToolCallId: "tc-q1" },
    };

    const ep = topologyGrouping.resolveCommEndpoints(answerEv, "root", parentMap);
    assert.deepEqual(ep, { fromId: "ext:human", toId: "a3-questioner" });

    // Non-answer coordinator prompt to a subagent still routes parent -> subagent
    const normalPrompt: NormalizedEvent = {
      ...answerEv,
      id: "ev-coord-prompt",
      payload: { prompt: "Start round 1" },
    };
    const ep2 = topologyGrouping.resolveCommEndpoints(normalPrompt, "root", parentMap);
    assert.deepEqual(ep2, { fromId: "root", toId: "a3-questioner" });
  });

  it("pairs ask_question with human answer (replyToEntryId, replyToQuote, chosenAnswerText)", () => {
    const events: NormalizedEvent[] = [
      {
        id: "ev-q1",
        ts: "2026-11-26T18:55:24.000Z",
        epoch: 1795719324,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a3-questioner",
        agentLabel: "A3 - Questioner",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "ask_question",
        toolCallId: "tc-q1",
        summary: "Which tone should Sauron and Morgoth use for the debate?",
        payload: {
          questions: [
            {
              question: "Which tone should Sauron and Morgoth use for the debate?",
              type: "single_select",
              options: [
                { label: "Sharp philosophical debate" },
                { label: "Dramatic First Age lore monologue" },
                { label: "Concise bullet-point duel" },
              ],
            },
          ],
        },
      },
      {
        id: "ev-a1",
        ts: "2026-11-26T18:55:29.000Z",
        epoch: 1795719329,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a3-questioner",
        parentAgentId: "root",
        kind: "user_input",
        summary: "Sharp philosophical debate",
        payload: {
          isHumanAnswer: true,
          questionToolCallId: "tc-q1",
          body: "Sharp philosophical debate — keep Morgoth brutally honest.",
        },
      },
    ];

    const entries = topologyGrouping.extractSmsStream({
      events,
      agents: makeAgents(),
      thread: ALL_THREAD,
      labelMap: new Map([["a3-questioner", "A3 - Questioner"]]),
    } as ExtractSmsStreamOptions);

    const msgs = entries.filter((e): e is SmsMessageItem => e.kind === "message");
    assert.equal(msgs.length, 2);

    const qMsg = msgs[0]!;
    const aMsg = msgs[1]!;

    assert.equal(qMsg.questions?.length, 1);
    assert.equal(qMsg.questions?.[0]?.options.length, 3);
    assert.equal(
      qMsg.chosenAnswerText,
      "Sharp philosophical debate — keep Morgoth brutally honest."
    );

    assert.equal(aMsg.isHumanAnswer, true);
    assert.equal(aMsg.fromLabel, "You");
    assert.equal(aMsg.roleBadge, "Answered Question");
    assert.equal(aMsg.routeLabel, "You → A3 - Questioner");
    assert.equal(aMsg.replyToEntryId, "ev-q1");
    assert.equal(aMsg.replyToActorLabel, "A3 - Questioner");
    assert.match(aMsg.replyToQuote ?? "", /Which tone should Sauron and Morgoth use/);
  });

  it("extracts full payload.body ahead of 1-line ev.summary without 320-word truncation", () => {
    const longWords = Array.from({ length: 420 }, (_, i) => `word${i}`).join(" ");
    const fullBody = [
      "**Real thoughts (Morgoth's honest critique):**",
      "Line 2 with critical nuance.",
      longWords,
    ].join("\n\n");

    const events: NormalizedEvent[] = [
      {
        id: "ev-morgoth",
        ts: "2026-11-26T18:55:18.000Z",
        epoch: 1795719318,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        agentLabel: "A2 - Morgoth",
        parentAgentId: "root",
        kind: "message",
        summary: "Real thoughts (Morgoth's honest critique):",
        payload: {
          body: fullBody,
        },
      },
    ];

    const entries = topologyGrouping.extractSmsStream({
      events,
      agents: makeAgents(),
      thread: ALL_THREAD,
      labelMap: new Map([["a3-questioner", "A3 - Questioner"]]),
    } as ExtractSmsStreamOptions);

    assert.equal(entries.length, 1);
    const msg = entries[0] as SmsMessageItem;
    assert.equal(msg.fullMarkdownText, fullBody);
    assert.ok(msg.fullMarkdownText.includes("word419"), "fullMarkdownText must not be truncated at 320 chars/words");
    assert.ok(msg.fullMarkdownText.includes("Line 2 with critical nuance."));
  });

  it("hides standalone tool_burst rows by default (showRawTools: false) and preserves them when showRawTools: true", () => {
    const events: NormalizedEvent[] = [
      {
        id: "ev-dispatch",
        ts: "2026-11-26T18:54:58.000Z",
        epoch: 1795719298,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "root",
        agentLabel: "Coordinator",
        targetAgentId: "a4-waiter",
        kind: "subagent_spawn",
        summary: "Spawned A4 - Waiter",
      },
      {
        id: "ev-wait-tool",
        ts: "2026-11-26T18:55:10.000Z",
        epoch: 1795719310,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a4-waiter",
        agentLabel: "A4 - Waiter",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "wait_for_signal",
        toolCallId: "tc-wait",
        summary: "Polling background turn",
      },
    ];

    const hiddenRes = topologyGrouping.extractSmsStreamWithMeta({
      events,
      agents: makeAgents(),
      thread: ALL_THREAD,
    });
    assert.equal(
      hiddenRes.entries.some((e) => e.kind === "tool_burst"),
      false,
      "Default showRawTools=false must suppress standalone tool_burst rows"
    );
    assert.equal(hiddenRes.hiddenBurstCount, 1);
    assert.equal(hiddenRes.hiddenToolCount, 1);
    assert.deepEqual(hiddenRes.hiddenBackgroundAgents, ["a4-waiter"]);

    const shownEntries = topologyGrouping.extractSmsStream(
      {
        events,
        agents: makeAgents(),
        thread: ALL_THREAD,
      },
      { showRawTools: true }
    );
    const bursts = shownEntries.filter((e) => e.kind === "tool_burst");
    assert.equal(bursts.length, 1);
    assert.equal(bursts[0]!.agentId, "a4-waiter");
  });

  it("correlates non-placeholder thinking_start and paired tool_start/tool_end into chronological behindSteps", () => {
    const events: NormalizedEvent[] = [
      {
        id: "ev-think-placeholder",
        ts: "2026-11-26T18:55:13.000Z",
        epoch: 1795719313,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "thinking_start",
        summary: "Thinking…",
      },
      {
        id: "ev-think-real",
        ts: "2026-11-26T18:55:14.000Z",
        epoch: 1795719314,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "thinking_start",
        summary: "Sauron sanitizes domination as craft.",
        payload: {
          body: "Sauron uses **lucid** and **mercy** to sanitize subjugation. I should call that out directly.",
        },
      },
      {
        id: "ev-tool-start",
        ts: "2026-11-26T18:55:15.000Z",
        epoch: 1795719315,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "read_file",
        toolCallId: "tc-r1",
        summary: "Read Sauron opening",
        payload: { args: { Path: "notes/sauron.md" } },
      },
      {
        id: "ev-tool-end",
        ts: "2026-11-26T18:55:16.500Z",
        epoch: 1795719316.5,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "tool_end",
        toolName: "read_file",
        toolCallId: "tc-r1",
        summary: "Done: read_file",
        payload: {
          routineEnd: true,
          outputPreview: "Chaos is merely the laziness of unshaped iron.",
        },
      },
      {
        id: "ev-msg-done",
        ts: "2026-11-26T18:55:18.000Z",
        epoch: 1795719318,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        agentLabel: "A2 - Morgoth",
        parentAgentId: "root",
        kind: "message",
        summary: "Critique delivered.",
        payload: { body: "**Real thoughts:**\n\nHe mistakes a clockwork cage for mercy." },
      },
    ];

    const entries = topologyGrouping.extractSmsStream({
      events,
      agents: makeAgents(),
      thread: ALL_THREAD,
      labelMap: new Map([["a3-questioner", "A3 - Questioner"]]),
    } as ExtractSmsStreamOptions);

    assert.equal(entries.length, 1);
    const msg = entries[0] as SmsMessageItem;
    const summary: BehindSummary = msg.behindSummary;
    const steps: BehindStep[] = msg.behindSteps;

    assert.equal(summary.thoughtCount, 1, "Placeholder 'Thinking…' must be skipped");
    assert.equal(summary.toolCount, 1);
    assert.equal(summary.durationLabel, "4s");
    assert.equal(steps.length, 2);

    assert.equal(steps[0]!.kind, "thought");
    if (steps[0]!.kind === "thought") {
      assert.match(steps[0]!.text, /sanitize subjugation/);
    }

    assert.equal(steps[1]!.kind, "tool");
    if (steps[1]!.kind === "tool") {
      assert.equal(steps[1]!.toolName, "read_file");
      assert.equal(steps[1]!.status, "ok");
      assert.equal(steps[1]!.durationLabel, "1.5s");
      assert.match(steps[1]!.inputPreview ?? "", /notes\/sauron\.md/);
      assert.match(steps[1]!.outputPreview ?? "", /unshaped iron/);
    }
  });

  it("prevents cross-turn behindSteps leakage when filtering by cluster thread", () => {
    const events: NormalizedEvent[] = [
      // Turn 1: a2-morgoth thinks + runs a tool before sending a peer message to a3-questioner (NOT matching root<->a2-morgoth cluster!)
      {
        id: "ev-t1-think",
        ts: "2026-11-26T18:55:00.000Z",
        epoch: 1795719300,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "thinking_start",
        summary: "Turn 1 private thought for A3 peer ping",
      },
      {
        id: "ev-t1-tool",
        ts: "2026-11-26T18:55:01.000Z",
        epoch: 1795719301,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "tool_start",
        toolName: "grep_search",
        toolCallId: "tc-t1",
        summary: "Turn 1 grep before peer msg",
      },
      {
        id: "ev-t1-peer-msg",
        ts: "2026-11-26T18:55:02.000Z",
        epoch: 1795719302,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        targetAgentId: "a3-questioner",
        parentAgentId: "root",
        kind: "message",
        summary: "Peer ping to A3",
      },
      // Turn 2: a2-morgoth thinks + responds to root (DOES match cluster)
      {
        id: "ev-t2-think",
        ts: "2026-11-26T18:55:10.000Z",
        epoch: 1795719310,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "thinking_start",
        summary: "Turn 2 private thought for Coordinator",
      },
      {
        id: "ev-t2-msg",
        ts: "2026-11-26T18:55:12.000Z",
        epoch: 1795719312,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "a2-morgoth",
        parentAgentId: "root",
        kind: "message",
        summary: "Turn 2 reply to Coordinator",
      },
    ];

    const clusterThread: ThreadSelection = {
      key: "cluster:a2",
      kind: "cluster",
      clusterId: "a2",
      agentIds: ["a2-morgoth"],
      label: "A2 - Morgoth",
      route: "Coordinator ↔ A2 - Morgoth",
    };

    const entries = topologyGrouping.extractSmsStream({
      events,
      agents: makeAgents(),
      thread: clusterThread,
    });

    assert.equal(entries.length, 1);
    const msg = entries[0] as SmsMessageItem;
    assert.equal(msg.event.id, "ev-t2-msg");
    assert.equal(msg.behindSummary.thoughtCount, 1);
    assert.equal(msg.behindSummary.toolCount, 0, "Turn 1 tool must not leak into Turn 2");
    assert.equal(msg.behindSteps.length, 1);
    assert.equal(msg.behindSteps[0]!.event.id, "ev-t2-think");
  });

  it("treats blocked Antigravity notify_user messages as human questions (→ You / ASKED USER)", () => {
    const events: NormalizedEvent[] = [
      {
        id: "ev-notify-q",
        ts: "2026-11-26T18:55:20.000Z",
        epoch: 1795719320,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "root",
        agentLabel: "Coordinator",
        targetAgentId: "ext:human",
        kind: "message",
        toolName: "notify_user",
        summary: "Approve the rollout plan?",
        payload: {
          blockedOnUser: true,
          body: "Please confirm whether we should proceed with **Option A**.",
          options: [{ label: "Option A" }, { label: "Option B" }],
        },
      },
      {
        id: "ev-notify-ans",
        ts: "2026-11-26T18:55:25.000Z",
        epoch: 1795719325,
        ide: "antigravity",
        sessionId: "sess-1",
        agentId: "root",
        kind: "user_input",
        summary: "Option A",
        payload: {
          isHumanAnswer: true,
          body: "Option A",
        },
      },
    ];

    const entries = topologyGrouping.extractSmsStream({
      events,
      agents: makeAgents(),
      thread: ALL_THREAD,
    });

    const msgs = entries.filter((e): e is SmsMessageItem => e.kind === "message");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.routeLabel, "Coordinator → You");
    assert.equal(msgs[0]!.roleBadge, "Orchestrator · ASKED USER");
    assert.equal(msgs[0]!.questions?.[0]?.options.length, 2);
    assert.equal(msgs[0]!.chosenAnswerText, "Option A");
    assert.equal(msgs[1]!.replyToEntryId, "ev-notify-q");
    assert.equal(msgs[1]!.fromLabel, "You");
  });
});
