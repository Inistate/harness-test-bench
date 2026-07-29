# Scenario Creation Policy

Rules for writing a new `src/scenarios/*.ts` file. Every scenario implements the `Scenario<TAssets>` interface in `src/types.ts`.

---

## 1. Two levels of setup/teardown

There are **global** (per model × run) and **per-task** (per task attempt) hooks. They nest like this:

```
global setup                         (once per model × run)
  task 1: setup → prompt → evaluate → verify → teardown
  task 2: setup → prompt → evaluate → verify → teardown
  ...
  task N: setup → prompt → evaluate → verify → teardown
global teardown                      (once per model × run)
```

- **Global `setup`** (`Scenario.setup`) creates run-level shared resources — typically modules (Technician, Issue, etc.) — and returns the initial `assets` object threaded through every task.
- **Per-task `setup`** (`Task.setup`) seeds that task's independent data (rows/entries) into `assets`, and may re-verify/reseed state left behind by a prior task (see `field-service-dispatch.ts` tasks 2–3, which re-check that earlier seeded issues are still in the expected state before proceeding).
- **Per-task `teardown`** (`Task.teardown`) always runs after the task attempt, including when setup, the model call, or verify throws. Use it to remove that task's own entries.
- **Global `teardown`** (`Scenario.teardown`) is meant to remove run-level shared resources (modules) after the model finishes all tasks.

### Caveat: put global teardown logic in the *last task's* teardown/verify, not in `Scenario.teardown`

`Scenario.teardown` only runs once per **scenario run**, not once per **model**. If you rely on it to delete modules, module cleanup won't happen between models in the same run — later models will see leftover state from earlier models.

Instead, do the module cleanup inside the **last task's** `teardown` (or `verify`, as `field-service-dispatch.ts` does today) so it fires once per model, right after that model finishes its tasks. Leave `Scenario.teardown` as a no-op:

```typescript
teardown: async (): Promise<void> => { /* cleanup handled in last task's teardown/verify */ },
```

This is exactly the pattern in `field-service-dispatch.ts`: task 4's `verify` deletes all Issue/Technician entries and then calls `ApiBridge.deleteModule` for both modules, so the workspace is clean before the next model's global `setup` runs.

---

## 2. Three levels of evaluation

Every task is checked at up to three levels, in order. Each level's failures are prefixed `Layer 1:` / `Layer 2:` / `Layer 3:` in the `issues` array so failure reports show which layer caught the problem.

| Layer | Where | What it checks |
| --- | --- | --- |
| **Layer 1 — Tool calling** | `evaluate()` | Did the agent call the *right tools at all*? (e.g. did it call `list_entries` on Issue before assigning; did it call `submit_activity` successfully) |
| **Layer 2 — Parameters** | `evaluate()` | Did it call those tools with the *right arguments*? (right activity name, right entry targeted, right technician picked, right field values) |
| **Layer 3 — API verify** | `verify()` (async, runs after `evaluate()`) | Does the **real** Inistate API state actually reflect the intended outcome? Fetches the entry/entries via `get_entry`/`list_entries` and checks state, assigned fields, etc. |

Layer 3 is the strongest signal: it catches cases where the agent called the right tool with the right-looking arguments but the API silently rejected the write, or the model's tool call result was misleading. Never skip `verify()` for tasks that write state — a task without it only proves the agent *said* the right thing, not that it *happened*.

`success` for the task is only `true` if all layers that ran returned no issues.

---

## 3. Scenario structure

A scenario file exports one object matching `Scenario<TAssets>` (`src/types.ts:153`):

```typescript
interface Scenario<TAssets> {
  id: string;
  name: string;
  description: string;
  system: string | ((assets: TAssets) => string);
  setup: (bridge: IBridge, workspaceId: string) => Promise<TAssets>;
  tasks: Task<TAssets>[];
  teardown: (bridge: IBridge, assets: TAssets) => Promise<void>;
}

interface Task<TAssets> {
  id: string;
  name: string;
  prompt: string | ((assets: TAssets) => string);
  evaluate: (toolCalls: ToolCall[], response: string, assets?: TAssets) => EvaluationResult;
  semanticCriteria?: string;   // LLM judge criteria — see section 4
  verify?: (bridge: IBridge, assets: TAssets, context?: TaskVerificationContext) => Promise<EvaluationResult>;
  maxSteps?: number;
  setup?: (bridge: IBridge, assets: TAssets) => Promise<void>;
  teardown?: (bridge: IBridge, assets: TAssets) => Promise<void>;
}
```

