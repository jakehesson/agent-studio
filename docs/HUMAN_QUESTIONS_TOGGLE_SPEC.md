# Orchestrator Human Questions Toggle & Canonical ask_human Spec (S1-81)

Implementation specification for toggling between Studio-direct human questions (`ask_human` via MCP/LM tool) and native IDE question dialogs across Antigravity, Claude Code, and VS Code Copilot.

---

## 1. Schema & Configuration

### `src/schema/team.ts`
Define enum and extend `WorkflowConfigSchema`:
```ts
export const HumanQuestionsModeSchema = z.enum(["studio-mcp", "native-ide"]);
export type HumanQuestionsMode = z.infer<typeof HumanQuestionsModeSchema>;
```
In `WorkflowConfigSchema`:
```ts
humanQuestions: HumanQuestionsModeSchema.default("studio-mcp"),
```
In `.agent-team/team.yaml`:
```yaml
workflow:
  humanQuestions: studio-mcp
```

### Telemetry & View Models
- `src/telemetry/definitions.ts`: Add `humanQuestions?: HumanQuestionsMode` to `TeamDetails.workflow` and map `manifest?.workflow.humanQuestions ?? "studio-mcp"` in `discoverTeamDetails()`.
- `web/src/types.ts`: Add `humanQuestions?: "studio-mcp" | "native-ide"` to `TeamDetailsResponse.workflow`.

---

## 2. Compiler & Prompt Templates

### `src/compiler/shared.ts` (`renderSharedTeamRules`)
Update the `Human Questions` guardrail based on `manifest.workflow.humanQuestions`:
- **`studio-mcp` (default)**:
  Emit strict guardrail: NEVER use native ask tools (`ask_question`, `vscode_askquestions`, `AskUserQuestion`). ALWAYS call `ask_human` via `call_mcp_tool` (ServerName `${manifest.project.id}-team_agent-studio`, ToolName `"ask_human"`) or `agent_studio_ask_human` in VS Code so users answer in Studio Messages UI. Subagents must be granted `EnableMCPTools: true` or return questions to the Coordinator.
- **`native-ide`**:
  Emit native rule: Agents must use native host IDE question dialogs (`ask_question` in Antigravity, `vscode_askQuestions` in VS Code, `AskUserQuestion` in Claude Code) for interactive questions and approvals.

### `src/templates/manifest.ts` & `src/templates/prompts.ts`
- `createTeamManifestTemplate()`: Set default `workflow.humanQuestions: "studio-mcp"`.
- `renderOrchestratorPrompt()`: Conditionally render the Human Questions section reflecting `studio-mcp` vs `native-ide` instructions.

### `src/cli/commands/hook-emit.ts`
In `preToolUse` hook for `vscode_askquestions`:
```ts
if (
  !denyReason &&
  lowTool === "vscode_askquestions" &&
  manifest?.workflow?.humanQuestions !== "native-ide" &&
  process.env.AGENT_STUDIO_DISABLE_ASK_REDIRECT !== "1"
) { ... }
```
When `manifest.workflow.humanQuestions === "native-ide"`, bypass redirection and allow native VS Code questions.

---

## 3. Server API & CLI Commands

### HTTP Server (`src/server/http-server.ts`)
- Extend `PatchTeamRoutingSchema`:
  ```ts
  workflow: z.object({
    policy: ModelRoutingPolicySchema.optional(),
    respectBuiltInOrchestrators: z.boolean().optional(),
    allowSubagentModelHints: z.boolean().optional(),
    copilotHandoffModels: z.boolean().optional(),
    humanQuestions: HumanQuestionsModeSchema.optional(),
    idePolicies: ...
  }).optional(),
  ```
- In `PATCH /api/team/routing`: inside `withTeamYamlLock`, update `manifest.workflow.humanQuestions = input.workflow.humanQuestions` when provided, then run `compileTeam` if `sync !== false`.

### CLI Command (`src/cli/commands/models.ts` & `src/cli/index.ts`)
Add command `agent-studio models set-questions <studio-mcp|native-ide> [--sync]`:
- Validates argument against `HumanQuestionsModeSchema`.
- Applies update via `withTeamYamlLock(teamYamlPath, ...)`.
- Recompiles IDE configs via `compileTeam(projectRoot)` when `--sync` is true.

---

## 4. Web Studio UI (`web/src/views/Team.ts`, `web/src/api.ts`)

### `web/src/api.ts`
Extend `patchTeamRouting` payload type:
```ts
workflow?: Partial<WorkflowModelRouting> & {
  humanQuestions?: "studio-mcp" | "native-ide";
};
```

### `web/src/views/Team.ts`
- In `renderModelRoutingBar(team)` and/or Orchestrator roster card:
  Render a segmented button / pill group:
  ```html
  <div class="mr-field">
    <label>Human Questions</label>
    <div class="pill-toggle-group" role="group" aria-label="Human Questions Mode">
      <button type="button" class="pill-btn ${mode === 'studio-mcp' ? 'active' : ''}" data-action="set-human-questions" data-mode="studio-mcp">Studio Direct (ask_human)</button>
      <button type="button" class="pill-btn ${mode === 'native-ide' ? 'active' : ''}" data-action="set-human-questions" data-mode="native-ide">Native IDE</button>
    </div>
  </div>
  ```
- On click: call `patchTeamRouting({ workflow: { humanQuestions: newMode }, sync: true })`.
- In MCP App mode (`this.embedScope.mcpAppMode`): render as read-only badge with CLI copy hint: `agent-studio models set-questions native-ide --sync`.
- Ergonomics: Support Galaxy Z Fold 7 closed cover screen (`< 640px`) via full-width stacked pills (`100%` width, `min-height: 44px` touch target) and unfolded/desktop (`>= 640px`) via inline button row.

---

## 5. Unit Test Requirements

### `tests/unit/schema.test.ts`
1. Validate `WorkflowConfigSchema` defaults `humanQuestions` to `"studio-mcp"`.
2. Validate parsing accepts `"studio-mcp"` and `"native-ide"`, rejecting invalid enum strings.
3. Test round-trip serialization of `team.yaml` preserving `workflow.humanQuestions`.

### `tests/unit/compiler.test.ts`
1. Verify `renderSharedTeamRules` outputs strict `ask_human` MCP guardrail when `humanQuestions: "studio-mcp"`.
2. Verify `renderSharedTeamRules` outputs native IDE tools instruction (`ask_question`, `vscode_askQuestions`, `AskUserQuestion`) when `humanQuestions: "native-ide"`.
3. Verify `renderOrchestratorPrompt` aligns with active `humanQuestions` mode.
4. Verify `createTeamManifestTemplate` includes `humanQuestions: "studio-mcp"`.

### `tests/unit/chat-and-prompts.test.ts`
1. Hook emission: verify `vscode_askquestions` is NOT denied/redirected in `preToolUse` when `workflow.humanQuestions === "native-ide"`, even when `/api/health` reports `hasActiveUi: true`.
2. Hook emission: verify `vscode_askquestions` IS redirected to `agent_studio_ask_human` when `workflow.humanQuestions === "studio-mcp"` and UI is active.

### `tests/unit/server.test.ts` & `tests/unit/model-routing.test.ts`
1. `PATCH /api/team/routing` updates `team.yaml` with `workflow.humanQuestions: "native-ide"` and triggers IDE sync.
2. CLI `agent-studio models set-questions <mode> --sync` updates file and recompiles without drift.
