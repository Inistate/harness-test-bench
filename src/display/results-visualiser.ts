import * as fs from "fs";
import * as path from "path";
import type { ModelRunResult, ScenarioResult, TaskResult } from "../types";

// ─── ANSI ──────────────────────────────────────────────────────────────────────
const c = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  white:   "\x1b[37m",
};

const tick  = `${c.green}☑${c.reset}`;
const cross = `${c.red}☒${c.reset}`;
const skip  = `${c.yellow}⊘${c.reset}`;
const dot   = `${c.dim}○${c.reset}`;

function bar(value: number, max: number, width = 20, color = c.green): string {
  const filled = Math.round((value / max) * width);
  const empty  = width - filled;
  return color + "█".repeat(filled) + c.dim + "░".repeat(empty) + c.reset;
}

function pctColor(pct: number): string {
  if (pct === 100) return c.green;
  if (pct >= 75)   return c.cyan;
  if (pct >= 50)   return c.yellow;
  return c.red;
}

function fmtCost(n: number): string {
  if (n === 0) return `${c.dim}free${c.reset}`;
  return `$${n.toFixed(6)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function header(text: string, width = 65): void {
  const pad   = Math.max(0, width - text.length - 4);
  const left  = Math.floor(pad / 2);
  const right = pad - left;
  console.log(
    c.bold + c.cyan +
    "╔" + "═".repeat(width - 2) + "╗\n" +
    "║" + " ".repeat(left + 1) + text + " ".repeat(right + 1) + "║\n" +
    "╚" + "═".repeat(width - 2) + "╝" +
    c.reset
  );
}

function divider(width = 65, char = "─"): void {
  console.log(c.dim + char.repeat(width) + c.reset);
}

function loadResults(filePath?: string): Record<string, ScenarioResult> {
  if (filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, ScenarioResult>;
  }
  const dir = path.join(__dirname, "../../results");
  if (!fs.existsSync(dir)) {
    console.error("No results directory found. Run testbench first.");
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  if (files.length === 0) {
    console.error("No result files found. Run testbench first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")) as Record<string, ScenarioResult>;
}

function sortedModelIds(scenarioData: ScenarioResult): string[] {
  return Object.keys(scenarioData.models).sort((a, b) => {
    const statsFor = (id: string) => {
      const validRuns = (scenarioData.models[id] ?? []).filter((r) => !r.skipped);
      if (validRuns.length === 0) return { score: -1, cost: Infinity, latency: Infinity };
      const avgScore = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
      const avgCost  = validRuns.reduce((s, r) => s + r.total_cost, 0) / validRuns.length;
      let latSum = 0, latCount = 0;
      for (const run of validRuns) {
        for (const task of Object.values(run.tasks)) {
          if (!task.skipped && task.latency_ms) { latSum += task.latency_ms; latCount++; }
        }
      }
      return { score: avgScore, cost: avgCost, latency: latCount > 0 ? latSum / latCount : Infinity };
    };
    const sa = statsFor(a), sb = statsFor(b);
    if (sb.score !== sa.score) return sb.score - sa.score;
    if (sa.cost  !== sb.cost)  return sa.cost  - sb.cost;
    return sa.latency - sb.latency;
  });
}

function drawTaskGrid(scenarioData: ScenarioResult): void {
  const taskIds = new Set<string>();
  for (const runs of Object.values(scenarioData.models)) {
    for (const run of runs) {
      if (!run.skipped) Object.keys(run.tasks).forEach((id) => taskIds.add(id));
    }
  }
  const tasks = Array.from(taskIds);
  if (tasks.length === 0) return;

  const taskNames: Record<string, string> = {};
  for (const runs of Object.values(scenarioData.models)) {
    for (const run of runs) {
      if (!run.skipped) {
        for (const [id, result] of Object.entries(run.tasks)) {
          if (!taskNames[id] && !result.skipped) {
            taskNames[id] = id.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
          }
        }
      }
    }
  }

  const modelColW = 22;
  const taskColW  = 12;
  const totalW    = modelColW + tasks.length * (taskColW + 1) + 20;

  console.log(`\n${c.bold}Task Breakdown${c.reset}`);
  divider(totalW);

  let headerRow = " ".repeat(modelColW) + " ";
  for (const id of tasks) {
    const name = (taskNames[id] ?? id).slice(0, taskColW - 2);
    headerRow += c.dim + name.padEnd(taskColW) + c.reset + " ";
  }
  headerRow += c.dim + "Score".padEnd(10) + "Tokens".padEnd(10) + "Cost" + c.reset;
  console.log(headerRow);
  divider(totalW);

  for (const modelId of sortedModelIds(scenarioData)) {
    const runs = scenarioData.models[modelId];
    const validRuns = runs.filter((r) => !r.skipped);
    if (validRuns.length === 0) {
      console.log(
        c.dim + modelId.split("/").pop()!.slice(0, modelColW - 1).padEnd(modelColW) + c.reset +
        " " + skip + " skipped"
      );
      continue;
    }

    const avgTaskResult: Record<string, number | "skipped" | null> = {};
    for (const id of tasks) {
      const results = validRuns.map((r) => r.tasks?.[id]).filter((x): x is TaskResult => !!x);
      if (results.length === 0) { avgTaskResult[id] = null; continue; }
      const skippedAll = results.every((r) => r.skipped);
      avgTaskResult[id] = skippedAll
        ? "skipped"
        : results.filter((r) => !r.skipped && r.success).length / results.length;
    }

    const avgScore  = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
    const avgTokens = Math.round(validRuns.reduce((s, r) => s + r.total_tokens, 0) / validRuns.length);
    const avgCost   = validRuns.reduce((s, r) => s + r.total_cost, 0) / validRuns.length;
    const pct       = Math.round(avgScore * 100);
    const label     = modelId.split("/").pop()!.slice(0, modelColW - 1).padEnd(modelColW);

    let row = c.bold + label + c.reset + " ";
    for (const id of tasks) {
      const res = avgTaskResult[id];
      let cell: string;
      if (res === null)        cell = dot + " ".repeat(taskColW - 1);
      else if (res === "skipped") cell = skip + " ".repeat(taskColW - 1);
      else if (res === 1)      cell = tick + " ".repeat(taskColW - 1);
      else if (res === 0)      cell = cross + " ".repeat(taskColW - 1);
      else {
        const pctTask = Math.round((res as number) * 100);
        cell = `${c.yellow}◑${c.reset} ${pctTask}%`.padEnd(taskColW);
      }
      row += cell + " ";
    }

    const col = pctColor(pct);
    row +=
      col + `${pct}%`.padEnd(6) + c.reset +
      "  " +
      c.dim + fmtTokens(avgTokens).padEnd(9) + c.reset +
      fmtCost(avgCost);

    console.log(row);
  }
  divider(totalW);
}

function drawScoreChart(scenarioData: ScenarioResult): void {
  console.log(`\n${c.bold}Overall Score${c.reset}`);
  divider(65);
  for (const modelId of sortedModelIds(scenarioData)) {
    const validRuns = (scenarioData.models[modelId] ?? []).filter((r) => !r.skipped);
    if (validRuns.length === 0) continue;
    const avgScore = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
    const pct      = Math.round(avgScore * 100);
    const col      = pctColor(pct);
    const label    = modelId.split("/").pop()!.slice(0, 20).padEnd(21);
    console.log(`${label} ${bar(pct, 100, 25, col)} ${col}${`${pct}%`.padStart(4)}${c.reset}`);
  }
  divider(65);
}

function drawTokenCostTable(scenarioData: ScenarioResult): void {
  console.log(`\n${c.bold}Token Usage & Cost${c.reset}`);
  divider(65);
  console.log(c.dim + "Model".padEnd(22) + "Avg Tokens".padEnd(14) + "Input".padEnd(12) + "Output".padEnd(12) + "Avg Cost" + c.reset);
  divider(65);

  for (const modelId of sortedModelIds(scenarioData)) {
    const validRuns = (scenarioData.models[modelId] ?? []).filter((r) => !r.skipped);
    if (validRuns.length === 0) continue;

    let totalIn = 0, totalOut = 0, totalCost = 0;
    for (const run of validRuns) {
      totalIn   += run.total_input_tokens  ?? 0;
      totalOut  += run.total_output_tokens ?? 0;
      totalCost += run.total_cost;
    }
    const n = validRuns.length;
    const label = modelId.split("/").pop()!.slice(0, 21).padEnd(22);
    const avgIn  = Math.round(totalIn  / n);
    const avgOut = Math.round(totalOut / n);
    console.log(
      label +
      fmtTokens(Math.round((totalIn + totalOut) / n)).padEnd(14) +
      c.dim + fmtTokens(avgIn).padEnd(12) + c.reset +
      c.dim + fmtTokens(avgOut).padEnd(12) + c.reset +
      fmtCost(totalCost / n)
    );
  }
  divider(65);
}

function drawLatencyToolTable(scenarioData: ScenarioResult): void {
  console.log(`\n${c.bold}Latency & Tool Calls${c.reset}`);
  divider(65);
  console.log(c.dim + "Model".padEnd(22) + "Avg Latency".padEnd(14) + "Total Calls".padEnd(14) + "Calls/Task" + c.reset);
  divider(65);

  for (const modelId of sortedModelIds(scenarioData)) {
    const validRuns = (scenarioData.models[modelId] ?? []).filter((r) => !r.skipped);
    if (validRuns.length === 0) continue;

    let latencySum = 0, latencyCount = 0, toolCallSum = 0, taskCount = 0;
    for (const run of validRuns) {
      for (const task of Object.values(run.tasks)) {
        if (!task.skipped) {
          if (task.latency_ms) { latencySum += task.latency_ms; latencyCount++; }
          toolCallSum += task.tool_calls?.length ?? 0;
          taskCount++;
        }
      }
    }
    const avgLatency   = latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0;
    const totalCalls   = Math.round(toolCallSum / validRuns.length);
    const callsPerTask = taskCount > 0 ? (toolCallSum / taskCount / validRuns.length).toFixed(1) : "0";
    const label        = modelId.split("/").pop()!.slice(0, 21).padEnd(22);
    const latCol       = avgLatency < 5000 ? c.green : avgLatency < 15000 ? c.yellow : c.red;
    console.log(label + (latCol + `${avgLatency}ms` + c.reset).padEnd(22) + String(totalCalls).padEnd(14) + callsPerTask);
  }
  divider(65);
}

function drawPerTaskTokens(scenarioData: ScenarioResult): void {
  const taskIds = Array.from(new Set(
    Object.values(scenarioData.models).flatMap((runs) =>
      runs.flatMap((r) => (r.skipped ? [] : Object.keys(r.tasks)))
    )
  ));
  if (taskIds.length === 0) return;

  const modelColW = 22;
  const taskColW  = 10;
  const totalW    = modelColW + taskIds.length * (taskColW + 1) + 1;

  console.log(`\n${c.bold}Per-Task Token Usage${c.reset}`);
  divider(totalW);

  let headerRow = " ".repeat(modelColW) + " ";
  for (const id of taskIds) {
    const label = id.replace(/^task_\d+_/, "").slice(0, taskColW - 2);
    headerRow += c.dim + label.padEnd(taskColW) + c.reset + " ";
  }
  console.log(headerRow);
  divider(totalW);

  for (const modelId of sortedModelIds(scenarioData)) {
    const validRuns = (scenarioData.models[modelId] ?? []).filter((r) => !r.skipped);
    if (validRuns.length === 0) continue;

    const label = modelId.split("/").pop()!.slice(0, modelColW - 1).padEnd(modelColW);
    let row = c.bold + label + c.reset + " ";
    for (const id of taskIds) {
      const results = validRuns.map((r) => r.tasks?.[id]).filter((t) => t && !t.skipped);
      if (results.length === 0) { row += c.dim + "—".padEnd(taskColW) + c.reset + " "; continue; }
      const avgTokens = Math.round(
        results.reduce((s, t) => s + (t.input_tokens ?? 0) + (t.output_tokens ?? 0), 0) / results.length
      );
      const col = avgTokens < 5000 ? c.green : avgTokens < 15000 ? c.yellow : c.red;
      row += col + fmtTokens(avgTokens).padEnd(taskColW) + c.reset + " ";
    }
    console.log(row);
  }
  divider(totalW);
}

function drawPerTaskToolCalls(scenarioData: ScenarioResult): void {
  const taskIds = Array.from(new Set(
    Object.values(scenarioData.models).flatMap((runs) =>
      runs.flatMap((r) => (r.skipped ? [] : Object.keys(r.tasks)))
    )
  ));
  if (taskIds.length === 0) return;

  const modelColW = 22;
  const taskColW  = 28;
  const totalW    = modelColW + taskIds.length * (taskColW + 1) + 1;

  console.log(`\n${c.bold}Per-Task Tool Calls${c.reset}`);
  divider(totalW);

  let headerRow = " ".repeat(modelColW) + " ";
  for (const id of taskIds) {
    const label = id.replace(/^task_\d+_/, "").slice(0, taskColW - 2);
    headerRow += c.dim + label.padEnd(taskColW) + c.reset + " ";
  }
  console.log(headerRow);
  divider(totalW);

  for (const modelId of sortedModelIds(scenarioData)) {
    const validRuns = (scenarioData.models[modelId] ?? []).filter((r) => !r.skipped);
    if (validRuns.length === 0) continue;

    const label = modelId.split("/").pop()!.slice(0, modelColW - 1).padEnd(modelColW);
    let row = c.bold + label + c.reset + " ";
    for (const id of taskIds) {
      const results = validRuns.map((r) => r.tasks?.[id]).filter((t) => t && !t.skipped);
      if (results.length === 0) { row += c.dim + "—".padEnd(taskColW) + c.reset + " "; continue; }

      const freq: Record<string, number> = {};
      for (const t of results) {
        for (const name of t.tool_calls ?? []) {
          freq[name] = (freq[name] ?? 0) + 1;
        }
      }
      const n = validRuns.length;
      const parts = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => {
          const avg = count / n;
          return avg > 1 ? `${name}(×${avg.toFixed(0)})` : name;
        });
      const total = Object.values(freq).reduce((s, v) => s + v, 0) / n;
      const summary = `[${total.toFixed(0)}] ${parts.join(", ")}`.slice(0, taskColW - 1);
      row += c.cyan + summary.padEnd(taskColW) + c.reset + " ";
    }
    console.log(row);
  }
  divider(totalW);
}

function drawIssuesSummary(scenarioData: ScenarioResult): void {
  const issueMap: Record<string, string[]> = {};
  for (const [modelId, runs] of Object.entries(scenarioData.models)) {
    for (const run of runs.filter((r) => !r.skipped)) {
      for (const task of Object.values(run.tasks)) {
        if (!task.skipped && (task.issues?.length ?? 0) > 0) {
          if (!issueMap[modelId]) issueMap[modelId] = [];
          issueMap[modelId].push(...task.issues!);
        }
      }
    }
  }
  if (Object.keys(issueMap).length === 0) return;

  console.log(`\n${c.bold}Failure Analysis${c.reset}`);
  divider(65);
  for (const [modelId, issues] of Object.entries(issueMap)) {
    console.log(`${c.yellow}${modelId.split("/").pop()!.slice(0, 20)}${c.reset}`);
    const freq: Record<string, number> = {};
    issues.forEach((i) => { freq[i] = (freq[i] ?? 0) + 1; });
    for (const [issue, count] of Object.entries(freq).sort((a, b) => b[1] - a[1])) {
      const countStr = count > 1 ? ` ${c.dim}(×${count})${c.reset}` : "";
      console.log(`  ${cross} ${issue}${countStr}`);
    }
  }
  divider(65);
}

function drawHallucinationSummary(scenarioData: ScenarioResult): void {
  const hallMap: Record<string, { hallucinatedTasks: number; totalTasks: number }> = {};
  for (const [modelId, runs] of Object.entries(scenarioData.models)) {
    let hallucinatedTasks = 0, totalTasks = 0;
    for (const run of runs.filter((r) => !r.skipped)) {
      for (const task of Object.values(run.tasks)) {
        if (!task.skipped) { totalTasks++; if (task.hallucinated) hallucinatedTasks++; }
      }
    }
    if (totalTasks > 0) hallMap[modelId] = { hallucinatedTasks, totalTasks };
  }
  if (Object.keys(hallMap).length === 0) return;

  console.log(`\n${c.bold}Hallucination Rate${c.reset}`);
  divider(65);
  for (const modelId of sortedModelIds(scenarioData).filter((id) => hallMap[id])) {
    const { hallucinatedTasks, totalTasks } = hallMap[modelId]!;
    const pct   = Math.round((hallucinatedTasks / totalTasks) * 100);
    const label = modelId.split("/").pop()!.slice(0, 20).padEnd(21);
    const col   = pct === 0 ? c.green : pct < 25 ? c.yellow : c.red;
    console.log(`${label} ${bar(pct, 100, 20, col)} ${col}${pct}%${c.reset} (${hallucinatedTasks}/${totalTasks} tasks)`);
  }
  divider(65);
}

export function visualise(filePath?: string): void {
  const data = loadResults(filePath);
  console.log("\n");
  header("Inistate TestBench — Results");

  for (const scenData of Object.values(data)) {
    console.log(`\n${c.bold}${c.magenta}▶ ${scenData.scenario}${c.reset}`);
    drawTaskGrid(scenData);
    drawScoreChart(scenData);
    drawTokenCostTable(scenData);
    drawPerTaskTokens(scenData);
    drawLatencyToolTable(scenData);
    drawPerTaskToolCalls(scenData);
    drawHallucinationSummary(scenData);
    drawIssuesSummary(scenData);
  }

  const src = filePath ?? (() => {
    const dir = path.join(__dirname, "../../results");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
    return path.join(dir, files[0]);
  })();
  console.log(`\n${c.dim}Source: ${src}${c.reset}\n`);
}

if (require.main === module) {
  visualise(process.argv[2]);
}
