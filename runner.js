const { OpenRouter, fromChatMessages, stepCountIs } = require("@openrouter/agent");
const { MCPBridge } = require("./mcp_bridge");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DELAY_BETWEEN_TASKS = 3000;
const DELAY_BETWEEN_MODELS = 10000;
const MAX_RETRIES = 3;

// ─── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

const tick = `${c.green}✅${c.reset}`;
const cross = `${c.red}❌${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;

function formatError(e) {
  const parts = [];
  if (e?.message) parts.push(e.message);
  if (e?.name && e.name !== "Error") parts.push(`type=${e.name}`);
  if (e?.statusCode) parts.push(`status=${e.statusCode}`);

  const issues = e?.cause?.issues || e?.cause?.errors;
  if (Array.isArray(issues) && issues.length > 0) {
    parts.push(`issues=${JSON.stringify(issues.slice(0, 5))}`);
  } else if (typeof e?.pretty === "function") {
    const pretty = e.pretty();
    if (pretty && pretty !== e.message) parts.push(pretty);
  }

  if (e?.rawValue !== undefined) {
    parts.push(`raw=${JSON.stringify(e.rawValue).slice(0, 1000)}`);
  }

  if (e?.body) {
    parts.push(`body=${String(e.body).slice(0, 1000)}`);
  }

  return parts.length > 0 ? parts.join(" | ") : String(e);
}

function parseToolOutput(output) {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function parseToolArguments(args) {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function compactJson(value, maxLength = 260) {
  if (value === undefined) return "";
  const text = JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function summarizeToolResult(result) {
  if (result === undefined) return "no result captured";
  if (typeof result === "string") return result.slice(0, 180);
  if (result?.error) return `error=${result.error}`;

  const summary = [];
  const entryId = result.entryId || result.entryIds?.[0] || result.results?.[0]?.entryId;
  const documentId = result.documentId || result.results?.[0]?.documentId;
  const state = result.state || result.results?.[0]?.state;
  const succeeded = result.summary?.succeeded;
  const failed = result.summary?.failed;
  const total = result.totalItems || result.total;
  const listCount = Array.isArray(result.list) ? result.list.length : undefined;

  if (entryId) summary.push(`entryId=${entryId}`);
  if (documentId) summary.push(`documentId=${documentId}`);
  if (state) summary.push(`state=${state}`);
  if (succeeded !== undefined || failed !== undefined) summary.push(`ok=${succeeded ?? 0} fail=${failed ?? 0}`);
  if (listCount !== undefined) summary.push(`list=${listCount}${total !== undefined ? `/${total}` : ""}`);
  if (result.success !== undefined) summary.push(`success=${result.success}`);

  return summary.length > 0 ? summary.join(" ") : compactJson(result, 180);
}

function formatToolTrace(toolCalls) {
  if (!toolCalls.length) return [`${c.dim}no tool calls captured${c.reset}`];
  return toolCalls.map((call, index) => {
    const args = compactJson(call.arguments, 320);
    const result = summarizeToolResult(call.result);
    return `${index + 1}. ${c.cyan}${call.name}${c.reset} args=${args || "{}"} → ${result}`;
  });
}

async function collectExecutedToolCalls(result) {
  const calls = [];
  const rounds = Array.isArray(result.allToolExecutionRounds)
    ? result.allToolExecutionRounds
    : [];

  for (const round of rounds) {
    const outputsByCallId = new Map(
      (round.toolResults || []).map((toolResult) => [
        toolResult.callId,
        parseToolOutput(toolResult.output),
      ])
    );

    for (const call of round.toolCalls || []) {
      calls.push({
        name: call.name,
        arguments: parseToolArguments(call.arguments),
        result: outputsByCallId.get(call.id),
      });
    }
  }

  if (calls.length > 0) return calls;

  try {
    const initialCalls = await result.getToolCalls();
    return (initialCalls || []).map((call) => ({
      name: call.name,
      arguments: parseToolArguments(call.arguments),
      result: call.result,
    }));
  } catch {
    return [];
  }
}

// ─── Run a single task for one model ──────────────────────────────────────────
async function runTask(openrouter, model, task, assets, tools, system, attempt = 0) {
  const prompt = typeof task.prompt === "function" ? task.prompt(assets) : task.prompt;

  try {
    const start = Date.now();

    const result = openrouter.callModel({
      model: model.id,
      input: fromChatMessages([
        { role: "system", content: system },
        { role: "user", content: prompt },
      ]),
      tools,
      stopWhen: stepCountIs(12),
    });

    const [text, response] = await Promise.all([
      result.getText(),
      result.getResponse(),
    ]);

    const latency = Date.now() - start;
    const usage = response.usage || {};
    const inputTokens = usage.prompt_tokens || usage.inputTokens || 0;
    const outputTokens = usage.completion_tokens || usage.outputTokens || 0;
    const cost = (inputTokens / 1e6) * model.price_in + (outputTokens / 1e6) * model.price_out;

    const toolCalls = await collectExecutedToolCalls(result);

    const evaluation = task.evaluate(toolCalls, text);

    return {
      skipped: false,
      success: evaluation.success,
      issues: evaluation.issues,
      hallucinated: evaluation.hallucinated,
      latency_ms: latency,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      tool_calls: toolCalls.map((t) => t.name),
      tool_call_details: toolCalls,
      response_preview: text?.slice(0, 200),
    };
  } catch (e) {
    const status = e?.status || e?.response?.status;

    // Rate limit — retry with backoff
    if (status === 429 && attempt < MAX_RETRIES) {
      const wait = [10000, 30000, 60000][attempt];
      process.stdout.write(`\n    ${warn} Rate limited. Waiting ${wait / 1000}s...`);
      await sleep(wait);
      return runTask(openrouter, model, task, assets, tools, system, attempt + 1);
    }

    // Paid model not accessible on free tier
    if (status === 402 || status === 403) {
      return { skipped: true, reason: `HTTP ${status} — model not accessible on free tier` };
    }

    return { skipped: true, reason: formatError(e) };
  }
}

// ─── Run all tasks for one scenario + model ────────────────────────────────────
async function runScenarioForModel(openrouter, model, scenario, assets, tools) {
  const modelResults = {
    model: model.name,
    tasks: {},
    score: 0,
    total: scenario.tasks.length,
    total_tokens: 0,
    total_cost: 0,
    total_tool_calls: 0,
    skipped: false,
  };

  for (let i = 0; i < scenario.tasks.length; i++) {
    const task = scenario.tasks[i];
    process.stdout.write(
      `    Task ${i + 1}/${scenario.tasks.length}: ${c.dim}${task.name}${c.reset} `
    );

    const result = await runTask(openrouter, model, task, assets, tools, scenario.system);

    if (result.skipped) {
      console.log(`${warn} Skipped: ${result.reason}`);
      modelResults.tasks[task.id] = { skipped: true, reason: result.reason };
      // If first task fails due to access, skip remaining tasks for this model
      if (i === 0) {
        modelResults.skipped = true;
        modelResults.skip_reason = result.reason;
        break;
      }
      continue;
    }

    const icon = result.success ? tick : cross;
    const costStr = result.cost_usd > 0 ? `$${result.cost_usd.toFixed(6)}` : "$0.000000";
    const issueStr = result.issues?.length > 0 ? `${c.red}${result.issues.join("; ")}${c.reset}` : "none";

    console.log(
      `${icon} ${result.latency_ms}ms | in=${result.input_tokens} out=${result.output_tokens} | ${costStr} | ${issueStr}`
    );
    for (const line of formatToolTrace(result.tool_call_details || [])) {
      console.log(`      ${line}`);
    }

    modelResults.tasks[task.id] = result;
    if (result.success) modelResults.score++;
    modelResults.total_tokens += result.input_tokens + result.output_tokens;
    modelResults.total_cost += result.cost_usd;
    modelResults.total_tool_calls += result.tool_calls?.length || 0;

    if (i < scenario.tasks.length - 1) await sleep(DELAY_BETWEEN_TASKS);
  }

  const nonSkippedTasks = Object.values(modelResults.tasks).filter(t => !t.skipped);
  const avgLatency = nonSkippedTasks.length > 0
    ? Math.round(nonSkippedTasks.reduce((s, t) => s + (t.latency_ms || 0), 0) / nonSkippedTasks.length)
    : 0;
  modelResults.avg_latency_ms = avgLatency;

  const pct = Math.round((modelResults.score / modelResults.total) * 100);
  const scoreColor = pct === 100 ? c.green : pct >= 50 ? c.yellow : c.red;
  console.log(
    `    ${c.bold}Score: ${scoreColor}${modelResults.score}/${modelResults.total} (${pct}%)${c.reset}` +
    ` | Tokens: ${modelResults.total_tokens} | Cost: $${modelResults.total_cost.toFixed(6)}` +
    ` | Tool calls: ${modelResults.total_tool_calls} | Avg latency: ${avgLatency}ms`
  );

  return modelResults;
}

// ─── Main runner ───────────────────────────────────────────────────────────────
async function runBenchmark({ scenarios, models, runs, mcpPath, mcpEnv, openRouterKey }) {
  const openrouter = new OpenRouter({ apiKey: openRouterKey || process.env.OPENROUTER_API_KEY });
  const allResults = {};

  for (const scenario of scenarios) {
    console.log(`\n${"═".repeat(65)}`);
    console.log(`${c.bold}${c.cyan}SCENARIO: ${scenario.name}${c.reset}`);
    console.log(`${"═".repeat(65)}`);

    allResults[scenario.id] = { scenario: scenario.name, models: {} };

    // Connect MCP
    process.stdout.write("Connecting to Inistate MCP... ");
    const mcpBridge = new MCPBridge(mcpPath, mcpEnv);
    let tools;
    try {
      tools = await mcpBridge.connect();
      console.log(`${tick} ${tools.length} tools loaded`);
    } catch (e) {
      console.log(`${cross} Failed: ${e.message}`);
      continue;
    }

    // Setup
    process.stdout.write("Setting up scenario... ");
    let assets;
    try {
      assets = await scenario.setup(mcpBridge);
      console.log(`${tick} entryId: ${assets.entryId}`);
    } catch (e) {
      console.log(`${cross} Setup failed: ${e.message}`);
      await mcpBridge.disconnect();
      continue;
    }

    // Run each model
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      console.log(`\n  ${c.bold}[${model.name}]${c.reset}`);

      const modelRunResults = [];

      for (let run = 0; run < runs; run++) {
        if (runs > 1) console.log(`  Run ${run + 1}/${runs}:`);
        const result = await runScenarioForModel(openrouter, model, scenario, assets, tools);
        modelRunResults.push(result);
        if (result.skipped) break;
      }

      allResults[scenario.id].models[model.id] = modelRunResults;

      if (m < models.length - 1) await sleep(DELAY_BETWEEN_MODELS);
    }

    // Teardown
    process.stdout.write("\nTearing down... ");
    try {
      await scenario.teardown(mcpBridge, assets);
      console.log(tick);
    } catch (e) {
      console.log(`${warn} ${e.message}`);
    }

    await mcpBridge.disconnect();
  }

  // ─── Print summary ───────────────────────────────────────────────────────────
  console.log(`\n\n${"═".repeat(65)}`);
  console.log(`${c.bold}SUMMARY${c.reset}`);
  console.log("═".repeat(65));

  for (const [scenarioId, scenarioData] of Object.entries(allResults)) {
    console.log(`\n${c.cyan}${scenarioData.scenario}${c.reset}`);
    console.log(
      `${"Model".padEnd(24)} ${"Score".padEnd(12)} ${"Tokens".padEnd(12)} ${"Cost".padEnd(14)} ${"Tool Calls".padEnd(12)} Avg Latency`
    );
    console.log("─".repeat(88));

    const sortedIds = Object.keys(scenarioData.models).sort((a, b) => {
      const statsFor = (id) => {
        const vr = (scenarioData.models[id] || []).filter(r => !r.skipped);
        if (vr.length === 0) return { score: -1, cost: Infinity, latency: Infinity };
        return {
          score: vr.reduce((s, r) => s + r.score / r.total, 0) / vr.length,
          cost:  vr.reduce((s, r) => s + r.total_cost, 0) / vr.length,
          latency: vr.reduce((s, r) => s + (r.avg_latency_ms || 0), 0) / vr.length,
        };
      };
      const sa = statsFor(a), sb = statsFor(b);
      if (sb.score   !== sa.score)   return sb.score   - sa.score;
      if (sa.cost    !== sb.cost)    return sa.cost    - sb.cost;
      return sa.latency - sb.latency;
    });

    for (const modelId of sortedIds) {
      const runs = scenarioData.models[modelId];
      const model = models.find((m) => m.id === modelId);
      if (!model) continue;

      const validRuns = runs.filter((r) => !r.skipped);
      if (validRuns.length === 0) {
        console.log(`${model.name.padEnd(24)} ${"SKIPPED".padEnd(12)}`);
        continue;
      }

      const avgScore = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
      const avgTokens = Math.round(validRuns.reduce((s, r) => s + r.total_tokens, 0) / validRuns.length);
      const avgCost = validRuns.reduce((s, r) => s + r.total_cost, 0) / validRuns.length;
      const avgToolCalls = Math.round(validRuns.reduce((s, r) => s + (r.total_tool_calls || 0), 0) / validRuns.length);
      const avgLatency = Math.round(validRuns.reduce((s, r) => s + (r.avg_latency_ms || 0), 0) / validRuns.length);
      const pct = Math.round(avgScore * 100);
      const scoreColor = pct === 100 ? c.green : pct >= 50 ? c.yellow : c.red;

      console.log(
        `${model.name.padEnd(24)} ${(scoreColor + pct + "%" + c.reset).padEnd(20)} ${String(avgTokens).padEnd(12)} $${avgCost.toFixed(6).padEnd(13)} ${String(avgToolCalls).padEnd(12)} ${avgLatency}ms`
      );
    }
  }

  // ─── Save results ────────────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const outPath = path.join(__dirname, "results", `${timestamp}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved → ${outPath}`);

  // Auto-visualise
  try {
    const { visualise } = require("./visualise");
    visualise(outPath);
  } catch (e) {
    // visualise is optional
  }

  return allResults;
}

module.exports = { runBenchmark };
