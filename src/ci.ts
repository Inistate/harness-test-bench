import * as fs from "fs";
import * as path from "path";

require("dotenv").config({ path: path.join(__dirname, "../.env") });

import { loadModels } from "./data/models";
import { runBenchmark } from "./core/benchmark-runner";
import { DEFAULT_JUDGE_MODEL } from "./core/llm-judge";
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
  judgeModel: string;
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

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  const inistateToken = (process.env.INISTATE_API_TOKEN ?? process.env.INISTATE_API_KEY ?? "").trim();
  const inistateUrl   = process.env.INISTATE_API_URL?.trim() ?? DEFAULT_API_URL;
  const mcpPath       = process.env.INISTATE_MCP_PATH?.trim() ?? getDefaultMcpPath();

  if (!openRouterKey) errors.push("OPENROUTER_API_KEY is required");
  if (!inistateToken) errors.push("INISTATE_API_TOKEN is required");

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
    judgeModel: process.env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL,
    mcpPath,
    mcpEnv: {
      INISTATE_API_TOKEN:    inistateToken,
      INISTATE_API_URL:      inistateUrl,
      INISTATE_WORKSPACE_ID: "",
      INISTATE_MCP_MODE:     "configure",
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
  const usesSemanticJudge = selectedScenarios.some((scenario) =>
    scenario.tasks.some((task) => Boolean(task.semanticCriteria))
  );
  if (usesSemanticJudge && !allModels.some((model) => model.id === env.judgeModel)) {
    console.error(`\n❌ Unknown judge model ID: ${env.judgeModel}`);
    process.exit(1);
  }
  const scenarioWorkspaces = Object.fromEntries(
    selectedScenarios.map((s) => [s.id, env.workspaceId])
  );

  console.log(
    `📋 ${selectedScenarios.length} scenario(s) | 🤖 ${selectedModels.length} model(s) | 🔄 ${env.runs} run(s)` +
    (usesSemanticJudge ? ` | ⚖️ judge ${env.judgeModel}` : "")
  );

  const results = await runBenchmark({
    scenarios: selectedScenarios,
    models: selectedModels,
    runs: env.runs,
    mcpPath: env.mcpPath,
    mcpEnv: env.mcpEnv,
    openRouterKey: env.openRouterKey,
    judgeModel: env.judgeModel,
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
