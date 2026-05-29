const inquirer = require("inquirer");
const path = require("path");
const fs = require("fs");
const { MODELS } = require("./models");
const { runBenchmark } = require("./runner");

const ENV_FILE = path.join(__dirname, ".env");
require("dotenv").config({ path: ENV_FILE });

function persistToEnv(vars) {
  let existing = "";
  if (fs.existsSync(ENV_FILE)) {
    existing = fs.readFileSync(ENV_FILE, "utf8");
  }
  for (const [key, value] of Object.entries(vars)) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const regex = new RegExp(`^${key}=.*`, "m");
    if (regex.test(existing)) {
      existing = existing.replace(regex, line);
    } else {
      existing = existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`;
    }
  }
  fs.writeFileSync(ENV_FILE, existing);
}

// ─── Load all scenarios ────────────────────────────────────────────────────────
const scenariosDir = path.join(__dirname, "scenarios");
const SCENARIOS = fs
  .readdirSync(scenariosDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => require(path.join(scenariosDir, f)));

// ─── MCP config from env ───────────────────────────────────────────────────────
const MCP_PATH =
  process.env.INISTATE_MCP_PATH ||
  path.join(process.env.HOME, "Documents/inistate-mcp/build/index.js");

const MCP_ENV = {
  INISTATE_API_TOKEN: process.env.INISTATE_API_TOKEN || process.env.INISTATE_API_KEY || "",
  INISTATE_API_URL: process.env.INISTATE_API_URL || "https://app02.apps.inistate.com",
  INISTATE_WORKSPACE_ID: "",
  INISTATE_MCP_MODE: "runtime",
};

const DEFAULT_INISTATE_API_URL = "https://app02.apps.inistate.com";

function getDefaultMcpPath() {
  return path.join(process.env.HOME, "Documents/inistate-mcp/build/index.js");
}

async function resolveConfig() {
  const answers = {};

  const needsOpenRouterKey = !process.env.OPENROUTER_API_KEY;
  const needsInistateToken = !MCP_ENV.INISTATE_API_TOKEN;
  const needsInistateUrl = !process.env.INISTATE_API_URL;
  const needsMcpPath = !fs.existsSync(MCP_PATH);

  if (needsOpenRouterKey || needsInistateToken || needsInistateUrl || needsMcpPath) {
    const prompts = [];

    if (needsOpenRouterKey) {
      prompts.push({
        type: "password",
        name: "OPENROUTER_API_KEY",
        message: "OpenRouter API key?",
        mask: "*",
      });
    }

    if (needsInistateToken) {
      prompts.push({
        type: "password",
        name: "INISTATE_API_TOKEN",
        message: "Inistate API token?",
        mask: "*",
      });
    }

    if (needsInistateUrl) {
      prompts.push({
        type: "input",
        name: "INISTATE_API_URL",
        message: "Inistate base URL?",
        default: MCP_ENV.INISTATE_API_URL || DEFAULT_INISTATE_API_URL,
        validate: (value) => {
          try {
            new URL(value);
            return true;
          } catch {
            return "Enter a valid URL, for example https://app02.apps.inistate.com";
          }
        },
      });
    }

    if (needsMcpPath) {
      prompts.push({
        type: "input",
        name: "INISTATE_MCP_PATH",
        message: "Path to the Inistate MCP server?",
        default: getDefaultMcpPath(),
      });
    }

    Object.assign(answers, await inquirer.prompt(prompts));

    const toSave = {};
    if (answers.OPENROUTER_API_KEY) toSave.OPENROUTER_API_KEY = answers.OPENROUTER_API_KEY;
    if (answers.INISTATE_API_TOKEN) toSave.INISTATE_API_TOKEN = answers.INISTATE_API_TOKEN;
    if (answers.INISTATE_API_URL) toSave.INISTATE_API_URL = answers.INISTATE_API_URL;
    if (answers.INISTATE_MCP_PATH) toSave.INISTATE_MCP_PATH = answers.INISTATE_MCP_PATH;
    if (Object.keys(toSave).length > 0) {
      persistToEnv(toSave);
      Object.assign(process.env, toSave);
    }
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY || answers.OPENROUTER_API_KEY || "";
  const inistateToken = MCP_ENV.INISTATE_API_TOKEN || answers.INISTATE_API_TOKEN || "";
  const inistateUrl = process.env.INISTATE_API_URL || answers.INISTATE_API_URL || MCP_ENV.INISTATE_API_URL;
  const mcpPath = process.env.INISTATE_MCP_PATH || answers.INISTATE_MCP_PATH || MCP_PATH;

  return {
    openRouterKey,
    mcpPath,
    mcpEnv: {
      ...MCP_ENV,
      INISTATE_API_TOKEN: inistateToken,
      INISTATE_API_URL: inistateUrl,
    },
  };
}

// ─── Validate env ──────────────────────────────────────────────────────────────
function validateEnv({ openRouterKey, mcpPath, mcpEnv }) {
  const missing = [];
  if (!openRouterKey) missing.push("OPENROUTER_API_KEY");
  if (!mcpEnv.INISTATE_API_TOKEN) missing.push("INISTATE_API_TOKEN or INISTATE_API_KEY");
  if (!fs.existsSync(mcpPath)) missing.push(`MCP server not found at: ${mcpPath}\n  Set INISTATE_MCP_PATH to correct path`);
  if (missing.length > 0) {
    console.error("\n❌ Missing required environment variables:");
    missing.forEach((m) => console.error(`   - ${m}`));
    console.error("\nExample:");
    console.error("  export OPENROUTER_API_KEY=your_key");
    console.error("  export INISTATE_API_TOKEN=your_token");
    console.error("  export INISTATE_MCP_PATH=/path/to/inistate-mcp/build/index.js\n");
    process.exit(1);
  }
}

// ─── Model search-and-select ───────────────────────────────────────────────────
async function selectModels() {
  const selected = new Set();

  console.log("\nAvailable models:");
  MODELS.forEach((m) => console.log(`  • ${m.name} ($${m.price_in}/$${m.price_out} per 1M)`));
  console.log('\nType a name to search, pick from matches. Leave blank when done (or type "all").\n');

  while (true) {
    const selectionLabel = selected.size > 0 ? `[${selected.size} selected] ` : "";

    const { query } = await inquirer.prompt([
      {
        type: "input",
        name: "query",
        message: `${selectionLabel}Search models:`,
      },
    ]);

    const trimmed = query.trim().toLowerCase();

    if (!trimmed) break;

    if (trimmed === "all") return MODELS;

    const matches = MODELS.filter(
      (m) => m.name.toLowerCase().includes(trimmed) || m.id.toLowerCase().includes(trimmed)
    );

    if (matches.length === 0) {
      console.log(`  No models match "${query.trim()}"\n`);
      continue;
    }

    const { picked } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "picked",
        message: `Results for "${query.trim()}":`,
        choices: matches.map((m) => ({
          name: `${m.name} ($${m.price_in}/$${m.price_out} per 1M)`,
          value: m.id,
          checked: selected.has(m.id),
        })),
      },
    ]);

    for (const m of matches) {
      if (picked.includes(m.id)) selected.add(m.id);
      else selected.delete(m.id);
    }
  }

  return selected.size === 0 ? MODELS : MODELS.filter((m) => selected.has(m.id));
}

// ─── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       Inistate TestBench v1.0        ║");
  console.log("╚══════════════════════════════════════╝\n");

  const config = await resolveConfig();
  validateEnv(config);

  const { scenarios } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "scenarios",
      message: "Which scenarios to run?",
      choices: [
        { name: "All scenarios", value: "__all__" },
        ...SCENARIOS.map((s) => ({ name: `${s.name} — ${s.description}`, value: s.id })),
      ],
      validate: (v) => v.length > 0 || "Select at least one scenario",
    },
  ]);

  const selectedModels = await selectModels();

  const { runsInput } = await inquirer.prompt([
    {
      type: "input",
      name: "runsInput",
      message: "Runs per task?",
      default: "1",
      validate: (value) => {
        const n = Number.parseInt(value, 10);
        return Number.isInteger(n) && n > 0 ? true : "Enter a positive whole number";
      },
    },
  ]);

  // Resolve selections
  const selectedScenarios = scenarios.includes("__all__")
    ? SCENARIOS
    : SCENARIOS.filter((s) => scenarios.includes(s.id));

  const runs = Number.parseInt(runsInput, 10);

  console.log(`\n📋 ${selectedScenarios.length} scenario(s) | 🤖 ${selectedModels.length} model(s) | 🔄 ${runs} run(s)`);
  console.log(`🔧 MCP: ${config.mcpPath}\n`);

  await runBenchmark({
    scenarios: selectedScenarios,
    models: selectedModels,
    runs,
    mcpPath: config.mcpPath,
    mcpEnv: config.mcpEnv,
    openRouterKey: config.openRouterKey,
  });
}

main().catch((e) => {
  console.error("\n❌ Fatal error:", e.message);
  process.exit(1);
});
