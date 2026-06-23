# Jenkins CI Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-interactive `npm run ci` entry point driven by `BENCH_*` env vars, plus a JUnit XML writer so Jenkins can display test results natively.

**Architecture:** Two new files — `src/display/junit-writer.ts` (pure function, no side effects except writing the file) and `src/ci.ts` (thin wiring layer that reads `BENCH_*` env vars and calls the existing `runBenchmark()`). No changes to `benchmark-runner.ts` or `index.ts`.

**Tech Stack:** TypeScript, Node.js `fs`, `tsx` (already in devDependencies).

## Global Constraints

- Use `tsx` not `ts-node` — matches the existing `"start": "tsx src/index.ts"` script
- All new files follow CommonJS (`require`/`module.exports` not ES modules) — the project is `"type": "commonjs"`
- TypeScript strict — run `npm run typecheck` after every task
- No new dependencies — use only what is already in `package.json`

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/display/junit-writer.ts` | **Create** | Pure function: `ScenarioResult` map → JUnit XML file |
| `src/ci.ts` | **Create** | Entry point: read `BENCH_*` env vars, validate, call `runBenchmark()`, call `writeJUnit()` |
| `package.json` | **Modify** | Add `"ci": "tsx src/ci.ts"` to scripts |

---

### Task 1: `src/display/junit-writer.ts`

**Files:**
- Create: `src/display/junit-writer.ts`

**Interfaces:**
- Consumes: `ScenarioResult` (from `src/types.ts`), `Model` (from `src/types.ts`), `Scenario` (from `src/types.ts`)
- Produces: `writeJUnit(results, models, scenarios, outputPath)` — called by `ci.ts` in Task 2

---

- [ ] **Step 1: Create `src/display/junit-writer.ts`**

```typescript
import * as fs from "fs";
import * as path from "path";
import type { ScenarioResult, Model, Scenario } from "../types";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function writeJUnit(
  results: Record<string, ScenarioResult>,
  models: Model[],
  scenarios: Scenario[],
  outputPath: string
): void {
  const modelMap = new Map(models.map((m) => [m.id, m.name]));
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<testsuites>"];

  for (const [scenarioId, scenarioResult] of Object.entries(results)) {
    const scenario = scenarios.find((s) => s.id === scenarioId);
    const testcases: string[] = [];
    let totalTests = 0;
    let totalFailures = 0;
    let totalSkipped = 0;
    let totalTime = 0;

    for (const [modelId, runs] of Object.entries(scenarioResult.models)) {
      const modelName = modelMap.get(modelId) ?? modelId;
      const validRuns = runs.filter((r) => !r.skipped);

      if (validRuns.length === 0) {
        testcases.push(
          `    <testcase name="${escapeXml(`[${modelName}] (all runs skipped)`)}" classname="${escapeXml(scenarioId)}" time="0"><skipped/></testcase>`
        );
        totalTests++;
        totalSkipped++;
        continue;
      }

      const taskIds = new Set(validRuns.flatMap((r) => Object.keys(r.tasks)));

      for (const taskId of taskIds) {
        const taskResults = validRuns.map((r) => r.tasks[taskId]).filter(Boolean);
        if (taskResults.length === 0) continue;

        totalTests++;

        const taskName = scenario?.tasks.find((t) => t.id === taskId)?.name ?? taskId;
        const allSkipped = taskResults.every((t) => t.skipped);
        const anyFailed = taskResults.some((t) => !t.skipped && t.success === false);
        const avgLatency =
          taskResults.reduce((s, t) => s + (t.latency_ms ?? 0), 0) / taskResults.length;
        const allIssues = taskResults.flatMap((t) => t.issues ?? []);

        totalTime += avgLatency / 1000;

        const tcName = escapeXml(`[${modelName}] ${taskName}`);
        const tcClass = escapeXml(scenarioId);
        const tcTime = (avgLatency / 1000).toFixed(3);

        if (allSkipped) {
          testcases.push(
            `    <testcase name="${tcName}" classname="${tcClass}" time="${tcTime}"><skipped/></testcase>`
          );
          totalSkipped++;
        } else if (anyFailed) {
          const msg = escapeXml(allIssues.join("; "));
          testcases.push(
            `    <testcase name="${tcName}" classname="${tcClass}" time="${tcTime}"><failure message="${msg}"/></testcase>`
          );
          totalFailures++;
        } else {
          testcases.push(
            `    <testcase name="${tcName}" classname="${tcClass}" time="${tcTime}"/>`
          );
        }
      }
    }

    lines.push(
      `  <testsuite name="${escapeXml(scenarioResult.scenario)}" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${totalTime.toFixed(3)}">`
    );
    lines.push(...testcases);
    lines.push("  </testsuite>");
  }

  lines.push("</testsuites>");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/display/junit-writer.ts
git commit -m "feat: add JUnit XML writer for CI result publishing"
```

---

### Task 2: `src/ci.ts` + `package.json` script

**Files:**
- Create: `src/ci.ts`
- Modify: `package.json` — add `"ci"` script

**Interfaces:**
- Consumes: `writeJUnit` from `src/display/junit-writer.ts` (Task 1), `loadModels` from `src/data/models.ts`, `runBenchmark` from `src/core/benchmark-runner.ts`
- Produces: process exit code 0 (all tasks passed) or 1 (any failure or misconfiguration)

---

- [ ] **Step 1: Create `src/ci.ts`**

```typescript
import * as fs from "fs";
import * as path from "path";

require("dotenv").config({ path: path.join(__dirname, "../.env") });

import { loadModels } from "./data/models";
import { runBenchmark } from "./core/benchmark-runner";
import { writeJUnit } from "./display/junit-writer";
import type { McpEnv, Scenario } from "./types";

const DEFAULT_API_URL = "https://app02.apps.inistate.com";

function getDefaultMcpPath(): string {
  return path.join(process.env.HOME ?? "", "Documents/inistate-mcp/build/index.js");
}

// ── Auto-discover hardcoded scenarios (same pattern as index.ts) ──────────────
const scenariosDir = path.join(__dirname, "scenarios");
const ALL_SCENARIOS: Scenario[] = fs
  .readdirSync(scenariosDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => require(path.join(scenariosDir, f)) as unknown)
  .filter((m): m is Scenario => typeof (m as Record<string, unknown>)?.id === "string");

interface CiEnv {
  scenarioIds: string[];
  modelIds: string[];
  workspaceId: string;
  runs: number;
  junitOutput: string;
  openRouterKey: string;
  mcpPath: string;
  mcpEnv: McpEnv;
}

function readAndValidateEnv(): CiEnv {
  const errors: string[] = [];

  const rawScenarios = process.env.BENCH_SCENARIOS?.trim();
  const rawModels    = process.env.BENCH_MODELS?.trim();
  const rawWorkspace = process.env.BENCH_WORKSPACE_ID?.trim();
  const rawRuns      = process.env.BENCH_RUNS?.trim() ?? "1";

  if (!rawScenarios) errors.push("BENCH_SCENARIOS is required");
  if (!rawModels)    errors.push("BENCH_MODELS is required");
  if (!rawWorkspace) errors.push("BENCH_WORKSPACE_ID is required");

  const openRouterKey  = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  const inistateToken  = (process.env.INISTATE_API_TOKEN ?? process.env.INISTATE_API_KEY ?? "").trim();
  const inistateUrl    = process.env.INISTATE_API_URL?.trim() ?? DEFAULT_API_URL;
  const mcpPath        = process.env.INISTATE_MCP_PATH?.trim() ?? getDefaultMcpPath();

  if (!openRouterKey)  errors.push("OPENROUTER_API_KEY is required");
  if (!inistateToken)  errors.push("INISTATE_API_TOKEN is required");

  const runs = Number.parseInt(rawRuns, 10);
  if (!Number.isInteger(runs) || runs < 1)
    errors.push(`BENCH_RUNS must be a positive integer, got "${rawRuns}"`);

  if (!fs.existsSync(mcpPath))
    errors.push(`MCP server not found at: ${mcpPath} — set INISTATE_MCP_PATH`);

  if (errors.length > 0) {
    console.error("\n❌ CI runner configuration errors:");
    errors.forEach((e) => console.error(`   - ${e}`));
    process.exit(1);
  }

  return {
    scenarioIds:  rawScenarios!.split(",").map((s) => s.trim()).filter(Boolean),
    modelIds:     rawModels!.split(",").map((m) => m.trim()).filter(Boolean),
    workspaceId:  rawWorkspace!,
    runs,
    junitOutput:  process.env.BENCH_JUNIT_OUTPUT?.trim() ?? path.join(__dirname, "../results/report.xml"),
    openRouterKey,
    mcpPath,
    mcpEnv: {
      INISTATE_API_TOKEN:   inistateToken,
      INISTATE_API_URL:     inistateUrl,
      INISTATE_WORKSPACE_ID: "",
      INISTATE_MCP_MODE:    "configure",
    },
  };
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║     Inistate TestBench — CI Mode     ║");
  console.log("╚══════════════════════════════════════╝\n");

  const env = readAndValidateEnv();

  // Validate scenario IDs before hitting OpenRouter
  const unknownScenarios = env.scenarioIds.filter(
    (id) => !ALL_SCENARIOS.some((s) => s.id === id)
  );
  if (unknownScenarios.length > 0) {
    console.error(`\n❌ Unknown scenario IDs: ${unknownScenarios.join(", ")}`);
    console.error(`   Available: ${ALL_SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  // Fetch live model catalogue and validate model IDs
  process.stdout.write("Fetching live model prices from OpenRouter... ");
  const allModels = await loadModels(env.openRouterKey);
  console.log("done");

  const unknownModels = env.modelIds.filter((id) => !allModels.some((m) => m.id === id));
  if (unknownModels.length > 0) {
    console.error(`\n❌ Unknown model IDs: ${unknownModels.join(", ")}`);
    console.error(`   Check available models at https://openrouter.ai/models`);
    process.exit(1);
  }

  const selectedScenarios = ALL_SCENARIOS.filter((s) => env.scenarioIds.includes(s.id));
  const selectedModels    = allModels.filter((m) => env.modelIds.includes(m.id));
  const scenarioWorkspaces = Object.fromEntries(
    selectedScenarios.map((s) => [s.id, env.workspaceId])
  );

  console.log(
    `📋 ${selectedScenarios.length} scenario(s) | 🤖 ${selectedModels.length} model(s) | 🔄 ${env.runs} run(s)`
  );

  const results = await runBenchmark({
    scenarios: selectedScenarios,
    models: selectedModels,
    runs: env.runs,
    mcpPath: env.mcpPath,
    mcpEnv: env.mcpEnv,
    openRouterKey: env.openRouterKey,
    logReasoning: false,
    scenarioWorkspaces,
  });

  writeJUnit(results, selectedModels, selectedScenarios, env.junitOutput);
  console.log(`\nJUnit results → ${env.junitOutput}`);

  const anyFailed = Object.values(results).some((sr) =>
    Object.values(sr.models).some((runs) =>
      runs.some((r) => !r.skipped && r.score < r.total)
    )
  );

  process.exit(anyFailed ? 1 : 0);
}

main().catch((e: Error) => {
  console.error("\n❌ Fatal error:", e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add `ci` script to `package.json`**

In `package.json`, add one line to the `"scripts"` block:

```json
"scripts": {
  "start": "tsx src/index.ts",
  "ci": "tsx src/ci.ts",
  "typecheck": "tsc --noEmit",
  "visualise": "tsx src/display/results-visualiser.ts",
  "analyse": "tsx src/display/results-analyser.ts",
  "merge": "tsx src/display/merge-results.ts"
},
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Smoke-test the validation path (no credentials needed)**

```bash
npm run ci
```

Expected output:
```
❌ CI runner configuration errors:
   - BENCH_SCENARIOS is required
   - BENCH_MODELS is required
   - BENCH_WORKSPACE_ID is required
   - OPENROUTER_API_KEY is required
   - INISTATE_API_TOKEN is required
```
Process exits with code 1. This confirms the entry point runs and validation fires correctly before any network call.

- [ ] **Step 5: Commit**

```bash
git add src/ci.ts package.json
git commit -m "feat: add non-interactive CI runner with BENCH_* env vars and JUnit output"
```

---

## Self-Review

**Spec coverage:**
- [x] `BENCH_SCENARIOS`, `BENCH_MODELS`, `BENCH_WORKSPACE_ID`, `BENCH_RUNS` — Task 2, `readAndValidateEnv()`
- [x] `BENCH_JUNIT_OUTPUT` override — Task 2, `readAndValidateEnv()`
- [x] Existing credentials (`OPENROUTER_API_KEY`, `INISTATE_API_TOKEN`, `INISTATE_MCP_PATH`) still resolved — Task 2
- [x] Unknown scenario IDs fail fast before OpenRouter call — Task 2
- [x] Unknown model IDs fail fast after model fetch — Task 2
- [x] `writeJUnit` — pure function in `src/display/junit-writer.ts` — Task 1
- [x] JUnit mapping: scenario → `<testsuite>`, model×task → `<testcase>`, issues → `<failure>`, skipped → `<skipped/>` — Task 1
- [x] XML escaping for `&`, `<`, `>`, `"` — Task 1, `escapeXml()`
- [x] `"ci": "tsx src/ci.ts"` in `package.json` — Task 2, Step 2
- [x] Non-zero exit code when any task fails — Task 2, `process.exit(anyFailed ? 1 : 0)`
- [x] File structure: `src/display/junit-writer.ts`, `src/ci.ts` — matches spec Section 5

**Type consistency:**
- `writeJUnit(results, models, scenarios, outputPath)` — defined in Task 1, called identically in Task 2
- `ScenarioResult`, `Model`, `Scenario`, `McpEnv` — all imported from `src/types.ts`, unchanged
- `loadModels`, `runBenchmark` — existing functions, signatures unchanged
