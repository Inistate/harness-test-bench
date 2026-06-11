import * as fs from "fs";
import * as path from "path";
import inquirer from "inquirer";
import { MODELS, loadModels } from "./data/models";
import { runBenchmark } from "./core/benchmark-runner";
import { runChatAgent } from "./scenarios/scenario-creator";
import { loadGeneratedScenarios } from "./scenarios/scenario-builder";
import { MCPBridge } from "./bridges/mcp-bridge";
import type { McpEnv, ResolvedConfig, Scenario } from "./types";

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const ENV_FILE = path.join(__dirname, "../.env");

function persistToEnv(vars: Record<string, string>): void {
  let existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    const line  = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*`, "m");
    existing = regex.test(existing)
      ? existing.replace(regex, line)
      : existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, existing);
}

// ─── Load hardcoded TypeScript scenarios ──────────────────────────────────────
const scenariosDir = path.join(__dirname, "scenarios");
const HARDCODED_SCENARIOS: Scenario[] = fs
  .readdirSync(scenariosDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => require(path.join(scenariosDir, f)) as unknown)
  .filter((m): m is Scenario => typeof (m as Record<string, unknown>)?.id === "string");

// ─── MCP config from env ───────────────────────────────────────────────────────
const DEFAULT_API_URL = "https://app02.apps.inistate.com";

function getDefaultMcpPath(): string {
  return path.join(process.env.HOME ?? "", "Documents/inistate-mcp/build/index.js");
}

const MCP_ENV: McpEnv = {
  INISTATE_API_TOKEN:   process.env.INISTATE_API_TOKEN ?? process.env.INISTATE_API_KEY ?? "",
  INISTATE_API_URL:     process.env.INISTATE_API_URL ?? DEFAULT_API_URL,
  INISTATE_WORKSPACE_ID: "",
  INISTATE_MCP_MODE:    "configure",
};

const MCP_PATH = process.env.INISTATE_MCP_PATH ?? getDefaultMcpPath();

async function resolveConfig(): Promise<ResolvedConfig> {
  const answers: Record<string, string> = {};

  const needsOpenRouterKey = !process.env.OPENROUTER_API_KEY;
  const needsInistateToken = !MCP_ENV.INISTATE_API_TOKEN;
  const needsInistateUrl   = !process.env.INISTATE_API_URL;
  const needsMcpPath       = !fs.existsSync(MCP_PATH);

  if (needsOpenRouterKey || needsInistateToken || needsInistateUrl || needsMcpPath) {
    const prompts = [];

    if (needsOpenRouterKey) prompts.push({ type: "password", name: "OPENROUTER_API_KEY", message: "OpenRouter API key?", mask: "*" });
    if (needsInistateToken) prompts.push({ type: "password", name: "INISTATE_API_TOKEN", message: "Inistate API token?", mask: "*" });
    if (needsInistateUrl)   prompts.push({
      type: "input", name: "INISTATE_API_URL", message: "Inistate base URL?", default: DEFAULT_API_URL,
      validate: (value: string) => { try { new URL(value); return true; } catch { return "Enter a valid URL"; } },
    });
    if (needsMcpPath) prompts.push({ type: "input", name: "INISTATE_MCP_PATH", message: "Path to the Inistate MCP server?", default: getDefaultMcpPath() });

    Object.assign(answers, await inquirer.prompt(prompts));

    const toSave: Record<string, string> = {};
    if (answers["OPENROUTER_API_KEY"]) toSave["OPENROUTER_API_KEY"] = answers["OPENROUTER_API_KEY"];
    if (answers["INISTATE_API_TOKEN"]) toSave["INISTATE_API_TOKEN"] = answers["INISTATE_API_TOKEN"];
    if (answers["INISTATE_API_URL"])   toSave["INISTATE_API_URL"]   = answers["INISTATE_API_URL"];
    if (answers["INISTATE_MCP_PATH"])  toSave["INISTATE_MCP_PATH"]  = answers["INISTATE_MCP_PATH"];
    if (Object.keys(toSave).length > 0) {
      persistToEnv(toSave);
      Object.assign(process.env, toSave);
    }
  }

  return {
    openRouterKey: process.env.OPENROUTER_API_KEY ?? answers["OPENROUTER_API_KEY"] ?? "",
    mcpPath: process.env.INISTATE_MCP_PATH ?? answers["INISTATE_MCP_PATH"] ?? MCP_PATH,
    mcpEnv: {
      ...MCP_ENV,
      INISTATE_API_TOKEN: MCP_ENV.INISTATE_API_TOKEN || (answers["INISTATE_API_TOKEN"] ?? ""),
      INISTATE_API_URL:   process.env.INISTATE_API_URL ?? answers["INISTATE_API_URL"] ?? MCP_ENV.INISTATE_API_URL,
    },
  };
}

function validateEnv({ openRouterKey, mcpPath, mcpEnv }: ResolvedConfig): void {
  const missing: string[] = [];
  if (!openRouterKey)          missing.push("OPENROUTER_API_KEY");
  if (!mcpEnv.INISTATE_API_TOKEN) missing.push("INISTATE_API_TOKEN or INISTATE_API_KEY");
  if (!fs.existsSync(mcpPath)) missing.push(`MCP server not found at: ${mcpPath}\n  Set INISTATE_MCP_PATH to correct path`);
  if (missing.length > 0) {
    console.error("\n❌ Missing required environment variables:");
    missing.forEach((m) => console.error(`   - ${m}`));
    process.exit(1);
  }
}

async function selectModels(models: typeof MODELS) {
  const selected = new Set<string>();

  console.log("\nAvailable models:");
  models.forEach((m) => console.log(`  • ${m.name} ($${m.price_in}/$${m.price_out} per 1M)`));
  console.log('\nType a name to search, pick from matches. Leave blank when done (or type "all").\n');

  while (true) {
    const selectionLabel = selected.size > 0 ? `[${selected.size} selected] ` : "";
    const { query } = await inquirer.prompt<{ query: string }>([{ type: "input", name: "query", message: `${selectionLabel}Search models:` }]);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) break;
    if (trimmed === "all") return models;

    const matches = models.filter((m) => m.name.toLowerCase().includes(trimmed) || m.id.toLowerCase().includes(trimmed));
    if (matches.length === 0) { console.log(`  No models match "${query.trim()}"\n`); continue; }

    const { picked } = await inquirer.prompt<{ picked: string[] }>([{
      type: "checkbox", name: "picked", message: `Results for "${query.trim()}":`,
      choices: matches.map((m) => ({ name: `${m.name} ($${m.price_in}/$${m.price_out} per 1M)`, value: m.id, checked: selected.has(m.id) })),
    }]);

    for (const m of matches) {
      if (picked.includes(m.id)) selected.add(m.id);
      else selected.delete(m.id);
    }
  }

  return selected.size === 0 ? models : models.filter((m) => selected.has(m.id));
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       Inistate TestBench v1.0        ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = await resolveConfig();
  validateEnv(config);

  process.stdout.write("Fetching live model prices from OpenRouter... ");
  const models = await loadModels(config.openRouterKey);
  console.log("done");

  const { action } = await inquirer.prompt<{ action: string }>([{
    type: "list",
    name: "action",
    message: "What would you like to do?",
    choices: [
      { name: "Run benchmark", value: "run" },
      { name: "Create new scenario", value: "create" },
    ],
  }]);

  async function getTools() {
    const toolBridge = new MCPBridge(config.mcpPath, {
      ...config.mcpEnv,
      INISTATE_WORKSPACE_ID: "",
      INISTATE_MCP_MODE: "configure",
    });
    await toolBridge.connect();
    const tools = toolBridge.rawTools;
    await toolBridge.disconnect();
    return tools;
  }

  if (action === "create") {
    const rawTools = await getTools();
    await runChatAgent(config, rawTools.map((t) => t.name));
    return;
  }

  const generatedDir = path.join(__dirname, "scenarios", "generated");
  const hasGenerated = fs.existsSync(generatedDir) &&
    fs.readdirSync(generatedDir).some((f) => f.endsWith(".json"));

  const rawTools = hasGenerated ? await getTools() : [];
  const generatedScenarios = loadGeneratedScenarios(config, rawTools);
  const ALL_SCENARIOS = [...HARDCODED_SCENARIOS, ...generatedScenarios];

  const { scenarios } = await inquirer.prompt<{ scenarios: string[] }>([{
    type: "checkbox", name: "scenarios", message: "Which scenarios to run?",
    choices: [
      { name: "All scenarios", value: "__all__" },
      ...ALL_SCENARIOS.map((s) => ({ name: `${s.name} — ${s.description}`, value: s.id })),
    ],
    validate: (v: string[]) => v.length > 0 || "Select at least one scenario",
  }]);

  const selectedModels = await selectModels(models);

  const { runsInput } = await inquirer.prompt<{ runsInput: string }>([{
    type: "input", name: "runsInput", message: "Runs per task?", default: "1",
    validate: (value: string) => {
      const n = Number.parseInt(value, 10);
      return Number.isInteger(n) && n > 0 ? true : "Enter a positive whole number";
    },
  }]);

  const selectedScenarios = scenarios.includes("__all__")
    ? ALL_SCENARIOS
    : ALL_SCENARIOS.filter((s) => scenarios.includes(s.id));

  // ─── Workspace ID per scenario ─────────────────────────────────────────────
  console.log("\n\x1b[38;5;208m⚠\x1b[0m  Each scenario runs against a specific workspace.");
  console.log("   Make sure the workspace already exists in Inistate before continuing.\n");

  const defaultWorkspaceId = process.env.INISTATE_DEFAULT_WORKSPACE_ID?.trim() ?? "";

  const scenarioWorkspaces: Record<string, string> = {};
  for (const scenario of selectedScenarios) {
    let workspaceId: string;

    if (defaultWorkspaceId) {
      const { choice } = await inquirer.prompt<{ choice: string }>([{
        type: "list",
        name: "choice",
        message: `Workspace for "${scenario.name}":`,
        choices: [
          { name: `Default: ${defaultWorkspaceId}`, value: "__default__" },
          { name: "Enter workspace ID...", value: "__enter__" },
        ],
      }]);

      if (choice === "__enter__") {
        const { entered } = await inquirer.prompt<{ entered: string }>([{
          type: "input",
          name: "entered",
          message: `Workspace ID for "${scenario.name}":`,
          validate: (v: string) => v.trim().length > 0 || "Workspace ID is required",
        }]);
        workspaceId = entered.trim();
      } else {
        workspaceId = defaultWorkspaceId;
      }
    } else {
      const { entered } = await inquirer.prompt<{ entered: string }>([{
        type: "input",
        name: "entered",
        message: `Workspace ID for "${scenario.name}":`,
        validate: (v: string) => v.trim().length > 0 || "Workspace ID is required",
      }]);
      workspaceId = entered.trim();
    }

    scenarioWorkspaces[scenario.id] = workspaceId;
  }

  const runs = Number.parseInt(runsInput, 10);

  const logReasoning = process.env.LOG_REASONING === "1" || process.env.LOG_REASONING === "true";

  console.log(`\n📋 ${selectedScenarios.length} scenario(s) | 🤖 ${selectedModels.length} model(s) | 🔄 ${runs} run(s)${logReasoning ? " | 🧠 reasoning on" : ""}`);
  console.log(`🔧 MCP: ${config.mcpPath}\n`);

  await runBenchmark({
    scenarios: selectedScenarios,
    models: selectedModels,
    runs,
    mcpPath: config.mcpPath,
    mcpEnv: config.mcpEnv,
    openRouterKey: config.openRouterKey,
    logReasoning,
    scenarioWorkspaces,
  });
}

main().catch((e: Error) => {
  console.error("\n❌ Fatal error:", e.message);
  process.exit(1);
});