Conventions to follow, based on existing scenarios (`field-service-dispatch.ts`, `invoice-workflow.ts`, etc.):

1. **`TAssets` interface** — define one `interface XAssets { workspaceId: string; ...moduleIds; ...entryIds }` per scenario. Every id created in setup gets a field so later tasks/verify can reference it.
2. **`id`** — snake_case, unique across scenarios (e.g. `field_service_dispatch`).
3. **Header comment** — every scenario file opens with a 2–4 line comment: what it tests, the seed data shape, and a one-liner per task. This is the fastest way for a reader to understand the scenario without reading the whole file.
4. **`system` prompt** — states the workspace is active, lists available modules, states any domain rule the agent must apply (e.g. "a technician is busy if..."), and explicitly authorizes state changes so the agent doesn't stop to ask for human confirmation (`"resubmit the same call with confirmed: true"`).
5. **`prompt`** — plain natural-language instruction, no hardcoded entry IDs. The agent must look records up itself; don't hand it the answer.
6. **Helpers** — keep tool-result parsing helpers (`hasError`, `calledSuccessfully`, `getCreatedEntryId`, `getCreatedModuleId`, `findModuleByName`, etc.) local to the file unless truly shared, in which case they belong in `scenario-builder.ts`/a shared helpers module, not duplicated.
7. **`maxSteps`** — cap agent tool-call loops per task (20–25 is typical); prevents runaway loops from a confused model burning budget.
8. **Module creation is idempotent** — `setup` should call `list_modules`/`findModuleByName` first and only `create_module` if missing, so reruns against an existing workspace don't fail or duplicate.
9. **`module.exports = scenario`** at the end — this is how the runner auto-discovers scenario files; a plain ESM default export will not be picked up.

---

## 4. LLM judge vs. deterministic check — when to use which

There are two evaluation mechanisms available for Layer 1/2 checks, plus semantic (response-content) checks:

### Deterministic checks (`check-evaluator.ts::runChecks`, or inline `evaluate()` logic)

A declarative or hand-written check against `toolCalls` — tool name called, arguments matched, success/failure of a call. Syntax for declarative checks:

```
called:<tool>            tool was called at least once
not_called:<tool>        tool was NOT called
arg:<tool>.<arg>=<val>   an argument on any call to <tool> equals <val>
success:<tool>           tool was called and at least one call returned without error
```

**Use deterministic checks whenever the correct outcome is a fact you can string-match or structurally compare** — did it call `submit_activity` with `activity: "Assign"`; did it target the right entry ID; did it pick the technician you expect. This is the default for almost all Layer 1/2 checks in the existing scenarios (see the hand-rolled `evaluate()` functions in `field-service-dispatch.ts`) — cheap, deterministic, no extra API call, no judge-model variance.

### LLM judge (`llm-judge.ts::judge`, via `Task.semanticCriteria`)

Sends the task prompt, tool calls, and model response to a separate judge LLM (`DEFAULT_JUDGE_MODEL`, currently `deepseek/deepseek-v4-flash`) with a criteria string, and gets back `{ success, issues, hallucinated }`.

**Use the LLM judge only when correctness depends on open-ended natural-language content that can't be reduced to a string match** — e.g. "the response should reasonably explain *why* it picked this technician," or "the drafted resolution summary should mention the root cause and the still-outstanding fix," where the acceptable phrasing varies too much for `arg:`/`called:` checks to cover. Set `Task.semanticCriteria` to the natural-language criteria; the runner invokes the judge after deterministic checks in `evaluate()` pass.

**Rule of thumb:** try to express a check deterministically first. Reach for the LLM judge only for the subset of a task's success criteria that is genuinely about free-text response quality, not tool-call structure or API state — those two are always deterministic (Layer 1/2 in `evaluate()`, Layer 3 in `verify()`).
