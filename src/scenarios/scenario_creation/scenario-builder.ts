import * as fs from "fs";
import * as path from "path";
import type { GeneratedScenario, IBridge, RawMcpTool, ResolvedConfig, Scenario } from "../../types";
import { runChecks } from "../../core/check-evaluator";
import { judge } from "../../core/llm-judge";

const GENERATED_DIR = path.join(__dirname, "generated");
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const AGENT_MODEL = "openai/gpt-5-nano";
const ASSETS_RE = /<assets>([\s\S]*?)<\/assets>/;
const MAX_AGENT_STEPS = 20;

// ─── OpenAI chat message types ─────────────────────────────────────────────────
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: AgentToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: AgentToolCall[];
    };
    finish_reason: string;
  }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function toOpenAITools(tools: RawMcpTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? t.name,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));
}

function substitute(template: string, assets: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key: string) =>
    assets[key] !== undefined ? String(assets[key]) : `\${${key}}`
  );
}

function parseAssets(text: string): Record<string, unknown> | null {
  const match = ASSETS_RE.exec(text);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()) as Record<string, unknown>; }
  catch { return null; }
}

// ─── Core agent loop ───────────────────────────────────────────────────────────
async function runAgentLoop(
  systemPrompt: string,
  userPrompt: string,
  bridge: IBridge,
  mcpTools: RawMcpTool[],
  openRouterKey: string
): Promise<string> {
  const tools = toOpenAITools(mcpTools);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt },
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: AGENT_MODEL, messages, tools, tool_choice: "auto" }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Agent LLM ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as ChatResponse;
    const msg = data.choices[0].message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content ?? "";
    }

    // Append assistant turn with tool_calls preserved
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });

    // Execute each tool call and append results
    for (const tc of msg.tool_calls) {
      let result: unknown;
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        result = await bridge.callTool(tc.function.name, args);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  // Max steps reached — ask for a final summary without tools
  const finalRes = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: AGENT_MODEL, messages: [...messages, { role: "user", content: "Summarise what you did and output <assets> if required." }] }),
  });
  const finalData = await finalRes.json() as ChatResponse;
  return finalData.choices[0]?.message?.content ?? "";
}

// ─── Setup / teardown agents ───────────────────────────────────────────────────
async function runSetupAgent(
  bridge: IBridge,
  workspaceId: string,
  setupPrompt: string,
  mcpTools: RawMcpTool[],
  openRouterKey: string
): Promise<Record<string, unknown>> {
  const system = `You are a test-environment setup agent for Inistate TestBench.
Use MCP tools to execute the setup instructions exactly.
Workspace ID: ${workspaceId}
When all setup is complete, output: <assets>{"workspaceId":"...","key":"value",...}</assets>
Include workspaceId and every created entry/module ID in the assets JSON.`;

  console.log("    → Running setup agent...");
  const output = await runAgentLoop(system, setupPrompt, bridge, mcpTools, openRouterKey);

  const assets = parseAssets(output);
  if (!assets) {
    console.warn("    ⚠  Setup agent did not output <assets> — using empty assets.");
    return { workspaceId };
  }
  return { workspaceId, ...assets };
}

async function runTaskSetupAgent(
  bridge: IBridge,
  assets: Record<string, unknown>,
  taskSetupPrompt: string,
  mcpTools: RawMcpTool[],
  openRouterKey: string
): Promise<void> {
  const system = `You are a pre-task setup agent for Inistate TestBench.
Use MCP tools to ensure the correct state before the task runs.
Current test assets: ${JSON.stringify(assets)}
Execute the instructions exactly. No output is needed.`;

  await runAgentLoop(system, substitute(taskSetupPrompt, assets), bridge, mcpTools, openRouterKey);
}

async function runTeardownAgent(
  bridge: IBridge,
  assets: Record<string, unknown>,
  mcpTools: RawMcpTool[],
  openRouterKey: string
): Promise<void> {
  const system = `You are a test cleanup agent for Inistate TestBench.
Use MCP tools to delete all entries created during the benchmark run.
Assets: ${JSON.stringify(assets)}
Delete every entry whose ID appears in the assets using submit_activity with activity "delete".`;

  try {
    await runAgentLoop(system, "Clean up all test entries from the assets above.", bridge, mcpTools, openRouterKey);
  } catch { /* teardown failures are non-fatal */ }
}

// ─── Scenario conversion ───────────────────────────────────────────────────────
function jsonToScenario(
  gen: GeneratedScenario,
  mcpTools: RawMcpTool[],
  openRouterKey: string
): Scenario {
  return {
    id: gen.id,
    name: gen.name,
    description: gen.description ?? "",

    setup: async (bridge: IBridge, workspaceId: string) =>
      runSetupAgent(bridge, workspaceId, gen.setupPrompt, mcpTools, openRouterKey),

    system: (assets) => substitute(gen.system, assets),

    tasks: gen.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      maxSteps: task.maxSteps,
      prompt: (assets: Record<string, unknown>) => substitute(task.prompt, assets),

      setup: task.setupPrompt
        ? async (bridge: IBridge, assets: Record<string, unknown>) => {
            console.log(`    → Pre-task setup: "${task.name}"...`);
            await runTaskSetupAgent(bridge, assets, task.setupPrompt!, mcpTools, openRouterKey);
          }
        : undefined,

      evaluate: (toolCalls, response) => {
        const checkResult = runChecks(task.checks, toolCalls);

        if (!task.ai) return checkResult;

        // ai criteria are evaluated async but evaluate() is sync — defer via returned promise trick
        // Instead: if checks already failed, skip the LLM call (save cost)
        // Return check result now; judge is invoked only if checks pass
        // Full async judge integration is in runTask (future enhancement)
        // For now, annotate the issue so it's visible in results
        if (!checkResult.success) return checkResult;

        // Append a marker so the runner knows to call the judge
        return {
          ...checkResult,
          issues: [...checkResult.issues, `__ai_pending__:${task.ai}`],
        };
      },
    })),

    teardown: async (bridge: IBridge, assets: Record<string, unknown>) =>
      runTeardownAgent(bridge, assets, mcpTools, openRouterKey),
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────
export function loadGeneratedScenarios(
  config: ResolvedConfig,
  mcpTools: RawMcpTool[]
): Scenario[] {
  if (!fs.existsSync(GENERATED_DIR)) return [];

  const scenarios: Scenario[] = [];
  for (const file of fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(GENERATED_DIR, file), "utf8")
      ) as GeneratedScenario;
      scenarios.push(jsonToScenario(raw, mcpTools, config.openRouterKey));
    } catch (e) {
      console.warn(`⚠  Skipping generated scenario "${file}": ${(e as Error).message}`);
    }
  }
  return scenarios;
}
