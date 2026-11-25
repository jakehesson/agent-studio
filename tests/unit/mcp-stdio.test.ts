import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initBoardFile } from "../../src/board/store.js";
import { NormalizedEventSchema } from "../../src/schema/telemetry.js";

const CLI_ENTRY = path.resolve(process.cwd(), "dist", "cli", "index.js");

interface JsonRpcResponseMsg {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class StdioMcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderrChunks: string[] = [];
  readonly rawStdoutLines: string[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (msg: JsonRpcResponseMsg) => void; reject: (err: Error) => void }
  >();
  private nextId = 1;

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
    });

    const rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.rawStdoutLines.push(trimmed);
      let msg: JsonRpcResponseMsg;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponseMsg;
      } catch (err) {
        for (const entry of this.pending.values()) {
          entry.reject(
            new Error(`Non-JSON line written to stdout: ${trimmed} (${String(err)})`),
          );
        }
        this.pending.clear();
        return;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        entry?.resolve(msg);
      }
    });
  }

  request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponseMsg> {
    const id = this.nextId++;
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timeout waiting for MCP response to ${method}. stderr=${this.stderrChunks.join("")}`,
          ),
        );
      }, 8_000);

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(frame + "\n");
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
    this.child.stdin.write(frame + "\n");
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) {
        resolve(this.child.exitCode);
        return;
      }
      this.child.once("exit", (code) => resolve(code));
    });
  }
}

describe("MCP stdio server (node dist/cli/index.js mcp)", () => {
  let tmpDir: string;
  let projDir: string;
  let studioHome: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "av-mcp-stdio-"));
    projDir = path.join(tmpDir, "mcp-demo");
    studioHome = path.join(tmpDir, "studio-home");
    await initBoardFile(path.join(projDir, "pipeline", "board.json"), {
      projectId: "mcp-demo",
      suites: { smoke: ["CP0", "CP1"], full: ["CP0", "CP1", "CP2"] },
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("handles initialize, tools/list, tools/call (with QA Gate), and writes telemetry.jsonl", async () => {
    const client = new StdioMcpClient(["mcp", "--project", projDir], {
      ...process.env,
      AGENT_STUDIO_HOME: studioHome,
    });

    try {
      // 1. initialize
      const initResp = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "unit-test", version: "1.0.0" },
      });
      assert.equal(initResp.error, undefined);
      assert.equal(initResp.result?.protocolVersion, "2024-11-05");
      assert.deepEqual(initResp.result?.capabilities, {
        tools: {},
        resources: {},
      });
      const rootPkg = JSON.parse(
        await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8"),
      ) as { version: string };
      assert.deepEqual(initResp.result?.serverInfo, {
        name: "agent-studio",
        version: rootPkg.version,
      });

      // 2. notifications/initialized (must produce no response)
      client.notify("notifications/initialized");

      // 3. tools/list (includes core + SEP-1865 MCP App tools with _meta)
      const listResp = await client.request("tools/list");
      assert.equal(listResp.error, undefined);
      const tools = listResp.result?.tools as Array<{
        name: string;
        _meta?: Record<string, unknown>;
      }>;
      assert.deepEqual(
        tools.map((t) => t.name),
        [
          "projects",
          "board",
          "testrun",
          "telemetry",
          "open_studio",
          "app_get_state",
          "app_get_board",
          "app_get_team",
          "app_get_doctor",
          "app_send_test_event",
        ],
      );

      const openStudioTool = tools.find((t) => t.name === "open_studio");
      assert.ok(openStudioTool?._meta, "open_studio must include _meta");
      assert.deepEqual(openStudioTool._meta?.ui, {
        resourceUri: "ui://agent-studio/app.html",
      });
      assert.deepEqual(openStudioTool._meta?.["com.google.antigravity/ui"], {
        entrypoints: [
          { type: "aux_pane", title: "Agent Studio" },
          { type: "global", title: "Agent Studio" },
        ],
      });

      for (const appOnlyName of [
        "app_get_state",
        "app_get_board",
        "app_get_team",
        "app_get_doctor",
        "app_send_test_event",
      ]) {
        const tool = tools.find((t) => t.name === appOnlyName);
        assert.deepEqual(tool?._meta?.ui, { visibility: ["app"] });
      }

      // 3b. resources/list & resources/read (SEP-1865 MCP App UI resource)
      const resListResp = await client.request("resources/list");
      assert.equal(resListResp.error, undefined);
      const resources = resListResp.result?.resources as Array<{
        uri: string;
        mimeType: string;
        _meta?: Record<string, unknown>;
      }>;
      assert.equal(resources.length, 1);
      assert.equal(resources[0]?.uri, "ui://agent-studio/app.html");
      assert.equal(resources[0]?.mimeType, "text/html;profile=mcp-app");
      assert.deepEqual(resources[0]?._meta?.ui, { prefersBorder: false });

      const resReadResp = await client.request("resources/read", {
        uri: "ui://agent-studio/app.html",
      });
      assert.equal(resReadResp.error, undefined);
      const contents = resReadResp.result?.contents as Array<{
        uri: string;
        mimeType: string;
        text: string;
      }>;
      assert.equal(contents.length, 1);
      assert.equal(contents[0]?.uri, "ui://agent-studio/app.html");
      assert.equal(contents[0]?.mimeType, "text/html;profile=mcp-app");
      assert.match(contents[0]?.text ?? "", /<!doctype html/i);
      assert.ok(
        Buffer.byteLength(contents[0]?.text ?? "", "utf8") < 10 * 1024 * 1024,
      );

      // 3c. open_studio works cleanly with empty {} arguments and returns compact structuredContent
      const openResp = await client.request("tools/call", {
        name: "open_studio",
        arguments: {},
      });
      const openRes = openResp.result as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      assert.notEqual(openRes.isError, true);
      assert.equal(openRes.structuredContent?.view, "studio");
      assert.equal(openRes.structuredContent?.ide, "antigravity");
      assert.equal(openRes.structuredContent?.version, rootPkg.version);
      assert.ok(
        Buffer.byteLength(JSON.stringify(openRes.structuredContent), "utf8") <
          4096,
      );

      // 4. projects register & list
      const regResp = await client.request("tools/call", {
        name: "projects",
        arguments: { op: "register", root: projDir, id: "mcp-demo", setDefault: true },
      });
      const regResult = regResp.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.notEqual(regResult.isError, true);
      assert.match(regResult.content[0]?.text ?? "", /registered mcp-demo/);

      // 5. board add -> move dev -> move test
      const addResp = await client.request("tools/call", {
        name: "board",
        arguments: {
          op: "add",
          type: "story",
          title: "MCP stdio test story",
          role: "backend",
          actor: "orchestrator",
        },
      });
      const addText = (addResp.result as { content: Array<{ text: string }> })
        .content[0]?.text;
      assert.match(addText ?? "", /S1-01/);

      await client.request("tools/call", {
        name: "board",
        arguments: { op: "move", itemId: "S1-01", state: "dev", actor: "backend" },
      });
      await client.request("tools/call", {
        name: "board",
        arguments: {
          op: "move",
          itemId: "S1-01",
          state: "test",
          actor: "backend",
          note: "ready for QA",
        },
      });

      // 6. Attempt test -> done WITHOUT passing testrun -> MUST be rejected by QA Gate
      const blockedResp = await client.request("tools/call", {
        name: "board",
        arguments: {
          op: "move",
          itemId: "S1-01",
          state: "done",
          actor: "qa",
        },
      });
      const blockedResult = blockedResp.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.equal(blockedResult.isError, true);
      assert.match(blockedResult.content[0]?.text ?? "", /QA Gate rejected/);

      // 7. Run passing smoke testrun via MCP testrun tool
      const startResp = await client.request("tools/call", {
        name: "testrun",
        arguments: { op: "start", suite: "smoke", build: "b1", actor: "qa" },
      });
      assert.match(
        (startResp.result as { content: Array<{ text: string }> }).content[0]
          ?.text ?? "",
        /TR-001 started/,
      );

      await client.request("tools/call", {
        name: "testrun",
        arguments: {
          op: "record",
          runId: "TR-001",
          checkpoint: "CP0",
          result: "pass",
          note: "check ok",
        },
      });
      await client.request("tools/call", {
        name: "testrun",
        arguments: {
          op: "record",
          runId: "TR-001",
          checkpoint: "CP1",
          result: "pass",
          note: "integration ok",
        },
      });
      const closeResp = await client.request("tools/call", {
        name: "testrun",
        arguments: { op: "close", runId: "TR-001" },
      });
      assert.match(
        (closeResp.result as { content: Array<{ text: string }> }).content[0]
          ?.text ?? "",
        /TR-001 passed/,
      );

      // 8. Retry test -> done AFTER passing testrun -> MUST succeed
      const doneResp = await client.request("tools/call", {
        name: "board",
        arguments: {
          op: "move",
          itemId: "S1-01",
          state: "done",
          actor: "qa",
          note: "all checks green",
        },
      });
      const doneResult = doneResp.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.notEqual(doneResult.isError, true);
      assert.match(doneResult.content[0]?.text ?? "", /S1-01 \[done\]/);

      // 9. Explicit telemetry handoff
      const telResp = await client.request("tools/call", {
        name: "telemetry",
        arguments: {
          op: "handoff",
          agentId: "orchestrator",
          targetAgentId: "qa-validator",
          summary: "Handed off S1-01 for QA",
        },
      });
      const telResult = telResp.result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.notEqual(telResult.isError, true);

      // 10. Verify telemetry.jsonl contains valid NormalizedEvent entries
      const telemetryPath = path.join(projDir, ".agent-studio", "telemetry.jsonl");
      const rawLines = (await fs.readFile(telemetryPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      assert.ok(rawLines.length >= 8, `expected >=8 telemetry events, got ${rawLines.length}`);
      const parsedEvents = rawLines.map((line) =>
        NormalizedEventSchema.parse(JSON.parse(line)),
      );
      assert.ok(parsedEvents.some((e) => e.kind === "board_mutation"));
      assert.ok(
        parsedEvents.some(
          (e) =>
            e.kind === "message" &&
            e.payload?.type === "handoff" &&
            e.payload?.to === "qa-validator",
        ),
      );

      // 10b. Verify app-only data bridges (app_get_board, app_get_team, app_get_doctor, app_send_test_event, app_get_state)
      const appBoardResp = await client.request("tools/call", {
        name: "app_get_board",
        arguments: { project: "mcp-demo" },
      });
      const appBoardRes = appBoardResp.result as {
        isError?: boolean;
        structuredContent?: { project?: { id: string }; board?: { items: unknown[] } };
      };
      assert.notEqual(appBoardRes.isError, true);
      assert.equal(appBoardRes.structuredContent?.project?.id, "mcp-demo");
      assert.ok(Array.isArray(appBoardRes.structuredContent?.board?.items));

      const appTeamResp = await client.request("tools/call", {
        name: "app_get_team",
        arguments: { workspace: projDir },
      });
      const appTeamRes = appTeamResp.result as {
        isError?: boolean;
        structuredContent?: { definitions?: unknown[]; skills?: unknown[] };
      };
      assert.notEqual(appTeamRes.isError, true);
      assert.ok(Array.isArray(appTeamRes.structuredContent?.definitions));
      assert.ok(Array.isArray(appTeamRes.structuredContent?.skills));

      const appDocResp = await client.request("tools/call", {
        name: "app_get_doctor",
        arguments: { workspace: projDir },
      });
      const appDocRes = appDocResp.result as {
        isError?: boolean;
        structuredContent?: { nodeVersion?: string; adapters?: unknown[]; doctor?: Record<string, unknown> };
      };
      assert.notEqual(appDocRes.isError, true);
      assert.ok(typeof appDocRes.structuredContent?.nodeVersion === "string");
      assert.ok(Array.isArray(appDocRes.structuredContent?.adapters));
      assert.ok(appDocRes.structuredContent?.doctor);

      const appProbeResp = await client.request("tools/call", {
        name: "app_send_test_event",
        arguments: { ide: "antigravity", project: "mcp-demo", summary: "MCP App probe" },
      });
      const appProbeRes = appProbeResp.result as {
        isError?: boolean;
        structuredContent?: { ok?: boolean; accepted?: number };
      };
      assert.notEqual(appProbeRes.isError, true);
      assert.equal(appProbeRes.structuredContent?.ok, true);
      assert.equal(appProbeRes.structuredContent?.accepted, 1);

      const appStateResp = await client.request("tools/call", {
        name: "app_get_state",
        arguments: { ide: "antigravity", session: "doctor-probe" },
      });
      const appStateRes = appStateResp.result as {
        isError?: boolean;
        structuredContent?: { sessions?: unknown[]; board_projects?: unknown[]; events?: unknown[] };
      };
      assert.notEqual(appStateRes.isError, true);
      assert.ok(Array.isArray(appStateRes.structuredContent?.sessions));
      assert.ok(Array.isArray(appStateRes.structuredContent?.board_projects));
      assert.ok((appStateRes.structuredContent?.events?.length ?? 0) >= 1);

      // 11. Verify every single line on stdout was valid JSON-RPC 2.0
      for (const line of client.rawStdoutLines) {
        const obj = JSON.parse(line) as { jsonrpc: string };
        assert.equal(obj.jsonrpc, "2.0");
      }
    } finally {
      const exitCode = await client.close();
      assert.equal(exitCode, 0, `MCP server exited with ${String(exitCode)}; stderr=${client.stderrChunks.join("")}`);
    }
  });
});
