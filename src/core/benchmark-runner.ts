import { OpenRouter, fromChatMessages, stepCountIs } from "@openrouter/agent";
import type { Tool } from "@openrouter/agent";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { MCPBridge } from "../bridges/mcp-bridge";
import type { BenchmarkConfig, IBridge, Model, ModelRunResult, RawMcpTool, ResultFile, Scenario, ScenarioResult, TaskResult, ToolCall } from "../types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fetch generation cost from /generations/{id} endpoint, which is more accurate than completion endpoint
async function fetchGenerationCost(generationIds: Array<string>): Promise<{cost: number, inputTokens: number, outputTokens: number}> {
  
  const options = {method: 'GET', headers: {Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`}};
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // slight delay to ensure generation is registered in OpenRouter system
  // exponential backoff
  for (const generationId of generationIds) {
    if (generationId === "unknown") continue;
    for (let i = 0; i < 4; i++) {
      await sleep(i == 0? 1000: 500 * 2**i);
      const url = `https://openrouter.ai/api/v1/generation?id=${generationId}`;
      const httpResponse = await fetch(url, options);
      if (!httpResponse.ok) {
        continue;
      }
      let cost = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      const res = await httpResponse.json() as { data?: { total_cost?: number; native_tokens_prompt?: number; native_tokens_completion?: number } };
      if (res.data?.total_cost !== null) {
        cost = res.data?.total_cost ?? 0;
        inputTokens = res.data?.native_tokens_prompt ?? 0;
        outputTokens = res.data?.native_tokens_completion ?? 0;
        totalCost += cost;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        break;
      }
    }
  }

  // Implementation for fetching generation cost
  
  return { cost: totalCost, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

function readPackageVersion(pkgPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function getMcpGitHash(mcpPath: string): string | null {
  try {
    const repoDir = path.dirname(mcpPath);
    return execSync(`git -C "${repoDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  } catch { return null; }
}

function getVersions(mcpPath: string): { testbenchVersion: string; mcpVersion: string | null; mcpCommit: string | null } {
  const tbPkgPath = path.join(__dirname, "../../package.json");
  const mcpPkgPath = path.join(path.dirname(mcpPath), "../package.json");
  return {
    testbenchVersion: readPackageVersion(tbPkgPath) ?? "unknown",
    mcpVersion: readPackageVersion(mcpPkgPath),
    mcpCommit: getMcpGitHash(mcpPath),
  };
}

const DELAY_BETWEEN_TASKS = 3000;
const DELAY_BETWEEN_MODELS = 10000;
const MAX_RETRIES = 3;

// ─── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
  reset:  "\x1b[0m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
};

const tick  = `${c.green}✅${c.reset}`;
const cross = `${c.red}❌${c.reset}`;
const warn  = `${c.yellow}⚠${c.reset}`;

function formatError(e: unknown): string {
  const err = e as Record<string, unknown>;
  const parts: string[] = [];
  if (err?.message) parts.push(String(err.message));
  if (err?.name && err.name !== "Error") parts.push(`type=${String(err.name)}`);
  if (err?.statusCode) parts.push(`status=${String(err.statusCode)}`);

  const issues = (err?.cause as Record<string, unknown>)?.issues ?? (err?.cause as Record<string, unknown>)?.errors;
  if (Array.isArray(issues) && issues.length > 0) {
    parts.push(`issues=${JSON.stringify(issues.slice(0, 5))}`);
  } else if (typeof err?.pretty === "function") {
    const pretty = (err.pretty as () => string)();
    if (pretty && pretty !== err.message) parts.push(pretty);
  }

  if (err?.rawValue !== undefined) parts.push(`raw=${JSON.stringify(err.rawValue).slice(0, 1000)}`);
  if (err?.body) parts.push(`body=${String(err.body).slice(0, 1000)}`);

  return parts.length > 0 ? parts.join(" | ") : String(e);
}

function parseToolOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try { return JSON.parse(output); } catch { return output; }
}

function parseToolArguments(args: unknown): Record<string, unknown> {
  if (typeof args !== "string") return (args as Record<string, unknown>) ?? {};
  try { return JSON.parse(args) as Record<string, unknown>; } catch { return {}; }
}

function compactJson(value: unknown, maxLength = 260): string {
  if (value === undefined) return "";
  const text = JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeToolResult(result: unknown): string {
  if (result === undefined) return "no result captured";
  if (typeof result === "string") return result.slice(0, 180);
  const r = result as Record<string, unknown>;
  if (r?.error) return `error=${String(r.error)}`;

  const summary: string[] = [];
  const results = r?.results as Array<Record<string, unknown>> | undefined;
  const entryId = r?.entryId ?? (r?.entryIds as unknown[])?.[0] ?? results?.[0]?.entryId;
  const documentId = r?.documentId ?? results?.[0]?.documentId;
  const state = r?.state ?? results?.[0]?.state;
  const summary2 = r?.summary as Record<string, unknown> | undefined;
  const succeeded = summary2?.succeeded;
  const failed = summary2?.failed;
  const total = r?.totalItems ?? r?.total;
  const listCount = Array.isArray(r?.list) ? (r.list as unknown[]).length : undefined;

  if (entryId !== undefined) summary.push(`entryId=${String(entryId)}`);
  if (documentId !== undefined) summary.push(`documentId=${String(documentId)}`);
  if (state !== undefined) summary.push(`state=${String(state)}`);
  if (succeeded !== undefined || failed !== undefined) summary.push(`ok=${String(succeeded ?? 0)} fail=${String(failed ?? 0)}`);
  if (listCount !== undefined) summary.push(`list=${listCount}${total !== undefined ? `/${String(total)}` : ""}`);
  if (r?.success !== undefined) summary.push(`success=${String(r.success)}`);

  return summary.length > 0 ? summary.join(" ") : compactJson(result, 180);
}

function formatToolTrace(toolCalls: ToolCall[]): string[] {
  if (!toolCalls.length) return [`${c.dim}no tool calls captured${c.reset}`];
  return toolCalls.map((call, index) => {
    const args = compactJson(call.arguments, 320);
    const result = summarizeToolResult(call.result);
    return `${index + 1}. ${c.cyan}${call.name}${c.reset} args=${args || "{}"} → ${result}`;
  });
}

interface RawToolRound {
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolResults?: Array<{ callId: string; output: unknown }>;
}

async function collectExecutedToolCalls(result: unknown): Promise<ToolCall[]> {
  const calls: ToolCall[] = [];

  // allToolExecutionRounds is a private field — access via cast at runtime
  const rounds: RawToolRound[] = Array.isArray((result as Record<string, unknown>).allToolExecutionRounds)
    ? (result as Record<string, unknown>).allToolExecutionRounds as RawToolRound[]
    : [];

  for (const round of rounds) {
    const outputsByCallId = new Map<string, unknown>(
      (round.toolResults ?? []).map((tr) => [tr.callId, parseToolOutput(tr.output)])
    );
    for (const call of round.toolCalls ?? []) {
      calls.push({
        name: call.name,
        arguments: parseToolArguments(call.arguments),
        result: outputsByCallId.get(call.id),
      });
    }
  }

  if (calls.length > 0) return calls;

  try {
    const r = result as { getToolCalls?: () => Promise<Array<{ name: string; arguments: unknown; result?: unknown }>> };
    const initialCalls = await r.getToolCalls?.() ?? [];
    return initialCalls.map((call) => ({
      name: call.name,
      arguments: parseToolArguments(call.arguments),
      result: call.result,
    }));
  } catch {
    return [];
  }
}

// ─── Run a single task for one model ──────────────────────────────────────────
async function runTask(
  openrouter: OpenRouter,
  model: Model,
  task: { id: string; name: string; prompt: string | ((assets: Record<string, unknown>) => string); evaluate: (calls: ToolCall[], response: string, assets?: Record<string, unknown>) => { success: boolean; issues: string[]; hallucinated: boolean }; maxSteps?: number },
  assets: Record<string, unknown>,
  tools: Tool[],
  system: string,
  logReasoning: boolean,
  attempt = 0
): Promise<TaskResult> {
  const prompt = typeof task.prompt === "function" ? task.prompt(assets) : task.prompt;

  try {
    const start = Date.now();

    // Capture per-step usage via stopWhen closure — response.usage only covers the last step
    type StepUsage = { usage?: { inputTokens?: number; outputTokens?: number } };
    let capturedSteps: StepUsage[] = [];
    const maxSteps = task.maxSteps ?? 12;
    const generationIds = new Array<string>();

    const result = openrouter.callModel({
      model: model.id,
      input: fromChatMessages([
        { role: "system", content: system },
        { role: "user", content: prompt },
      ]),
      tools,
      stopWhen: (ctx) => {
        // console.log(`Ctx shape:`, ctx);
        // if (ctx.steps.length > 0) {
        //   console.log(`Response shape:`, JSON.stringify((ctx.steps[0] as any).response ?? {}), null, 2);
        // }
        for (const step of ctx.steps) {
          const response = step.response 
          const genId = (response as unknown as { id?: string })?.id;
          if (genId && !generationIds.includes(genId)) {
            console.log(`Captured generation ID: ${genId}`);
            generationIds.push(genId);
          }
        }
        capturedSteps = ctx.steps as unknown as StepUsage[];
        return ctx.steps.length >= maxSteps;
      },
    });

    // Collect reasoning concurrently while the model runs
    const reasoningChunks: string[] = [];
    if (logReasoning) {
      (async () => {
        for await (const delta of result.getReasoningStream()) {
          reasoningChunks.push(delta);
        }
      })().catch(() => { /* model doesn't support reasoning */ });
    }

    const [text, finalResponse] = await Promise.all([
      result.getText(),
      result.getResponse(),
    ]);

    const latency = Date.now() - start;
    console.log(`array length`, generationIds.length);
    const finalId = (finalResponse as unknown as { id?: string })?.id;
    if (finalId && !generationIds.includes(finalId)) {
      console.log(`Captured final generation ID: ${finalId}`);
      generationIds.push(finalId);
    }
    console.log(`array length`, generationIds.length);
    const resPromise = fetchGenerationCost(generationIds);

    // Sum tokens across all steps; fall back to final response.usage for single-step runs
    // const inputTokens = capturedSteps.length > 0
    //   ? capturedSteps.reduce((s, step) => s + (step.usage?.inputTokens ?? 0), 0)
    //   : (response.usage?.inputTokens ?? 0);
    // const outputTokens = capturedSteps.length > 0
    //   ? capturedSteps.reduce((s, step) => s + (step.usage?.outputTokens ?? 0), 0)
    //   : (response.usage?.outputTokens ?? 0);
    // const cost = (inputTokens / 1e6) * model.price_in + (outputTokens / 1e6) * model.price_out;

    const toolCalls = await collectExecutedToolCalls(result);
    const evaluation = task.evaluate(toolCalls, text, assets);

    if (logReasoning && reasoningChunks.length > 0) {
      const reasoning = reasoningChunks.join("").trim();
      console.log(`      ${c.dim}┌ reasoning ─────────────────────────────${c.reset}`);
      for (const line of reasoning.split("\n").slice(0, 10)) {
        console.log(`      ${c.dim}│ ${line}${c.reset}`);
      }
      if (reasoning.split("\n").length > 10) {
        console.log(`      ${c.dim}│ … (${reasoning.split("\n").length - 10} more lines)${c.reset}`);
      }
      console.log(`      ${c.dim}└───────────────────────────────────────${c.reset}`);
    }

    return {
      skipped: false,
      success: evaluation.success,
      issues: evaluation.issues,
      hallucinated: evaluation.hallucinated,
      latency_ms: latency,
      cost_usd: null,
      tool_calls: toolCalls.map((t) => t.name),
      tool_call_details: toolCalls,
      response_preview: text?.slice(0, 200),
      _res_promise: resPromise,
    };
  } catch (e) {
    const err = e as Record<string, unknown>;
    const status = (err?.status ?? (err?.response as Record<string, unknown>)?.status) as number | undefined;

    if (status === 429 && attempt < MAX_RETRIES) {
      const wait = [10000, 30000, 60000][attempt];
      process.stdout.write(`\n    ${warn} Rate limited. Waiting ${wait / 1000}s...`);
      await sleep(wait);
      return runTask(openrouter, model, task, assets, tools, system, logReasoning, attempt + 1);
    }

    if (status === 402 || status === 403) {
      return { skipped: true, reason: `HTTP ${status} — model not accessible on free tier` };
    }

    return { skipped: true, reason: formatError(e) };
  }
}

// ─── Qwen3-Coder XML tool call parser ─────────────────────────────────────────
// mlx_lm 0.29.x has no built-in XML converter, so tool calls land in content
// as raw XML. This extracts them into OpenAI-compatible tool_calls format.
function extractXmlToolCalls(
  content: string
): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  const results: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  // Match either <tool_call>...</tool_call> blocks or bare <function=...>...</function> blocks
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>|(<function=[^>]+>[\s\S]*?<\/function>)/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(content)) !== null) {
    const inner = (block[1] ?? block[2] ?? "").trim();
    const nameMatch = /<function=([^>]+)>/.exec(inner);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(inner)) !== null) {
      const key = pm[1].trim();
      const raw = pm[2].trim();
      try { args[key] = JSON.parse(raw); } catch { args[key] = raw; }
    }
    results.push({
      id: `call_${Date.now()}_${results.length}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return results;
}

// ─── Local model runner (fetch → /chat/completions, bypasses OpenRouter SDK) ───
type LocalMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

async function runTaskLocal(
  localBaseUrl: string,
  model: Model,
  task: Parameters<typeof runTask>[2],
  assets: Record<string, unknown>,
  rawTools: RawMcpTool[],
  bridge: IBridge,
  system: string
): Promise<TaskResult> {
  const prompt = typeof task.prompt === "function" ? task.prompt(assets) : task.prompt;
  const start = Date.now();
  const collectedToolCalls: ToolCall[] = [];

  const openaiTools = rawTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? t.name,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));

  const messages: LocalMsg[] = [
    { role: "system", content: system },
    { role: "user",   content: prompt },
  ];

  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let taskCost = 0;
  const maxSteps = task.maxSteps ?? 12;

  for (let step = 0; step < maxSteps; step++) {
    const requestBody = JSON.stringify({ model: process.env.LOCAL_MODEL_ID ?? model.id, messages, tools: openaiTools, tool_choice: "auto", max_tokens: 4096, transforms: ["usage"] });
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(`${localBaseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer local" },
          body: requestBody,
        });
        break;
      } catch {
        if (attempt === 2) return { skipped: true, reason: "Local model unreachable after 3 attempts" };
        await sleep(3000);
      }
    }
    if (!res) return { skipped: true, reason: "Local model unreachable" };

    if (!res.ok) {
      const body = await res.text();
      return { skipped: true, reason: `Local model ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json() as {
      choices: Array<{ message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }; finish_reason: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };

    inputTokens  += data.usage?.prompt_tokens  ?? 0;
    outputTokens += data.usage?.completion_tokens ?? 0;
    taskCost     += data.usage?.cost ?? 0;

    const msg = data.choices[0].message;

    // mlx_lm may return XML tool calls in content instead of tool_calls
    const activeCalls = (msg.tool_calls && msg.tool_calls.length > 0)
      ? msg.tool_calls
      : extractXmlToolCalls(msg.content ?? "");

    if (activeCalls.length === 0) {
      finalText = (msg.content ?? "").replace(/<\|im_end\|>/g, "").trim();
      break;
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: activeCalls });

    for (const tc of activeCalls) {
      let result: unknown;
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
      try {
        result = await bridge.callTool(tc.function.name, parsedArgs);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      collectedToolCalls.push({ name: tc.function.name, arguments: parsedArgs, result });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  const latency = Date.now() - start;
  const evaluation = task.evaluate(collectedToolCalls, finalText, assets);

  return {
    skipped: false,
    success: evaluation.success,
    issues: evaluation.issues,
    hallucinated: evaluation.hallucinated,
    latency_ms: latency,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: taskCost,
    tool_calls: collectedToolCalls.map((t) => t.name),
    tool_call_details: collectedToolCalls,
    response_preview: finalText.slice(0, 200),
  };
}

// ─── Run all tasks for one scenario + model ────────────────────────────────────
async function runScenarioForModel(
  openrouter: OpenRouter,
  model: Model,
  scenario: Scenario,
  assets: Record<string, unknown>,
  tools: Tool[],
  rawTools: RawMcpTool[],
  localBaseUrl: string | undefined,
  logReasoning: boolean,
  bridge: IBridge
): Promise<ModelRunResult> {
  const modelResults: ModelRunResult = {
    model: model.name,
    tasks: {},
    score: 0,
    total: scenario.tasks.length,
    total_tokens: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
    total_tool_calls: 0,
    avg_latency_ms: 0,
    skipped: false,
  };

  for (let i = 0; i < scenario.tasks.length; i++) {
    const task = scenario.tasks[i];
    process.stdout.write(
      `    Task ${i + 1}/${scenario.tasks.length}: ${c.dim}${task.name}${c.reset} `
    );

    if (task.setup) {
      try {
        await task.setup(bridge, assets as Parameters<typeof task.setup>[1]);
      } catch (e) {
        console.log(`\n    ${warn} Task setup failed: ${(e as Error).message}`);
      }
    }

    const system = typeof scenario.system === "function" ? scenario.system(assets) : scenario.system;
    const result = (model.local && localBaseUrl)
      ? await runTaskLocal(localBaseUrl, model, task as Parameters<typeof runTask>[2], assets, rawTools, bridge, system)
      : await runTask(openrouter, model, task as Parameters<typeof runTask>[2], assets, tools, system, logReasoning);

    if (result.skipped) {
      console.log(`${warn} Skipped: ${result.reason}`);
      modelResults.tasks[task.id] = { skipped: true, reason: result.reason };
      if (i === 0) {
        modelResults.skipped = true;
        modelResults.skip_reason = result.reason;
        break;
      }
      continue;
    }

    if (task.verify) {
      try {
        const verifyResult = await task.verify(bridge, assets as Parameters<NonNullable<typeof task.verify>>[1]);
        if (!verifyResult.success) {
          result.success = false;
          result.issues = [...(result.issues ?? []), ...verifyResult.issues];
        }
      } catch (e) {
        console.log(`\n    ${warn} Task verify error: ${(e as Error).message}`);
      }
    }
    
    let inputTokens = result.input_tokens ?? 0;
    let outputTokens = result.output_tokens ?? 0;
    if (result._res_promise) {
      const resData = await result._res_promise;
      // console.log(resData);
      inputTokens = resData.inputTokens;
      outputTokens = resData.outputTokens;
      result.cost_usd = resData.cost;
      result.input_tokens = inputTokens;
      result.output_tokens = outputTokens;
      delete result._res_promise;
    }

    const icon = result.success ? tick : cross;
    const costStr = (result.cost_usd ?? 0) > 0 ? `$${result.cost_usd!.toFixed(6)}` : "$0.000000";
    const issueStr = (result.issues?.length ?? 0) > 0
      ? `${c.red}${result.issues!.join("; ")}${c.reset}`
      : "none";

    console.log(
      `${icon} ${result.latency_ms}ms | in=${result.input_tokens} out=${result.output_tokens} | ${costStr} | ${issueStr}`
    );
    for (const line of formatToolTrace(result.tool_call_details ?? [])) {
      console.log(`      ${line}`);
    }

    modelResults.tasks[task.id] = result;
    if (result.success) modelResults.score++;


    modelResults.total_input_tokens  += inputTokens;
    modelResults.total_output_tokens += outputTokens;
    modelResults.total_tokens += inputTokens + outputTokens;
    modelResults.total_cost   += result.cost_usd ?? 0;
    modelResults.total_tool_calls += result.tool_calls?.length ?? 0;

    if (i < scenario.tasks.length - 1) await sleep(DELAY_BETWEEN_TASKS);
  }

  const nonSkipped = Object.values(modelResults.tasks).filter((t) => !t.skipped);
  modelResults.avg_latency_ms = nonSkipped.length > 0
    ? Math.round(nonSkipped.reduce((s, t) => s + (t.latency_ms ?? 0), 0) / nonSkipped.length)
    : 0;

  const pct = Math.round((modelResults.score / modelResults.total) * 100);
  const scoreColor = pct === 100 ? c.green : pct >= 50 ? c.yellow : c.red;
  console.log(
    `    ${c.bold}Score: ${scoreColor}${modelResults.score}/${modelResults.total} (${pct}%)${c.reset}` +
    ` | Tokens: ${modelResults.total_tokens} | Cost: $${modelResults.total_cost.toFixed(6)}` +
    ` | Tool calls: ${modelResults.total_tool_calls} | Avg latency: ${modelResults.avg_latency_ms}ms`
  );

  return modelResults;
}

// ─── Main runner ───────────────────────────────────────────────────────────────
export async function runBenchmark(config: BenchmarkConfig): Promise<Record<string, ScenarioResult>> {
  const { scenarios, models, runs, mcpPath, mcpEnv, openRouterKey, logReasoning = false, scenarioWorkspaces } = config;
  const localBaseUrl = process.env.LOCAL_BASE_URL;
  const openrouter = new OpenRouter({
    apiKey: openRouterKey || process.env.OPENROUTER_API_KEY || "local",
  });

  const allResults: Record<string, ScenarioResult> = {};

  for (const scenario of scenarios) {
    console.log(`\n${"═".repeat(65)}`);
    console.log(`${c.bold}${c.cyan}SCENARIO: ${scenario.name}${c.reset}`);
    console.log(`${"═".repeat(65)}`);

    allResults[scenario.id] = { scenario: scenario.name, models: {} };

    process.stdout.write("Connecting to Inistate MCP... ");
    const mcpBridge = new MCPBridge(mcpPath, mcpEnv as unknown as Record<string, string>);
    let tools: Tool[];
    try {
      tools = await mcpBridge.connect();
      console.log(`${tick} ${tools.length} tools loaded`);
    } catch (e) {
      console.log(`${cross} Failed: ${(e as Error).message}`);
      continue;
    }

    const workspaceId = scenarioWorkspaces[scenario.id] ?? "";

    process.stdout.write("Setting up scenario... ");
    let assets: Record<string, unknown>;
    try {
      assets = await scenario.setup(mcpBridge, workspaceId) as Record<string, unknown>;
      console.log(`${tick} entryId: ${(assets as Record<string, unknown>).entryId ?? "n/a"}`);
    } catch (e) {
      console.log(`${cross} Setup failed: ${(e as Error).message}`);
      await mcpBridge.disconnect();
      continue;
    }

    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      console.log(`\n  ${c.bold}[${model.name}]${c.reset}`);

      const modelRunResults: ModelRunResult[] = [];

      for (let run = 0; run < runs; run++) {
        if (runs > 1) console.log(`  Run ${run + 1}/${runs}:`);
        const result = await runScenarioForModel(openrouter, model, scenario, assets, tools, mcpBridge.rawTools, localBaseUrl, logReasoning, mcpBridge);
        modelRunResults.push(result);
        if (result.skipped) break;
      }

      allResults[scenario.id].models[model.id] = modelRunResults;

      if (m < models.length - 1) await sleep(DELAY_BETWEEN_MODELS);
    }

    process.stdout.write("\nTearing down... ");
    try {
      await scenario.teardown(mcpBridge, assets);
      console.log(tick);
    } catch (e) {
      console.log(`${warn} ${(e as Error).message}`);
    }

    await mcpBridge.disconnect();
  }

  // ─── Print summary ─────────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(65)}`);
  console.log(`${c.bold}SUMMARY${c.reset}`);
  console.log("═".repeat(65));

  for (const scenarioData of Object.values(allResults)) {
    console.log(`\n${c.cyan}${scenarioData.scenario}${c.reset}`);
    console.log(
      `${"Model".padEnd(24)} ${"Score".padEnd(12)} ${"Tokens".padEnd(12)} ${"Cost".padEnd(14)} ${"Tool Calls".padEnd(12)} Avg Latency`
    );
    console.log("─".repeat(88));

    const sortedIds = Object.keys(scenarioData.models).sort((a, b) => {
      const statsFor = (id: string) => {
        const vr = (scenarioData.models[id] ?? []).filter((r) => !r.skipped);
        if (vr.length === 0) return { score: -1, cost: Infinity, latency: Infinity };
        return {
          score: vr.reduce((s, r) => s + r.score / r.total, 0) / vr.length,
          cost:  vr.reduce((s, r) => s + r.total_cost, 0) / vr.length,
          latency: vr.reduce((s, r) => s + (r.avg_latency_ms ?? 0), 0) / vr.length,
        };
      };
      const sa = statsFor(a), sb = statsFor(b);
      if (sb.score !== sa.score) return sb.score - sa.score;
      if (sa.cost  !== sb.cost)  return sa.cost  - sb.cost;
      return sa.latency - sb.latency;
    });

    for (const modelId of sortedIds) {
      const modelRuns = scenarioData.models[modelId];
      const model = models.find((m) => m.id === modelId);
      if (!model) continue;

      const validRuns = modelRuns.filter((r) => !r.skipped);
      if (validRuns.length === 0) {
        console.log(`${model.name.padEnd(24)} ${"SKIPPED".padEnd(12)}`);
        continue;
      }

      const avgScore = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
      const avgTokens = Math.round(validRuns.reduce((s, r) => s + r.total_tokens, 0) / validRuns.length);
      const avgCost = validRuns.reduce((s, r) => s + r.total_cost, 0) / validRuns.length;
      const avgToolCalls = Math.round(validRuns.reduce((s, r) => s + (r.total_tool_calls ?? 0), 0) / validRuns.length);
      const avgLatency = Math.round(validRuns.reduce((s, r) => s + (r.avg_latency_ms ?? 0), 0) / validRuns.length);
      const pct = Math.round(avgScore * 100);
      const scoreColor = pct === 100 ? c.green : pct >= 50 ? c.yellow : c.red;

      console.log(
        `${model.name.padEnd(24)} ${(scoreColor + pct + "%" + c.reset).padEnd(20)} ${String(avgTokens).padEnd(12)} $${avgCost.toFixed(6).padEnd(13)} ${String(avgToolCalls).padEnd(12)} ${avgLatency}ms`
      );
    }
  }

  // ─── Save results ──────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const outPath = path.join(__dirname, "../../results", `${timestamp}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const { testbenchVersion, mcpVersion, mcpCommit } = getVersions(mcpPath);
  const resultFile: ResultFile = {
    meta: { testbenchVersion, mcpVersion, mcpCommit, runAt: new Date().toISOString() },
    scenarios: allResults,
  };
  fs.writeFileSync(outPath, JSON.stringify(resultFile, null, 2));
  console.log(`\nResults saved → ${outPath}`);

  try {
    const { visualise } = require("../display/results-visualiser") as { visualise: (p: string) => void };
    visualise(outPath);
  } catch {
    // visualise is optional
  }

  return allResults;
}
