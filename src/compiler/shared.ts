import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  buildWorkflowRoutingSummary,
  resolveRoleModel,
  type ResolvedRoleModel,
} from "../models/resolve.js";
import {
  DEFAULT_MODEL_INDEX,
  type ModelIndex,
} from "../schema/model-index.js";
import type { RosterEntry, TeamManifest } from "../schema/team.js";
import { normalizeLf } from "./merge.js";

export interface LoadedSkill {
  id: string;
  frontmatter?: string;
  body: string;
  raw: string;
}

export function splitFrontmatter(markdown: string): {
  frontmatter?: string;
  body: string;
} {
  const normalized = normalizeLf(markdown);
  if (!normalized.startsWith("---\n")) {
    return { body: normalized };
  }
  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    return { body: normalized };
  }
  const frontmatter = normalized.slice(4, endIdx).trim();
  const body = normalized.slice(endIdx + 5).replace(/^\n+/, "");
  return { frontmatter, body };
}

export function serializeFrontmatter(data: Record<string, unknown>): string {
  return stringifyYaml(data, { lineWidth: 0 }).trim();
}

function lstatSyncSafe(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

function resolveRealWithMissingTail(targetPath: string): string {
  let curr = path.resolve(targetPath);
  const missingTail: string[] = [];

  while (true) {
    const st = lstatSyncSafe(curr);
    if (st !== null) {
      if (st.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(curr);
          return missingTail.length > 0
            ? path.join(real, ...missingTail.reverse())
            : real;
        } catch (err) {
          throw new Error(
            `Symlink path cannot be resolved safely: ${curr} (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      const real = fs.realpathSync(curr);
      return missingTail.length > 0
        ? path.join(real, ...missingTail.reverse())
        : real;
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      return path.resolve(targetPath);
    }
    missingTail.push(path.basename(curr));
    curr = parent;
  }
}

export function assertContainedPath(
  baseDir: string,
  targetPath: string,
  label = "path",
): string {
  if (/[\x00-\x1f\x7f]/.test(targetPath)) {
    throw new Error(
      `Unsafe control characters in ${label}: ${JSON.stringify(targetPath)}`,
    );
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  ) {
    throw new Error(
      `Path traversal blocked for ${label}: "${targetPath}" escapes "${resolvedBase}"`,
    );
  }

  const realBase = resolveRealWithMissingTail(resolvedBase);
  const realTarget = resolveRealWithMissingTail(resolvedTarget);
  const realRel = path.relative(realBase, realTarget);
  if (
    !realRel ||
    realRel === ".." ||
    realRel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRel)
  ) {
    throw new Error(
      `Symlink escape blocked for ${label}: "${targetPath}" resolves outside "${resolvedBase}"`,
    );
  }

  return resolvedTarget;
}

export function readRolePrompt(
  projectRoot: string,
  role: RosterEntry,
): string {
  const agentTeamDir = assertContainedPath(
    projectRoot,
    ".agent-team",
    ".agent-team directory",
  );
  const promptPath = assertContainedPath(
    agentTeamDir,
    role.promptFile,
    "role.promptFile",
  );
  if (fs.existsSync(promptPath)) {
    const raw = fs.readFileSync(promptPath, "utf8");
    const { body } = splitFrontmatter(raw);
    return body.trim();
  }
  return `# ${role.name}\n\nYou are \`${role.id}\` (${role.roleType}, board role \`${role.boardRole}\`).\n`;
}

export function loadManifestSkills(
  projectRoot: string,
  manifest: TeamManifest,
): LoadedSkill[] {
  const agentTeamDir = assertContainedPath(
    projectRoot,
    ".agent-team",
    ".agent-team directory",
  );
  const loaded: LoadedSkill[] = [];
  for (const skillEntry of manifest.skills) {
    assertContainedPath(agentTeamDir, skillEntry, "skill directory");
    const normalizedSkill = skillEntry.replace(/\\/g, "/");
    const skillId = path.basename(normalizedSkill);
    const candidateFile = assertContainedPath(
      agentTeamDir,
      `${normalizedSkill}/SKILL.md`,
      "skill file",
    );
    if (!fs.existsSync(candidateFile)) {
      continue;
    }
    const raw = fs.readFileSync(candidateFile, "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    loaded.push({
      id: skillId,
      frontmatter,
      body: body.trim(),
      raw,
    });
  }
  return loaded;
}

function formatResolvedCell(resolved: ResolvedRoleModel): string {
  if (resolved.omit) {
    return resolved.ide === "copilot-vscode"
      ? "_omit (Fusion/Auto)_"
      : "_omit_";
  }
  const val = Array.isArray(resolved.frontmatterModel)
    ? `${resolved.primaryModel} (+${Math.max(0, resolved.frontmatterModel.length - 1)} fallback)`
    : resolved.primaryModel;
  return resolved.copilotPolicy
    ? `\`${val}\` (${resolved.copilotPolicy})`
    : `\`${val}\``;
}

export function renderSharedTeamRules(
  manifest: TeamManifest,
  modelIndex: ModelIndex = DEFAULT_MODEL_INDEX,
): string {
  const stages = manifest.workflow.stages.join(" -> ");
  const rosterLines = manifest.roster.map(
    (r) =>
      `- **\`${r.id}\`** (\`${r.boardRole}\` / ${r.roleType}): ${r.description ?? r.name}`,
  );
  const checkpointLines = Object.entries(manifest.workflow.checkpoints).map(
    ([cpId, cp]) =>
      `- **${cpId}** — ${cp.title}${cp.command ? ` (\`${cp.command}\`)` : ""}`,
  );

  const routingSummary = buildWorkflowRoutingSummary(manifest);
  const routingRows = manifest.roster.map((role) => {
    const agy = resolveRoleModel(manifest, role, "antigravity", modelIndex);
    const cc = resolveRoleModel(manifest, role, "claude-code", modelIndex);
    const vsc = resolveRoleModel(manifest, role, "copilot-vscode", modelIndex);
    return `| \`${role.id}\` | \`${agy.tier}\` | ${formatResolvedCell(agy)} | ${formatResolvedCell(cc)} | ${formatResolvedCell(vsc)} |`;
  });

  const guardrails: string[] = [];
  if (manifest.workflow.enforcement.orchestratorReadOnly) {
    guardrails.push(
      "- **Strict Orchestrator Boundary:** `orchestrator` is read-only (no edit/write/shell tools) and only manages the board and dispatches specialists.",
    );
  }
  if (manifest.workflow.enforcement.qaGateRequired) {
    guardrails.push(
      "- **QA Gate Required:** No item may transition `test -> done` without a closed, passing `testrun` recorded via the `agent-studio` MCP server.",
    );
  }
  if (manifest.workflow.enforcement.blockDirectBoardEdits) {
    guardrails.push(
      `- **Protected Board File:** Never hand-edit \`${manifest.workflow.boardPath}\`; use the \`agent-studio\` MCP \`board\` and \`testrun\` tools exclusively.`,
    );
  }

  return [
    `# ${manifest.project.title} — Agent Studio Team Rules`,
    "",
    `- **Project ID:** \`${manifest.project.id}\``,
    `- **Canonical Source:** \`.agent-team/team.yaml\` + \`.agent-team/model-index.json\` (edit only \`.agent-team/\`, then run \`agent-studio sync\`).`,
    `- **Lifecycle:** \`${stages}\``,
    `- **Board File:** \`${manifest.workflow.boardPath}\``,
    "",
    "## Guardrails",
    ...(guardrails.length > 0 ? guardrails : ["- Follow team workflow rules."]),
    "",
    "## Team Roster",
    ...rosterLines,
    "",
    "## Verification Checkpoints",
    ...(checkpointLines.length > 0
      ? checkpointLines
      : ["- Define verification checkpoints in `.agent-team/team.yaml`."]),
    "",
    "## Model Routing & Host Compatibility",
    `- **Policy:** \`${routingSummary.policy}\` (\`respectBuiltInOrchestrators: ${routingSummary.respectBuiltInOrchestrators}\`, \`allowSubagentModelHints: ${routingSummary.allowSubagentModelHints}\`, \`copilotHandoffModels: ${routingSummary.copilotHandoffModels}\`)`,
    "- **Antigravity (`/swarm` & UI Picker):** Pass `Model: \"inherit\"` (or omit model forcing) on `invoke_subagent` whenever `/swarm` or a user UI Model Selection override is active; otherwise use portable tier enums (`flash_lite`/`flash`/`pro`).",
    "- **Claude Code (`/model` & Env):** Frontmatter `model:` yields automatically to `CLAUDE_CODE_SUBAGENT_MODEL`, explicit `Agent` invocation `model` overrides, and session `/model`.",
    "- **VS Code Copilot (Fusion / Auto):** Uses `model-policy: preferred` (or omitted `model` on `defer-to-host`) so Copilot Fusion/Auto and user/org pickers are never blocked.",
    "",
    "| Role | Tier | Antigravity | Claude Code | Copilot / VS Code |",
    "| :--- | :--- | :--- | :--- | :--- |",
    ...routingRows,
    "",
    "## Token & Context Discipline (Core — All Agents)",
    "1. **Memory first:** Check workspace quickref skills (`*-quickref/SKILL.md`) and `AGENTS.md` before exploring; trust verified paths, endpoints, and commands.",
    "2. **Targeted reads:** Search first (`rg` / `Select-String`), then read narrow line ranges. Never dump whole large files, lockfiles, minified bundles, or huge JSON logs.",
    "3. **Cap output:** Pipe noisy commands through head/tail/limit filters (`Select-Object -First/-Last N`, `head`/`tail`, `--quiet`).",
    "4. **Batch calls:** Issue independent searches, reads, and edits in parallel in one turn; chain shell commands instead of one-call loops.",
    "5. **Delegate breadth:** For 5+ file surveys or transcript/log mining, delegate to a scoped subagent with an explicit word cap and output format.",
    "6. **Minimal edits:** Use small, surgical diffs; never rewrite whole files or re-read immediately after a clean edit.",
    "7. **No script sprawl:** Keep throwaway probes out of the repo; extend existing helpers rather than adding one-off scripts.",
    "8. **Concise replies:** Don't restate tool output or artifact contents; skip ceremony on simple tasks.",
    "9. **Persist learnings:** Record durable verified facts (working commands, quirks, endpoints, fixes) in workspace quickrefs; never store secrets.",
    "10. **Reuse subagent read-only checks:** Pass verified diagnostic/read-only findings forward into follow-on agent briefs instead of re-running redundant checks.",
    "11. **Context-budget handoff (`>= 55%` / `PreCompact`):** When context hits `55%` (or `PreCompact` fires), pause new exploration and run `board { op: \"handoff\", kind: \"fresh_context\" | \"task_split\", ... }`; `orchestrator` dispatches a fresh subagent via `board { op: \"show\", itemId }` or splits via `board { op: \"split\", itemId }`.",
  ].join("\n");
}
