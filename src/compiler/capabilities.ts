import type { ResolvedRoleModel } from "../models/resolve.js";
import type {
  Capability,
  RosterEntry,
  WorkflowEnforcement,
} from "../schema/team.js";

const ORCHESTRATOR_FORBIDDEN_CAPABILITIES = new Set<Capability>([
  "edit",
  "write_docs",
  "edit_tests",
  "shell",
]);

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Resolves a role's effective capabilities after applying workflow enforcement.
 * When `orchestratorReadOnly` is true, edit/write/shell capabilities are always
 * stripped from `orchestrator` roles across all IDEs.
 */
export function resolveEffectiveCapabilities(
  role: RosterEntry,
  enforcement: WorkflowEnforcement,
): Capability[] {
  const caps = role.capabilities ?? [];
  if (enforcement.orchestratorReadOnly && role.roleType === "orchestrator") {
    return caps.filter((cap) => !ORCHESTRATOR_FORBIDDEN_CAPABILITIES.has(cap));
  }
  return [...caps];
}

export interface AntigravityToolMapping {
  tools: string[];
  inheritMcp: boolean;
}

export interface AntigravityMappingOptions {
  /**
   * When true (enforced for `orchestrator` roles under `orchestratorReadOnly`),
   * shell and write tools (`run_command`, `write_file`, `edit_file`) are
   * strictly withheld even when `search` is present. Orchestrators delegate
   * codebase search via `invoke_subagent` (e.g. built-in `research` or
   * specialists) rather than executing shell commands directly.
   */
  readOnly?: boolean;
}

const ANTIGRAVITY_READ_ONLY_FORBIDDEN_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
  "run_command",
]);

export function mapCapabilitiesToAntigravity(
  capabilities: Capability[],
  options?: AntigravityMappingOptions,
): AntigravityToolMapping {
  const tools: string[] = [];
  let inheritMcp = false;

  for (const cap of capabilities) {
    switch (cap) {
      case "read":
        tools.push("read_file");
        break;
      case "search":
        // Antigravity 2.0 does not expose legacy v1 IDE tools (grep_search,
        // find_by_name, list_dir, view_file_outline) and specifying unmapped
        // tool names in subagent frontmatter can hang execution. Native
        // Antigravity 2.0 agents—including the built-in `research` subagent—
        // pair `read_file` with `run_command` (rg / Select-String / Get-ChildItem)
        // for fast codebase search and directory discovery.
        tools.push("read_file");
        if (!options?.readOnly) {
          tools.push("run_command");
        }
        break;
      case "edit":
      case "write_docs":
      case "edit_tests":
        tools.push("write_file", "edit_file");
        break;
      case "shell":
        tools.push("run_command");
        break;
      case "delegate":
        tools.push(
          "invoke_subagent",
          "define_subagent",
          "manage_subagents",
          "send_message",
        );
        break;
      case "ask_user":
        tools.push("ask_question");
        break;
      case "mcp_board":
      case "mcp_testrun":
        inheritMcp = true;
        break;
    }
  }

  const deduped = dedupe(tools);
  return {
    tools: options?.readOnly
      ? deduped.filter((t) => !ANTIGRAVITY_READ_ONLY_FORBIDDEN_TOOLS.has(t))
      : deduped,
    inheritMcp,
  };
}

export function mapCapabilitiesToClaudeCode(
  capabilities: Capability[],
): string[] {
  const tools: string[] = [];

  for (const cap of capabilities) {
    switch (cap) {
      case "read":
        tools.push("Read");
        break;
      case "search":
        tools.push("Glob", "Grep");
        break;
      case "edit":
      case "write_docs":
      case "edit_tests":
        tools.push("Edit", "Write", "MultiEdit");
        break;
      case "shell":
        tools.push("Bash");
        break;
      case "delegate":
        tools.push("Agent");
        break;
      case "ask_user":
        tools.push("AskUserQuestion");
        break;
      case "mcp_board":
        tools.push("mcp__agent-studio__board", "mcp__agent-studio__projects");
        break;
      case "mcp_testrun":
        tools.push("mcp__agent-studio__testrun");
        break;
    }
  }

  return dedupe(tools);
}

export function mapCapabilitiesToCopilotVsCode(
  capabilities: Capability[],
): string[] {
  const tools: string[] = [];

  for (const cap of capabilities) {
    switch (cap) {
      case "read":
        tools.push("read/readFile");
        break;
      case "search":
        tools.push(
          "search/codebase",
          "search/textSearch",
          "search/fileSearch",
        );
        break;
      case "edit":
      case "write_docs":
      case "edit_tests":
        tools.push("edit/editFiles", "edit/createFile");
        break;
      case "shell":
        tools.push("execute/runInTerminal");
        break;
      case "delegate":
        tools.push("agent/runSubagent");
        break;
      case "ask_user":
        // VS Code Copilot uses native chat confirmation; no explicit tool entry required.
        break;
      case "mcp_board":
        tools.push("agent-studio/*");
        break;
      case "mcp_testrun":
        tools.push("agent-studio/testrun");
        break;
    }
  }

  return dedupe(tools);
}

export interface CopilotHandoff {
  label: string;
  agent: string;
  prompt: string;
  send: boolean;
  model?: string;
}

export interface BuildCopilotHandoffsOptions {
  includeModels?: boolean;
  resolvedByRoleId?:
    | Map<string, ResolvedRoleModel>
    | Record<string, ResolvedRoleModel>;
}

export function buildCopilotHandoffs(
  role: RosterEntry,
  roster: RosterEntry[],
  options?: BuildCopilotHandoffsOptions,
): CopilotHandoff[] {
  if (!role.handoffs || role.handoffs.length === 0) {
    return [];
  }

  const byId = new Map(roster.map((r) => [r.id, r]));
  const handoffs: CopilotHandoff[] = [];

  for (const targetId of role.handoffs) {
    const target = byId.get(targetId);
    const displayName = target ? target.name : targetId;
    const resolvedTarget =
      options?.resolvedByRoleId instanceof Map
        ? options.resolvedByRoleId.get(targetId)
        : options?.resolvedByRoleId?.[targetId];

    const includeModel =
      Boolean(options?.includeModels) &&
      resolvedTarget &&
      !resolvedTarget.omit &&
      resolvedTarget.policy !== "defer-to-host" &&
      Boolean(resolvedTarget.primaryModel);

    handoffs.push({
      label: `Delegate to ${displayName}`,
      agent: targetId,
      prompt: `Execute the assigned sprint item as ${displayName} (${targetId}) and update the agent-studio board when done.`,
      send: false,
      ...(includeModel ? { model: resolvedTarget!.primaryModel } : {}),
    });
  }

  return handoffs;
}
